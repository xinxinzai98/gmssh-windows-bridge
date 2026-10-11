import socket
import base64
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import paramiko

from gmssh_windows_bridge.bridge import Session, collect, load_key, metric_mode, serve


def request(mode, body="ignored shell body"):
    marker = "__GMB_" + mode.upper() + "_METRICS__"
    return ("sh -s <<'" + marker + "'\n# " + marker + "\n" + body + "\n" + marker).encode()


class ProtocolTests(unittest.TestCase):
    def test_recognizes_only_metric_envelopes(self):
        for mode in ("fast", "slow"):
            self.assertEqual(metric_mode(request(mode)), mode)
        for command in (b"echo __GMB_FAST_METRICS__", b"sudo -n id", b"uname -m",
                        b"\xff", b"x" * 65537, request("fast") + b"\necho extra"):
            self.assertIsNone(metric_mode(command))

    def test_host_key_persists(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "key"
            first = load_key(path)
            self.assertEqual(first.asbytes(), load_key(path).asbytes())
            if __import__('os').name != 'nt':
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_authentication_requires_expected_user_and_trusted_host(self):
        cfg = SimpleNamespace(username="tester", target="example.invalid", target_port=22,
                              timeout=3, known_hosts=Path("example-known-hosts"))
        session = Session(cfg)
        with patch('gmssh_windows_bridge.bridge.paramiko.SSHClient') as factory:
            self.assertEqual(session.check_auth_password("root", "synthetic"), paramiko.AUTH_FAILED)
            factory.assert_not_called()
            factory.return_value.connect.side_effect = paramiko.SSHException("unknown key")
            self.assertEqual(session.check_auth_password("tester", "synthetic"), paramiko.AUTH_FAILED)
            factory.return_value.load_host_keys.assert_called_once_with('example-known-hosts')
            factory.return_value.set_missing_host_key_policy.assert_not_called()

    def test_collection_has_deadline(self):
        remote = MagicMock()
        channel = remote.get_transport.return_value.open_session.return_value
        channel.recv_ready.return_value = False
        channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = False
        with patch('gmssh_windows_bridge.bridge.time.monotonic', side_effect=[0, 0, 10]):
            with self.assertRaises(TimeoutError):
                collect(remote, 'fast', 3)
        channel.close.assert_called_once()

    def test_fixed_collector_fits_windows_command_limit(self):
        remote = MagicMock()
        channel = remote.get_transport.return_value.open_session.return_value
        channel.recv_ready.side_effect = [True, False, False]
        channel.recv.return_value = b'__GMB_MEM_TOTAL_BYTES__=1024\r\n'
        channel.recv_stderr_ready.return_value = False
        channel.exit_status_ready.return_value = True
        channel.recv_exit_status.return_value = 0
        self.assertEqual(collect(remote, 'fast', 3), b'__GMB_MEM_TOTAL_BYTES__=1024\n')
        command = channel.exec_command.call_args.args[0]
        self.assertLess(len(command), 8191)
        script = base64.b64decode(command.split()[-1]).decode('utf-16le')
        self.assertIn("$MetricMode = 'fast'", script)
        self.assertIn('GetSystemTimes', script)

    def test_ssh_roundtrip_and_arbitrary_command_rejection(self):
        # Synthetic data only. Does not demonstrate Windows/GMSSH compatibility.
        left, right = socket.socketpair()
        key = paramiko.RSAKey.generate(2048)
        cfg = SimpleNamespace(timeout=3)
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        with patch.object(Session, 'check_auth_password', return_value=paramiko.AUTH_SUCCESSFUL), \
                patch('gmssh_windows_bridge.bridge.collect', return_value=b'__GMB_CPU_USAGE__=12\n') as collector:
            thread = threading.Thread(target=serve, args=(left, key, cfg, slots), daemon=True)
            thread.start()
            client = paramiko.Transport(right)
            try:
                client.connect(hostkey=key, username='synthetic', password='synthetic')
                for command, expected in ((request('fast', 'echo MUST_NOT_EXECUTE'), 0),
                                          (b'echo unsupported', 126)):
                    channel = client.open_session(timeout=3)
                    channel.settimeout(3)
                    channel.exec_command(command)
                    payload = channel.makefile('rb').read()
                    self.assertEqual(channel.recv_exit_status(), expected)
                    if expected == 0:
                        self.assertEqual(payload, b'__GMB_CPU_USAGE__=12\n')
                    channel.close()
                collector.assert_called_once_with(None, 'fast', 3)
                with self.assertRaises(paramiko.ChannelException):
                    client.open_channel('direct-tcpip', ('example.invalid', 22), ('127.0.0.1', 1234), timeout=3)
            finally:
                client.close()
                thread.join(5)
                right.close()
                left.close()
            self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()
