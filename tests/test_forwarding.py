"""Real SSH/SFTP protocol tests against a synthetic upstream, not a Windows claim."""
from contextlib import contextmanager
import errno
import hashlib
import os
import queue
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import paramiko

from gmssh_windows_bridge.bridge import Session, serve


class Files(paramiko.SFTPServerInterface):
    def __init__(self, server, root):
        super().__init__(server)
        self.root = Path(root).resolve()

    def path(self, name):
        path = (self.root / name.lstrip('/')).resolve()
        if path != self.root and self.root not in path.parents:
            raise PermissionError(errno.EACCES, 'synthetic filesystem boundary')
        return path

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.path(path).stat())
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    lstat = stat

    def list_folder(self, path):
        try:
            result = []
            for file in self.path(path).iterdir():
                attr = paramiko.SFTPAttributes.from_stat(file.stat())
                attr.filename = file.name
                result.append(attr)
            return result
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def open(self, path, flags, attr):
        try:
            fd = os.open(self.path(path), flags, 0o600)
            stream = os.fdopen(fd, 'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb')
            handle = paramiko.SFTPHandle(flags)
            if flags & (os.O_RDWR | os.O_WRONLY):
                handle.writefile = stream
            if not flags & os.O_WRONLY:
                handle.readfile = stream
            return handle
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def remove(self, path):
        try:
            self.path(path).unlink()
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)


class Upstream(paramiko.ServerInterface):
    def __init__(self):
        self.channels = []
        self.dimensions = []
        self.shell_ready = threading.Event()
        self.release = threading.Event()
        self.commands = queue.Queue()

    def check_auth_password(self, user, password):
        return paramiko.AUTH_SUCCESSFUL

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == 'session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, channel, term, width, height, pw, ph, modes):
        self.dimensions.append((width, height))
        return True

    def check_channel_window_change_request(self, channel, width, height, pw, ph):
        self.dimensions.append((width, height))
        return True

    def check_channel_exec_request(self, channel, command):
        self.commands.put((channel, command))
        return True

    def execute(self, channel, command):
        try:
            self._execute(channel, command)
        except OSError:
            # A test may close the peer while an independent synthetic worker writes.
            if not channel.closed:
                raise

    def _execute(self, channel, command):
        if command == b'wait':
            self.release.wait(3)
        if command == b'status-before-output':
            channel.send_exit_status(7)
            self.release.wait(3)
            channel.sendall(b'output-after-status')
            channel.close()
            return
        if command == b'output-eof-before-input':
            channel.sendall(b'output-complete')
            channel.shutdown_write()
            while channel.recv(32768):
                pass
            channel.send_exit_status(7)
            channel.close()
            return
        if command == b'read-stdin':
            data = bytearray()
            while True:
                chunk = channel.recv(32768)
                if not chunk:
                    break
                data.extend(chunk)
            channel.sendall(bytes(data))
        else:
            channel.sendall(b'forwarded:' + command)
            channel.sendall_stderr(b'upstream-stderr')
        channel.send_exit_status(7)
        channel.close()

    def check_channel_shell_request(self, channel):
        def run():
            channel.sendall(b'synthetic-shell-ready\n')
            self.shell_ready.set()
            data = channel.recv(1024)
            channel.sendall(b'input:' + data)
            channel.send_exit_status(0)
            channel.close()
        threading.Thread(target=run, daemon=True).start()
        return True


@contextmanager
def bridge(terminal=True, sftp=True, gmssh=False, shell='default'):
    key = paramiko.RSAKey.generate(2048)
    upstream = Upstream()
    us, uc = socket.socketpair()
    server = paramiko.Transport(us)
    server.add_server_key(key)
    upstream.disconnect = server.close
    with tempfile.TemporaryDirectory() as root:
        server.set_subsystem_handler('sftp', paramiko.SFTPServer, Files, root=root)
        def upstream_loop():
            try:
                server.start_server(server=upstream)
                while server.is_active():
                    channel = server.accept(0.1)
                    if channel is not None:
                        upstream.channels.append(channel)
                    while not upstream.commands.empty():
                        channel, command = upstream.commands.get_nowait()
                        threading.Thread(target=upstream.execute, args=(channel, command), daemon=True).start()
            except (EOFError, OSError, paramiko.SSHException):
                pass
        upstream_thread = threading.Thread(target=upstream_loop, daemon=True)
        upstream_thread.start()
        remote = paramiko.Transport(uc)
        remote.connect(hostkey=key, username='synthetic', password='synthetic')
        ds, dc = socket.socketpair()
        config = SimpleNamespace(timeout=3, enable_terminal=terminal, enable_sftp=sftp,
                                 gmssh_terminal=gmssh, shell=shell)
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        def auth(session, user, password):
            session.remote = SimpleNamespace(get_transport=lambda: remote, close=lambda: None)
            return paramiko.AUTH_SUCCESSFUL
        with patch.object(Session, 'check_auth_password', auth), \
                patch('gmssh_windows_bridge.bridge.collect', return_value=b'__GMB_CPU_USAGE__=12\n'):
            worker = threading.Thread(target=serve, args=(ds, key, config, slots), daemon=True)
            worker.start()
            client = paramiko.Transport(dc)
            try:
                client.connect(hostkey=key, username='synthetic', password='synthetic')
                yield client, upstream
            finally:
                upstream.release.set()
                client.close()
                worker.join(5)
                remote.close()
                server.close()
                upstream_thread.join(5)
                for sock in (us, uc, ds, dc):
                    sock.close()


