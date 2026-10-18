"""Opt-in CLI and shared AI operations. No discovery of private GMSSH credentials."""
import argparse
import base64
from contextlib import contextmanager
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import uuid

import paramiko

from . import __version__, ai_files, readonly_tools
from .address import normalize_address, ssh_endpoint
from .controller_access import ControllerClient, configuration, inspect_authorization, metadata_connection
from .file_stream import StreamError
from .pairing import _object, choose_target, inspect_connection

PERMISSIONS = {'inspect', 'terminal', 'files', 'view', 'input'}
SCHEMA = {'type': 'object', 'required': ['schema', 'ok', 'tool', 'sampledAt'],
          'properties': {'schema': {'type': 'integer'}, 'ok': {'type': 'boolean'}, 'tool': {'type': 'string'},
                         'sampledAt': {'type': 'string'}, 'device': {'type': ['string', 'null']},
                         'result': {'type': 'object'}, 'error': {'type': 'object'}}}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def default_root():
    if sys.platform == 'darwin':
        return Path.home()/'Library'/'Application Support'/'gmssh-windows-bridge'/'ai'
    return Path.home()/'.gmssh-windows-bridge'/'ai'


def bounded_text(value, maximum=32768):
    if not isinstance(value, str) or len(value.encode('utf-8')) > maximum or '\x00' in value:
        raise StreamError('INVALID_ARGUMENT')
    return value


