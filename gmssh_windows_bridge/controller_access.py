"""Independent long-lived grants: pinned HTTPS, no Windows/desktop password export."""
import base64
import errno
import hashlib
import json
import re
import stat
import socket
import ssl
import threading
import weakref

import paramiko

from .address import normalize_address
from .connection_code import _PinnedConnection, inspect_code, PREFIX as LEGACY_PREFIX
from .file_stream import StreamError, CHUNK
from .pairing import _object

PREFIX = 'GMSSH-AUTH2.'
PERMISSIONS = {'view', 'input', 'clipboard', 'files', 'terminal', 'power'}


def checked_policy(value):
    if (not isinstance(value, dict) or not PERMISSIONS <= value.keys() <= PERMISSIONS | {'files_read'}
            or any(type(flag) is not bool for flag in value.values())
            or not value['view'] and (value['input'] or value['clipboard'])):
        raise ValueError('Invalid controller permissions')
    policy = dict(value)
    if policy['files'] or not policy.get('files_read'):
        policy.pop('files_read', None)
    return policy


def inspect_authorization(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > 32768 or not text.strip().startswith(PREFIX):
        raise ValueError('请粘贴服务端创建的独立授权码。')
    encoded = text.strip()[len(PREFIX):]
    try:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', encoded):
            raise ValueError()
        raw = base64.b64decode(encoded+'='*(-len(encoded) % 4), altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(raw).decode().rstrip('=') != encoded:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=_object)
        if not isinstance(value, dict) or set(value) != {'schema', 'connection', 'port', 'certificate', 'controller'} or type(value['schema']) is not int or value['schema'] != 2:
            raise ValueError()
        controller = value['controller']
        if (not isinstance(controller, dict) or set(controller) != {'id', 'name', 'token', 'permissions'}
                or not isinstance(controller['id'], str) or not re.fullmatch('[a-f0-9]{32}', controller['id'])
                or not isinstance(controller['name'], str) or not 1 <= len(controller['name']) <= 80
                or any(ord(c) < 32 for c in controller['name'])):
            raise ValueError()
        policy = checked_policy(controller['permissions'])
        controller = {**controller, 'permissions': policy}
        # Reuse the existing canonical certificate/SAN/device identity checks.
        legacy = {key: value[key] for key in ('connection', 'port', 'certificate')}
        legacy.update(schema=1, token=controller['token'])
        code = inspect_code(LEGACY_PREFIX+base64.urlsafe_b64encode(json.dumps(legacy, separators=(',', ':')).encode()).decode().rstrip('='))
    except (ValueError, UnicodeError, KeyError, TypeError):
        raise ValueError('独立授权码无效，或证书与设备身份不一致。') from None
    code.update(controller=dict(controller), id=hashlib.sha256((code['public']['id']+':'+controller['id']).encode()).hexdigest()[:32])
    return code


def public_authorization(code):
    return {**code['public'], 'id': code['id'], 'controllerId': code['controller']['id'],
            'controllerName': code['controller']['name'], 'permissions': dict(code['controller']['permissions']),
            'fromAuthorization': True}


def metadata_connection(code):
    public = dict(code['public'])
    public['wakeAdapters'] = [{key: adapter[key] for key in ('address', 'mac', 'prefixLength')} for adapter in public.get('adapters', [])]
    for key in ('id', 'adapters'):
        public.pop(key, None)
    public['desktopAuth'] = 'controller'
    public['authorization'] = {'schema': 2, 'port': code['port'], 'certificate': code['certificate'],
                               'controller': {key: code['controller'][key] for key in ('id', 'name', 'permissions')}}
    return json.dumps(public, ensure_ascii=False, separators=(',', ':'))


def configuration(connection):
    """Rebuild pinned public configuration without needing a stored bearer token."""
    metadata = connection.get('authorization')
    if not isinstance(metadata, dict) or set(metadata) != {'schema', 'port', 'certificate', 'controller'} or type(metadata.get('schema')) is not int or metadata['schema'] != 2:
        raise ValueError('独立授权配置无效。')
    controller = metadata['controller']
    if not isinstance(controller, dict) or set(controller) != {'id', 'name', 'permissions'}:
        raise ValueError('独立授权配置包含不受支持的字段。')
    public = {key: connection[key] for key in ('schema', 'computer', 'username', 'sshPort', 'addresses', 'sshHostPublicKey', 'sshHostFingerprint')}
    public['desktopAuth'] = 'shared-ssh'
    payload = {'schema': 2, 'connection': public, 'port': metadata['port'], 'certificate': metadata['certificate'],
               'controller': {**controller, 'token': 'A'*43}}
    return inspect_authorization(PREFIX+base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('='))


def probe_authorization(connection, target, timeout=8):
    code = configuration(connection)
    target = normalize_address(target)
    if target not in code['public']['addresses']:
        raise ValueError('请选择独立授权配置中的目标地址。')
    client = _PinnedConnection(target, code)
    client.timeout = timeout
    try:
        client.connect()  # No bearer token is sent during this public identity probe.
        return {'verified': True, 'fingerprint': code['public']['sshHostFingerprint']}
    finally:
        client.close()


class ControllerClient:
    controller_protocol = 2
    def __init__(self, target, code, token=None):
        self.code = code
        self.target = normalize_address(target)
        self.token = token if token is not None else code['controller']['token']
        self.local = threading.local()
        self.connections = weakref.WeakSet()
        self.lock = threading.Lock()
        self.closed = False
        self.authenticated = False
        self.file_read_only = False
        self.windows_unlock = False
        self.policy = dict(code['controller']['permissions'])

    def authorize(self):
        value = self.call('capabilities')
        try:
            policy = checked_policy(value.get('permissions'))
        except ValueError:
            self.authenticated = False
            raise StreamError('INVALID_RESPONSE') from None
        if value.get('protocol') != 2 or value.get('controllerId') != self.code['controller']['id']:
            self.authenticated = False
            raise StreamError('INVALID_RESPONSE')
        self.file_read_only = type(value.get('fileReadOnly')) is int and value['fileReadOnly'] == 1
        self.windows_unlock = type(value.get('windowsUnlock')) is int and value['windowsUnlock'] == 1
        if policy.get('files_read') and not self.file_read_only:
            self.authenticated = False
            raise StreamError('SERVER_UPGRADE_REQUIRED')
        self.policy = policy
        self.authenticated = True
        return value

    def call(self, action, session=None, **values):
        if self.closed:
            raise StreamError('AUTH_FAILED')
        body = {'action': action}
        if session is not None:
            body['session'] = session
        body.update(values)
        try:
            connection = getattr(self.local, 'connection', None)
            if connection is None:
                connection = _PinnedConnection(self.target, self.code)
                self.local.connection = connection
                with self.lock:
                    self.connections.add(connection)
            raw = json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
            if len(raw) > 128*1024:
                raise StreamError('INVALID_TRANSFER')
            connection.timeout = 65 if action == 'execute' else 8
            if connection.sock:
                connection.sock.settimeout(connection.timeout)
            connection.request('POST', '/v2/controller', body=raw, headers={
                'Content-Type': 'application/json', 'Authorization': 'Bearer '+self.token,
                'X-GMSSH-Controller': self.code['controller']['id']})
            response = connection.getresponse()
            data = response.read(24*1024*1024+1)
            if len(data) > 24*1024*1024:
                raise StreamError('INVALID_RESPONSE')
            reply = json.loads(data, object_pairs_hook=_object)
            if not isinstance(reply, dict) or reply.get('ok') is not True or response.status != 200:
                error = reply.get('code') if isinstance(reply, dict) else None
                if action in {'info', 'capabilities'} and response.status in (401, 403):
                    self.authenticated = False
                if error == 'NOT_FOUND':
                    raise FileNotFoundError(errno.ENOENT, 'remote file unavailable')
                if error == 'CONFLICT':
                    raise FileExistsError(errno.EEXIST, 'remote target exists')
                if error == 'SOURCE_DENIED':
                    raise StreamError('SOURCE_DENIED')
                allowed = {'ACCESS_DENIED', 'DISK_FULL', 'CONFLICT', 'IDEMPOTENCY_CONFLICT', 'TASK_LIMIT', 'TASK_RUNNING',
                           'NO_INTERACTIVE_SESSION', 'DESKTOP_WORKER_UNAVAILABLE', 'DESKTOP_OUTCOME_UNKNOWN', 'INVALID_RESPONSE',
                           'DESKTOP_LOCKED', 'AI_PAUSED', 'STALE_TARGET', 'TARGET_NOT_FOUND', 'AMBIGUOUS_TARGET',
                           'UNSUPPORTED_PATTERN', 'FOCUS_DENIED', 'DESKTOP_BUSY', 'INVALID_QUERY', 'QUERY_FAILED', 'PASSWORD_FIELD', 'DESKTOP_QUERY_FAILED',
                           'SESSION_CLOSED', 'OPERATION_TIMEOUT', 'OPERATION_INTERRUPTED', 'OUTCOME_UNKNOWN'}
                raise StreamError('AUTH_FAILED' if action == 'capabilities' and response.status in (401, 403) else error if error in allowed else 'REMOTE_IO')
            result = reply.get('result')
            if not isinstance(result, dict):
                raise StreamError('INVALID_RESPONSE')
            policy = reply.get('permissions', result.get('permissions'))
            if policy is not None:
                try:
                    self.policy = checked_policy(policy)
                except ValueError:
                    raise StreamError('INVALID_RESPONSE') from None
            return result
        except (StreamError, FileNotFoundError, FileExistsError):
            raise
        except ssl.SSLCertVerificationError:
            self.authenticated = False
            self.local.connection = None
            if 'connection' in locals() and connection:
                connection.close()
            raise StreamError('PEER_CHANGED') from None
        except (TimeoutError, socket.timeout):
            self.authenticated = False
            self.local.connection = None
            if 'connection' in locals() and connection:
                connection.close()
            raise StreamError('OPERATION_TIMEOUT') from None
        except Exception:
            self.local.connection = None
            if 'connection' in locals() and connection:
                connection.close()
            raise StreamError('REMOTE_IO') from None

    def open(self, kind):
        self.authorize()  # Reconnects always use the server's current permission set.
        value = self.call('open', kind=kind)
        if not isinstance(value.get('session'), str) or re.fullmatch('[a-f0-9]{32}', value['session']) is None:
            raise StreamError('INVALID_RESPONSE')
        return value['session']

    def close_session(self, session):
        try:
            self.call('close', session)
        except (StreamError, OSError):
            pass

    def info(self, tool, options=None):
        value = self.call('info', args={'tool': tool, 'options': options or {}})
        try:
            raw = base64.b64decode(value['data'], validate=True)
            if len(raw) > 262144:
                raise ValueError()
            return raw
        except (KeyError, ValueError, TypeError):
            raise StreamError('INVALID_RESPONSE') from None

    def close(self):
        self.closed = True
        self.authenticated = False
        self.token = ''
        with self.lock:
            for connection in list(self.connections):
                connection.close()
            self.connections.clear()

    def get_transport(self):
        return self

    def is_active(self):
        return self.authenticated and not self.closed

    is_authenticated = is_active

    def getpeername(self):
        return self.target, self.code['port']

    def get_remote_server_key(self):
        return paramiko.Ed25519Key(data=base64.b64decode(self.code['public']['sshHostPublicKey'].split()[1]))

    def open_sftp(self):
        return ControllerSFTP(self)

    def collect(self, mode):
        if mode not in {'fast', 'slow', 'login'}:
            raise StreamError('INVALID_TRANSFER')
        raw = self.info('metrics-'+mode if mode in ('fast', 'slow') else 'login')
        if mode == 'login':
            raw = b'\n'.join(b'__GMB_LOGIN_USER__='+self.code['public']['username'].encode() if line.startswith(b'__GMB_LOGIN_USER__=') else line for line in raw.splitlines())+b'\n'
        expected = {'fast': b'__GMB_MEM_TOTAL_BYTES__=', 'slow': b'__GMB_OS_NAME__=', 'login': b'__GMB_LOGIN_USER__='}[mode]
        if expected not in raw:
            raise StreamError('INVALID_RESPONSE')
        return raw

    def readonly(self, tool, options):
        return self.info(tool, options)

    def open_channel(self, kind, destination, source, timeout=8):
        if kind != 'direct-tcpip' or destination != ('127.0.0.1', 21118):
            raise StreamError('ACCESS_DENIED')
        return ControllerDesktopSocket(self)

    def open_session(self, timeout=8):
        return ControllerCommand(self)

    def run_command(self, command, timeout=8, stdin=None):
        from .desktop_operations import DRIVE_COMMAND, SYSTEM_COMMAND, POWER_COMMANDS
        if command == DRIVE_COMMAND:
            return self.info('drives')
        if command == SYSTEM_COMMAND:
            return self.info('system')
        if stdin is not None:
            raise StreamError('ACCESS_DENIED')
        power = next((key for key, value in POWER_COMMANDS.items() if value == command), None)
        session = self.open('power' if power else 'terminal')
        try:
            result = self.call('power' if power else 'execute', session, args={'command': power or command, 'timeout': min(60, max(1, int(timeout)))})
            if type(result.get('exit')) is not int or result['exit'] != 0:
                raise StreamError('REMOTE_IO')
            raw = result.get('output')
            if not isinstance(raw, str) or len(raw.encode()) > 262144:
                raise StreamError('INVALID_RESPONSE')
            return raw.encode()
        finally:
            self.close_session(session)


class ControllerCommand:
    """Paramiko channel surface over a server-owned ConPTY or bounded command."""
    def __init__(self, client):
        self.client, self.session = client, None
        self.closed = self.eof_received = False
        self.width, self.height = 80, 24
        self.output = bytearray()
        self.condition = threading.Condition()
        self.status = None
        self.timeout = 8

    def settimeout(self, timeout):
        self.timeout = timeout

    def get_pty(self, term='xterm', width=80, height=24, width_pixels=0, height_pixels=0):
        self.width, self.height = max(1, min(512, width)), max(1, min(512, height))

    def resize_pty(self, width=80, height=24, width_pixels=0, height_pixels=0):
        self.get_pty(width=width, height=height)
        if self.session:
            self.client.call('terminal-resize', self.session, args={'width': self.width, 'height': self.height})

    def exec_command(self, command):
        from .bridge import POWERSHELL_SCRIPT
        if isinstance(command, bytes):
            command = command.decode('utf-8')
        if not isinstance(command, str) or len(command.encode()) > 65536:
            raise StreamError('INVALID_TRANSFER')
        startup = 'powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand '+base64.b64encode(POWERSHELL_SCRIPT.encode('utf-16le')).decode()
        if command == startup:
            self.invoke_shell()
            return
        try:
            output = self.client.run_command(command, self.timeout)
            with self.condition:
                self.output.extend(output)
                self.status, self.eof_received = 0, True
        except Exception:
            with self.condition:
                self.status, self.eof_received = 1, True
            raise

    def invoke_shell(self):
        self.session = self.client.open('terminal')
        try:
            self.client.call('terminal-start', self.session, args={'width': self.width, 'height': self.height})
        except Exception:
            self.client.close_session(self.session)
            self.session = None
            raise
        threading.Thread(target=self.receive, daemon=True).start()

    def receive(self):
        try:
            while not self.closed:
                with self.condition:
                    while len(self.output) >= 1024*1024 and not self.closed:
                        self.condition.wait(.1)
                if self.closed:
                    break
                value = self.client.call('terminal-read', self.session, args={})
                if value.get('waiting') is True:
                    continue
                if value.get('closed') is True:
                    if type(value.get('exit')) is not int:
                        raise StreamError('INVALID_RESPONSE')
                    with self.condition:
                        self.status = value['exit']
                        self.eof_received = True
                    return
                data = base64.b64decode(value['data'], validate=True)
                if len(data) > 8192:
                    raise StreamError('INVALID_RESPONSE')
                with self.condition:
                    self.output.extend(data)
        except Exception:
            with self.condition:
                self.status, self.eof_received = 1, True

    def recv_ready(self):
        with self.condition:
            return bool(self.output)

    def recv(self, size):
        with self.condition:
            data = bytes(self.output[:size])
            del self.output[:size]
            self.condition.notify_all()
            return data

    def recv_stderr_ready(self):
        return False  # A pseudoconsole combines its terminal output streams.

    def recv_stderr(self, size):
        return b''

    def exit_status_ready(self):
        with self.condition:
            return self.status is not None

    def recv_exit_status(self):
        return self.status if self.status is not None else -1

    def sendall(self, data):
        if not self.session or self.closed or not isinstance(data, bytes):
            raise StreamError('ACCESS_DENIED')
        for offset in range(0, len(data), 8192):
            part = data[offset:offset+8192]
            result = self.client.call('terminal-write', self.session, args={'data': base64.b64encode(part).decode()})
            if result.get('written') != len(part):
                raise StreamError('INVALID_RESPONSE')

    def shutdown_write(self):
        self.close()

    def close(self):
        with self.condition:
            if self.closed:
                return
            self.closed = True
            self.condition.notify_all()
        if self.session:
            self.client.close_session(self.session)


class ControllerDesktopSocket:
    """RustDesk framing adapter; only the Windows broker sees its password."""
    def __init__(self, client):
        self.client = client
        self.session = client.open('desktop')
        self.buffer = bytearray()
        self.closed = False

    def settimeout(self, timeout):
        pass  # HTTPS polls have a bounded three-second server wait/eight-second deadline.

    def recv(self, size):
        if self.closed:
            return b''
        if not self.buffer:
            from .desktop import frame_header, MAX_FRAME
            value = self.client.call('desktop-read', self.session)
            if value.get('waiting') is True:
                raise socket.timeout()
            try:
                data = base64.b64decode(value['data'], validate=True)
                if len(data) > MAX_FRAME:
                    raise ValueError()
            except (KeyError, TypeError, ValueError):
                raise StreamError('INVALID_RESPONSE') from None
            self.buffer.extend(frame_header(len(data))+data)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def sendall(self, packet):
        if self.closed or not isinstance(packet, bytes) or not packet:
            raise StreamError('INVALID_TRANSFER')
        width = (packet[0] & 3)+1
        size = int.from_bytes(packet[:width], 'little') >> 2
        if size > 16384 or len(packet) != size+width:
            raise StreamError('INVALID_TRANSFER')
        result = self.client.call('desktop-write', self.session, args={'data': base64.b64encode(packet[width:]).decode()})
        if result.get('written') is not True:
            raise StreamError('INVALID_RESPONSE')

    def close(self):
        if not self.closed:
            self.closed = True
            self.client.close_session(self.session)
            self.buffer.clear()


class ControllerSFTP:
    def __init__(self, client):
        self.client = client
        self.session = client.open('files')

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def request(self, action, **args):
        return self.client.call(action, self.session, args=args)

    @staticmethod
    def attributes(value, filename=None):
        if (not isinstance(value, dict) or type(value.get('size')) is not int or not 0 <= value['size'] <= 1024**4
                or type(value.get('modified')) is not int or value['modified'] < 0 or value.get('mode') not in (stat.S_IFDIR, stat.S_IFREG)):
            raise StreamError('INVALID_RESPONSE')
        info = paramiko.SFTPAttributes()
        info.st_mode, info.st_size, info.st_mtime = value['mode'], value['size'], value['modified']
        if filename is not None:
            from .desktop_operations import validate_name
            info.filename = validate_name(filename)
        return info

    def lstat(self, path):
        value = self.request('fs-stat', path=path)
        if value.get('missing') is True:
            raise FileNotFoundError(errno.ENOENT, 'remote file unavailable')
        return self.attributes(value)

    stat = lstat

    def listing(self, path):
        result = self.request('fs-list', path=path)
        rows = result.get('entries')
        if not isinstance(rows, list) or len(rows) > 2000 or type(result.get('truncated')) is not bool:
            raise StreamError('INVALID_RESPONSE')
        entries = []
        for row in rows:
            info = self.attributes(row, row.get('name'))
            entries.append({'name': info.filename, 'directory': stat.S_ISDIR(info.st_mode), 'size': info.st_size, 'modified': info.st_mtime})
        return {'path': path, 'entries': entries, 'truncated': result['truncated']}

    def listdir_iter(self, path, read_aheads=1):
        result = self.request('fs-list', path=path)
        rows = result.get('entries')
        if not isinstance(rows, list) or len(rows) > 2000:
            raise StreamError('INVALID_RESPONSE')
        if result.get('truncated'):
            raise StreamError('TRANSFER_LIMIT')
        for value in rows:
            yield self.attributes(value, value.get('name'))

    listdir_attr = lambda self, path: list(self.listdir_iter(path))

    def open(self, path, mode='rb', bufsize=-1):
        value = self.request('fs-open', path=path, mode=mode)
        if not isinstance(value.get('handle'), str) or re.fullmatch('[a-f0-9]{32}', value['handle']) is None:
            raise StreamError('INVALID_RESPONSE')
        return ControllerFile(self, value['handle'])

    def mkdir(self, path):
        self.request('fs-mkdir', path=path)

    def remove(self, path):
        self.request('fs-remove', path=path)

    def rename(self, source, target):
        self.request('fs-rename', path=source, target=target)

    def close(self):
        self.client.close_session(self.session)


class ControllerFile:
    def __init__(self, sftp, handle):
        self.sftp, self.handle, self.offset = sftp, handle, 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def seek(self, offset, whence=0):
        if whence != 0 or type(offset) is not int or not 0 <= offset <= 1024**4:
            raise StreamError('INVALID_TRANSFER')
        self.offset = offset

    def flush(self):
        pass  # Each acknowledged server write already calls File.Sync().

    def tell(self):
        return self.offset

    def read(self, size=CHUNK):
        if type(size) is not int or size < 0:
            raise StreamError('TRANSFER_LIMIT')
        reply = self.sftp.request('file-read', handle=self.handle, offset=self.offset, length=min(size, CHUNK))
        try:
            data = base64.b64decode(reply['data'], validate=True)
        except (KeyError, ValueError, TypeError):
            raise StreamError('INVALID_RESPONSE') from None
        if len(data) > min(size, CHUNK):
            raise StreamError('INVALID_RESPONSE')
        self.offset += len(data)
        return data

    def write(self, data):
        offset = 0
        while offset < len(data):
            part = data[offset:offset+CHUNK]
            reply = self.sftp.request('file-write', handle=self.handle, offset=self.offset, data=base64.b64encode(part).decode())
            if reply.get('written') != len(part):
                raise StreamError('REMOTE_IO')
            self.offset += len(part)
            offset += len(part)
        return len(data)

    def close(self):
        if self.handle:
            try:
                self.sftp.request('file-close', handle=self.handle)
            finally:
                self.handle = None
