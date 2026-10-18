"""Pinned SFTP for native Linux devices, including their saved bastion chain.

Credentials arrive on the worker's stdin, never on a command line or in a journal.
Key exchange precedes authentication; an unknown key is returned for confirmation.
"""
import base64
import hashlib
import io
import re
import stat
from types import SimpleNamespace

import paramiko

from .file_stream import FileStream, StreamError, CHUNK


def fingerprint(key):
    return 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')


def posix_name(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 255 or value in {'.', '..'}
            or '/' in value or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise StreamError('INVALID_NAME')
    return value


def posix_path(value):
    if not isinstance(value, str) or not value.startswith('/') or len(value) > 1024:
        raise StreamError('INVALID_PATH')
    return '/' + '/'.join(posix_name(part) for part in value.split('/') if part)


def chain(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        raise StreamError('INVALID_DEVICE')
    for item in value:
        if (not isinstance(item, dict) or set(item) - {'host', 'port', 'username', 'authType', 'authValue', 'keyPass', 'peer', 'timeout'}
                or not isinstance(item.get('host'), str) or not 1 <= len(item['host']) <= 253
                or any(c.isspace() or c in '/\\\x00' for c in item['host'])
                or type(item.get('port')) is not int or not 1 <= item['port'] <= 65535
                or not isinstance(item.get('username'), str) or not 1 <= len(item['username']) <= 128
                or any(ord(c) < 32 for c in item['username']) or item.get('authType') not in {'pass', 'ca'}
                or not isinstance(item.get('authValue'), str) or not 1 <= len(item['authValue']) <= 262144
                or not isinstance(item.get('keyPass', ''), str) or len(item.get('keyPass', '')) > 1024
                or item.get('peer') is not None and (not isinstance(item['peer'], str) or re.fullmatch(r'SHA256:[A-Za-z0-9+/]{43}', item['peer']) is None)
                or type(item.get('timeout', 15)) is not int or not 3 <= item.get('timeout', 15) <= 60):
            raise StreamError('INVALID_DEVICE')
    return value


class LinuxPeer:
    def __init__(self, value, inspect=False):
        self.transports = []
        self.stream = None
        self.binary = None
        self.trust = None
        try:
            previous = None
            for index, item in enumerate(chain(value['ssh'])):
                timeout = item.get('timeout', 15)
                endpoint = (item['host'], item['port'])
                sock = previous.open_channel('direct-tcpip', endpoint, ('127.0.0.1', 0), timeout=timeout) if previous else endpoint
                transport = paramiko.Transport(sock)
                self.transports.append(transport)
                transport.banner_timeout = transport.auth_timeout = timeout
                transport.start_client(timeout=timeout)
                key = transport.get_remote_server_key()
                actual = fingerprint(key)
                if item.get('peer') is None:
                    if not inspect:
                        raise StreamError('HOST_UNVERIFIED')
                    self.trust = {'index': index, 'host': item['host'], 'port': item['port'], 'algorithm': key.get_name(), 'peer': actual}
                    return
                if item['peer'] != actual:
                    raise StreamError('PEER_CHANGED')
                if item['authType'] == 'pass':
                    transport.auth_password(item['username'], item['authValue'], fallback=False)
                else:
                    private = None
                    for kind in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
                        try:
                            private = kind.from_private_key(io.StringIO(item['authValue']), password=item.get('keyPass') or None)
                            break
                        except (paramiko.SSHException, ValueError):
                            continue
                    if private is None:
                        raise StreamError('INVALID_PRIVATE_KEY')
                    transport.auth_publickey(item['username'], private)
                if not transport.is_authenticated():
                    raise StreamError('AUTH_FAILED')
                previous = transport
            sftp = paramiko.SFTPClient.from_transport(previous)
            sftp.get_channel().settimeout(30)
            client = SimpleNamespace(get_transport=lambda: previous)
            self.sftp = sftp
            self.stream = FileStream(SimpleNamespace(ssh_nowait=lambda: client, files=lambda: sftp), path_validator=self.path, name_validator=posix_name)
        except paramiko.AuthenticationException:
            self.close()
            raise StreamError('AUTH_FAILED') from None
        except Exception:
            self.close()
            raise

    def call(self, action, options):
        from .transfer_worker import check, emit
        check()
        result = self.stream.request(action, options, lambda **p: emit(event='progress', **p))
        if isinstance(result, tuple):
            result, self.binary = result
        return result

    def listing(self, value):
        root = self.path(value)
        if not stat.S_ISDIR(self.sftp.lstat(root).st_mode or 0):
            raise StreamError('UNSUPPORTED_FILE')
        entries, truncated = [], False
        for item in self.sftp.listdir_iter(root, read_aheads=1):
            if len(entries) >= 2000:
                truncated = True
                break
            if not (stat.S_ISREG(item.st_mode or 0) or stat.S_ISDIR(item.st_mode or 0)):
                continue
            entries.append({'name': posix_name(item.filename), 'directory': stat.S_ISDIR(item.st_mode),
                            'size': max(0, int(item.st_size or 0)), 'modified': max(0, int(item.st_mtime or 0))})
        return {'path': root, 'entries': entries, 'truncated': truncated}

    def path(self, value):
        root = posix_path(value)
        # Reject symlink ancestors; the last component is checked by each operation.
        current = ''
        for part in root.split('/')[:-1]:
            current = current + '/' + part if part else '/'
            if not stat.S_ISDIR(self.sftp.lstat(current).st_mode or 0):
                raise StreamError('UNSUPPORTED_FILE')
            current = current.rstrip('/')
        return root

    def read(self):
        result, self.binary = self.binary, None
        if not isinstance(result, bytes) or len(result) > CHUNK:
            raise StreamError('INVALID_RESPONSE')
        return result

    def write(self, data):
        return self.stream.write(data)

    def close(self):
        if self.stream:
            self.stream.close()
        if hasattr(self, 'sftp'):
            self.sftp.close()
        for transport in reversed(self.transports):
            transport.close()