def identifier(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{32}', value) is None:
        raise StreamError('INVALID_ARGUMENT')
    return value


def private_json(file, maximum=1024*1024):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > maximum or os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise StreamError('CONFIG_UNSAFE')
    return json.loads(file.read_text(encoding='utf-8'), object_pairs_hook=_object)


class Registry:
    def __init__(self, root):
        self.root = Path(root).absolute()

    def prepare(self):
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = self.root.lstat()
        if not stat.S_ISDIR(info.st_mode) or os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise StreamError('CONFIG_UNSAFE')

    def devices(self):
        if not self.root.exists():
            return []
        self.prepare()
        try:
            value = private_json(self.root/'ai-devices.json')
        except FileNotFoundError:
            return []
        if not isinstance(value, dict) or set(value) != {'schema', 'devices'} or type(value['schema']) is not int or value['schema'] != 1 or not isinstance(value['devices'], list) or len(value['devices']) > 50:
            raise StreamError('CONFIG_UNSAFE')
        seen = set()
        for item in value['devices']:
            if not isinstance(item, dict) or set(item) != {'id', 'name', 'connection', 'target', 'allow', 'credential'}:
                raise StreamError('CONFIG_UNSAFE')
            identifier(item['id'])
            bounded_text(item['name'], 128)
            connection = inspect_connection(json.dumps(item['connection']))
            if connection['id'] != item['id'] or item['id'] in seen or item['target'] is not None and item['target'] not in connection['addresses']:
                raise StreamError('CONFIG_UNSAFE')
            allowed, credential = item['allow'], item['credential']
            if not isinstance(allowed, list) or any(not isinstance(v, str) for v in allowed) or not set(allowed) <= PERMISSIONS or 'input' in allowed and 'view' not in allowed:
                raise StreamError('CONFIG_UNSAFE')
            if not isinstance(credential, dict) or set(credential) != {'kind', 'reference'}:
                raise StreamError('CONFIG_UNSAFE')
            if credential['kind'] == 'env':
                if not isinstance(credential['reference'], str) or not re.fullmatch('[A-Z][A-Z0-9_]{0,79}', credential['reference']):
                    raise StreamError('CONFIG_UNSAFE')
            elif credential != {'kind': 'keychain', 'reference': 'ai:'+item['id']}:
                raise StreamError('CONFIG_UNSAFE')
            seen.add(item['id'])
        return value['devices']

    @contextmanager
    def lock(self):
        self.prepare()
        flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
        with os.fdopen(os.open(self.root/'registry.lock', flags, 0o600), 'a+b') as file:
            if os.name != 'nt':
                import fcntl
                fcntl.flock(file.fileno(), fcntl.LOCK_EX)
            else:
                import msvcrt
                file.write(b'0'); file.flush(); file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_LOCK, 1)
            try:
                yield
            finally:
                if os.name != 'nt':
                    fcntl.flock(file.fileno(), fcntl.LOCK_UN)
                else:
                    file.seek(0); msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)

    def enroll(self, text, name, allow, env=None, password=None, target=None):
        bounded_text(name, 128)
        if not name.strip() or not set(allow) <= PERMISSIONS or 'input' in allow and 'view' not in allow:
            raise StreamError('INVALID_ARGUMENT')
        if text.strip().startswith('GMSSH-AUTH2.'):
            code = inspect_authorization(text)
            raw = json.loads(metadata_connection(code))
            secret = code['controller']['token']
        else:
            raw = json.loads(text, object_pairs_hook=_object)
            inspect_connection(text)
            secret = password
        connection = inspect_connection(json.dumps(raw))
        if target is not None:
            target = normalize_address(target)
            if target not in connection['addresses']:
                raise StreamError('INVALID_ARGUMENT')
        device_id = connection['id']
        reference = {'kind': 'env', 'reference': env} if env else {'kind': 'keychain', 'reference': 'ai:'+device_id}
        if env and re.fullmatch('[A-Z][A-Z0-9_]{0,79}', env) is None:
            raise StreamError('INVALID_ARGUMENT')
        if not env and sys.platform != 'darwin':
            raise StreamError('KEYCHAIN_UNAVAILABLE')
        with self.lock():
            devices = self.devices()
            if any(item['id'] == device_id for item in devices):
                raise StreamError('DEVICE_EXISTS')
            if len(devices) >= 50:
                raise StreamError('DEVICE_LIMIT')
            if not env:
                if not secret:
                    raise StreamError('CREDENTIAL_REQUIRED')
                from .keychain import DesktopKeychain
                DesktopKeychain('ai:'+device_id).save(secret)
            device = {'id': device_id, 'name': name, 'connection': raw, 'target': target,
                      'allow': sorted(set(allow)), 'credential': reference}
            devices.append(device)
            self.save(devices)
        return self.public(device)

    def save(self, devices):
        file = self.root/'ai-devices.json'
        if file.is_symlink():
            raise StreamError('CONFIG_UNSAFE')
        fd, temporary = tempfile.mkstemp(prefix='.ai-devices-', dir=self.root)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as target:
                json.dump({'schema': 1, 'devices': devices}, target, ensure_ascii=False)
                target.flush(); os.fsync(target.fileno())
            os.replace(temporary, file)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def configure(self, device_id, allow):
        identifier(device_id)
        if not set(allow) <= PERMISSIONS or 'input' in allow and 'view' not in allow:
            raise StreamError('INVALID_ARGUMENT')
        with self.lock():
            devices = self.devices()
            device = next((v for v in devices if v['id'] == device_id), None)
            if device is None:
                raise StreamError('DEVICE_NOT_ENABLED')
            device['allow'] = sorted(set(allow))
            self.save(devices)
            return self.public(device)

    @staticmethod
    def public(device):
        connection = device['connection']
        return {'id': device['id'], 'name': device['name'], 'computer': connection['computer'],
                'addresses': connection['addresses'], 'mode': 'fixed' if device['target'] else 'auto',
                'allow': device['allow'], 'transport': 'controller' if connection.get('authorization') else 'ssh'}

    def credential(self, device):
        reference = device['credential']
        if reference['kind'] == 'env':
            secret = os.environ.get(reference['reference'])
        else:
            if sys.platform != 'darwin':
                raise StreamError('KEYCHAIN_UNAVAILABLE')
            from .keychain import DesktopKeychain
            secret = DesktopKeychain(reference['reference']).get()
        if not isinstance(secret, str) or not 1 <= len(secret.encode()) <= 4096:
            raise StreamError('CREDENTIAL_REQUIRED')
        return secret


