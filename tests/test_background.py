"""Local detached-process checks; no real Windows credentials or target required."""
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import gmssh_windows_bridge


class BackgroundTests(unittest.TestCase):
    package_dir = Path(gmssh_windows_bridge.__file__).resolve().parent.parent
    def command(self, root, port):
        known = root / 'known hosts'
        known.write_text('')
        return [sys.executable, '-m', 'gmssh_windows_bridge', '--background',
                '--target', 'example.invalid', '--username', 'synthetic',
                '--known-hosts', str(known), '--host-key', str(root / 'host key'),
                '--background-log', str(root / 'bridge.log'), '--listen-port', str(port)]

    def test_child_listens_after_launcher_exits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0))
                port = available.getsockname()[1]
            result = subprocess.run(self.command(root, port), cwd=self.package_dir,
                                    capture_output=True, text=True, timeout=35)
            self.assertEqual(result.returncode, 0, result.stderr)
            pid = int(re.search(r'PID (\d+)', result.stdout).group(1))
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=3) as peer:
                    self.assertTrue(peer.recv(128).startswith(b'SSH-2.0-'))
                self.assertIn('Monitoring bridge ready', (root / 'bridge.log').read_text())
            finally:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                            time.sleep(0.02)
                    except OSError:
                        break

    def test_occupied_port_reports_startup_failure(self):
        with tempfile.TemporaryDirectory() as folder, socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen(1)
            result = subprocess.run(self.command(Path(folder), occupied.getsockname()[1]),
                                    cwd=self.package_dir, capture_output=True, text=True, timeout=35)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('failed to start', result.stderr)
            self.assertNotIn('Background bridge started', result.stdout)


if __name__ == '__main__':
    unittest.main()
