import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from gmssh_windows_bridge.desktop_operations import OperationsSession, OperationError
from gmssh_windows_bridge.file_stream import StreamError


class WindowsLoginResultTests(unittest.TestCase):
    def test_result_comes_from_live_worker_without_reading_or_returning_credentials(self):
        for value, expected in (({'unlocked': True, 'user': 'do-not-return'}, 'unlocked'),
                                ({'unlocked': False}, 'unknown'), ({'unlocked': 1}, 'unknown')):
            client = SimpleNamespace(controller_protocol=2, call=Mock(return_value=value))
            store = Mock(); replies = []
            config = SimpleNamespace(windows_login_store=store, controller_policy=lambda: {'input': False, 'view': True})
            session = OperationsSession(client, SimpleNamespace(send=lambda raw: replies.append(json.loads(raw))), 2, config=config)
            session.request({'id': 1, 'op': 'windows-login', 'action': 'check', 'settings': {}})
            self.assertEqual(replies, [{'id': 1, 'ok': True, 'state': expected}])
            client.call.assert_called_once_with('ai-desktop', args={'operation': 'context'})
            self.assertEqual(store.mock_calls, [])

    def test_locked_secure_desktop_auth_failure_and_unavailable_are_distinct(self):
        for code, expected in (('DESKTOP_LOCKED', 'locked-or-secure'), ('AUTH_FAILED', 'unauthorized'),
                               ('ACCESS_DENIED', 'unauthorized'), ('PEER_CHANGED', 'unauthorized'),
                               ('DESKTOP_WORKER_UNAVAILABLE', 'unknown'), ('OPERATION_TIMEOUT', 'unknown')):
            client = SimpleNamespace(controller_protocol=2, call=Mock(side_effect=StreamError(code)))
            session = OperationsSession(client, None, 2, config=SimpleNamespace())
            self.assertEqual(session.windows_login_state(), {'state': expected})
        legacy = SimpleNamespace(controller_protocol=1, call=Mock())
        self.assertEqual(OperationsSession(legacy, None, 2).windows_login_state(), {'state': 'unknown'})
        legacy.call.assert_not_called()

    def test_view_denial_and_unexpected_settings_stop_before_querying(self):
        client = SimpleNamespace(controller_protocol=2, call=Mock())
        config = SimpleNamespace(controller_policy=lambda: {'input': False, 'view': False})
        session = OperationsSession(client, None, 2, config=config)
        for settings in ({}, {'password': 'synthetic-unexpected-secret'}):
            with self.assertRaises(OperationError):
                session.request({'id': 1, 'op': 'windows-login', 'action': 'check', 'settings': settings})
        client.call.assert_not_called()


if __name__ == '__main__':
    unittest.main()