class ForwardingTests(unittest.TestCase):
    def test_upstream_disconnect_closes_the_native_client_transport(self):
        with bridge() as (client, upstream):
            self.assertTrue(client.is_active())
            upstream.disconnect()
            client.join(3)
            self.assertFalse(client.is_active(), 'Native client retained a dead Windows connection')

    def test_shell_selection_forwards_fixed_command_without_changing_exec(self):
        import base64
        for shell in ('cmd', 'powershell'):
            with bridge(shell=shell) as (client, _):
                channel = client.open_session(timeout=3)
                channel.settimeout(3)
                channel.get_pty()
                channel.invoke_shell()
                output = channel.makefile('rb').read()
                self.assertEqual(channel.recv_exit_status(), 7)
                if shell == 'cmd':
                    self.assertEqual(output, b'forwarded:cmd.exe')
                else:
                    command = output.removeprefix(b'forwarded:').decode()
                    self.assertTrue(command.startswith('powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand '))
                    script = base64.b64decode(command.split()[-1]).decode('utf-16le')
                    self.assertNotIn('GMB_CWD', script)
                    self.assertIn('Get-Location', script)
                    self.assertNotIn('Set-Content', script)
                direct = client.open_session(timeout=3)
                direct.settimeout(3)
                direct.exec_command('user-command')
                self.assertEqual(direct.makefile('rb').read(), b'forwarded:user-command')

    def test_gmssh_bootstrap_opens_native_shell_only_when_enabled(self):
        # A synthetic fingerprint tests routing, not a real client version.
        command = b'synthetic-gmssh-terminal-bootstrap'
        with patch('gmssh_windows_bridge.bridge.GMSSH_SHELL_SHA256',
                   hashlib.sha256(command).hexdigest()):
            for enabled in (False, True):
                with bridge(gmssh=enabled) as (client, _):
                    channel = client.open_session(timeout=3)
                    channel.settimeout(3)
                    channel.get_pty()
                    channel.exec_command(command)
                    output = channel.makefile('rb')
                    if enabled:
                        self.assertIn(b'no privilege elevation', output.readline())
                        self.assertEqual(output.readline(), b'synthetic-shell-ready\n')
                        channel.sendall(b'hello\n')
                        self.assertEqual(output.read(), b'input:hello\n')
                        self.assertEqual(channel.recv_exit_status(), 0)
                    else:
                        self.assertEqual(output.read(), b'forwarded:' + command)
                        self.assertEqual(channel.recv_exit_status(), 7)

    def test_gmssh_preflight_and_identity_keep_real_windows_user(self):
        login = (b'__GMB_LOGIN_USER__=windows-user\n__GMB_LOGIN_SUDO__=0\n'
                 b'__GMB_LOGIN_SUDO_ACCESS__=0\n__GMB_LOGIN_SUDO_PASSWORD__=0\n')
        command = b'profile_state=$(ignored); __GMB_LOGIN_PROFILE__ __GMB_LOGIN_USER__ __GMB_LOGIN_SUDO__ __GMB_LOGIN_OS__'
        for enabled in (False, True):
            with bridge(gmssh=enabled) as (client, _), \
                    patch('gmssh_windows_bridge.bridge.collect', return_value=login):
                channel = client.open_session(timeout=3)
                channel.settimeout(3)
                channel.exec_command(command)
                payload = channel.makefile('rb').read()
                self.assertIn(b'__GMB_LOGIN_USER__=windows-user\n', payload)
                self.assertIn(b'__GMB_LOGIN_SUDO_PASSWORD__=0\n', payload)
                expected = b'1' if enabled else b'0'
                self.assertIn(b'__GMB_LOGIN_SUDO_ACCESS__=' + expected + b'\n', payload)
                if enabled:
                    identity = client.open_session(timeout=3)
                    identity.settimeout(3)
                    identity.exec_command('id -nu')
                    self.assertEqual(identity.makefile('rb').read(), b'windows-user\n')
                    self.assertEqual(identity.recv_exit_status(), 0)

    def test_upstream_exit_status_does_not_truncate_later_output(self):
        with bridge() as (client, upstream):
            channel = client.open_session(timeout=3)
            channel.settimeout(3)
            channel.exec_command('status-before-output')
            self.assertEqual(channel.recv_exit_status(), 7)
            upstream.release.set()
            self.assertEqual(channel.makefile('rb').read(), b'output-after-status')

    def test_upstream_output_eof_does_not_close_stdin(self):
        with patch('threading.excepthook') as worker_errors:
            with bridge() as (client, _):
                channel = client.open_session(timeout=3)
                channel.settimeout(3)
                channel.exec_command('output-eof-before-input')
                self.assertEqual(channel.makefile('rb').read(), b'output-complete')
                channel.sendall(b'input-after-output-eof')
                channel.shutdown_write()
                self.assertEqual(channel.recv_exit_status(), 7)
            worker_errors.assert_not_called()

    def test_exec_preserves_stdout_stderr_and_exit_status(self):
        with bridge() as (client, _):
            channel = client.open_session(timeout=3)
            channel.settimeout(3)
            command = 'echo 中文'.encode()
            channel.exec_command(command)
            self.assertEqual(channel.makefile('rb').read(), b'forwarded:' + command)
            self.assertEqual(channel.makefile_stderr('rb').read(), b'upstream-stderr')
            self.assertEqual(channel.recv_exit_status(), 7)

    def test_stdin_eof_and_binary_payload(self):
        with bridge() as (client, _):
            channel = client.open_session(timeout=3)
            channel.settimeout(3)
            channel.exec_command('read-stdin')
            payload = bytes(range(256)) * 512
            channel.sendall(payload)
            channel.shutdown_write()
            self.assertEqual(channel.makefile('rb').read(), payload)
            self.assertEqual(channel.recv_exit_status(), 7)

    def test_shell_and_window_resize(self):
        with bridge() as (client, upstream):
            channel = client.open_session(timeout=3)
            channel.settimeout(3)
            channel.get_pty(width=80, height=24)
            channel.invoke_shell()
            self.assertEqual(channel.makefile('rb').readline(), b'synthetic-shell-ready\n')
            channel.resize_pty(width=132, height=40)
            deadline = time.monotonic() + 3
            while (132, 40) not in upstream.dimensions and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIn((80, 24), upstream.dimensions)
            self.assertIn((132, 40), upstream.dimensions)
            channel.sendall(b'hello\n')
            self.assertEqual(channel.makefile('rb').read(), b'input:hello\n')

    def test_sftp_roundtrip_unicode_binary_and_remove(self):
        with bridge() as (client, _):
            with paramiko.SFTPClient.from_transport(client) as files:
                files.get_channel().settimeout(3)
                name = '/测试.bin'
                payload = bytes(range(256)) * 512
                with files.open(name, 'wb') as target:
                    target.write(payload)
                self.assertIn('测试.bin', files.listdir('/'))
                with files.open(name, 'rb') as target:
                    self.assertEqual(target.read(), payload)
                self.assertEqual(files.stat(name).st_size, len(payload))
                files.remove(name)
                self.assertNotIn('测试.bin', files.listdir('/'))

    def test_disabled_shell_and_sftp_requests_fail(self):
        with bridge(terminal=False, sftp=False) as (client, _):
            channel = client.open_session(timeout=3)
            with self.assertRaises(paramiko.SSHException):
                channel.get_pty()
            channel.close()
            with self.assertRaises(paramiko.SSHException):
                paramiko.SFTPClient.from_transport(client)

    def test_shell_does_not_block_monitoring_on_same_connection(self):
        with bridge() as (client, upstream):
            waiting = client.open_session(timeout=3)
            waiting.exec_command('wait')
            metrics = client.open_session(timeout=3)
            metrics.settimeout(2)
            metrics.exec_command("sh -s <<'__GMB_FAST_METRICS__'\n# __GMB_FAST_METRICS__\nignored\n__GMB_FAST_METRICS__")
            self.assertEqual(metrics.makefile('rb').read(), b'__GMB_CPU_USAGE__=12\n')
            upstream.release.set()
            waiting.close()


if __name__ == '__main__':
    unittest.main()
