"""Local detached-process checks; no real Windows credentials or target required."""
import os
import importlib.util
import json
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
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

    def detached_roundtrip(self, desktop=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0))
                port = available.getsockname()[1]
            command = self.command(root, port)
            if desktop:
                with socket.socket() as available:
                    available.bind(('127.0.0.1', 0))
                    desktop_port = available.getsockname()[1]
                command.extend(['--desktop-port', str(desktop_port), '--rustdesk-port', '21218'])
            result = subprocess.run(command, cwd=self.package_dir,
                                    capture_output=True, text=True, timeout=35)
            self.assertEqual(result.returncode, 0, result.stderr)
            pid = int(re.search(r'PID (\d+)', result.stdout).group(1))
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=3) as peer:
                    self.assertTrue(peer.recv(128).startswith(b'SSH-2.0-'))
                self.assertIn('Monitoring bridge ready', (root / 'bridge.log').read_text())
                if desktop:
                    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with http.open(f'http://127.0.0.1:{desktop_port}/config.json', timeout=3) as response:
                        self.assertEqual(json.load(response)['username'], 'synthetic')
                    self.assertIn(f'RustDesk desktop preview: http://127.0.0.1:{desktop_port}/', (root / 'bridge.log').read_text())
            finally:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                            time.sleep(0.02)
                    except OSError:
                        break

    def test_child_listens_after_launcher_exits(self):
        self.detached_roundtrip()

    @unittest.skipUnless(importlib.util.find_spec('websockets'), 'optional desktop dependency not installed')
    def test_desktop_and_ssh_both_listen_after_launcher_exits(self):
        self.detached_roundtrip(desktop=True)

    @unittest.skipUnless(sys.platform == 'darwin' and importlib.util.find_spec('websockets'), 'macOS shared viewer startup check')
    def test_windows_unlock_store_is_independent_of_connection_password_storage(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0)); port = available.getsockname()[1]
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0)); desktop_port = available.getsockname()[1]
            command = self.command(root, port)
            command.remove('--background')
            command.extend(['--desktop-port', str(desktop_port), '--desktop-shared-auth'])
            # Shared viewers intentionally stay foreground: do not persist their
            # private browser token to a detached log just to run this check.
            child = subprocess.Popen(command, cwd=self.package_dir, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                deadline = time.monotonic() + 15
                while True:
                    try:
                        with http.open(f'http://127.0.0.1:{desktop_port}/config.json', timeout=1) as response:
                            info = json.load(response)
                        break
                    except OSError:
                        if child.poll() is not None or time.monotonic() > deadline:
                            self.fail('shared viewer did not start')
                        time.sleep(0.05)
                self.assertFalse(info['keychain'])
                self.assertTrue(info['capabilities']['windows_login'])
                self.assertTrue(info['requires_token'])
            finally:
                child.terminate(); child.wait(timeout=5); child.stderr.close()

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
