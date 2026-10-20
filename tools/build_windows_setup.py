"""Build the Windows LAN first-run bundle, optionally with the official installer."""
import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
import zipfile


def windows_source_files(root, monitor_only=False, public_release=False):
    source = root / 'gmssh_windows_bridge'
    names = ['setup-windows.cmd', 'setup-windows.ps1', 'setup-checks.ps1', 'setup-existing.ps1', 'setup-progress.ps1', 'setup-monitor.ps1', 'install-vc-runtime.ps1', 'windows-installers.json', 'credential-dialog.ps1']
    if not monitor_only:
        names += ['setup-desktop.ps1', 'install-desktop-engine.ps1', 'gmssh-agent.ps1', 'controller-panel.ps1', 'collector.ps1', 'login.ps1', 'system-info.ps1', 'readonly-tools.ps1', 'ai-context.ps1', 'ai-desktop.ps1', 'setup-maintenance.ps1', 'setup-connect.ps1', 'setup-network.ps1', 'setup-uninstall.ps1', 'uninstall-windows.ps1']
    files = {}
    for name in names:
        content = (source / name).read_bytes()
        if name.endswith('.ps1'):
            content = content.decode('utf-8-sig').encode('utf-8-sig')
        if name.endswith('.cmd'):
            content = content.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        files[name] = content
    for file in sorted((source / 'brand').glob('*')):
        if file.is_file():
            files['brand/' + file.name] = file.read_bytes()
    guide = 'getting-started.md' if public_release else 'windows-first-run.md'
    files['README.txt'] = (root / 'docs' / guide).read_text().encode('utf-8-sig')
    for file in (source / 'third_party').iterdir():
        if not monitor_only or file.name == 'Go-LICENSE.txt':
            files['third-party-licenses/' + file.name] = file.read_bytes()
            if file.name == 'go-qrcode-MIT.txt':
                files['go-qrcode-LICENSE.txt'] = file.read_bytes()
    return files


def check_engine_files(files, expected_digest):
    if (not isinstance(files, dict) or not files or 'rustdesk.exe' not in files
            or not isinstance(expected_digest, str)
            or hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest() != expected_digest):
        raise ValueError('desktop engine file manifest differs from the pinned official payload')
    for name, digest in files.items():
        if not isinstance(name, str) or not isinstance(digest, str):
            raise ValueError('unsafe engine file manifest')
        relative = Path(name)
        if (relative.is_absolute() or '..' in relative.parts
                or ':' in name or '\\' in name or not re.fullmatch('[a-f0-9]{64}', digest)):
            raise ValueError('unsafe engine file manifest')