def powershell(script):
    bounded_text(script)
    prefix = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode((prefix+script).encode('utf-16le')).decode()


def ssh_run(client, script, timeout):
    channel = client.get_transport().open_session(timeout=5)
    output, errors = bytearray(), bytearray()
    deadline = time.monotonic()+timeout
    result = {'stdout': '', 'stderr': '', 'exitCode': None, 'truncated': False, 'state': 'completed', 'code': 'OK', 'combinedOutput': False}
    try:
        bootstrap = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))"
        channel.exec_command(powershell(bootstrap))
        channel.sendall(script.encode('utf-8'))
        channel.shutdown_write()
        while True:
            for ready, recv, buffer in ((channel.recv_ready, channel.recv, output), (channel.recv_stderr_ready, channel.recv_stderr, errors)):
                if ready():
                    raw = recv(8192)
                    remaining = 262144-len(output)-len(errors)
                    buffer.extend(raw[:remaining])
                    if len(raw) > remaining:
                        result.update(state='failed', code='OUTPUT_LIMIT', truncated=True)
                        return result
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                result['exitCode'] = channel.recv_exit_status()
                if result['exitCode'] != 0:
                    result.update(state='failed', code='EXIT_NONZERO')
                return result
            if time.monotonic() >= deadline:
                result.update(state='interrupted', code='OUTCOME_UNKNOWN')
                return result
            time.sleep(.01)
    finally:
        channel.close()
        result.update(stdout=output.decode('utf-8', 'replace'), stderr=errors.decode('utf-8', 'replace'))


@contextmanager
def connect_device(registry, device):
    connection = inspect_connection(json.dumps(device['connection']))
    # Shared route selection verifies identity before retrieving or sending a secret.
    target = device['target'] or choose_target(connection)['target']
    secret = registry.credential(device)
    client = None
    try:
        if connection.get('authorization'):
            client = ControllerClient(target, configuration(connection), token=secret)
            client.ai_capabilities = client.authorize()
        else:
            client = paramiko.SSHClient()
            key = paramiko.Ed25519Key(data=base64.b64decode(connection['sshHostPublicKey'].split()[1]))
            client.get_host_keys().add(ssh_endpoint(target, connection['sshPort']), 'ssh-ed25519', key)
            client.connect(target, port=connection['sshPort'], username=connection['username'], password=secret,
                           allow_agent=False, look_for_keys=False, timeout=5, auth_timeout=5, banner_timeout=5)
        secret = None
        yield client
    finally:
        secret = None
        if client is not None:
            client.close()


def specification(name, description, fields=None, required=(), permission=None, mutates=False):
    properties = dict(fields or {})
    if permission:
        properties = {'device': {'type': 'string', 'pattern': '^[0-9a-f]{32}$'}, **properties}
        required = ('device', *required)
    return {'name': name, 'description': description,
            'inputSchema': {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False},
            'outputSchema': SCHEMA, 'permission': permission, 'mutates': mutates}


TEXT = {'type': 'string', 'maxLength': 32768}
PATH = {'type': 'string', 'minLength': 3, 'maxLength': 1024}
HASH = {'type': 'string', 'pattern': '^[0-9a-f]{64}$'}
ID = {'type': 'string', 'pattern': '^[0-9a-f]{32}$'}
SELECTOR = {'window': {'type': 'string', 'pattern': '^[1-9][0-9]{0,18}$'},
            'name': {'type': 'string', 'maxLength': 256}, 'automationId': {'type': 'string', 'maxLength': 256},
            'controlType': {'type': 'string', 'maxLength': 64}}
