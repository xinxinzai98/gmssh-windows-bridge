import errno
import io
import json
import socket
import stat
import threading
import unittest
import urllib.request
import zipfile
from contextlib import redirect_stdout
from collections import deque
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from gmssh_windows_bridge.desktop import MAX_INPUT, MonitorDesktopPool, create_server
from gmssh_windows_bridge.desktop_operations import (
    DRIVE_COMMAND, DRIVE_SCRIPT, SYSTEM_COMMAND, SYSTEM_SCRIPT, MAX_CHUNK, MAX_CONTROL, MAX_ENTRIES, MAX_FILE,
    POWER_COMMANDS, OperationError, OperationsSession, SSHPoolUnavailable,
    connection_health, decode_request, handle_operations, normalize_path, run_command, validate_name, wake_settings,
)


class MemoryFile(io.BytesIO):
    def __init__(self, files, path):
        super().__init__()
        self.files, self.path = files, path

    def write(self, data):
        result = super().write(data)
        self.files[self.path] = self.getvalue()
        return result


class MemorySFTP:
    def __init__(self):
        self.data = {"C:/测试 目录/original.txt": b"original", "C:/测试 目录/.gmssh-upload-existing.part": b"keep"}
        self.opened, self.removed, self.renamed = [], [], []
        self.directories = {'C:/', 'C:/测试 目录'}
        self.links = set()
        self.closed = False

    def stat(self, path):
        if path in self.links:
            return SimpleNamespace(st_mode=stat.S_IFLNK, st_size=0, st_mtime=10)
        if path in self.directories:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_size=0, st_mtime=10)
        if path not in self.data:
            raise FileNotFoundError(errno.ENOENT, "synthetic private remote path")
        return SimpleNamespace(st_mode=stat.S_IFREG, st_size=len(self.data[path]), st_mtime=10)

    lstat = stat

    def listdir_attr(self, path):
        prefix = path.rstrip("/") + "/"
        return [SimpleNamespace(filename=name[len(prefix):], **vars(self.stat(name)))
                for name in sorted(set(self.data) | self.directories | self.links)
                if name.startswith(prefix) and name != path and '/' not in name[len(prefix):]]

    def listdir_iter(self, path, read_aheads=1):
        return iter(self.listdir_attr(path))

    def mkdir(self, path):
        if path in self.data or path in self.directories:
            raise FileExistsError(errno.EEXIST, 'exists')
        parent = path.rsplit('/', 1)[0]
        if len(parent) == 2: parent += '/'
        if parent not in self.directories:
            raise FileNotFoundError(errno.ENOENT, 'missing parent')
        self.directories.add(path)

    def open(self, path, mode, bufsize=-1):
        self.opened.append((path, mode, bufsize))
        if mode == "rb":
            return io.BytesIO(self.data[path])
        assert mode == "wx" and bufsize == 0
        if path in self.data:
            raise FileExistsError(errno.EEXIST, "must not overwrite")
        self.data[path] = b""
        return MemoryFile(self.data, path)

    def remove(self, path):
        self.removed.append(path)
        if path not in self.data:
            raise FileNotFoundError(errno.ENOENT, "missing")
        del self.data[path]

    def rename(self, source, target):
        if target in self.data:
            raise FileExistsError(errno.EEXIST, "must not overwrite")
        self.renamed.append((source, target))
        self.data[target] = self.data.pop(source)

    def close(self):
        self.closed = True


class FakeWebSocket:
    def __init__(self, incoming=()):
        self.incoming, self.outgoing = deque(incoming), []
        self.closed = False

    def recv(self, timeout):
        if not self.incoming:
            raise EOFError("synthetic disconnect")
        return self.incoming.popleft()

    def send(self, data):
        self.outgoing.append(data)

    def close(self, *args):
        self.closed = True

    def replies(self):
        return [json.loads(data) for data in self.outgoing if isinstance(data, str)]


