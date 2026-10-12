import importlib.util
import json
import socket
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import paramiko
from gmssh_windows_bridge.desktop import MAX_FRAME, connect_target, create_server, frame_header, read_frame


class DesktopTransportTests(unittest.TestCase):
    def test_native_header_vectors_and_fragmented_packets(self):
        # Native RustDesk BytesCodec boundary vectors, independent of a round trip.
        vectors = {0: b'\x00', 63: b'\xfc', 64: b'\x01\x01',
                   16383: b'\xfd\xff', 16384: b'\x02\x00\x01',
                   4194303: b'\xfe\xff\xff', 4194304: b'\x03\x00\x00\x01'}
        for size, header in vectors.items():
            self.assertEqual(frame_header(size), header)
        for size in (-1, MAX_FRAME + 1):
            with self.assertRaises(ValueError): frame_header(size)
        stopped = threading.Event()
        channel = MagicMock()
        # A non-minimal two-byte header for a three-byte payload must still decode.
        channel.recv.side_effect = [b'\x0d', b'\x00', b'a', b'b', b'c']
        self.assertEqual(read_frame(channel, stopped), b'abc')
        channel.recv.side_effect = [((MAX_FRAME + 1) << 2 | 3).to_bytes(4, 'little')[:1],
                                    ((MAX_FRAME + 1) << 2 | 3).to_bytes(4, 'little')[1:]]
        with self.assertRaises(ValueError): read_frame(channel, stopped)
        channel.recv.side_effect = [b'\x01', b'']
        with self.assertRaises(EOFError): read_frame(channel, stopped)

    def test_target_host_identity_is_required_and_failed_client_is_closed(self):
        cfg = SimpleNamespace(known_hosts=Path('synthetic-known-hosts'), target='windows.example.invalid',
                              username='windows-user', target_port=22, timeout=2)
        with patch('gmssh_windows_bridge.desktop.paramiko.SSHClient') as factory:
            factory.return_value.connect.side_effect = paramiko.SSHException('untrusted host')
            with self.assertRaises(paramiko.SSHException): connect_target(cfg, 'synthetic-password')
            factory.return_value.load_host_keys.assert_called_once_with('synthetic-known-hosts')
            factory.return_value.set_missing_host_key_policy.assert_not_called()
            factory.return_value.close.assert_called_once()
            self.assertFalse(factory.return_value.connect.call_args.kwargs['look_for_keys'])

    @unittest.skipUnless(importlib.util.find_spec('websockets'), 'optional desktop dependency not installed')
    def test_local_http_origin_boundary_and_bidirectional_native_frames(self):
        from websockets.sync.client import connect
        from websockets.exceptions import InvalidStatus
        cfg = SimpleNamespace(listen_port=0, target='windows.example.invalid', username='windows-user',
                              target_port=22, rustdesk_port=21118, known_hosts=Path('synthetic-known-hosts'), timeout=3)
        remote, peer = socket.socketpair()
        client = MagicMock()
        client.get_transport.return_value.open_channel.return_value = remote
        with patch('gmssh_windows_bridge.desktop.connect_target', return_value=client), create_server(cfg) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            port = server.socket.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with http.open(origin + '/config.json', timeout=3) as response:
                    info = json.load(response)
                self.assertEqual(info['username'], 'windows-user')
                req = urllib.request.Request(origin + '/config.json', headers={'Host': 'attacker.example.invalid'})
                with self.assertRaises(urllib.error.HTTPError) as error: http.open(req, timeout=3)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
                with self.assertRaises(urllib.error.HTTPError) as error: http.open(origin + '/%2e%2e/desktop.py', timeout=3)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
                with self.assertRaises(InvalidStatus): connect(f'ws://127.0.0.1:{port}/socket', origin='https://attacker.example.invalid', proxy=None)
                client.get_transport.assert_not_called()
                with connect(f'ws://127.0.0.1:{port}/socket', origin=origin, proxy=None) as ws:
                    ws.send(json.dumps({'password': 'synthetic-password'}))
                    self.assertEqual(json.loads(ws.recv(timeout=3)), {'type': 'ssh_ready'})
                    for chunk in [b'\x0d', b'\x00', b'abc']: peer.sendall(chunk)
                    self.assertEqual(ws.recv(timeout=3), b'abc')
                    ws.send(b'\x08\x01')
                    self.assertEqual(read_frame(peer, threading.Event()), b'\x08\x01')
                client.get_transport.return_value.open_channel.assert_called_once_with(
                    'direct-tcpip', ('127.0.0.1', 21118), ('127.0.0.1', 0), timeout=3)
                dead, closed = socket.socketpair()
                closed.close()
                client.get_transport.return_value.open_channel.return_value = dead
                try:
                    with connect(f'ws://127.0.0.1:{port}/socket', origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({'password': 'synthetic-password'}))
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {'type': 'ssh_ready'})
                        failure = json.loads(ws.recv(timeout=3))
                        self.assertEqual(failure['type'], 'error')
                        self.assertIn('未返回握手', failure['message'])
                finally:
                    dead.close()
            finally:
                server.shutdown(); thread.join(timeout=3)
                remote.close(); peer.close()


if __name__ == '__main__': unittest.main()