TOOLS = [
    specification('devices_list', 'List only explicitly enrolled AI devices. Never connects or retrieves credentials.'),
    specification('device_context', 'Read OS, user session, shell/tool availability, disks and effective AI capabilities.', permission='inspect'),
    specification('system_query', 'Bounded read-only process, service or Windows event query.',
                  {'tool': {'enum': ['processes', 'services', 'logs', 'log-detail']}, 'options': {'type': 'object'}}, ('tool', 'options'), 'inspect'),
    specification('powershell_run', 'Execute arbitrary PowerShell as the managed account. Controller: durable task with idempotency key. SSH: synchronous <=60 seconds. Not read-only.',
                  {'script': TEXT, 'timeout': {'type': 'integer', 'minimum': 1, 'maximum': 3600}, 'requestKey': ID}, ('script',), 'terminal', True),
    *[specification(name, description, {'taskId': ID, 'offset': {'type': 'integer', 'minimum': 0, 'maximum': 262144}}, ('taskId',), 'terminal', name != 'task_get')
      for name, description in [('task_get', 'Read a controller task after reconnect; output offsets count UTF-8 bytes.'),
                                ('task_cancel', 'Request cancellation of a running command. Does not undo its effects.'),
                                ('task_forget', 'Delete the retained result of a finished task owned by this authorization.')]],
    specification('desktop_observe', 'List windows; with window handle, return a bounded UIA control tree and 30-second target handles.',
                  {'window': SELECTOR['window']}, permission='view'),
    specification('desktop_find', 'Find UIA controls by exact name, automationId or controlType within one observed window. Multiple matches remain explicit.',
                  SELECTOR, ('window',), 'view'),
    specification('desktop_screenshot', 'Capture the unlocked interactive desktop, resized to <=1600x1000. Image may contain visible private content.', permission='view'),
    specification('desktop_act', 'Act on one fresh observed target. Invoke/set-value use UIA; click/type-text/key require foreground focus. Observe again to verify.',
                  {'snapshot': ID, 'target': ID, 'action': {'enum': ['invoke', 'set-value', 'click', 'type-text', 'key']},
                   'text': {'type': 'string', 'maxLength': 4096}, 'key': {'type': 'string', 'maxLength': 16}}, ('snapshot', 'target', 'action'), 'input', True),
    specification('wait_for', 'Wait for a UI selector, service state, or file hash. A query failure is never treated as disappearance.',
                  {'condition': {'enum': ['ui_exists', 'ui_absent', 'service_state', 'file_sha256']}, 'timeout': {'type': 'integer', 'minimum': 1, 'maximum': 60},
                   **SELECTOR, 'service': {'type': 'string', 'maxLength': 64}, 'state': {'enum': ['Running', 'Stopped', 'Paused']}, 'path': PATH, 'sha256': HASH}, ('condition',), 'dynamic'),
    specification('files_search', 'List/search file names under an explicit Windows directory. <=200 rows, 2000 entries, depth 4; no symlink traversal.',
                  {'path': PATH, 'query': {'type': 'string', 'maxLength': 128}, 'recursive': {'type': 'boolean'}}, ('path',), 'files'),
    specification('files_read', 'Read a UTF-8 text file <=1 MiB in bounded line ranges, with full-file SHA-256.',
                  {'path': PATH, 'startLine': {'type': 'integer', 'minimum': 1}, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 200}}, ('path',), 'files'),
    *[specification(name, description, {'path': PATH, 'content': {'type': 'string', 'maxLength': 1048576}, 'expectedSha256': HASH}, ('path', 'content', 'expectedSha256'), 'files', name == 'files_apply')
      for name, description in [('files_preview', 'Preview an exact-content text edit against the expected file hash.'),
                                ('files_apply', 'Apply a verified text edit; retain original in a unique sibling backup; never overwrite a competing destination.')]],
    specification('files_restore', 'Restore a retained sibling AI backup against the current file hash. Creates a new backup before restoring.',
                  {'path': PATH, 'backup': PATH, 'backupSha256': HASH, 'expectedSha256': HASH}, ('path', 'backup', 'backupSha256', 'expectedSha256'), 'files', True),
]
TOOL_MAP = {v['name']: v for v in TOOLS}


