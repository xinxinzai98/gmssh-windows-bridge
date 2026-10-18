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
                return {'taskId': 'c'*32, 'state': 'running', 'exitCode': None}

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
