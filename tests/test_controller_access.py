import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import ssl
import tempfile
import threading
import time
import queue
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gmssh_windows_bridge.controller_access import PREFIX, ControllerClient, ControllerCommand, ControllerDesktopSocket, configuration, metadata_connection, inspect_authorization, public_authorization
from gmssh_windows_bridge.desktop import frame_header
from gmssh_windows_bridge.file_stream import StreamError
from tests.test_connection_code import certificate, public_connection


def encode(value):
    return PREFIX+base64.urlsafe_b64encode(json.dumps(value, separators=(',', ':')).encode()).decode().rstrip('=')


class ControllerAccessTests(unittest.TestCase):
    def test_source_rejection_keeps_a_distinct_error_code(self):
        response=type('Response',(),{'status':403,'read':lambda _self,_limit:b'{"ok":false,"code":"SOURCE_DENIED"}'})()
        with patch('gmssh_windows_bridge.controller_access._PinnedConnection') as connection:
            connection.return_value.getresponse.return_value=response
            client=ControllerClient('192.168.250.2',inspect_authorization(encode(self.payload)))
            try:
                with self.assertRaises(StreamError) as error:client.authorize()
                self.assertEqual(error.exception.code,'SOURCE_DENIED')
                self.assertFalse(client.is_authenticated())
            finally:client.close()

    def setUp(self):
        self.public = public_connection()
        self.cert, self.key = certificate(self.public)
        self.token = base64.urlsafe_b64encode(b'z'*32).decode().rstrip('=')
        self.policy = dict(view=True, input=False, clipboard=False, files=False, terminal=False, power=False)
        self.payload = dict(schema=2, connection=self.public, port=22257, certificate=self.cert,
                            controller=dict(id='f'*32, name='Synthetic viewer', token=self.token, permissions=self.policy))

    def test_authorization_preview_omits_all_tokens_and_binds_the_controller_to_the_device(self):
        code = inspect_authorization(encode(self.payload))
        preview = public_authorization(code)
        self.assertNotIn(self.token, json.dumps(preview))
        self.assertNotIn('certificate', preview)
        self.assertTrue(preview['fromAuthorization'])
        self.assertNotEqual(preview['id'], code['public']['id'])
        changed = json.loads(json.dumps(self.payload))
        changed['controller']['id'] = 'a'*32
        self.assertNotEqual(inspect_authorization(encode(changed))['id'], code['id'])
        for mutate in [lambda p: p.update(schema=True), lambda p: p['controller'].update(token='bad'),
                       lambda p: p['controller']['permissions'].update(input=True, view=False),
                       lambda p: p['controller']['permissions'].update(terminal=1),
                       lambda p: p['controller']['permissions'].update(unrecognized=True),
                       lambda p: p['controller'].update(password='not allowed')]:
            bad = json.loads(json.dumps(self.payload)); mutate(bad)
            with self.assertRaises(ValueError):
                inspect_authorization(encode(bad))

    def test_public_configuration_restores_without_a_bearer_and_keeps_legacy_identity_separate(self):
        from gmssh_windows_bridge.pairing import inspect_connection
        code = inspect_authorization(encode(self.payload)); text = metadata_connection(code)
        self.assertNotIn(self.token, text)
        restored = inspect_connection(text)
        self.assertEqual(restored['id'], code['id']); self.assertEqual(restored['physicalId'], code['public']['id'])
        self.assertEqual(restored['desktopAuth'], 'controller')
        rebuilt = configuration(restored)
        self.assertEqual(rebuilt['controller']['id'], code['controller']['id'])
        self.assertNotEqual(rebuilt['token'], self.token)
        bad = json.loads(text); bad['authorization']['controller']['token'] = self.token
        with self.assertRaises(ValueError):
            inspect_connection(json.dumps(bad))

    def test_preserved_account_authorization_keeps_pinned_identity_without_exporting_passwords(self):
        from gmssh_windows_bridge.pairing import inspect_connection
        self.payload['connection'].update(username='Existing User', sshPort=2222, desktopAuth='manual')
        cert, _ = certificate(self.payload['connection'])
        self.payload['certificate'] = cert
        code = inspect_authorization(encode(self.payload))
        self.assertEqual(code['public']['username'], 'Existing User')
        self.assertEqual(code['public']['desktopAuth'], 'manual')
        text = metadata_connection(code)
        self.assertNotIn(self.token, text)
        restored = inspect_connection(text)
        self.assertEqual(restored['desktopAuth'], 'controller')
        self.assertEqual(restored['sshPort'], 2222)
        self.assertEqual(configuration(restored)['public']['username'], 'Existing User')

    def test_optional_server_read_only_policy_preserves_legacy_full_grants(self):
        payload=json.loads(json.dumps(self.payload));payload['controller']['permissions']['files_read']=True
        code=inspect_authorization(encode(payload))
        self.assertTrue(code['controller']['permissions']['files_read'])
        from gmssh_windows_bridge.pairing import inspect_connection
        restored=configuration(inspect_connection(metadata_connection(code)))
        self.assertTrue(restored['controller']['permissions']['files_read'])
        payload['controller']['permissions']['files']=True
        full=inspect_authorization(encode(payload))
        self.assertEqual(len(full['controller']['permissions']),6)
        self.assertNotIn('files_read',full['controller']['permissions'])
        payload['controller']['permissions']['files_read']=1
        with self.assertRaises(ValueError):inspect_authorization(encode(payload))

    def test_server_read_only_grant_requires_capability_and_timeouts_never_replay(self):
        code=inspect_authorization(encode(self.payload));client=ControllerClient('192.168.250.2',code)
        policy={**self.policy,'files_read':True}
        with patch.object(client,'call',return_value={'protocol':2,'controllerId':'f'*32,'permissions':policy}) as call:
            with self.assertRaisesRegex(StreamError,'SERVER_UPGRADE_REQUIRED'):client.authorize()
            self.assertFalse(client.authenticated);self.assertEqual(call.call_count,1)
        with patch.object(client,'call',return_value={'protocol':2,'controllerId':'f'*32,'permissions':policy,'fileReadOnly':1}):
            client.authorize();self.assertTrue(client.authenticated);self.assertTrue(client.file_read_only)
        with patch('gmssh_windows_bridge.controller_access._PinnedConnection') as connection:
            connection.return_value.request.side_effect=TimeoutError('synthetic timeout')
            with self.assertRaisesRegex(StreamError,'OPERATION_TIMEOUT'):client.call('ai-task-start',args={'key':'a'*32,'command':'synthetic','timeout':1})
            self.assertEqual(connection.return_value.request.call_count,1)
            self.assertFalse(client.authenticated);self.assertIsNone(client.local.connection)
            connection.return_value.close.assert_called_once()
        client.close()

    def test_windows_unlock_capability_requires_explicit_new_server_support(self):
        code=inspect_authorization(encode(self.payload));client=ControllerClient('192.168.250.2',code)
        base={'protocol':2,'controllerId':'f'*32,'permissions':self.policy}
        for value,expected in [(None,False),(True,False),(0,False),('1',False),(1,True)]:
            with patch.object(client,'call',return_value={**base,'windowsUnlock':value}):
                client.authorize();self.assertEqual(client.windows_unlock,expected)
        client.close()

    def test_native_bridge_accepts_only_its_grant_and_enforces_terminal_policy(self):
        from gmssh_windows_bridge.controller_session import ControllerSession
        attached = []
        code = inspect_authorization(encode(self.payload))
        config = SimpleNamespace(username='gmssh', target='192.168.250.2', controller_configuration=code,
                                 desktop_sessions=SimpleNamespace(attach=lambda c: attached.append(c)), gmssh_terminal=True, enable_terminal=True)
        class Client:
            def __init__(_self, target, code, token):
                _self.token = token; _self.policy = dict(self.policy)
            def authorize(_self):
                if _self.token != self.token:
                    raise StreamError('AUTH_FAILED')
            def close(_self):
                pass
        with patch('gmssh_windows_bridge.controller_session.ControllerClient', Client):
            session = ControllerSession(config)
            self.assertEqual(session.check_auth_password('other', self.token), 2)
            self.assertEqual(session.check_auth_password('gmssh', self.token), 0)
            self.assertEqual(len(attached), 1)
            channel = SimpleNamespace(get_id=lambda: 1)
            self.assertFalse(session.check_channel_pty_request(channel, b'xterm', 80, 24, 0, 0, b''))
            self.assertTrue(session.check_channel_exec_request(channel, b'Stop-Service sshd'))
            self.assertEqual(session.pending[1][1], 'unsupported')

    def test_terminal_channel_keeps_unicode_vt_input_resize_and_close(self):
        class Client:
            def __init__(_self):
                _self.data = queue.Queue(); _self.calls = []; _self.finished = False
            def open(_self, kind):
                self.assertEqual(kind, 'terminal'); return 'a'*32
            def call(_self, action, session, **values):
                _self.calls.append((action, values))
                if action == 'terminal-read':
                    try:
                        value = _self.data.get(timeout=.05)
                    except queue.Empty:
                        return {'waiting': True}
                    return {'closed': True, 'exit': 0} if value is None else {'data': base64.b64encode(value).decode()}
                if action == 'terminal-write':
                    value = base64.b64decode(values['args']['data']); _self.data.put(value); return {'written': len(value)}
                return {'started': True}
            def close_session(_self, session):
                _self.finished = True; _self.data.put(None)
        client = Client(); channel = ControllerCommand(client)
        channel.get_pty(width=100, height=30); channel.invoke_shell()
        text = '中文'.encode()+b'\x1b[A\x03\r'; channel.sendall(text)
        for _ in range(100):
            if channel.recv_ready(): break
            time.sleep(.01)
        self.assertEqual(channel.recv(1000), text)
        channel.resize_pty(120, 40)
        self.assertEqual(client.calls[-1][1]['args'], {'width': 120, 'height': 40})
        channel.close(); self.assertTrue(client.finished)

    def test_pinned_https_reuses_connections_and_reads_actual_server_policy(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name); (root/'cert.pem').write_text(self.cert); (root/'key.pem').write_bytes(self.key)
        calls, owner = [], self
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            def log_message(self, *_):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path, body, self.headers.get('X-GMSSH-Controller'), self.headers.get('Authorization')))
                valid = self.headers.get('Authorization') == 'Bearer '+owner.token and self.headers.get('X-GMSSH-Controller') == 'f'*32
                result = dict(protocol=2, controllerId='f'*32, name='Synthetic viewer', permissions={**owner.policy, 'files': True}) if body['action'] == 'capabilities' else {'data': base64.b64encode(b'synthetic metadata').decode()}
                raw = json.dumps({'ok': True, 'result': result} if valid else {'ok': False, 'code': 'ACCESS_DENIED'}).encode()
                self.send_response(200 if valid else 403); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(root/'cert.pem', root/'key.pem'); server.socket = context.wrap_socket(server.socket, server_side=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        code = inspect_authorization(encode(self.payload)); code['port'] = server.server_port
        from gmssh_windows_bridge.connection_code import _PinnedConnection
        routed = patch('gmssh_windows_bridge.controller_access._PinnedConnection', side_effect=lambda _target, value: _PinnedConnection('127.0.0.1', value))
        routed.start(); self.addCleanup(routed.stop)
        client = ControllerClient('192.168.250.2', code); self.addCleanup(client.close)
        client.authorize(); first = client.local.connection
        self.assertTrue(client.policy['files']); self.assertTrue(client.is_authenticated())
        self.assertEqual(client.info('metrics-fast'), b'synthetic metadata'); self.assertIs(client.local.connection, first)
        self.assertEqual(calls[0][0], '/v2/controller'); self.assertNotIn('password', json.dumps(calls))
        invalid = ControllerClient('192.168.250.2', code, token='x'*43); self.addCleanup(invalid.close)
        with self.assertRaisesRegex(StreamError, 'AUTH_FAILED'):
            invalid.authorize()
        before = len(calls); wrong, _ = certificate(self.public); changed = {**code, 'certificate': wrong}
        other = ControllerClient('192.168.250.2', changed); self.addCleanup(other.close)
        with self.assertRaises(StreamError):
            other.authorize()
        self.assertEqual(len(calls), before)

    def test_desktop_adapter_preserves_framing_without_requesting_a_password(self):
        class Client:
            def __init__(self):
                self.calls = []; self.closed = []
            def open(self, kind):
                self.calls.append(('open', kind)); return 'a'*32
            def call(self, action, session, **values):
                self.calls.append((action, values)); return {'data': base64.b64encode(b'wire data').decode()} if action == 'desktop-read' else {'written': True}
            def close_session(self, session):
                self.closed.append(session)
        client = Client(); channel = ControllerDesktopSocket(client)
        expected = frame_header(9)+b'wire data'; self.assertEqual(channel.recv(2)+channel.recv(100), expected)
        channel.sendall(frame_header(3)+b'abc')
        self.assertEqual(base64.b64decode(client.calls[-1][1]['args']['data']), b'abc')
        with self.assertRaisesRegex(StreamError, 'INVALID_TRANSFER'):
            channel.sendall(frame_header(1)+b'too long')
        channel.close(); channel.close(); self.assertEqual(len(client.closed), 1)
        self.assertNotIn('password', json.dumps(client.calls))


if __name__ == '__main__':
    unittest.main()