def validate_arguments(schema, arguments):
    # Same small, closed schemas are consumed by the CLI and the official MCP SDK.
    if not isinstance(arguments, dict) or set(arguments)-set(schema['properties']) or set(schema['required'])-set(arguments):
        raise StreamError('INVALID_ARGUMENT')
    for name, value in arguments.items():
        rule = schema['properties'][name]
        kind = rule.get('type')
        if kind == 'string':
            bounded_text(value, 4*rule.get('maxLength', 32768))
            if len(value) < rule.get('minLength', 0) or len(value) > rule.get('maxLength', 32768) or 'pattern' in rule and re.fullmatch(rule['pattern'], value) is None:
                raise StreamError('INVALID_ARGUMENT')
        elif kind == 'integer':
            if type(value) is not int or value < rule.get('minimum', -2**53) or value > rule.get('maximum', 2**53):
                raise StreamError('INVALID_ARGUMENT')
        elif kind == 'boolean' and type(value) is not bool or kind == 'object' and not isinstance(value, dict):
            raise StreamError('INVALID_ARGUMENT')
        if 'enum' in rule and value not in rule['enum']:
            raise StreamError('INVALID_ARGUMENT')


class Operations:
    def __init__(self, registry, connector=connect_device):
        self.registry, self.connector = registry, connector

    def device(self, device_id, permission):
        identifier(device_id)
        device = next((v for v in self.registry.devices() if v['id'] == device_id), None)
        if device is None:
            raise StreamError('DEVICE_NOT_ENABLED')
        if permission and permission not in device['allow']:
            raise StreamError('ACCESS_DENIED')
        return device

    @staticmethod
    def require_controller(client):
        if getattr(client, 'controller_protocol', None) != 2 or client.ai_capabilities.get('aiProtocol') != 1:
            raise StreamError('SERVER_UPGRADE_REQUIRED')

    def call(self, name, arguments):
        reply = {'schema': 1, 'ok': False, 'tool': name, 'sampledAt': now(), 'device': arguments.get('device') if isinstance(arguments, dict) else None}
        try:
            tool = TOOL_MAP.get(name)
            if tool is None:
                raise StreamError('UNKNOWN_TOOL')
            validate_arguments(tool['inputSchema'], arguments)
            if name == 'devices_list':
                result = {'devices': [self.registry.public(v) for v in self.registry.devices()], 'version': __version__}
            else:
                permission = tool['permission']
                if name == 'wait_for':
                    permission = {'ui_exists': 'view', 'ui_absent': 'view', 'service_state': 'inspect', 'file_sha256': 'files'}[arguments['condition']]
                device = self.device(arguments['device'], permission)
                if name == 'desktop_act' and 'view' not in device['allow']:
                    raise StreamError('ACCESS_DENIED')
                with self.connector(self.registry, device) as client:
                    result = self.execute(client, device, name, arguments)
            reply.update(ok=True, result=result)
        except Exception as error:
            code = error.code if isinstance(error, StreamError) else 'AUTH_FAILED' if isinstance(error, paramiko.AuthenticationException) else 'PEER_CHANGED' if isinstance(error, paramiko.BadHostKeyException) else 'NOT_FOUND' if isinstance(error, FileNotFoundError) else 'ACCESS_DENIED' if isinstance(error, PermissionError) else 'INVALID_ARGUMENT' if isinstance(error, (ValueError, TypeError, KeyError, UnicodeError)) else 'CONNECTION_FAILED'
            reply['error'] = {'code': code, 'message': error_message(code)}
            if isinstance(error, StreamError) and hasattr(error, 'recovery'):
                reply['error']['recovery'] = error.recovery
        return reply

    def execute(self, client, device, name, args):
        controller = getattr(client, 'controller_protocol', None) == 2
        if name == 'device_context':
            if controller:
                if client.ai_capabilities.get('aiProtocol') == 1:
                    context = json.loads(client.info('ai-context').decode('utf-8-sig'))
                else:
                    context = {'state': 'unsupported', 'code': 'SERVER_UPGRADE_REQUIRED'}
            else:
                result = ssh_run(client, Path(__file__).with_name('ai-context.ps1').read_text(encoding='utf-8-sig'), 10)
                if result['exitCode'] != 0:
                    raise StreamError('QUERY_FAILED')
                context = json.loads(result['stdout'].lstrip('\ufeff'))
            context['scope'] = 'broker' if controller else 'ssh-account'
            ui = {'state': 'unsupported', 'code': 'SERVER_UPGRADE_REQUIRED'} if 'view' in device['allow'] else {'state': 'disabled', 'code': 'ACCESS_DENIED'}
            if 'view' in device['allow'] and controller and client.ai_capabilities.get('aiProtocol') == 1:
                try:
                    ui = {'state': 'available', **client.call('ai-desktop', args={'operation': 'context'})}
                except StreamError as error:
                    ui = {'state': 'unavailable', 'code': error.code}
            return {'device': self.registry.public(device), 'environment': context, 'desktop': ui,
                    'commandAccount': device['connection']['username'],
                    'permissions': dict(client.policy) if controller else {'accountPermissions': True},
                    'durableTasks': controller and client.ai_capabilities.get('aiProtocol') == 1}
        if name == 'system_query':
            from .desktop_operations import run_command
            return readonly_tools.query(client, args['tool'], args['options'], 10, run_command)
        if name == 'powershell_run':
            bounded_text(args['script'])
            if not controller:
                if args.get('timeout', 60) > 60:
                    raise StreamError('SERVER_UPGRADE_REQUIRED')
                return ssh_run(client, args['script'], args.get('timeout', 60))
            self.require_controller(client)
            request_key = args.get('requestKey', uuid.uuid4().hex)
            try:
                return {**client.call('ai-task-start', args={'command': args['script'], 'timeout': args.get('timeout', 60), 'key': request_key}), 'requestKey': request_key}
            except StreamError as error:
                # A lost start response must not cause a second execution.
                error.recovery = {'requestKey': request_key, 'retryWithSameKey': True}
                raise
        if name.startswith('task_'):
            self.require_controller(client)
            return client.call('ai-'+name.replace('_', '-'), args={'taskId': args['taskId'], 'offset': args.get('offset', 0)})
        if name.startswith('desktop_'):
            self.require_controller(client)
            request = {key: value for key, value in args.items() if key != 'device'}
            request['operation'] = request.pop('action') if name == 'desktop_act' else name.removeprefix('desktop_')
            return client.call('ai-desktop', args=request)
        if name == 'wait_for':
            return self.wait_for(client, device, args)
        with client.open_sftp() as sftp:
            if name == 'files_search':
                return ai_files.search(sftp, args['path'], args.get('query', ''), args.get('recursive', False))
            if name == 'files_read':
                return ai_files.read(sftp, args['path'], args.get('startLine', 1), args.get('limit', 100))
            if name in {'files_preview', 'files_apply'}:
                return (ai_files.preview if name == 'files_preview' else ai_files.apply)(sftp, args['path'], args['content'], args['expectedSha256'])
            if name == 'files_restore':
                path, backup = ai_files.remote_path(args['path']), ai_files.remote_path(args['backup'])
                if os.path.dirname(path) != os.path.dirname(backup) or re.fullmatch(r'\.gmssh-ai-[a-f0-9]{32}\.bak', os.path.basename(backup)) is None:
                    raise StreamError('INVALID_ARGUMENT')
                raw = ai_files.read_bytes(sftp, backup)
                if ai_files.digest(raw) != args['backupSha256']:
                    raise StreamError('SOURCE_CHANGED')
                return ai_files.apply(sftp, path, raw.decode('utf-8'), args['expectedSha256'])
        raise StreamError('UNKNOWN_TOOL')

    def wait_for(self, client, device, args):
        condition = args['condition']
        required = {'ui_exists': {'window'}, 'ui_absent': {'window'}, 'service_state': {'service', 'state'}, 'file_sha256': {'path', 'sha256'}}[condition]
        if not required <= set(args) or condition.startswith('ui_') and not set(args) & {'name', 'automationId', 'controlType'}:
            raise StreamError('INVALID_ARGUMENT')
        deadline = time.monotonic()+args.get('timeout', 15)
        last = {}
        while True:
            if condition.startswith('ui_'):
                try:
                    last = self.execute(client, device, 'desktop_find', {key: value for key, value in args.items() if key in SELECTOR or key == 'device'})
                except StreamError as error:
                    if condition != 'ui_absent' or error.code != 'TARGET_NOT_FOUND':
                        raise
                    return {'matched': True, 'condition': condition, 'observation': {'windowMissing': True}}
                if last.get('truncated'):
                    raise StreamError('QUERY_TRUNCATED')
                found = bool(last.get('nodes'))
                passed = found if condition == 'ui_exists' else not found
            elif condition == 'service_state':
                last = self.execute(client, device, 'system_query', {'tool': 'services', 'options': {'limit': 200, 'search': args['service'], 'sort': 'name'}})
                if last.get('state') != 'passed' or last.get('truncated'):
                    raise StreamError('QUERY_FAILED')
                passed = any(v['name'].casefold() == args['service'].casefold() and v['state'] == args['state'] for v in last['items'])
            else:
                try:
                    with client.open_sftp() as sftp:
                        actual = ai_files.digest(ai_files.read_bytes(sftp, args['path']))
                    last = {'path': args['path'], 'sha256': actual}
                    passed = actual == args['sha256']
                except FileNotFoundError:
                    last, passed = {'state': 'missing'}, False
            if passed:
                return {'matched': True, 'condition': condition, 'observation': last}
            if time.monotonic() >= deadline:
                return {'matched': False, 'condition': condition, 'code': 'TIMEOUT', 'observation': last}
            time.sleep(min(.5, max(0, deadline-time.monotonic())))


