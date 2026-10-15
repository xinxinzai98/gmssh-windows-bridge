import base64
import hashlib
import json
import struct
import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import paramiko

from gmssh_windows_bridge.pairing import AssetHandler, inspect_connection, probe_identity


def exported():
    kind = b'ssh-ed25519'
    blob = struct.pack('!I', len(kind)) + kind + struct.pack('!I', 32) + b's' * 32
    return {'schema': 1, 'computer': 'LAB-PC', 'username': 'gmssh', 'sshPort': 22,
            'addresses': ['100.64.0.7', '192.0.2.42'],
            'sshHostPublicKey': 'ssh-ed25519 ' + base64.b64encode(blob).decode() + ' system@fixture',
            'sshHostFingerprint': '256 SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=') + ' system@fixture (ED25519)',
            'wakeAdapters': [{'address': '192.0.2.42', 'mac': '02:00:00:00:00:01', 'prefixLength': 24}]}


class PairingTests(unittest.TestCase):
    def test_public_export_normalizes_identity_addresses_and_physical_adapter(self):
        data = exported()
        result = inspect_connection('\ufeff' + json.dumps(data))
        self.assertEqual(result['addresses'], ['192.0.2.42', '100.64.0.7'])
        self.assertEqual(result['adapters'][0]['broadcast'], '192.0.2.255')
        self.assertNotIn('system@fixture', result['sshHostPublicKey'])
        data['computer'] = '其他名称'
        self.assertEqual(inspect_connection(json.dumps(data))['id'], result['id'])
        data['username'] = 'other-user'
        self.assertNotEqual(inspect_connection(json.dumps(data))['id'], result['id'])

    def test_rejects_bad_exports_before_network_access(self):
        for change in [{'schema': True}, {'schema': 2}, {'sshPort': True}, {'sshPort': 0},
                       {'addresses': ['127.0.0.1']}, {'addresses': ['169.254.1.2']},
                       {'username': 'user\ncommand'}, {'computer': '<script>'},
                       {'sshHostFingerprint': 'SHA256:' + 'a' * 43},
                       {'sshHostPublicKey': 'ssh-ed25519 AAAA'}, {'password': 'synthetic-secret'}, {'desktopAuth': 'unexpected'}]:
            with self.subTest(change=tuple(change)):
                with self.assertRaises(ValueError):
                    inspect_connection(json.dumps({**exported(), **change}))
        for text in ['{"schema":1,"schema":1}', '[]', 'not JSON', '{"schema":NaN}', 'x' * 65537]:
            with self.assertRaises(ValueError): inspect_connection(text)

    def test_identity_probe_checks_only_exported_address_and_key_without_login(self):
        connection = inspect_connection(json.dumps(exported()))
        key = paramiko.Ed25519Key(data=base64.b64decode(connection['sshHostPublicKey'].split()[1]))
        transport = MagicMock()
        transport.get_remote_server_key.return_value = key
        with patch('gmssh_windows_bridge.pairing.socket.create_connection') as connect, patch('gmssh_windows_bridge.pairing.paramiko.Transport', return_value=transport):
            self.assertTrue(probe_identity(connection, '192.0.2.42')['verified'])
            connect.assert_called_once_with(('192.0.2.42', 22), timeout=5)
            transport.auth_password.assert_not_called()
            transport.close.assert_called_once()
            transport.get_remote_server_key.return_value = MagicMock(get_name=lambda: 'ssh-ed25519', get_base64=lambda: 'changed')
            with self.assertRaises(ValueError): probe_identity(connection, '192.0.2.42')
        with patch('gmssh_windows_bridge.pairing.socket.create_connection') as connect:
            with self.assertRaises(ValueError): probe_identity(connection, '192.0.2.99')
            connect.assert_not_called()

    def test_shared_auth_is_explicit_and_public_assets_cannot_serve_connection_or_directory_data(self):
        data = exported()
        self.assertEqual(inspect_connection(json.dumps(data))['desktopAuth'], 'manual')
        data['desktopAuth'] = 'shared-ssh'
        self.assertEqual(inspect_connection(json.dumps(data))['desktopAuth'], 'shared-ssh')
        server = ThreadingHTTPServer(('127.0.0.1', 0), AssetHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            with http.open(base + '/ui-icons/windows.svg', timeout=3) as response:
                self.assertIn(b'<svg', response.read())
            for resource in ['/', '/config.json', '/brand/../../setup-windows.ps1', '/ui-icons/%2e%2e/collector.ps1']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    http.open(base + resource, timeout=3)
                self.assertEqual(error.exception.code, 404)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=3)
