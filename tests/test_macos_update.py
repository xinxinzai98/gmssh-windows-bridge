import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from gmssh_windows_bridge import __version__
from gmssh_windows_bridge import macos_update as update
from gmssh_windows_bridge.macos_launcher import write_asar


@unittest.skipUnless(os.name == 'posix', 'Mac updater requires POSIX ownership and locking')
class MacUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / 'Enhanced.app'
        self.prefix = self.root / 'runtime'
        self.site = self.prefix / 'lib/python3.12/site-packages'
        self.site.mkdir(parents=True)
        self.old_dist = f'{update.PACKAGE}-{update.BASE_VERSION}.dist-info'
        self.dist = f'{update.PACKAGE}-{__version__}.dist-info'
        for name in (update.PACKAGE, self.old_dist):
            (self.site / name).mkdir()
            (self.site / name / 'original.txt').write_text('original-runtime')
        for name in update.APP_FILES:
            path = self.app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'original-app')
        executable = (struct.pack('<8I', 0xFEEDFACF, 0x0100000C, 0, 2, 1, 24, 0, 0)
                      + struct.pack('<II', 0x1B, 24) + b'u' * 16 + b'original-signature')
        (self.app / 'Contents/MacOS/GMSSH').write_bytes(executable)
        self.files = {'launcher-config.json': json.dumps({'python': '/synthetic/python',
                      'profile': '/synthetic/profile', 'custom': 'preserve-exactly'}).encode(),
                      'gmssh-workspace.js': b'original-workspace', 'other.js': b'original-wrapper'}
        digest = write_asar(self.app / update.APP_FILES[0], self.files)
        self.info = {'CFBundleIdentifier': update.APP_ID, 'CFBundleName': 'Original helper name',
                     'GMSSHBridgeVersion': update.BASE_VERSION, 'ElectronAsarIntegrity': {
                         'Resources/app.asar': {'algorithm': 'SHA256', 'hash': digest},
                         'Resources/vendor.asar': {'hash': 'unchanged-vendor'}}}
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps(self.info))
        (self.app / 'Contents/Resources/launcher-entitlements.plist').write_bytes(plistlib.dumps({}))
        self.state = {'app': self.app, 'info': self.info, 'files': self.files,
                      'python': '/synthetic/python', 'site': self.site, 'prefix': self.prefix}
        self.new_files = {update.PACKAGE + '/__init__.py': ('__version__ = "' + __version__ + '"').encode(),
                          update.PACKAGE + '/desktop_web/gmssh-workspace.js': b'new-workspace',
                          self.dist + '/METADATA': ('Name: gmssh-windows-bridge\nVersion: ' + __version__ + '\n').encode()}
        self.original_app = {name: (self.app / name).read_bytes() for name in update.APP_FILES}
        self.fail_signing = False

    def fake_run(self, args):
        if str(args[0]) == '/bin/ps':
            return ''
        if '--force' in args:
            (self.app / 'Contents/_CodeSignature/CodeResources').write_bytes(b'new-code-resources')
            with (self.app / 'Contents/MacOS/GMSSH').open('ab') as handle:
                handle.write(b'new-signature')
            if self.fail_signing:
                raise subprocess.CalledProcessError(1, ['codesign'])
        return ''

    def assert_restored(self):
        for name, body in self.original_app.items():
            self.assertEqual((self.app / name).read_bytes(), body, name)
        self.assertEqual((self.site / update.PACKAGE / 'original.txt').read_text(), 'original-runtime')
        self.assertTrue((self.site / self.old_dist).is_dir())
        self.assertFalse((self.site / self.dist).exists())
        with update.update_lock(self.prefix):
            pass

    def test_updates_in_place_preserving_config_vendor_identity_and_recoverable_runtime(self):
        with patch.object(update, 'run', side_effect=self.fake_run):
            backup = update.apply(self.state, self.new_files, self.dist)
        files, digest = update.read_asar(self.app / update.APP_FILES[0])
        self.assertEqual(files['gmssh-workspace.js'], b'new-workspace')
        self.assertEqual(files['launcher-config.json'], self.files['launcher-config.json'])
        self.assertEqual(files['other.js'], b'original-wrapper')
        info = plistlib.loads((self.app / 'Contents/Info.plist').read_bytes())
        self.assertEqual(info['GMSSHBridgeVersion'], __version__)
        self.assertEqual(info['CFBundleName'], self.info['CFBundleName'])
        self.assertEqual(info['ElectronAsarIntegrity']['Resources/app.asar']['hash'], digest)
        self.assertEqual(info['ElectronAsarIntegrity']['Resources/vendor.asar'], self.info['ElectronAsarIntegrity']['Resources/vendor.asar'])
        self.assertEqual(update.executable_uuid(self.app / 'Contents/MacOS/GMSSH'), b'u' * 16)
        self.assertTrue((backup / ('runtime-' + update.PACKAGE) / 'original.txt').is_file())
        self.assertTrue((self.site / self.dist / 'METADATA').is_file())
        with update.update_lock(self.prefix):
            pass

    def test_sign_failure_restores_signature_executable_app_and_runtime_bytes(self):
        self.fail_signing = True
        with patch.object(update, 'run', side_effect=self.fake_run):
            with self.assertRaises(subprocess.CalledProcessError):
                update.apply(self.state, self.new_files, self.dist)
        self.assert_restored()

    def test_successful_update_can_be_rolled_back_and_corrupt_backups_are_rejected(self):
        with patch.object(update, 'run', side_effect=self.fake_run):
            backup = update.apply(self.state, self.new_files, self.dist)
            saved = backup / update.APP_FILES[0]
            body = saved.read_bytes()
            saved.write_bytes(b'changed-backup')
            with self.assertRaisesRegex(ValueError, '回退文件校验'):
                update.restore(self.state, backup)
            self.assertEqual((self.site / update.PACKAGE / '__init__.py').read_bytes(), self.new_files[update.PACKAGE + '/__init__.py'])
            saved.write_bytes(body)
            update.restore(self.state, backup)
        self.assert_restored()

    def test_running_app_and_existing_lock_are_preserved_without_updates(self):
        with patch.object(update, 'run', return_value='42 ' + str(self.app / 'Contents/MacOS/GMSSH')):
            with self.assertRaisesRegex(ValueError, '正常退出'):
                update.ensure_stopped(self.app)
        lock = self.prefix / '.gmssh-update.lock'
        lock.write_text('another-update')
        with update.update_lock(self.prefix), patch.object(update, 'run', side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, '另一个更新'):
                update.apply(self.state, self.new_files, self.dist)
        self.assertEqual(lock.read_text(), 'another-update')
        self.assertEqual((self.app / update.APP_FILES[0]).read_bytes(), self.original_app[update.APP_FILES[0]])

    def test_asar_tampering_and_unsupported_app_are_rejected_before_mutation(self):
        archive = self.app / update.APP_FILES[0]
        archive.write_bytes(archive.read_bytes()[:-1] + b'x')
        with self.assertRaisesRegex(ValueError, '完整性'):
            update.read_asar(archive)
        self.info['GMSSHBridgeVersion'] = '0.4.0a8'
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps(self.info))
        with patch.object(update, 'run', side_effect=self.fake_run):
            with self.assertRaisesRegex(ValueError, '0.4.0a38'):
                update.inspect(self.app)

    def test_shared_and_external_python_package_locations_are_not_modified(self):
        for value in ({'prefix': str(self.prefix), 'base': str(self.prefix), 'site': str(self.site), 'version': [3, 12]},
                      {'prefix': str(self.prefix), 'base': str(self.root), 'site': str(self.root / 'outside'), 'version': [3, 12]}):
            with patch.object(update, 'run', return_value=json.dumps(value)):
                with self.assertRaises(ValueError):
                    update.runtime_layout('/synthetic/python')

    def test_recovery_uses_verified_backup_when_current_signature_or_package_is_incomplete(self):
        with patch.object(update, 'run', side_effect=self.fake_run):
            backup = update.apply(self.state, self.new_files, self.dist)
        # Simulate an interrupted replacement; recovery must not need a working new package.
        (self.site / update.PACKAGE).rename(self.root / 'interrupted-package')
        (self.app / 'Contents/_CodeSignature/CodeResources').unlink()
        with patch.object(update, 'run', side_effect=self.fake_run), \
                patch.object(update, 'runtime_layout', return_value=(self.prefix, self.site)):
            state = update.inspect(self.app, recovery=backup)
            update.restore(state, backup)
        self.assert_restored()

    def wheel(self, extra=None, changed=False):
        path = self.root / 'update.whl'
        files = dict(self.new_files)
        if extra:
            files.update(extra)
        record = io.StringIO()
        writer = csv.writer(record, lineterminator='\n')
        for name, body in files.items():
            digest = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b'=').decode()
            writer.writerow([name, 'sha256=' + digest, len(body)])
        writer.writerow([self.dist + '/RECORD', '', ''])
        files[self.dist + '/RECORD'] = record.getvalue().encode()
        if changed:
            files[update.PACKAGE + '/__init__.py'] += b'changed'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, body in files.items():
                archive.writestr(name, body)
        return path

    def test_wheel_records_and_paths_are_checked_before_extraction(self):
        files, dist = update.read_wheel(self.wheel())
        self.assertEqual(dist, self.dist)
        self.assertEqual(files[update.PACKAGE + '/desktop_web/gmssh-workspace.js'], b'new-workspace')
        with self.assertRaisesRegex(ValueError, '文件校验'):
            update.read_wheel(self.wheel(changed=True))
        for name in ('../escape.py', '/absolute.py', update.PACKAGE + '/../outside.py', 'other_package/file.py'):
            with self.assertRaisesRegex(ValueError, '路径'):
                update.read_wheel(self.wheel(extra={name: b'unsafe'}))
        self.assertFalse((self.root / 'escape.py').exists())

    def test_check_only_does_not_apply_and_non_mac_execution_is_refused(self):
        args = ['update', '--wheel', str(self.wheel()), '--check']
        with patch.object(sys, 'argv', args), patch.object(sys, 'platform', 'darwin'), \
                patch.object(update, 'inspect', return_value=self.state), patch.object(update, 'apply') as apply:
            self.assertEqual(update.main(), 0)
            apply.assert_not_called()
        with patch.object(sys, 'argv', args), patch.object(sys, 'platform', 'linux'):
            with self.assertRaises(SystemExit) as result:
                update.main()
            self.assertEqual(result.exception.code, 1)


if __name__ == '__main__':
    unittest.main()