def error_message(code):
    return {'DEVICE_NOT_ENABLED': '该设备未启用 AI 接入。', 'ACCESS_DENIED': '当前本机或服务端授权不允许此操作。',
            'CREDENTIAL_REQUIRED': '请由用户在 CLI 接入流程设置凭据；无需向 AI 提供密码。',
            'SERVER_UPGRADE_REQUIRED': '该能力需要新版 Windows 服务端与独立授权；不会自动升级设备。',
            'CONFIG_UNSAFE': 'AI 配置文件格式、所有者或访问权限不符合要求。',
            'STALE_TARGET': '目标已变化或观察已过期，请重新观察后决定下一步。',
            'DESKTOP_OUTCOME_UNKNOWN': '桌面响应中断，操作结果未知；请重新观察，不要直接重试操作。',
            'EDIT_RECOVERY_REQUIRED': '保存未完成，原文件备份已保留，请先核对恢复路径。',
            'AI_PAUSED': '用户已从 Windows 托盘暂停 AI 桌面控制。',
            'DESKTOP_LOCKED': 'Windows 当前未提供可操作的已解锁桌面。',
            'SOURCE_CHANGED': '文件与预览时不一致，请重新读取并生成修改预览。'}.get(code, code)


def main(argv=None):
    parser = argparse.ArgumentParser(description='GMSSH opt-in AI CLI; JSON results, pinned peers and existing permissions.')
    parser.add_argument('--root', type=Path, default=default_root(), help='Private AI configuration directory')
    parser.add_argument('--version', action='version', version=__version__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('devices', help='List enrolled devices without connecting')
    enroll = commands.add_parser('enroll', help='User-operated enrollment; never pass a credential in command arguments')
    source = enroll.add_mutually_exclusive_group(required=True)
    source.add_argument('--authorization-stdin', action='store_true')
    source.add_argument('--connection', type=Path)
    enroll.add_argument('--name', required=True)
    enroll.add_argument('--allow', nargs='+', choices=sorted(PERMISSIONS), default=['inspect'])
    enroll.add_argument('--credential-env', help='Reference an environment variable instead of macOS Keychain')
    enroll.add_argument('--target', help='Optional fixed address; default uses supplied pinned addresses automatically')
    configure = commands.add_parser('configure', help='Change only this local AI device allowlist')
    configure.add_argument('device'); configure.add_argument('--allow', nargs='*', choices=sorted(PERMISSIONS), required=True)
    call = commands.add_parser('call', help='Call any listed AI tool with one JSON object')
    call.add_argument('tool', choices=sorted(TOOL_MAP)); call.add_argument('--arguments', default='-', help='JSON or - for stdin')
    context = commands.add_parser('context'); context.add_argument('device')
    run = commands.add_parser('run'); run.add_argument('device')
    run.add_argument('--script-file', type=Path, help='UTF-8 script; stdin when omitted')
    run.add_argument('--timeout', type=int, default=60); run.add_argument('--request-key')
    for name in ('task', 'cancel', 'forget'):
        sub = commands.add_parser(name); sub.add_argument('device'); sub.add_argument('task_id'); sub.add_argument('--offset', type=int, default=0)
    commands.add_parser('tools', help='Print shared tool schemas')
    commands.add_parser('mcp', help='Run official MCP SDK over stdio; no TCP listener')
    commands.add_parser('mcp-config', help='Print a portable MCP client configuration; never edits client settings')
    args = parser.parse_args(argv)
    registry = Registry(args.root)
    try:
        if args.command == 'mcp':
            from .ai_mcp import main as serve
            return serve(registry)
        if args.command == 'mcp-config':
            result = {'mcpServers': {'gmssh': {'command': sys.executable, 'args': ['-m', 'gmssh_windows_bridge.ai', '--root', str(registry.root), 'mcp']}}}
        elif args.command == 'tools':
            result = {'tools': [{k: v for k, v in tool.items() if k not in {'permission', 'mutates'}} for tool in TOOLS]}
        elif args.command == 'enroll':
            if args.authorization_stdin:
                raw = sys.stdin.buffer.read(65537)
            else:
                with args.connection.open('rb') as source:
                    raw = source.read(65537)
            if len(raw) > 65536:
                raise StreamError('INVALID_ARGUMENT')
            password = getpass.getpass('现有连接密码（仅存本机钥匙串）：') if args.connection and not args.credential_env else None
            result = registry.enroll(raw.decode('utf-8-sig'), args.name, args.allow, args.credential_env, password, args.target)
        elif args.command == 'configure':
            result = registry.configure(args.device, args.allow)
        else:
            tool, values = 'devices_list', {}
            if args.command == 'call':
                raw = sys.stdin.buffer.read(1200001) if args.arguments == '-' else args.arguments.encode()
                if len(raw) > 1200000:
                    raise StreamError('INVALID_ARGUMENT')
                tool, values = args.tool, json.loads(raw, object_pairs_hook=_object)
            elif args.command == 'context':
                tool, values = 'device_context', {'device': args.device}
            elif args.command == 'run':
                if args.script_file:
                    with args.script_file.open('rb') as source:
                        raw = source.read(32769)
                else:
                    raw = sys.stdin.buffer.read(32769)
                if len(raw) > 32768:
                    raise StreamError('INVALID_ARGUMENT')
                tool, values = 'powershell_run', {'device': args.device, 'script': raw.decode('utf-8-sig'), 'timeout': args.timeout}
                if args.request_key:
                    values['requestKey'] = args.request_key
            elif args.command in {'task', 'cancel', 'forget'}:
                tool = {'task': 'task_get', 'cancel': 'task_cancel', 'forget': 'task_forget'}[args.command]
                values = {'device': args.device, 'taskId': args.task_id, 'offset': args.offset}
            result = Operations(registry).call(tool, values)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 1 if result.get('ok') is False else 0
    except ImportError:
        result = {'ok': False, 'error': {'code': 'AI_DEPENDENCY_REQUIRED', 'message': '请安装 gmssh-windows-bridge[ai]。'}}
    except Exception as error:
        code = error.code if isinstance(error, StreamError) else 'INVALID_ARGUMENT'
        result = {'ok': False, 'error': {'code': code, 'message': error_message(code)}}
    print(json.dumps(result, ensure_ascii=False), file=sys.stderr if args.command == 'mcp' else sys.stdout)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