def build(output, installer=None, controller="LocalSubnet", openssh=None, engine=None, monitor_only=False,
          vcredist=None, preserve_desktop=False, expected_computer=None, runtime_source='bundled', public_release=False,
          connect_helper=None):
    if runtime_source not in ('bundled', 'microsoft'):
        raise ValueError('choose bundled or microsoft runtime source')
    if public_release and (controller != 'LocalSubnet' or preserve_desktop or expected_computer or monitor_only or runtime_source != 'microsoft'):
        raise ValueError('public packages require generic LAN settings and Microsoft runtime download')
    if controller != "LocalSubnet" and ipaddress.ip_address(controller).version != 4:
        raise ValueError("use LocalSubnet or one controller IPv4 address")
    if output.exists():
        raise ValueError("choose a new output path; existing bundles are preserved")
    root = Path(__file__).resolve().parents[1]
    source = root / "gmssh_windows_bridge"
    manifest = json.loads((source / "windows-installers.json").read_text())
    if openssh is None or hashlib.sha256(openssh.read_bytes()).hexdigest() != manifest['openssh']['sha256']:
        raise ValueError('include the pinned official offline OpenSSH MSI')
    if runtime_source == 'bundled' and (vcredist is None or hashlib.sha256(vcredist.read_bytes()).hexdigest() != manifest['vcredist']['sha256']):
        raise ValueError('include the pinned official Microsoft runtime')
    payload = None
    connect_files = {}
    if not monitor_only:
        if connect_helper is None:
            raise ValueError('include the verified connection-code helper')
        if __package__:
            from .build_windows_connect import source_digest
        else:
            from build_windows_connect import source_digest
        connect_manifest = json.loads((connect_helper / 'connect-payload.json').read_text())
        helper = (connect_helper / 'gmssh-connect.exe').read_bytes()
        if (connect_manifest.get('filename') != 'gmssh-connect.exe' or connect_manifest.get('protocol') != 1
                or connect_manifest.get('sourceSha256') != source_digest()
                or connect_manifest.get('sha256') != hashlib.sha256(helper).hexdigest() or not helper.startswith(b'MZ')):
            raise ValueError('connection-code helper differs from the checked public source')
        connect_files = {'gmssh-connect.exe': helper, 'connect-payload.json': (connect_helper / 'connect-payload.json').read_bytes()}
        if installer is None or hashlib.sha256(installer.read_bytes()).hexdigest() != manifest['rustdesk']['sha256']:
            raise ValueError('verify the original official RustDesk portable release')
        if engine is None:
            raise ValueError('extract the verified native engine before building the complete installer')
        engine_manifest = json.loads((engine / 'engine-files.json').read_text())
        if engine_manifest['source']['sha256'] != manifest['rustdesk']['sha256']:
            raise ValueError('desktop engine source differs from the pinned release')
        check_engine_files(engine_manifest['files'], manifest['rustdesk']['filesSha256'])
        import io
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, expected in engine_manifest['files'].items():
                relative = Path(name)
                if relative.is_absolute() or '..' in relative.parts or ':' in name:
                    raise ValueError('unsafe engine path')
                content = (engine / relative).read_bytes()
                if hashlib.sha256(content).hexdigest() != expected:
                    raise ValueError('native engine content differs from the official payload')
                archive.writestr(name, content)
            archive.write(engine / 'engine-files.json', 'engine-files.json')
        payload = buffer.getvalue()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name, content in windows_source_files(root, monitor_only, public_release).items():
            bundle.writestr(name, content)
        for name, content in connect_files.items():
            bundle.writestr(name, content)
        version = re.search(r'__version__\s*=\s*[\'"]([^\'"]+)', (source / '__init__.py').read_text()).group(1)
        bundle.writestr("setup-config.json", json.dumps({"version": version, "controllerAddress": controller, "monitorOnly": monitor_only,
                                                      "preserveDesktop": preserve_desktop,
                                                      "expectedComputer": expected_computer, "runtimeSource": runtime_source}, indent=2))
        bundle.write(openssh, 'installers/' + manifest['openssh']['filename'])
        if runtime_source == 'bundled':
            bundle.write(vcredist, 'installers/' + manifest['vcredist']['filename'])
        if payload is not None:
            bundle.writestr('desktop-engine.zip', payload, compress_type=zipfile.ZIP_STORED)
            bundle.writestr('desktop-payload.json', json.dumps({'filename':'desktop-engine.zip',
                'sha256':hashlib.sha256(payload).hexdigest(), 'sourceSha256':manifest['rustdesk']['sha256']}, indent=2))
    with zipfile.ZipFile(output) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("bundle integrity check failed")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rustdesk-installer", type=Path)
    parser.add_argument('--openssh-installer', type=Path, required=True)
    parser.add_argument('--desktop-engine', type=Path)
    parser.add_argument('--connect-helper', type=Path, help='Output directory of build_windows_connect.py')
    parser.add_argument('--monitor-only', action='store_true')
    parser.add_argument('--preserve-desktop', action='store_true')
    parser.add_argument('--vc-runtime', type=Path)
    parser.add_argument('--runtime-source', choices=['bundled','microsoft'], default='bundled')
    parser.add_argument('--public-release', action='store_true', help='Refuse device-specific settings and bundled Microsoft runtime')
    parser.add_argument('--expected-computer')
    parser.add_argument("--controller-address", default="LocalSubnet")
    args = parser.parse_args()
    print(build(args.output, args.rustdesk_installer, args.controller_address,
                args.openssh_installer, args.desktop_engine, args.monitor_only, args.vc_runtime,
                args.preserve_desktop, args.expected_computer, args.runtime_source, args.public_release, args.connect_helper))