class DesktopOperationsTests(unittest.TestCase):
    def make_session(self):
        websocket, sftp = FakeWebSocket(), MemorySFTP()
        session = OperationsSession(MagicMock(), websocket, 1)
        session.sftp = sftp
        return session, websocket, sftp

    def test_token_envelope_never_acquires_ssh_for_invalid_authorization(self):
        token, pool = "s" * 43, MagicMock()
        config = SimpleNamespace(access_token=token, timeout=1, monitor_pool=pool)
        for envelope in ({}, {"token": "wrong"}, {"token": token, "password": "unused"}, {"token": 7}, {"token": "中" * 43}):
            ws = FakeWebSocket([json.dumps(envelope)])
            handle_operations(config, ws, threading.BoundedSemaphore(1))
            self.assertEqual(ws.replies()[0]["code"], "DesktopAccessError")
            self.assertTrue(ws.closed)
        pool.acquire.assert_not_called()
        pool.acquire.side_effect = SSHPoolUnavailable("synthetic sensitive SSH detail")
        ws = FakeWebSocket([json.dumps({"token": token}), json.dumps({"id": 1, "op": "list", "path": "/"})])
        handle_operations(config, ws, threading.BoundedSemaphore(1))
        self.assertEqual(ws.replies()[0], {"type": "operations_ready"})
        self.assertEqual(ws.replies()[1]["code"], "SSHPoolUnavailable")
        self.assertNotIn("sensitive", ws.replies()[1]["message"])

    def test_paths_names_and_control_envelopes_are_bounded(self):
        self.assertEqual(normalize_path(r"c:\测试 目录\文件.txt"), "C:/测试 目录/文件.txt")
        self.assertEqual(normalize_path("", allow_root=True), "/")
        for path in ("/tmp/test", "C:relative", r"\\server\share\file", "//server/share", "C:/a:stream", "C:/a\x00", "C:/a\n", "C:/../file", "C:/NUL", 7):
            with self.subTest(path=repr(path)), self.assertRaises(OperationError):
                normalize_path(path)
        for name in ("", ".", "..", "CON.txt", "NUL .txt", "CONIN$", "NUL", "a:b", "../a", r"dir\a", "x\x7f", "x\ud800", "a.", "a ", "a*", "x" * 256):
            with self.subTest(name=repr(name)), self.assertRaises(OperationError):
                validate_name(name)
        self.assertEqual(validate_name("中文 空格.txt"), "中文 空格.txt")
        with self.assertRaises(OperationError): decode_request(" " * (MAX_CONTROL + 1))
        with self.assertRaises(OperationError): decode_request(b"{}")
        session, _, _ = self.make_session()
        for request_id in (True, 0, -1, 1.5):
            with self.assertRaises(OperationError): session.request({"id": request_id, "op": "list", "path": "/"})

    def test_drive_listing_is_fixed_and_download_streams_with_exact_size(self):
        session, ws, sftp = self.make_session()
        with patch("gmssh_windows_bridge.desktop_operations.run_command", return_value=b'["C:","D:"]') as command:
            session.request({"id": 1, "op": "list", "path": "/"})
            command.assert_called_once_with(session.client, DRIVE_COMMAND, 1)
        self.assertIn("Get-CimInstance Win32_LogicalDisk", DRIVE_SCRIPT)
        self.assertEqual(ws.replies()[-1]["entries"][0], {"name": "C:", "directory": True, "size": 0, "modified": 0})
        for number in range(MAX_ENTRIES): sftp.data[f"C:/测试 目录/{number}.txt"] = b"x"
        session.request({"id": 2, "op": "list", "path": r"C:\测试 目录"})
        self.assertTrue(ws.replies()[-1]["truncated"])
        self.assertEqual(len(ws.replies()[-1]["entries"]), MAX_ENTRIES)
        content = b"a" * MAX_CHUNK + b"tail"
        sftp.data["C:/测试 目录/large.bin"] = content
        session.request({"id": 3, "op": "download", "path": "C:/测试 目录/large.bin"})
        chunks = [data for data in ws.outgoing if isinstance(data, bytes)]
        self.assertEqual([len(chunk) for chunk in chunks], [MAX_CHUNK, 4])
        self.assertEqual(b"".join(chunks), content)
        self.assertEqual(ws.replies()[-1], {"id": 3, "ok": True, "done": True, "bytes": len(content)})
        with patch.object(sftp, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFREG, st_size=MAX_FILE + 1)):
            with self.assertRaises(OperationError): session.request({"id": 4, "op": "download", "path": "C:/too-big.bin"})

    def test_system_information_uses_only_a_packaged_read_only_command(self):
        session, ws, _ = self.make_session()
        info = {"computer": "LAB-PC", "os": "Windows", "version": "10", "cpu": "CPU", "cores": 8,
                "memory": 16 * 1024 ** 3, "uptime": 10, "processes": 30, "disks": [], "network": []}
        with patch("gmssh_windows_bridge.desktop_operations.run_command", return_value=json.dumps(info).encode()) as command:
            session.request({"id": 1, "op": "system-info"})
            command.assert_called_once_with(session.client, SYSTEM_COMMAND, 1)
            reply = ws.replies()[-1]
            self.assertEqual({k: v for k, v in reply['info'].items() if k != 'connection'}, info)
            self.assertEqual(reply['info']['connection'], {'state': 'unknown', 'latencyMs': None})
            with self.assertRaises(OperationError): session.request({"id": 2, "op": "system-info", "command": "ignored"})
            self.assertEqual(command.call_count, 1)
        with patch("gmssh_windows_bridge.desktop_operations.run_command", return_value=b'{"password":"must not be forwarded"}'):
            with self.assertRaises(OperationError): session.request({"id": 3, "op": "system-info"})
        self.assertLess(len(SYSTEM_COMMAND), 7900)
        self.assertIn("Get-NetAdapterStatistics", SYSTEM_SCRIPT)
        self.assertNotIn("Set-", SYSTEM_SCRIPT)

    def test_folder_upload_paths_and_zip_download_preserve_files_and_empty_directories(self):
        session, ws, sftp = self.make_session()
        for index, path in enumerate(['C:/测试 目录/新目录', 'C:/测试 目录/新目录/空目录']):
            session.request({'id': index + 1, 'op': 'mkdir', 'path': path})
            self.assertTrue(ws.replies()[-1]['created'])
        session.request({'id': 3, 'op': 'mkdir', 'path': 'C:/测试 目录/新目录'})
        self.assertFalse(ws.replies()[-1]['created'])
        sftp.data['C:/测试 目录/新目录/中文.txt'] = '内容'.encode()
        session.request({'id': 4, 'op': 'download-folder', 'path': 'C:/测试 目录/新目录'})
        archive_bytes = b''.join(value for value in ws.outgoing if isinstance(value, bytes))
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            self.assertEqual(archive.read('新目录/中文.txt'), '内容'.encode())
            self.assertIn('新目录/空目录/', archive.namelist())
        self.assertEqual(ws.replies()[-1]['bytes'], len(archive_bytes))
        for path in ['C:/测试 目录/original.txt', 'C:/../outside']:
            with self.assertRaises(OperationError): session.request({'id': 5, 'op': 'mkdir', 'path': path})
        with self.assertRaises(OperationError): session.request({'id': 6, 'op': 'download-folder', 'path': 'C:/'})
        sftp.links.add('C:/测试 目录/新目录/外部链接')
        with self.assertRaises(OperationError): session.request({'id': 7, 'op': 'download-folder', 'path': 'C:/测试 目录/新目录'})
        self.assertEqual(sftp.data['C:/测试 目录/original.txt'], b'original')

    def test_connection_health_measures_only_the_authenticated_remote_tcp_peer(self):
        transport = SimpleNamespace(is_active=lambda: True, is_authenticated=lambda: True,
                                    getpeername=lambda: ('2001:db8::42', 2222, 0, 0))
        client = SimpleNamespace(get_transport=lambda: transport)
        with patch('gmssh_windows_bridge.desktop_operations.socket.create_connection') as connect, \
                patch('gmssh_windows_bridge.desktop_operations.time.monotonic', side_effect=[10, 10.012]):
            self.assertEqual(connection_health(client, 8), {'state': 'connected', 'latencyMs': 12.0})
            connect.assert_called_once_with(('2001:db8::42', 2222), timeout=2)
        with patch('gmssh_windows_bridge.desktop_operations.socket.create_connection', side_effect=TimeoutError):
            self.assertEqual(connection_health(client, 1), {'state': 'connected', 'latencyMs': None})
        transport.getpeername = lambda: ('127.0.0.1', 22252)
        with patch('gmssh_windows_bridge.desktop_operations.socket.create_connection') as connect:
            self.assertEqual(connection_health(client, 1), {'state': 'connected', 'latencyMs': None})
            connect.assert_not_called()
        transport.is_authenticated = lambda: False
        with patch('gmssh_windows_bridge.desktop_operations.socket.create_connection') as connect:
            self.assertEqual(connection_health(client, 1)['state'], 'disconnected')
            connect.assert_not_called()

    def test_folder_download_limits_stop_before_large_or_excessive_reads(self):
        session, _, sftp = self.make_session()
        sftp.directories.add('C:/测试 目录/样本');sftp.data['C:/测试 目录/样本/a.txt'] = b'abc'
        for bound in ['MAX_FILE', 'MAX_ENTRIES']:
            with patch('gmssh_windows_bridge.desktop_operations.' + bound, 1):
                with self.assertRaises(OperationError): session.request({'id': 20, 'op': 'download-folder', 'path': 'C:/测试 目录/样本'})
        self.assertEqual(sftp.opened, [])

    def test_upload_is_exclusive_acknowledged_and_rename_never_overwrites(self):
        session, ws, sftp = self.make_session()
        request = {"id": 8, "op": "upload-start", "path": "C:/测试 目录", "name": "新的文件.txt", "size": 4}
        session.request(request)
        temporary = session.upload["temporary"]
        self.assertTrue(temporary.startswith("C:/测试 目录/.gmssh-upload-"))
        self.assertTrue(temporary.endswith(".part"))
        self.assertEqual(ws.replies()[-1], {"id": 8, "ok": True, "ready": True})
        session.receive_chunk(b"data")
        self.assertEqual(ws.replies()[-1], {"id": 8, "ok": True, "bytes": 4})
        session.request({"id": 8, "op": "upload-finish"})
        self.assertEqual(ws.replies()[-1], {"id": 8, "ok": True, "done": True, "bytes": 4})
        self.assertEqual(sftp.data["C:/测试 目录/新的文件.txt"], b"data")
        self.assertNotIn(temporary, sftp.data)
        self.assertEqual(sftp.data["C:/测试 目录/original.txt"], b"original")
        with self.assertRaises(OperationError): session.request({**request, "name": "original.txt"})
        session.request({**request, "name": "race.txt"})
        session.receive_chunk(b"data")
        sftp.data["C:/测试 目录/race.txt"] = b"other writer"
        with self.assertRaises(OperationError): session.request({"id": 8, "op": "upload-finish"})
        session.cancel_upload()
        self.assertEqual(sftp.data["C:/测试 目录/race.txt"], b"other writer")

    def test_cancel_size_failure_and_disconnect_clean_only_owned_temporary_file(self):
        session, _, sftp = self.make_session()
        start = {"id": 9, "op": "upload-start", "path": "C:/测试 目录", "name": "cancel.txt", "size": 2}
        session.request(start)
        temporary = session.upload["temporary"]
        session.request({"id": 9, "op": "upload-cancel"})
        self.assertEqual(sftp.removed, [temporary])
        session.request(start)
        with self.assertRaises(OperationError): session.receive_chunk(b"too much")
        with self.assertRaises(OperationError): session.receive_chunk(b"x" * (MAX_CHUNK + 1))
        with self.assertRaises(OperationError): session.request({"id": 9, "op": "upload-finish"})
        session.close()
        self.assertEqual(set(sftp.data), {"C:/测试 目录/original.txt", "C:/测试 目录/.gmssh-upload-existing.part"})
        ws = FakeWebSocket([json.dumps({"token": "s" * 43}), json.dumps(start), b"x"])
        pool, lease, client = MagicMock(), MagicMock(), MagicMock()
        pool.acquire.return_value = (lease, client)
        with patch("gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient", return_value=sftp):
            handle_operations(SimpleNamespace(access_token="s" * 43, timeout=1, monitor_pool=pool), ws, threading.BoundedSemaphore(1))
        self.assertEqual(ws.replies()[0], {"type": "operations_ready"})
        self.assertEqual(set(sftp.data), {"C:/测试 目录/original.txt", "C:/测试 目录/.gmssh-upload-existing.part"})
        client.close.assert_not_called()
        lease.close.assert_called_once()
        self.assertTrue(sftp.closed)
        client.get_transport.return_value.open_session.assert_called_once_with(timeout=1)
        client.get_transport.return_value.open_session.return_value.settimeout.assert_called_once_with(1)

    def test_power_allowlist_runs_only_fixed_commands_and_reports_requests(self):
        session, ws, _ = self.make_session()
        with patch("gmssh_windows_bridge.desktop_operations.run_command", return_value=b"") as command:
            for action in POWER_COMMANDS:
                session.request({"id": 12, "op": "power", "action": action})
                command.assert_called_with(session.client, POWER_COMMANDS[action], 1)
                self.assertTrue(ws.replies()[-1]["requested"])
                self.assertNotIn("scheduled", ws.replies()[-1])
                self.assertEqual(ws.replies()[-1]["delay"], 0)
            calls = command.call_count
            with self.assertRaises(OperationError): session.request({"id": 13, "op": "power", "action": "shutdown /f & whoami"})
            self.assertEqual(command.call_count, calls)
        self.assertNotIn("/f", " ".join(POWER_COMMANDS.values()))
        self.assertEqual(POWER_COMMANDS["restart"], "shutdown.exe /r /t 0")
        self.assertEqual(POWER_COMMANDS["shutdown"], "shutdown.exe /s /t 0")
        client, channel = MagicMock(), MagicMock()
        client.get_transport.return_value.open_session.return_value = channel
        channel.recv_ready.return_value = channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = True
        channel.recv_exit_status.return_value = 0
        self.assertEqual(run_command(client, POWER_COMMANDS["cancel"], 1), b"")
        channel.exec_command.assert_called_once_with("shutdown.exe /a")
        channel.close.assert_called_once()

    def test_monitor_acquire_keeps_authenticated_transport_alive_until_release(self):
        pool, client = MonitorDesktopPool(21118, 0.01), MagicMock()
        pool.attach(client)
        lease, shared = pool.acquire()
        self.assertIs(shared, client)
        client.get_transport.return_value.open_channel.assert_not_called()
        pool.detach(client)
        client.close.assert_not_called()
        lease.close()
        client.close.assert_called_once()

    def test_operations_use_same_origin_capabilities_and_keep_desktop_input_limit(self):
        from websockets.exceptions import ConnectionClosedError, InvalidStatus
        from websockets.sync.client import connect
        pool = MagicMock()
        config = SimpleNamespace(listen_port=0, target="windows.example.invalid", username="synthetic-user", target_port=22,
                                 timeout=1, monitor_pool=pool, monitor_channel=MagicMock(), access_token="s" * 43)
        sftp = MemorySFTP()
        pool.acquire.return_value = (MagicMock(), MagicMock())
        with create_server(config) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            port = server.socket.getsockname()[1]
            origin = f"http://127.0.0.1:{port}"
            http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with http.open(origin + "/config.json", timeout=3) as response:
                    self.assertEqual(json.load(response)["capabilities"], {"files": True, "files_write": True, "power": True, "wake": False})
                config.controller_policy=lambda:{'view':True,'input':False,'clipboard':False,'files':False,'files_read':True,'terminal':False,'power':False}
                with http.open(origin + '/config.json',timeout=3) as response:
                    value=json.load(response)
                    self.assertTrue(value['capabilities']['files']);self.assertFalse(value['capabilities']['files_write'])
                    self.assertTrue(value['authorization']['files_read'])
                del config.controller_policy
                with self.assertRaises(InvalidStatus):
                    connect(f"ws://127.0.0.1:{port}/operations", origin="https://attacker.example.invalid", proxy=None)
                with connect(f"ws://127.0.0.1:{port}/operations", origin=origin, proxy=None) as ws:
                    ws.send(json.dumps({"token": "wrong"}))
                    self.assertEqual(json.loads(ws.recv(timeout=3))["code"], "DesktopAccessError")
                pool.acquire.assert_not_called()
                with patch("gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient", return_value=sftp):
                    with connect(f"ws://127.0.0.1:{port}/operations", origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({"token": config.access_token}))
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {"type": "operations_ready"})
                        pool.acquire.assert_not_called()
                        ws.send(json.dumps({"id": 14, "op": "upload-start", "path": "C:/测试 目录", "name": "frame.bin", "size": MAX_CHUNK}))
                        self.assertTrue(json.loads(ws.recv(timeout=3))["ready"])
                        ws.send(b"x" * MAX_CHUNK)
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {"id": 14, "ok": True, "bytes": MAX_CHUNK})
                        ws.send(json.dumps({"id": 14, "op": "upload-finish"}))
                        self.assertTrue(json.loads(ws.recv(timeout=3))["done"])
                        ws.send(json.dumps({"id": 15, "op": "download", "path": "C:/测试 目录/frame.bin"}))
                        self.assertEqual(json.loads(ws.recv(timeout=3))["size"], MAX_CHUNK)
                        self.assertEqual(ws.recv(timeout=3), b"x" * MAX_CHUNK)
                        self.assertTrue(json.loads(ws.recv(timeout=3))["done"])
                        ws.send(json.dumps({"id": 16, "op": "download", "path": "C:/missing.bin"}))
                        failure = json.loads(ws.recv(timeout=3))
                        self.assertEqual(failure["id"], 16)
                        self.assertFalse(failure["ok"])
                        self.assertNotIn("private", failure["message"])
                remote, peer = socket.socketpair()
                peer.settimeout(0.1)
                config.monitor_channel.return_value = (MagicMock(), remote)
                try:
                    with connect(f"ws://127.0.0.1:{port}/socket", origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({"password": "", "token": config.access_token}))
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {"type": "ssh_ready"})
                        ws.send(b"x" * (MAX_INPUT + 1))
                        with self.assertRaises(ConnectionClosedError): ws.recv(timeout=3)
                        try:
                            forwarded = peer.recv(1)
                        except socket.timeout:
                            forwarded = b""
                        self.assertEqual(forwarded, b"")
                finally:
                    remote.close()
                    peer.close()
                config.monitor_pool = None
                with http.open(origin + "/config.json", timeout=3) as response:
                    self.assertEqual(json.load(response)["capabilities"], {"files": False, "files_write": False, "power": False, "wake": False})
                self.assertEqual(MAX_INPUT, 16 * 1024)
            finally:
                server.shutdown()
                thread.join(timeout=3)

    def test_wake_configuration_rejects_unpaired_or_nonlocal_targets(self):
        good = {"wake_mac": "02:11:22:33:44:55", "wake_broadcast": "192.168.10.255"}
        self.assertIsNone(wake_settings(SimpleNamespace()))
        expected = (bytes.fromhex("021122334455"), "192.168.10.255")
        for mac in ("02:11:22:33:44:55", "02-11-22-33-44-55", "021122334455"):
            self.assertEqual(wake_settings(SimpleNamespace(**{**good, "wake_mac": mac})), expected)
        for mac in ("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", "01:11:22:33:44:55", "02:11:22:33:44", "02:11-22:33:44:55", "0211:22:33:44:55:", "02:11:22:33:44:ZZ", None, 9):
            with self.subTest(mac=mac), self.assertRaises(OperationError):
                wake_settings(SimpleNamespace(**{**good, "wake_mac": mac}))
        for broadcast in ("192.168.10.254", "127.0.0.255", "169.254.10.255", "224.0.0.255", "255.255.255.255", "203.0.113.255", "::1", "192.168.010.255", None, 9):
            with self.subTest(broadcast=broadcast), self.assertRaises(OperationError):
                wake_settings(SimpleNamespace(**{**good, "wake_broadcast": broadcast}))
        for port in (7, "9", True):
            with self.assertRaises(OperationError): wake_settings(SimpleNamespace(**good, wake_port=port))

    def test_authenticated_offline_wake_sends_only_paired_magic_packet_without_ssh(self):
        pool = MagicMock()
        pool.acquire.side_effect = SSHPoolUnavailable("synthetic offline")
        config = SimpleNamespace(access_token="s" * 43, timeout=1, monitor_pool=pool,
                                 wake_mac="02:11:22:33:44:55", wake_broadcast="192.168.10.255")
        requests = [{"token": config.access_token}, {"id": 20, "op": "wake"},
                    {"id": 21, "op": "wake", "mac": "02:AA:BB:CC:DD:EE", "broadcast": "192.168.20.255", "port": 7}]
        ws = FakeWebSocket([json.dumps(request) for request in requests])
        with patch("gmssh_windows_bridge.desktop_operations.socket.socket") as factory:
            udp = factory.return_value.__enter__.return_value
            udp.sendto.return_value = 102
            handle_operations(config, ws, threading.BoundedSemaphore(1))
            factory.assert_called_once_with(socket.AF_INET, socket.SOCK_DGRAM)
            udp.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            udp.sendto.assert_called_once_with(b"\xff" * 6 + bytes.fromhex("021122334455") * 16, ("192.168.10.255", 9))
            self.assertEqual(len(udp.sendto.call_args.args[0]), 102)
        pool.acquire.assert_not_called()
        self.assertEqual(ws.replies()[0], {"type": "operations_ready"})
        self.assertEqual(ws.replies()[1], {"id": 20, "ok": True, "sent": True, "message": "唤醒请求已发送，等待设备上线。"})
        self.assertFalse(ws.replies()[2]["ok"])
        with patch("gmssh_windows_bridge.desktop_operations.socket.socket") as factory:
            ws = FakeWebSocket([json.dumps({"token": "wrong"}), json.dumps({"id": 22, "op": "wake"})])
            handle_operations(config, ws, threading.BoundedSemaphore(1))
            factory.assert_not_called()
            self.assertEqual(ws.replies()[0]["code"], "DesktopAccessError")

    def test_wake_capability_requires_private_token_and_offline_files_keep_monitor_hint(self):
        from websockets.sync.client import connect
        config = SimpleNamespace(listen_port=0, target="windows.example.invalid", username="", target_port=22,
                                 timeout=1, wake_mac="02:11:22:33:44:55", wake_broadcast="192.168.10.255")
        with self.assertRaises(ValueError): create_server(config)
        config.access_token = "s" * 43
        with create_server(config) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            port = server.socket.getsockname()[1]
            origin = f"http://127.0.0.1:{port}"
            http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with http.open(origin + "/config.json", timeout=3) as response:
                    self.assertEqual(json.load(response)["capabilities"], {"files": False, "files_write": False, "power": False, "wake": True})
                with patch("gmssh_windows_bridge.desktop_operations.send_wake") as wake:
                    with connect(f"ws://127.0.0.1:{port}/operations", origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({"token": config.access_token}))
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {"type": "operations_ready"})
                        ws.send(json.dumps({"id": 23, "op": "list", "path": "/"}))
                        self.assertEqual(json.loads(ws.recv(timeout=3))["code"], "SSHPoolUnavailable")
                        ws.send(json.dumps({"id": 24, "op": "power", "action": "cancel"}))
                        self.assertEqual(json.loads(ws.recv(timeout=3))["code"], "SSHPoolUnavailable")
                        ws.send(json.dumps({"id": 25, "op": "wake"}))
                        self.assertTrue(json.loads(ws.recv(timeout=3))["sent"])
                    wake.assert_called_once_with(bytes.fromhex("021122334455"), "192.168.10.255", 1)
            finally:
                server.shutdown()
                thread.join(timeout=3)

    def test_wake_only_cli_generates_private_fragment_without_keychain(self):
        from gmssh_windows_bridge.desktop import main
        output = io.StringIO()
        args = ["desktop", "--target", "windows.example.invalid", "--wake-mac", "02:11:22:33:44:55", "--wake-broadcast", "192.168.10.255"]
        with patch("sys.argv", args), patch("gmssh_windows_bridge.desktop.create_server") as server, \
                patch("gmssh_windows_bridge.desktop.secrets.token_urlsafe", return_value="s" * 43), redirect_stdout(output):
            main()
        config = server.call_args.args[0]
        self.assertEqual(config.access_token, "s" * 43)
        self.assertIsNone(config.keychain_store)
        self.assertIn("#token=" + config.access_token, output.getvalue())

    def test_bridge_wake_cli_generates_token_without_shared_auth_or_keychain(self):
        from gmssh_windows_bridge.bridge import main
        from pathlib import Path
        output = io.StringIO()
        args = ["bridge", "--target", "windows.example.invalid", "--username", "synthetic-user", "--desktop-port", "22240",
                "--wake-mac", "02:11:22:33:44:55", "--wake-broadcast", "192.168.10.255"]
        with patch("sys.argv", args), patch.object(Path, "is_file", return_value=True), \
                patch("gmssh_windows_bridge.bridge.load_key"), patch("gmssh_windows_bridge.bridge.socket.socket") as sockets, \
                patch("gmssh_windows_bridge.bridge.threading.Thread"), patch("gmssh_windows_bridge.desktop.create_server") as server, \
                patch("secrets.token_urlsafe", return_value="s" * 43), redirect_stdout(output):
            sockets.return_value.__enter__.return_value.accept.side_effect = KeyboardInterrupt()
            main()
        config = server.call_args.args[0]
        self.assertEqual(config.access_token, "s" * 43)
        self.assertFalse(config.desktop_keychain)
        self.assertFalse(config.desktop_shared_auth)
        self.assertIn("#token=" + config.access_token, output.getvalue())

    def test_lazy_ssh_lease_is_shared_and_released_even_if_sftp_close_fails(self):
        pool, client, lease = MagicMock(), MagicMock(), MagicMock()
        pool.acquire.return_value = (lease, client)
        session = OperationsSession(None, FakeWebSocket(), 1, pool=pool)
        pool.acquire.assert_not_called()
        sftp = MemorySFTP()
        with patch("gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient", return_value=sftp), \
                patch("gmssh_windows_bridge.desktop_operations.run_command", return_value=b""):
            session.request({"id": 26, "op": "list", "path": "C:/测试 目录"})
            session.request({"id": 27, "op": "power", "action": "cancel"})
        pool.acquire.assert_called_once()
        with patch.object(sftp, "close", side_effect=OSError("synthetic close failure")):
            with self.assertRaises(OSError): session.close()
            with self.assertRaises(OSError): session.close()
        lease.close.assert_called_once()
        client.close.assert_not_called()


if __name__ == "__main__": unittest.main()
