import asyncio
from contextlib import contextmanager
import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gmssh_windows_bridge import ai, ai_files
from gmssh_windows_bridge.file_stream import StreamError
from tests.test_connection_code import public_connection


class LocalSFTP:
    """Real disposable files behind the SFTP surface, never a real remote device."""
    def __init__(self, root):
        self.root = root
        self.before_rename = None

    def local(self, name):
        if not name.startswith('C:/') or '..' in name.split('/'):
            raise ValueError('unexpected path')
        return self.root/name[3:]

    def lstat(self, name):
        return self.local(name).lstat()

    def open(self, name, mode):
        return self.local(name).open('xb' if mode == 'wx' else mode)

    def listdir_iter(self, name, **_):
        for path in self.local(name).iterdir():
            result = type('Entry', (), {})()
            info = path.lstat()
            result.filename, result.st_mode, result.st_size, result.st_mtime = path.name, info.st_mode, info.st_size, info.st_mtime
            yield result

    def rename(self, source, destination):
        if self.before_rename:
            self.before_rename(source, destination)
        # A hard link provides the SFTP no-overwrite contract on this test host.
        os.link(self.local(source), self.local(destination))
        self.local(source).unlink()

    def remove(self, name):
        self.local(name).unlink()

    def chmod(self, name, mode):
        self.local(name).chmod(mode)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


class AITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.registry = ai.Registry(self.root/'config')
        self.public = public_connection()
        self.device = self.registry.enroll(json.dumps(self.public), 'Synthetic PC', ['inspect', 'files', 'terminal', 'view', 'input'], env='GMSSH_SYNTHETIC_AI_SECRET')
        self.device_id = self.device['id']
        self.remote = self.root/'remote'; self.remote.mkdir()
        self.sftp = LocalSFTP(self.remote)
        self.connects = 0
        self.calls = []
        test = self

        class Client:
            controller_protocol = 2
            ai_capabilities = {'aiProtocol': 1}
            policy = {'view': True, 'input': True, 'files': True, 'terminal': True, 'clipboard': False, 'power': False}

            def info(self, tool):
                test.calls.append(('info', tool))
                return b'{"schema":1,"computer":"SYNTHETIC","tools":[]}'

            def call(self, operation, **values):
                test.calls.append((operation, values))
                if operation == 'ai-desktop':
                    return {'snapshot': 'a'*32, 'nodes': [], 'truncated': False}
                return {'taskId': 'c'*32, 'state': 'running', 'code': 'OK', 'exitCode': None}

            def open_sftp(self):
                return test.sftp

        self.client = Client()

        @contextmanager
        def connector(registry, device):
            self.connects += 1
            yield self.client

        self.operations = ai.Operations(self.registry, connector=connector)

    def call(self, tool_name, **args):
        return self.operations.call(tool_name, {'device': self.device_id, **args})

    def test_registry_never_lists_or_reads_credentials_and_enforces_opt_in(self):
        with patch.object(self.registry, 'credential', side_effect=AssertionError('credential read')):
            result = self.operations.call('devices_list', {})
            self.assertTrue(result['ok'])
            self.assertEqual(self.connects, 0)
        self.assertNotIn('credential', json.dumps(result))
        self.assertNotIn('GMSSH_SYNTHETIC_AI_SECRET', json.dumps(result))
        denied = self.operations.call('device_context', {'device': 'e'*32})
        self.assertEqual(denied['error']['code'], 'DEVICE_NOT_ENABLED')
        self.registry.configure(self.device_id, ['inspect'])
        denied = self.call('powershell_run', script='Get-Date')
        self.assertEqual(denied['error']['code'], 'ACCESS_DENIED')
        self.assertEqual(self.connects, 0)
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE((self.registry.root/'ai-devices.json').stat().st_mode), 0o600)
            (self.registry.root/'ai-devices.json').chmod(0o644)
            with self.assertRaisesRegex(StreamError, 'CONFIG_UNSAFE'):
                self.registry.devices()

    def test_closed_schemas_reject_unknown_fields_before_connecting(self):
        result = self.call('desktop_act', action='invoke', snapshot='a'*32, target='b'*32, script='untrusted')
        self.assertEqual(result['error']['code'], 'INVALID_ARGUMENT')
        result = self.call('powershell_run', script='Get-Date', timeout=True)
        self.assertEqual(result['error']['code'], 'INVALID_ARGUMENT')
        self.assertEqual(self.connects, 0)
        result = self.call('powershell_run', script='中文'*16000)
        self.assertEqual(result['error']['code'], 'INVALID_ARGUMENT')
        self.assertEqual(self.calls, [])

    def test_task_key_is_returned_even_when_start_response_is_lost(self):
        def lost(*_, **__):
            raise StreamError('REMOTE_IO')
        self.client.call = lost
        result = self.call('powershell_run', script='Get-Date', requestKey='d'*32)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['recovery'], {'requestKey': 'd'*32, 'retryWithSameKey': True})
        self.assertNotIn('Get-Date', json.dumps(result))
        receipt = ai.Registry(self.registry.root).task_history(self.device_id)['tasks'][0]
        self.assertEqual((receipt['requestKey'], receipt['taskId'], receipt['state']), ('d'*32, None, 'unknown'))
        self.assertNotIn('Get-Date', (self.registry.root/'ai-tasks.json').read_text())

    def test_task_wait_timeout_history_restart_and_disable_never_replay(self):
        task = self.call('powershell_run', script='private command', requestKey='d'*32)['result']
        self.assertEqual(task['taskId'], 'c'*32)
        clock = [0.0]
        def advance(seconds):
            clock[0] += seconds
        with patch('gmssh_windows_bridge.ai.time.monotonic', side_effect=lambda: clock[0]), patch('gmssh_windows_bridge.ai.time.sleep', side_effect=advance):
            result = self.call('task_wait', taskId=task['taskId'], timeout=1)
        self.assertTrue(result['ok']); self.assertFalse(result['result']['finished'])
        self.assertTrue(result['result']['waitTimedOut'])
        self.assertEqual([v[0] for v in self.calls].count('ai-task-start'), 1)
        before = self.connects
        result = self.call('tasks_list')
        self.assertTrue(result['ok']); self.assertFalse(result['result']['remoteStateChecked'])
        self.assertEqual(self.connects, before)
        self.assertEqual(ai.Registry(self.registry.root).task_history(self.device_id)['tasks'][0]['taskId'], task['taskId'])
        raw = (self.registry.root/'ai-tasks.json').read_text()
        self.assertNotIn('private command', raw); self.assertNotIn('output', raw)
        self.registry.configure(self.device_id, [])
        self.assertEqual(self.call('tasks_list')['error']['code'], 'ACCESS_DENIED')
        self.assertEqual(self.call('task_wait', taskId=task['taskId'])['error']['code'], 'ACCESS_DENIED')
        self.assertEqual(self.connects, before)

    def test_finished_task_preserves_output_page_and_nonzero_exit_without_wait_failure(self):
        def finished(operation, **values):
            self.calls.append((operation, values))
            return {'taskId': 'c'*32, 'state': 'failed', 'code': 'EXIT_NONZERO', 'exitCode': 7,
                    'output': '中文 <script>untrusted</script>', 'offset': 16384, 'nextOffset': 16417, 'more': True, 'truncated': False}
        self.client.call = finished
        result = self.call('task_wait', taskId='c'*32, offset=16384)
        self.assertTrue(result['ok']); self.assertTrue(result['result']['finished'])
        self.assertFalse(result['result']['waitTimedOut']); self.assertEqual(result['result']['exitCode'], 7)
        self.assertEqual(self.calls, [('ai-task-get', {'args': {'taskId': 'c'*32, 'offset': 16384}})])
        self.assertTrue(result['result']['more']); self.assertEqual(result['result']['nextOffset'], 16417)
        self.assertNotIn('untrusted', (self.registry.root/'ai-tasks.json').read_text())

    def test_submit_requires_local_recovery_record_and_forget_marks_only_its_receipt(self):
        with patch.object(self.registry, 'remember_task', side_effect=OSError('synthetic disk full')):
            reply = self.call('powershell_run', script='must not run', requestKey='d'*32)
        self.assertEqual(reply['error']['code'], 'LOCAL_JOURNAL_FAILED'); self.assertEqual(self.calls, [])
        with patch.object(self.registry, 'remember_task', return_value=False):
            reply = self.call('powershell_run', script='configuration changed', requestKey='d'*32)
        self.assertEqual(reply['error']['code'], 'ACCESS_DENIED'); self.assertEqual(self.calls, [])
        self.call('powershell_run', script='private', requestKey='d'*32)
        self.client.call = lambda *_, **__: {'forgotten': True}
        reply = self.call('task_forget', taskId='c'*32)
        self.assertTrue(reply['ok']); self.assertTrue(reply['result']['forgotten'])
        record = self.registry.task_history(self.device_id)['tasks'][0]
        self.assertEqual((record['state'], record['taskId'], record['requestKey']), ('forgotten', 'c'*32, 'd'*32))

    def test_history_is_bounded_and_local_write_failure_does_not_hide_started_task(self):
        device = self.registry.devices()[0]
        for index in range(ai.TASK_HISTORY_LIMIT+1):
            self.registry.remember_task(device, request_key=f'{index:032x}')
        result = self.registry.task_history(self.device_id, 200)
        self.assertEqual(len(result['tasks']), 200); self.assertTrue(result['pruned'])
        self.assertEqual(result['tasks'][0]['requestKey'], f'{ai.TASK_HISTORY_LIMIT:032x}')
        original = self.registry.remember_task
        def fail_after_start(device, result=None, request_key=None):
            if result is not None:
                raise OSError('synthetic disk full')
            return original(device, result, request_key)
        with patch.object(self.registry, 'remember_task', side_effect=fail_after_start):
            reply = self.call('powershell_run', script='private', requestKey='d'*32)
        self.assertTrue(reply['ok']); self.assertEqual(reply['result']['taskId'], 'c'*32)
        self.assertEqual(reply['result']['localJournal']['code'], 'LOCAL_JOURNAL_FAILED')
        with self.registry.lock():
            value = self.registry.task_records(); value['tasks'][0]['output'] = 'must not load'
            self.registry._save_json('ai-tasks.json', value)
        with self.assertRaisesRegex(StreamError, 'CONFIG_UNSAFE'):
            self.registry.task_records()

    def test_long_utf8_lines_resume_without_loss_and_detect_changed_source(self):
        original = b'\xef\xbb\xbf'+('中文🙂'*12000+'\r\nlast\n').encode('utf-8')
        (self.remote/'long.txt').write_bytes(original)
        first = self.call('files_read', path='C:/long.txt', limit=1)['result']
        self.assertTrue(first['truncated']); self.assertIsNone(first['nextLine'])
        self.assertLessEqual(len(first['text'].encode()), 32768)
        text, page = first['text'], first
        while page['nextByte'] is not None:
            page = self.call('files_read', path='C:/long.txt', startByte=page['nextByte'], expectedSha256=first['sha256'])['result']
            self.assertLessEqual(len(page['text'].encode()), 32768)
            text += page['text']
        self.assertEqual(text, original.decode('utf-8-sig')); self.assertTrue(page['eof'])
        before = self.connects
        for values in ({'startByte': 1}, {'startByte': 0, 'limit': 3}):
            result = self.call('files_read', path='C:/long.txt', **values)
            self.assertEqual(result['error']['code'], 'INVALID_ARGUMENT')
        self.assertEqual(before, self.connects)
        self.assertEqual(self.call('files_read', path='C:/long.txt', startByte=4, expectedSha256=first['sha256'])['error']['code'], 'INVALID_ARGUMENT')
        (self.remote/'long.txt').write_text('changed', encoding='utf-8')
        result = self.call('files_read', path='C:/long.txt', startByte=first['nextByte'], expectedSha256=first['sha256'])
        self.assertEqual(result['error']['code'], 'SOURCE_CHANGED')

    def test_literal_content_search_paginates_matches_and_checks_source(self):
        content = b'\xef\xbb\xbf'+('heading\r\n'+'x'*60000+'目标.*[0]🙂\r\n'+'目标.*[0]🙂\n'*120).encode()
        (self.remote/'config.txt').write_bytes(content)
        result = self.call('files_find_text', path='C:/config.txt', query='目标.*[0]🙂', limit=2)['result']
        self.assertEqual([row['line'] for row in result['items']], [2, 3]); self.assertEqual(result['nextLine'], 4)
        self.assertTrue(result['literal']); self.assertTrue(result['items'][0]['truncated'])
        self.assertIn('目标.*[0]🙂', result['items'][0]['text']); self.assertLessEqual(len(result['items'][0]['text'].encode()), 512)
        self.assertEqual(result['items'][0]['column'], 60001)
        next_page = self.call('files_find_text', path='C:/config.txt', query='目标.*[0]🙂', startLine=4, expectedSha256=result['sha256'])['result']
        self.assertEqual(next_page['items'][0]['line'], 4); self.assertLessEqual(len(next_page['items']), 100)
        (self.remote/'config.txt').write_text('changed', encoding='utf-8')
        self.assertEqual(self.call('files_find_text', path='C:/config.txt', query='目标', expectedSha256=result['sha256'])['error']['code'], 'SOURCE_CHANGED')
        self.assertEqual(self.call('files_find_text', path='C:/config.txt', query='missing')['result']['items'], [])
        query = '🙂'*64
        (self.remote/'config.txt').write_text(('前'*32+query+'后'*32+'\n')*100, encoding='utf-8')
        bounded = self.call('files_find_text', path='C:/config.txt', query=query, limit=100)['result']
        self.assertLess(len(bounded['items']), 100)
        self.assertLessEqual(sum(len(row['text'].encode()) for row in bounded['items']), 16384)
        self.assertEqual(bounded['nextLine'], len(bounded['items'])+1)

    def test_precise_replacement_previews_preserve_bom_crlf_and_retained_backups(self):
        original = b'\xef\xbb\xbf'+('name=测试\r\nport=22257\r\nlast=🙂\r\n').encode()
        (self.remote/'config.txt').write_bytes(original); sha = ai_files.digest(original)
        args = dict(path='C:/config.txt', oldText='port=22257', newText='port=22258', expectedSha256=sha)
        result = self.call('files_replace_preview', **args)
        self.assertTrue(result['ok']); self.assertEqual(result['result']['occurrences'], 1)
        self.assertIn('+port=22258\r\n', result['result']['diff']); self.assertFalse(result['result']['bomChanged'])
        self.assertEqual((self.remote/'config.txt').read_bytes(), original); self.assertEqual(len(list(self.remote.iterdir())), 1)
        bom_only = self.call('files_preview', path='C:/config.txt', content=original.decode('utf-8-sig'), expectedSha256=sha)['result']
        self.assertTrue(bom_only['changed']); self.assertTrue(bom_only['bomChanged']); self.assertEqual(bom_only['diff'], '')
        saved = self.call('files_replace', **args)['result']
        expected = original.replace(b'22257', b'22258')
        self.assertEqual((self.remote/'config.txt').read_bytes(), expected)
        self.assertEqual(self.sftp.local(saved['backup']).read_bytes(), original)
        reply = self.call('files_replace', **args)
        self.assertEqual(reply['error']['code'], 'SOURCE_CHANGED')
        restored = self.call('files_restore', path='C:/config.txt', backup=saved['backup'], backupSha256=sha, expectedSha256=saved['sha256'])
        self.assertTrue(restored['ok']); self.assertEqual((self.remote/'config.txt').read_bytes(), original)

    def test_replacement_rejects_missing_or_ambiguous_including_overlapping_text(self):
        for source, old, code in [('a=1\na=1\n', 'a=1', 'TEXT_NOT_UNIQUE'), ('aaa', 'aa', 'TEXT_NOT_UNIQUE'), ('name=one', 'name=two', 'TEXT_NOT_FOUND')]:
            with self.subTest(source=source):
                (self.remote/'config.txt').write_text(source)
                result = self.call('files_replace', path='C:/config.txt', oldText=old, newText='new', expectedSha256=ai_files.digest(source.encode()))
                self.assertEqual(result['error']['code'], code); self.assertEqual((self.remote/'config.txt').read_text(), source)
                self.assertEqual(len(list(self.remote.iterdir())), 1)

    def test_create_verifies_new_content_and_never_overwrites_existing_or_racing_target(self):
        content = '中文配置\r\n🙂'
        reply = self.call('files_create', path='C:/new.txt', content=content)
        self.assertTrue(reply['ok'], reply); self.assertEqual((self.remote/'new.txt').read_bytes(), content.encode())
        missing = self.call('files_create', path='C:/missing/new.txt', content='new')
        self.assertEqual(missing['error']['code'], 'NOT_FOUND'); self.assertFalse((self.remote/'missing').exists())
        reply = self.call('files_create', path='C:/new.txt', content='different')
        self.assertEqual(reply['error']['code'], 'ALREADY_EXISTS'); self.assertEqual((self.remote/'new.txt').read_bytes(), content.encode())
        def race(source, target):
            (self.remote/'racing.txt').write_text('other writer')
        self.sftp.before_rename = race
        reply = self.call('files_create', path='C:/racing.txt', content='mine')
        self.assertEqual(reply['error']['code'], 'ALREADY_EXISTS'); self.assertEqual((self.remote/'racing.txt').read_text(), 'other writer')
        self.assertEqual(sorted(path.name for path in self.remote.iterdir()), ['new.txt', 'racing.txt'])

    def test_create_lost_commit_response_never_claims_success_or_deletes_destination(self):
        rename = self.sftp.rename
        def lost(source, target):
            rename(source, target)
            raise StreamError('REMOTE_IO')
        self.sftp.rename = lost
        self.sftp.remove = lambda *_: (_ for _ in ()).throw(AssertionError('must retain unconfirmed commit'))
        reply = self.call('files_create', path='C:/new.txt', content='new 中文')
        self.assertEqual(reply['error']['code'], 'CREATE_OUTCOME_UNKNOWN')
        self.assertEqual(reply['error']['recovery']['path'], 'C:/new.txt')
        self.assertEqual((self.remote/'new.txt').read_text(), 'new 中文')
        self.assertEqual(reply['error']['recovery']['expectedSha256'], ai_files.digest('new 中文'.encode()))

    def test_file_operations_over_real_disposable_ssh_sftp(self):
        import paramiko
        from tests.test_forwarding import Files, bridge
        class WindowsFiles(Files):
            def path(self, name):
                if not name.startswith('C:/'):
                    raise PermissionError(errno.EACCES, 'synthetic Windows drive only')
                return super().path(name[2:])
            def rename(self, source, target):
                try:
                    os.link(self.path(source), self.path(target)); self.path(source).unlink()
                    return paramiko.SFTP_OK
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)
        with patch('tests.test_forwarding.Files', WindowsFiles), bridge() as (transport, _):
            self.client = SimpleNamespace(open_sftp=lambda: paramiko.SFTPClient.from_transport(transport))
            created = self.call('files_create', path='C:/config.txt', content='name=one\r\nvalue=中文\r\n')
            self.assertTrue(created['ok'], created); sha = created['result']['sha256']
            found = self.call('files_find_text', path='C:/config.txt', query='value=中文')
            self.assertEqual(found['result']['items'][0]['line'], 2)
            saved = self.call('files_replace', path='C:/config.txt', oldText='name=one', newText='name=two', expectedSha256=sha)
            self.assertTrue(saved['ok'], saved)
            self.assertTrue(self.call('files_read', path='C:/config.txt')['result']['text'].startswith('name=two\r\n'))
            self.assertFalse(self.call('files_create', path='C:/config.txt', content='no overwrite')['ok'])
            result = saved['result']
            self.assertTrue(self.call('files_restore', path='C:/config.txt', backup=result['backup'], backupSha256=sha, expectedSha256=result['sha256'])['ok'])
            self.assertEqual(self.call('files_read', path='C:/config.txt')['result']['sha256'], sha)

    @unittest.skipIf(os.name == 'nt', 'ordinary user symlink fixture is Unix-only')
    def test_create_rejects_linked_parent_and_verification_failure_removes_only_own_candidate(self):
        outside = self.root/'outside'; outside.mkdir(); (self.remote/'linked').symlink_to(outside, target_is_directory=True)
        result = self.call('files_create', path='C:/linked/new.txt', content='not allowed')
        self.assertEqual(result['error']['code'], 'UNSUPPORTED_FILE'); self.assertEqual(list(outside.iterdir()), [])
        real_read = ai_files.read_bytes
        def corrupt(sftp, path):
            return b'synthetic corrupt write' if path.endswith('.tmp') else real_read(sftp, path)
        with patch('gmssh_windows_bridge.ai_files.read_bytes', side_effect=corrupt):
            result = self.call('files_create', path='C:/new.txt', content='intended content')
        self.assertEqual(result['error']['code'], 'VERIFY_FAILED'); self.assertFalse((self.remote/'new.txt').exists())
        self.assertEqual([path.name for path in self.remote.iterdir()], ['linked'])

    def test_file_tools_validate_fragments_before_connecting_and_require_file_permission(self):
        sha = '0'*64
        invalid = [('files_find_text', dict(query='two\nlines')), ('files_find_text', dict(query='line\u2028')),
                   ('files_replace', dict(oldText='', newText='new', expectedSha256=sha)),
                   ('files_replace', dict(oldText='old', newText='🙂'*10000, expectedSha256=sha)),
                   ('files_create', dict(content='中文'*400000))]
        for name, values in invalid:
            result = self.call(name, path='C:/config.txt', **values)
            self.assertIn(result['error']['code'], {'INVALID_ARGUMENT', 'FILE_LIMIT'})
        self.assertEqual(self.connects, 0)
        self.registry.configure(self.device_id, ['inspect'])
        for name, values in [('files_find_text', dict(query='one')), ('files_replace_preview', dict(oldText='a', newText='b', expectedSha256=sha)),
                             ('files_replace', dict(oldText='a', newText='b', expectedSha256=sha)), ('files_create', dict(content='new'))]:
            self.assertEqual(self.call(name, path='C:/config.txt', **values)['error']['code'], 'ACCESS_DENIED')
        self.assertEqual(self.connects, 0)

    def test_older_server_is_reported_without_auto_upgrade_or_command_fallback(self):
        self.client.ai_capabilities = {}
        result = self.call('powershell_run', script='Get-Date')
        self.assertEqual(result['error']['code'], 'SERVER_UPGRADE_REQUIRED')
        self.assertEqual(self.calls, [])

    def test_context_does_not_disguise_a_peer_change_as_an_old_server(self):
        self.client.info = lambda *_: (_ for _ in ()).throw(StreamError('PEER_CHANGED'))
        result = self.call('device_context')
        self.assertEqual(result['error']['code'], 'PEER_CHANGED')

    def test_wait_does_not_turn_query_failure_or_truncation_into_absence(self):
        def failed(*_, **__):
            raise StreamError('DESKTOP_LOCKED')
        self.client.call = failed
        result = self.call('wait_for', condition='ui_absent', window='123', name='Save', timeout=1)
        self.assertEqual(result['error']['code'], 'DESKTOP_LOCKED')
        self.client.call = lambda *_, **__: {'nodes': [], 'truncated': True}
        result = self.call('wait_for', condition='ui_absent', window='123', name='Save', timeout=1)
        self.assertEqual(result['error']['code'], 'QUERY_TRUNCATED')
        self.client.call = lambda *_, **__: {'nodes': [], 'truncated': False}
        self.assertTrue(self.call('wait_for', condition='ui_absent', window='123', name='Save')['result']['matched'])

    def test_file_preview_change_detection_edit_and_restore(self):
        original = ('first\n中文 line\n'+'z'*70000).encode()
        (self.remote/'config.txt').write_bytes(original)
        sha = ai_files.digest(original)
        read = self.call('files_read', path='C:/config.txt', startLine=1, limit=2)
        self.assertTrue(read['ok']); self.assertEqual(read['result']['sha256'], sha)
        self.assertEqual(read['result']['text'], 'first\n中文 line\n')
        preview = self.call('files_preview', path='C:/config.txt', content='new\n', expectedSha256=sha)
        self.assertTrue(preview['ok']); self.assertIn('+new', preview['result']['diff'])
        self.assertEqual((self.remote/'config.txt').read_bytes(), original)
        changed = self.call('files_apply', path='C:/config.txt', content='new\n', expectedSha256='0'*64)
        self.assertEqual(changed['error']['code'], 'SOURCE_CHANGED')
        applied = self.call('files_apply', path='C:\\config.txt', content='new\n', expectedSha256=sha)
        self.assertTrue(applied['ok'], applied)
        self.assertEqual((self.remote/'config.txt').read_bytes(), b'new\n')
        backup = applied['result']['backup']
        self.assertEqual(self.sftp.local(backup).read_bytes(), original)
        restored = self.call('files_restore', path='C:/config.txt', backup=backup, backupSha256=sha, expectedSha256=ai_files.digest(b'new\n'))
        self.assertTrue(restored['ok'], restored)
        self.assertEqual((self.remote/'config.txt').read_bytes(), original)

    def test_competing_writer_is_not_overwritten_and_original_backup_is_retained(self):
        (self.remote/'config.txt').write_bytes(b'original')
        def race(source, destination):
            if source.endswith('.tmp'):
                (self.remote/'config.txt').write_bytes(b'competing writer')
        self.sftp.before_rename = race
        result = self.call('files_apply', path='C:/config.txt', content='new', expectedSha256=ai_files.digest(b'original'))
        self.assertEqual(result['error']['code'], 'EDIT_RECOVERY_REQUIRED')
        self.assertEqual((self.remote/'config.txt').read_bytes(), b'competing writer')
        recovery = result['error']['recovery']
        self.assertEqual(self.sftp.local(recovery['backup']).read_bytes(), b'original')
        self.assertEqual(self.sftp.local(recovery['temporary']).read_bytes(), b'new')

    def test_completed_edit_does_not_remove_an_already_committed_temporary_file(self):
        (self.remote/'config.txt').write_bytes(b'original')
        self.sftp.remove = lambda _: (_ for _ in ()).throw(StreamError('ACCESS_DENIED'))
        result = self.call('files_apply', path='C:/config.txt', content='new', expectedSha256=ai_files.digest(b'original'))
        self.assertTrue(result['ok'], result)
        self.assertEqual((self.remote/'config.txt').read_bytes(), b'new')

    def test_search_is_bounded_and_does_not_follow_symlinks(self):
        folder = self.remote/'docs'; folder.mkdir()
        (folder/'readme.txt').write_text('hello')
        result = self.call('files_search', path='C:/', query='readme', recursive=True)
        self.assertTrue(result['ok']); self.assertEqual(len(result['result']['items']), 1)
        if os.name != 'nt':
            (folder/'link.txt').symlink_to(self.root/'outside.txt')
            (self.root/'outside.txt').write_text('private')
            result = self.call('files_read', path='C:/docs/link.txt')
            self.assertEqual(result['error']['code'], 'UNSUPPORTED_FILE')

    def test_cli_list_and_mcp_config_work_from_installed_package_without_device_access(self):
        command = [sys.executable, '-m', 'gmssh_windows_bridge.ai', '--root', str(self.registry.root)]
        result = subprocess.run(command+['devices'], capture_output=True, text=True, check=True)
        self.assertEqual(len(json.loads(result.stdout)['result']['devices']), 1)
        result = subprocess.run(command+['mcp-config'], capture_output=True, text=True, check=True)
        config = json.loads(result.stdout)['mcpServers']['gmssh']
        self.assertNotIn('env', config)
        self.assertEqual(config['args'][-1], 'mcp')

    @unittest.skipUnless(importlib.util.find_spec('mcp'), 'optional official MCP SDK')
    def test_official_mcp_stdio_initialize_list_and_call(self):
        from mcp import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        async def check():
            parameters = StdioServerParameters(command=sys.executable, args=['-m', 'gmssh_windows_bridge.ai', '--root', str(self.registry.root), 'mcp'])
            async with stdio_client(parameters) as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    self.assertEqual({v.name for v in tools.tools}, set(ai.TOOL_MAP))
                    devices = await session.call_tool('devices_list', {})
                    self.assertFalse(devices.isError)
                    self.assertEqual(devices.structuredContent['result']['devices'][0]['id'], self.device_id)
                    denied = await session.call_tool('device_context', {'device': 'f'*32})
                    self.assertTrue(denied.isError)
                    self.assertEqual(denied.structuredContent['error']['code'], 'DEVICE_NOT_ENABLED')
        asyncio.run(check())

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell parser requires Windows')
    def test_windows_powershell_sources_parse_without_running_or_touching_devices(self):
        files = [Path(ai.__file__).with_name(name) for name in ('ai-context.ps1', 'ai-desktop.ps1', 'gmssh-agent.ps1')]
        for file in files:
            import base64
            script = "$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('"+str(file).replace("'", "''")+"',[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{Write-Error $_.Message};exit 1}"
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', base64.b64encode(script.encode('utf-16le')).decode()], capture_output=True)
            self.assertEqual(result.returncode, 0, (file.name, result.stderr))


if __name__ == '__main__':
    unittest.main()
