import json
import importlib.util
import unittest
import threading
from types import SimpleNamespace
from unittest.mock import patch

from gmssh_windows_bridge.keychain import WindowsLoginKeychain, DeviceKeychain, windows_login_keychain
from gmssh_windows_bridge.desktop_operations import OperationsSession, OperationError
from gmssh_windows_bridge.desktop import create_server


class Store:
    account = b'ssh-device:synthetic-pinned-identity:21118'
    value = None
    def get(self): return self.value
    def save(self, value): self.value = value
    def delete(self): self.value = None


class WindowsLoginTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec('websockets'), 'optional desktop dependency not installed')
    def test_local_socket_requires_token_before_any_windows_password_access(self):
        from websockets.sync.client import connect
        store = WindowsLoginKeychain(Store())
        config = SimpleNamespace(listen_port=0, target='synthetic.invalid', username='synthetic',
                                 target_port=22, timeout=2, windows_login_store=store)
        with self.assertRaises(ValueError): create_server(config)
        config.access_token = 's' * 43
        with create_server(config) as server:
            thread = threading.Thread(target=server.serve_forever); thread.start()
            origin = f'http://127.0.0.1:{server.socket.getsockname()[1]}'
            try:
                with patch.object(store, 'get', wraps=store.get) as read:
                    with connect(origin.replace('http:', 'ws:') + '/operations', origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({'token': 'wrong'}))
                        self.assertEqual(json.loads(ws.recv(timeout=3))['code'], 'DesktopAccessError')
                    read.assert_not_called()
                    with connect(origin.replace('http:', 'ws:') + '/operations', origin=origin, proxy=None) as ws:
                        ws.send(json.dumps({'token': config.access_token}))
                        self.assertEqual(json.loads(ws.recv(timeout=3))['type'], 'operations_ready')
                        ws.send(json.dumps({'id': 1, 'op': 'windows-login', 'action': 'status', 'settings': {}}))
                        self.assertEqual(json.loads(ws.recv(timeout=3)), {'id': 1, 'ok': True, 'configured': False, 'autoUnlock': False})
                    read.assert_called_once()
            finally:
                server.shutdown(); thread.join(timeout=3)

    def test_separate_item_and_default_off_save_load_clear(self):
        desktop = Store()
        with patch('gmssh_windows_bridge.keychain.DesktopKeychain', side_effect=lambda account: SimpleNamespace(account=account)):
            scoped = windows_login_keychain(DeviceKeychain(desktop, []))
            self.assertEqual(scoped.store.account, 'windows-login:ssh-device:synthetic-pinned-identity:21118')
        store = WindowsLoginKeychain(Store())
        self.assertIsNone(store.get())
        store.save({'password': 'synthetic-Windows-password', 'autoUnlock': True})
        self.assertEqual(store.get()['password'], 'synthetic-Windows-password')
        self.assertIsNone(desktop.value)
        store.clear()
        self.assertIsNone(store.get())
        for bad in ({'password': '', 'autoUnlock': True}, {'password': 'synthetic\rpassword', 'autoUnlock': True},
                    {'password': '中' * 342, 'autoUnlock': True}, {'password': 'synthetic', 'autoUnlock': 1},
                    {'password': 'synthetic', 'autoUnlock': True, 'target': 'other-device'}):
            with self.assertRaises(ValueError): store.save(bad)

    def test_grant_login_store_is_bound_to_the_actual_tls_authority_without_the_token(self):
        desktop = Store()
        with patch('gmssh_windows_bridge.keychain.DesktopKeychain', side_effect=lambda account: SimpleNamespace(account=account)):
            first = {'certificate': 'a' * 64, 'id': '1' * 32, 'token': 'synthetic-first-token'}
            reference = windows_login_keychain(desktop, first).store.account
            self.assertEqual(reference, windows_login_keychain(desktop, {**first, 'token': 'synthetic-rotated-token'}).store.account)
            self.assertNotEqual(reference, windows_login_keychain(desktop, {**first, 'certificate': 'b' * 64}).store.account)
            self.assertNotEqual(reference, windows_login_keychain(desktop, {**first, 'id': '2' * 32}).store.account)
            self.assertNotIn('token', reference)

    def test_operation_never_returns_password_in_status_or_writes_without_input_permission(self):
        store = WindowsLoginKeychain(Store())
        ws = SimpleNamespace(send=lambda raw: replies.append(json.loads(raw)))
        config = SimpleNamespace(windows_login_store=store, controller_policy=lambda: {'input': True})
        session = OperationsSession(None, ws, 1, config=config)
        replies = []
        def request(action, settings=None): session.request({'id': 1, 'op': 'windows-login', 'action': action, 'settings': settings or {}})
        request('status')
        self.assertEqual(replies[-1], {'id': 1, 'ok': True, 'configured': False, 'autoUnlock': False})
        request('save', {'password': 'synthetic-Windows-password', 'autoUnlock': True})
        self.assertNotIn('password', replies[-1])
        request('status')
        self.assertNotIn('password', replies[-1])
        request('load')
        self.assertEqual(replies[-1]['password'], 'synthetic-Windows-password')
        config.controller_policy = lambda: {'input': False}
        for action in ('status', 'load', 'clear'):
            with self.assertRaises(OperationError): request(action)
        self.assertIsNotNone(store.get())
        config.controller_policy = lambda: {'input': True}
        request('clear')
        self.assertIsNone(store.get())
        self.assertFalse(replies[-1]['autoUnlock'])


if __name__ == '__main__': unittest.main()
