import base64
import datetime
import hashlib
import json
import socket
import ssl
import struct
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from gmssh_windows_bridge.connection_code import PREFIX, PORT, inspect_code, redeem_code
from gmssh_windows_bridge.pairing import inspect_connection


def public_connection():
    kind = b'ssh-ed25519'
    blob = struct.pack('!I', len(kind)) + kind + struct.pack('!I', 32) + b'c' * 32
    return {'schema': 1, 'computer': 'LAB-PC', 'username': 'gmssh', 'sshPort': 22,
            'addresses': ['192.168.250.2'], 'desktopAuth': 'shared-ssh',
            'sshHostPublicKey': 'ssh-ed25519 ' + base64.b64encode(blob).decode(),
            'sshHostFingerprint': 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')}


def encode(payload):
    return PREFIX + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')


def certificate(public):
    name = 'gmssh-' + inspect_connection(json.dumps(public))['id'] + '.local'
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365 * 30))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM).decode(), key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


class CodeTests(unittest.TestCase):
    def setUp(self):
        self.public = public_connection()
        self.cert, key = certificate(self.public)
        self.payload = {'schema': 1, 'connection': self.public, 'port': PORT, 'certificate': self.cert,
                        'token': base64.urlsafe_b64encode(b't' * 32).decode().rstrip('=')}
        self.password = 'synthetic-windows-secret'
        self.calls = []
        self.status = 200
        self.response = None
        self.temp = tempfile.TemporaryDirectory()
        folder = Path(self.temp.name)
        (folder / 'cert.pem').write_text(self.cert)
        (folder / 'key.pem').write_bytes(key)
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                owner.calls.append((self.path, self.headers.get('Authorization')))
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                status = owner.status if self.headers.get('Authorization') == 'Bearer ' + owner.payload['token'] else 403
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                if status == 302:
                    self.send_header('Location', 'https://example.invalid/never-follow')
                self.end_headers()
                result = owner.response or {'schema': 1, 'username': owner.public['username'],
                                            'fingerprint': owner.public['sshHostFingerprint'], 'password': owner.password}
                self.wfile.write(json.dumps(result if status == 200 else {'ok': False}).encode())

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.load_cert_chain(folder / 'cert.pem', folder / 'key.pem')
        self.server.socket = self.tls.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        original_socket = socket.create_connection
        self.original_socket = original_socket

        def local_socket(address, timeout):
            self.assertEqual(address, (self.public['addresses'][0], PORT))
            return original_socket(('127.0.0.1', self.server.server_port), timeout=timeout)

        self.network = patch('gmssh_windows_bridge.connection_code.socket.create_connection', side_effect=local_socket)
        self.network_mock = self.network.start()
        self.identity = patch('gmssh_windows_bridge.connection_code.probe_identity', return_value={'verified': True})
        self.identity_mock = self.identity.start()

    def tearDown(self):
        self.network.stop(); self.identity.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)
        self.temp.cleanup()

    def test_long_lived_code_reuses_pinned_tls_without_password_in_clipboard(self):
        code = encode(self.payload)
        self.assertNotIn(self.password.encode(), base64.urlsafe_b64decode(code[len(PREFIX):] + '=' * (-len(code[len(PREFIX):]) % 4)))
        self.assertNotIn('expiresAt', self.payload)
        for _ in range(2):
            self.assertEqual(redeem_code(code, self.public['addresses'][0]), {'password': self.password})
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][0], '/v1/connect')
        self.assertTrue(inspect_code(code)['public']['desktopAuth'] == 'shared-ssh')

    def test_supplied_ipv6_target_uses_the_original_ssh_and_tls_identity(self):
        class IPv6Server(ThreadingHTTPServer): address_family=socket.AF_INET6
        try: server=IPv6Server(('::1',0),self.server.RequestHandlerClass)
        except OSError: self.skipTest('IPv6 loopback unavailable')
        server.socket=self.tls.wrap_socket(server.socket,server_side=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        original_socket=self.original_socket
        target='2001:db8::42'
        def ipv6_socket(address,timeout):
            self.assertEqual(address,(target,PORT))
            return original_socket(('::1',server.server_port),timeout=timeout)
        self.network_mock.side_effect=ipv6_socket
        try:
            self.assertEqual(redeem_code(encode(self.payload),target)['password'],self.password)
            inspected=self.identity_mock.call_args.args[0]
            self.assertEqual(inspected['sshHostPublicKey'],self.public['sshHostPublicKey'])
            self.assertEqual(inspected['addresses'],[target]);self.assertEqual(self.calls[0][0],'/v1/connect')
            self.payload['connection']={**self.public,'addresses':[target]}
            self.assertEqual(inspect_code(encode(self.payload))['public']['addresses'],[target])
        finally: server.shutdown();server.server_close();thread.join(3)

    def test_reset_rejects_the_old_code_and_accepts_replacement(self):
        old = encode(self.payload)
        self.payload['token'] = base64.urlsafe_b64encode(b'n' * 32).decode().rstrip('=')
        with self.assertRaisesRegex(ValueError, '失效|重置'):
            redeem_code(old, self.public['addresses'][0])
        self.assertEqual(redeem_code(encode(self.payload), self.public['addresses'][0])['password'], self.password)

    def test_changed_ssh_identity_stops_before_the_access_credential_is_sent(self):
        self.identity_mock.side_effect = ValueError('SSH identity changed')
        with self.assertRaises(ValueError):
            redeem_code(encode(self.payload), self.public['addresses'][0])
        self.network_mock.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_another_certificate_cannot_receive_the_token(self):
        other, _ = certificate(self.public)
        code = encode({**self.payload, 'certificate': other})
        with self.assertRaisesRegex(ValueError, '验证|连接'):
            redeem_code(code, self.public['addresses'][0])
        self.assertEqual(self.calls, [])

    def test_redirects_and_mismatched_accounts_never_return_a_credential(self):
        self.status = 302
        with self.assertRaises(ValueError):
            redeem_code(encode(self.payload), self.public['addresses'][0])
        self.assertEqual(self.network_mock.call_count, 1)
        self.status = 200
        self.response = {'schema': 1, 'username': 'different-user', 'fingerprint': self.public['sshHostFingerprint'], 'password': self.password}
        with self.assertRaisesRegex(ValueError, '身份不一致'):
            redeem_code(encode(self.payload), self.public['addresses'][0])

    def test_malformed_or_non_lan_codes_are_rejected_without_network_access(self):
        for change in [{'schema': True}, {'port': 22}, {'token': 'short'}, {'expiresAt': 1},
                       {'certificate': self.cert + self.cert}, {'password': self.password},
                       {'connection': {**self.public, 'addresses': ['192.0.2.42']}},
                       {'connection': {**self.public, 'desktopAuth': 'manual'}}]:
            with self.subTest(change=tuple(change)):
                with self.assertRaises(ValueError):
                    inspect_code(encode({**self.payload, **change}))
        for text in [PREFIX + '!!', encode(self.payload) + '=', 'not a code', 'x' * 32769]:
            with self.assertRaises(ValueError): inspect_code(text)
        self.network_mock.assert_not_called()
