import base64
import hashlib
import json
import ipaddress
import struct
import unittest
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import paramiko

from gmssh_windows_bridge.pairing import AssetHandler, inspect_connection, inspect_manual, probe_identity, test_credentials, choose_target


def exported():
    kind = b'ssh-ed25519'
    blob = struct.pack('!I', len(kind)) + kind + struct.pack('!I', 32) + b's' * 32
    return {'schema': 1, 'computer': 'LAB-PC', 'username': 'gmssh', 'sshPort': 22,
            'addresses': ['100.64.0.7', '192.0.2.42'],
            'sshHostPublicKey': 'ssh-ed25519 ' + base64.b64encode(blob).decode() + ' system@fixture',
            'sshHostFingerprint': '256 SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=') + ' system@fixture (ED25519)',
            'wakeAdapters': [{'address': '192.0.2.42', 'mac': '02:00:00:00:00:01', 'prefixLength': 24}]}


class PairingTests(unittest.TestCase):
    def test_auto_address_uses_a_pinned_ipv6_when_ipv4_is_unreachable(self):
        connection=inspect_connection(json.dumps({**exported(),'addresses':['192.0.2.42','2001:db8::42']}))
        checked=[]
        def probe(value,target,timeout):
            checked.append(target)
            self.assertIs(value,connection);self.assertEqual(timeout,1.5)
            if target=='192.0.2.42':raise OSError('unreachable')
        with patch('gmssh_windows_bridge.pairing.probe_identity',side_effect=probe):
            result=choose_target(connection,'192.0.2.42')
        self.assertEqual(result,{'target':'2001:db8::42','verified':True})
        self.assertIn('2001:db8::42',checked)
        with patch('gmssh_windows_bridge.pairing.probe_identity') as probe:
            self.assertEqual(choose_target(connection,'2001:db8::42')['target'],'2001:db8::42')
            probe.assert_called_once_with(connection,'2001:db8::42',timeout=1.5)
        with patch('gmssh_windows_bridge.pairing.probe_identity',side_effect=ValueError('identity mismatch')):
            with self.assertRaisesRegex(ValueError,'主机身份'):choose_target(connection)

    def test_auto_address_checks_tls_without_sending_a_bearer_or_password(self):
        connection=inspect_connection(json.dumps({**exported(),'addresses':['2001:db8::42']}))
        with patch('gmssh_windows_bridge.pairing.probe_identity') as ssh,patch('gmssh_windows_bridge.connection_code._PinnedConnection') as tls:
            result=choose_target(connection,code={'certificate':'synthetic'})
            self.assertTrue(result['verified']);ssh.assert_called_once()
            tls.return_value.connect.assert_called_once();tls.return_value.request.assert_not_called();tls.return_value.close.assert_called_once()

    def test_locality_precedes_family_and_last_address_never_overrides_priority(self):
        order=['2001:db8:1::42','192.0.2.42','2001:db8:2::42','10.99.0.42']
        connection=inspect_connection(json.dumps({**exported(),'addresses':list(reversed(order))}))
        networks=[ipaddress.ip_network('2001:db8:1::/64'),ipaddress.ip_network('192.0.2.0/24')]
        for first in range(4):
            checked=[]
            def probe(_connection,target,timeout):
                checked.append(target)
                if target in order[:first]:raise OSError('unavailable')
            with patch('gmssh_windows_bridge.network_routes.local_networks',return_value=networks),patch('gmssh_windows_bridge.pairing.probe_identity',side_effect=probe):
                self.assertEqual(choose_target(connection,preferred=order[-1])['target'],order[first])
            self.assertEqual(checked,order[:first+1])

    def test_manual_ipv6_reads_only_the_public_key_before_password_authentication(self):
        connection=inspect_connection(json.dumps(exported()))
        key=paramiko.Ed25519Key(data=base64.b64decode(connection['sshHostPublicKey'].split()[1]))
        transport=MagicMock();transport.get_remote_server_key.return_value=key
        with patch('gmssh_windows_bridge.pairing.socket.create_connection') as connect, patch('gmssh_windows_bridge.pairing.paramiko.Transport',return_value=transport):
            result=inspect_manual({'computer':'LAB-PC','username':'gmssh','target':'[2001:0db8::42]:2222','port':22})
            connect.assert_called_once_with(('2001:db8::42',2222),timeout=5)
            transport.auth_password.assert_not_called();self.assertEqual(result['desktopAuth'],'manual')
            self.assertEqual(result['sshHostPublicKey'],connection['sshHostPublicKey'])
        with patch('gmssh_windows_bridge.pairing.paramiko.SSHClient') as factory:
            self.assertTrue(test_credentials(result,'2001:db8::42','synthetic-password')['verified'])
            client=factory.return_value;client.get_host_keys.return_value.add.assert_called_once_with('[2001:db8::42]:2222','ssh-ed25519',key)
            self.assertFalse(client.connect.call_args.kwargs['allow_agent']);self.assertFalse(client.connect.call_args.kwargs['look_for_keys'])
            client.close.assert_called_once()
            client.connect.side_effect=paramiko.AuthenticationException()
            with self.assertRaisesRegex(ValueError,'原设备配置已保留'): test_credentials(result,'2001:db8::42','incorrect')

    def test_ipv6_export_keeps_identity_and_ipv4_wake_metadata(self):
        data=exported();before=inspect_connection(json.dumps(data))
        data['addresses']=['2001:0DB8:0:0::10','192.0.2.42','2001:db8::10']
        result=inspect_connection(json.dumps(data))
        self.assertEqual(result['id'],before['id'])
        self.assertEqual(result['addresses'],['192.0.2.42','2001:db8::10'])
        self.assertEqual(result['adapters'],before['adapters'])

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
