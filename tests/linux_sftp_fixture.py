"""Disposable loopback SSH/SFTP and bastion used by Linux file-center checks."""
import errno
import json
import os
from pathlib import Path
import select
import socket
import sys
import threading

import paramiko


class Store(paramiko.SFTPServerInterface):
    def __init__(self, server, root):
        super().__init__(server)
        self.root = Path(root)

    def local(self, name):
        parts = name.split('/')
        if '..' in parts:
            raise PermissionError(errno.EACCES, 'synthetic denied')
        return self.root / name.lstrip('/')

    def perform(self, method, *args):
        try:
            method(*args)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def list_folder(self, name):
        try:
            result = []
            for file in self.local(name).iterdir():
                value = paramiko.SFTPAttributes.from_stat(file.lstat())
                value.filename = file.name
                result.append(value)
            return result
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def lstat(self, name):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(name).lstat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    stat = lstat

    def open(self, name, flags, attr):
        try:
            fd = os.open(self.local(name), flags, 0o600)
            handle = paramiko.SFTPHandle(flags)
            file = os.fdopen(fd, 'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb')
            if flags & os.O_RDWR or not flags & os.O_WRONLY:
                handle.readfile = file
            if flags & (os.O_WRONLY | os.O_RDWR):
                handle.writefile = file
            return handle
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def mkdir(self, name, attr):
        return self.perform(self.local(name).mkdir)

    def remove(self, name):
        return self.perform(self.local(name).unlink)

    def rename(self, old, new):
        if self.local(new).exists():
            return paramiko.SFTP_FAILURE
        return self.perform(self.local(old).rename, self.local(new))


class Server(paramiko.ServerInterface):
    def __init__(self, owner):
        self.owner = owner
        self.destinations = {}

    def check_auth_password(self, username, password):
        self.owner.auth.append((username, password))
        return paramiko.AUTH_SUCCESSFUL if (username, password) == ('fixture', 'synthetic-password') else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        self.owner.auth.append((username, 'key'))
        return paramiko.AUTH_SUCCESSFUL if username == 'fixture' and key == self.owner.user_key else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return 'password,publickey'

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        if destination[0] != '127.0.0.1' or destination[1] not in self.owner.destinations:
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.destinations[chanid] = destination
        return paramiko.OPEN_SUCCEEDED


class SSHFixture:
    def __init__(self, root):
        self.root = root
        self.key = paramiko.RSAKey.generate(2048)
        self.user_key = paramiko.RSAKey.generate(2048)
        self.auth, self.transports, self.destinations = [], [], set()
        self.socket = socket.socket()
        self.socket.bind(('127.0.0.1', 0))
        self.socket.listen()
        self.socket.settimeout(.2)
        self.port = self.socket.getsockname()[1]
        self.closed = False
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while not self.closed:
            try:
                sock, _ = self.socket.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self.client, args=(sock,), daemon=True).start()

    def client(self, sock):
        transport = paramiko.Transport(sock)
        self.transports.append(transport)
        transport.add_server_key(self.key)
        transport.set_subsystem_handler('sftp', paramiko.SFTPServer, Store, root=self.root)
        server = Server(self)
        try:
            transport.start_server(server=server)
            while not self.closed and transport.is_active():
                channel = transport.accept(.2)
                if channel and channel.chanid in server.destinations:
                    threading.Thread(target=self.forward, args=(channel, server.destinations[channel.chanid]), daemon=True).start()
        except (EOFError, OSError, paramiko.SSHException):
            pass
        finally:
            transport.close()

    def forward(self, channel, destination):
        with socket.create_connection(destination) as remote:
            try:
                while not self.closed:
                    for source in select.select([channel, remote], [], [], .2)[0]:
                        data = source.recv(65536)
                        if not data:
                            return
                        (remote if source is channel else channel).sendall(data)
            finally:
                channel.close()

    def close(self):
        self.closed = True
        self.socket.close()
        for transport in self.transports:
            transport.close()


if __name__ == '__main__':
    from gmssh_windows_bridge.linux_files import fingerprint
    fixture = SSHFixture(sys.argv[1])
    print(json.dumps({'port': fixture.port, 'peer': fingerprint(fixture.key)}), flush=True)
    try:
        threading.Event().wait()
    finally:
        fixture.close()
