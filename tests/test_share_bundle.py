import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from tools.build_share_bundle import check_content, check_windows, private_path, public_files, write_zip
from tools.build_windows_setup import build as build_windows


class ShareBundleTests(unittest.TestCase):
    def test_exports_source_without_profiles_and_refuses_linked_or_identifying_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'gmssh_windows_bridge').mkdir()
            (root/'README.md').write_text('public guide')
            (root/'gmssh_windows_bridge/module.py').write_text('public source')
            (root/'gmssh_windows_bridge/agent.json').write_text('private fixture')
            (root/'gmssh_windows_bridge/file-places.json').write_text('private favorite paths')
            web=root/'gmssh_windows_bridge/desktop_web';web.mkdir()
            (web/'gmssh-home.js').write_text('canonical generated asset')
            (web/'gmssh-home 2.js').write_text('pre-existing conflict copy')
            files = public_files(root)
            self.assertEqual(set(files), {'README.md', 'gmssh_windows_bridge/module.py','gmssh_windows_bridge/desktop_web/gmssh-home.js'})
            self.assertEqual((web/'gmssh-home 2.js').read_text(),'pre-existing conflict copy')
            for name in ['catalog.json', 'connection.json', 'local.app/info.json', 'bridge_host_key', 'windows_known_hosts', '.DS_Store',
                         'private/ai-devices.json', 'private/ai-status.json', 'private/ai-tasks.json', 'private/ai-job-11111111111111111111111111111111.dat', 'private/registry.lock',
                         'private/connect-password.dat', 'private/connect-meta.dat', 'private/connect-identity.dat',
                         'personal.gmsshbackup', 'GMSSH-devices-20260101.json', 'GMSSH-connection-QR.png', 'private/file-places.json', 'private/linux-host-pins.json', 'private/workspace-history.json', 'private/controllers.dat', 'private/controller-connection.json']:
                self.assertTrue(private_path(name), name)
            with self.assertRaises(ValueError): check_content('fixture.py', b'/' + b'Users/' + b'operator/project')
            with self.assertRaises(ValueError): check_content('fixture.py', b'fixture-station', ['fixture-station'])
            (root/'gmssh_windows_bridge/link.py').symlink_to(root/'README.md')
            with self.assertRaises(ValueError): public_files(root)

    def test_archive_strips_owner_metadata_and_keeps_command_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary)/'share.zip'
            write_zip(archive, {'Install.command': b'echo fixture', 'guide.txt': b'guide'})
            with zipfile.ZipFile(archive) as package:
                self.assertEqual(stat.S_IMODE(package.getinfo('Install.command').external_attr >> 16), 0o755)
                self.assertEqual(package.getinfo('guide.txt').date_time, (2026,1,1,0,0,0))
                self.assertEqual(package.getinfo('guide.txt').extra, b'')

    def test_windows_export_requires_generic_settings_and_no_bundled_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            config={'version':'0.4.0a8','controllerAddress':'LocalSubnet','monitorOnly':False,
                    'preserveDesktop':False,'expectedComputer':None,'runtimeSource':'microsoft'}
            def fixture(extra=None):
                bundle=root/'bundle.zip';exe=root/'fixture.exe'
                with zipfile.ZipFile(bundle,'w') as package:
                    package.writestr('setup-config.json',json.dumps(config))
                    if extra: package.writestr(extra,b'fixture')
                exe.write_bytes(b'MZ fixture\0'+bundle.read_bytes())
                return bundle,exe
            check_windows(*fixture(),'0.4.0a8')
            for extra in ['installers/VC_redist.x64.exe','agent.json']:
                with self.assertRaises(ValueError): check_windows(*fixture(extra),'0.4.0a8')
            config['expectedComputer']='fixture-station'
            with self.assertRaises(ValueError): check_windows(*fixture(),'0.4.0a8')
            with self.assertRaises(ValueError): build_windows(root/'private.zip',controller='192.0.2.42',public_release=True,runtime_source='microsoft')


if __name__ == '__main__':
    unittest.main()
