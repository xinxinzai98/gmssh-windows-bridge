import io
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from tools.build_share_bundle import build as build_share, check_content, check_windows, private_path, public_files, release_version, write_zip
from tools.build_windows_setup import build as build_windows, check_engine_files, windows_source_files
from tools.build_windows_connect import source_digest


class ShareBundleTests(unittest.TestCase):
    def test_release_versions_and_complete_wheel_contents_are_checked(self):
        root=Path(__file__).resolve().parents[1];files=public_files(root);version=release_version(files)
        with self.assertRaisesRegex(ValueError,'Project version'):
            release_version({**files,'pyproject.toml':b'[project]\nversion = "0.0.0"\n'})
        expected={name:body for name,body in files.items() if name.startswith('gmssh_windows_bridge/')}
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary);wheel=folder/f'gmssh_windows_bridge-{version}-py3-none-any.whl'
            for mode in ('old-metadata','incomplete','correct'):
                content=expected if mode!='incomplete' else {'gmssh_windows_bridge/__init__.py':expected['gmssh_windows_bridge/__init__.py']}
                with zipfile.ZipFile(wheel,'w',zipfile.ZIP_DEFLATED) as archive:
                    for name,body in content.items():archive.writestr(name,body)
                    archive.writestr(f'gmssh_windows_bridge-{version}.dist-info/METADATA','Metadata-Version: 2.1\nName: gmssh-windows-bridge\nVersion: '+('0.0.0' if mode=='old-metadata' else version)+'\n')
                output=folder/mode
                if mode=='correct':
                    result=build_share(root,output,wheel);self.assertEqual(result['version'],version)
                    self.assertTrue((output/f'GMSSH-Mac-Setup-{version}.zip').is_file())
                    with zipfile.ZipFile(output/f'GMSSH-Mac-Setup-{version}.zip') as mac:
                        self.assertIn('Update GMSSH.command', mac.namelist())
                        self.assertEqual(stat.S_IMODE(mac.getinfo('Update GMSSH.command').external_attr >> 16), 0o755)
                else:
                    with self.assertRaisesRegex(ValueError,'Wheel'):build_share(root,output,wheel)
                    self.assertFalse(output.exists())

    def test_fixed_engine_manifest_rejects_modified_missing_and_unsafe_files(self):
        files={'rustdesk.exe':'a'*64,'data/notices.txt':'b'*64}
        digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        check_engine_files(files,digest(files))
        for changed in ({'rustdesk.exe':'c'*64,'data/notices.txt':'b'*64},{'rustdesk.exe':'a'*64},{}):
            with self.assertRaises(ValueError):check_engine_files(changed,digest(files))
        for name in ('../escape.dll','C:/outside.dll','data\\outside.dll'):
            changed={**files,name:'d'*64}
            with self.assertRaises(ValueError):check_engine_files(changed,digest(changed))

    def test_public_windows_export_checks_the_embedded_engine_and_dependency_pins(self):
        config={'version':'0.4.0a34','controllerAddress':'LocalSubnet','monitorOnly':False,
                'preserveDesktop':False,'expectedComputer':None,'runtimeSource':'microsoft'}
        native=b'MZ synthetic desktop engine';helper=b'MZ synthetic own helper';openssh=b'synthetic official MSI'
        files={'rustdesk.exe':hashlib.sha256(native).hexdigest()}
        pins={'rustdesk':{'sha256':'f'*64,'filesSha256':hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()},
              'openssh':{'filename':'OpenSSH-fixture.msi','sha256':hashlib.sha256(openssh).hexdigest()}}
        sources=windows_source_files(Path(__file__).resolve().parents[1],public_release=True)
        original_read_text=Path.read_text
        def read_text(path,*args,**kwargs):
            return json.dumps(pins) if path.name=='windows-installers.json' else original_read_text(path,*args,**kwargs)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);bundle=root/'setup.zip';exe=root/'setup.exe'
            for mode in ('correct','old-pins','modified-engine','missing-engine','extra-engine',
                         'old-script','missing-script','extra-script','missing-license','modified-openssh','duplicate-script'):
                buffer=io.BytesIO()
                with zipfile.ZipFile(buffer,'w') as engine:
                    engine.writestr('engine-files.json',json.dumps({'source':pins['rustdesk'],'files':files}))
                    if mode!='missing-engine':engine.writestr('rustdesk.exe',native if mode!='modified-engine' else b'MZ changed')
                    if mode=='extra-engine':engine.writestr('unexpected.ini',b'extra')
                payload=buffer.getvalue()
                with zipfile.ZipFile(bundle,'w') as archive:
                    for name,body in sources.items():
                        if name=='windows-installers.json' or mode=='missing-script' and name=='setup-uninstall.ps1' or mode=='missing-license' and name=='third-party-licenses/RustDesk-AGPL-3.0.txt':continue
                        archive.writestr(name,body if mode!='old-script' or name!='setup-windows.ps1' else b'old script')
                    if mode=='extra-script':archive.writestr('unexpected.ps1',b'unsupported')
                    if mode=='duplicate-script':
                        with self.assertWarns(UserWarning):archive.writestr('setup-windows.ps1',sources['setup-windows.ps1'])
                    archive.writestr('setup-config.json',json.dumps(config))
                    archive.writestr('windows-installers.json',json.dumps(pins if mode!='old-pins' else {'rustdesk':{'sha256':'0'*64}}))
                    archive.writestr('installers/OpenSSH-fixture.msi',openssh if mode!='modified-openssh' else b'modified MSI')
                    archive.writestr('gmssh-connect.exe',helper)
                    archive.writestr('connect-payload.json',json.dumps({'filename':'gmssh-connect.exe','protocol':1,'sourceSha256':source_digest(),'sha256':hashlib.sha256(helper).hexdigest()}))
                    archive.writestr('desktop-engine.zip',payload)
                    archive.writestr('desktop-payload.json',json.dumps({'filename':'desktop-engine.zip','sourceSha256':pins['rustdesk']['sha256'],'sha256':hashlib.sha256(payload).hexdigest()}))
                exe.write_bytes(b'MZ synthetic wrapper\0'+bundle.read_bytes())
                with patch.object(Path,'read_text',read_text):
                    if mode=='correct':check_windows(bundle,exe,config['version'])
                    else:
                        with self.assertRaises(ValueError,msg=mode):check_windows(bundle,exe,config['version'])

    def test_exports_source_without_profiles_and_refuses_linked_or_identifying_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'gmssh_windows_bridge').mkdir()
            (root/'README.md').write_text('public guide')
            (root/'AGENTS.md').write_text('portable development instructions')
            (root/'gmssh_windows_bridge/module.py').write_text('public source')
            (root/'gmssh_windows_bridge/agent.json').write_text('private fixture')
            (root/'gmssh_windows_bridge/file-places.json').write_text('private favorite paths')
            web=root/'gmssh_windows_bridge/desktop_web';web.mkdir()
            (web/'gmssh-home.js').write_text('canonical generated asset')
            (web/'gmssh-home 2.js').write_text('pre-existing conflict copy')
            files = public_files(root)
            self.assertEqual(set(files), {'README.md', 'AGENTS.md', 'gmssh_windows_bridge/module.py','gmssh_windows_bridge/desktop_web/gmssh-home.js'})
            self.assertEqual((web/'gmssh-home 2.js').read_text(),'pre-existing conflict copy')
            for name in ['catalog.json', 'connection.json', 'local.app/info.json', 'bridge_host_key', 'windows_known_hosts', '.DS_Store',
                         'private/ai-devices.json', 'private/ai-status.json', 'private/ai-tasks.json', 'private/ai-job-11111111111111111111111111111111.dat', 'private/registry.lock',
                         'private/connect-password.dat', 'private/connect-meta.dat', 'private/connect-identity.dat', 'private/uninstall.json',
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
