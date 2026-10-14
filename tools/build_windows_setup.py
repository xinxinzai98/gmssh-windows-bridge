"""Build the Windows LAN first-run bundle, optionally with the official installer."""
import argparse
import hashlib
import ipaddress
import json
import re
from pathlib import Path
import zipfile


def build(output, installer=None, controller="LocalSubnet", openssh=None, engine=None, monitor_only=False,
          vcredist=None, preserve_desktop=False, expected_computer=None):
    if controller != "LocalSubnet" and ipaddress.ip_address(controller).version != 4:
        raise ValueError("use LocalSubnet or one controller IPv4 address")
    if output.exists():
        raise ValueError("choose a new output path; existing bundles are preserved")
    root = Path(__file__).resolve().parents[1]
    source = root / "gmssh_windows_bridge"
    manifest = json.loads((source / "windows-installers.json").read_text())
    if openssh is None or hashlib.sha256(openssh.read_bytes()).hexdigest() != manifest['openssh']['sha256']:
        raise ValueError('include the pinned official offline OpenSSH MSI')
    if vcredist is None or hashlib.sha256(vcredist.read_bytes()).hexdigest() != manifest['vcredist']['sha256']:
        raise ValueError('include the pinned official Microsoft runtime')
    payload = None
    if not monitor_only:
        if installer is None or hashlib.sha256(installer.read_bytes()).hexdigest() != manifest['rustdesk']['sha256']:
            raise ValueError('verify the original official RustDesk portable release')
        if engine is None:
            raise ValueError('extract the verified native engine before building the complete installer')
        engine_manifest = json.loads((engine / 'engine-files.json').read_text())
        if engine_manifest['source']['sha256'] != manifest['rustdesk']['sha256']:
            raise ValueError('desktop engine source differs from the pinned release')
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
        names = ['setup-windows.cmd', 'setup-windows.ps1', 'setup-checks.ps1', 'setup-progress.ps1', 'setup-monitor.ps1', 'install-vc-runtime.ps1', 'windows-installers.json', 'credential-dialog.ps1']
        if not monitor_only:
            names += ['setup-desktop.ps1', 'install-desktop-engine.ps1', 'gmssh-agent.ps1']
        for name in names:
            content = (source / name).read_bytes()
            if name.endswith(".ps1"):
                content = content.decode("utf-8-sig").encode("utf-8-sig")
            if name.endswith(".cmd"):
                content = content.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            bundle.writestr(name, content)
        for file in sorted((source / 'brand').glob('*')):
            if file.is_file():
                bundle.write(file, 'brand/' + file.name)
        version = re.search(r'__version__\s*=\s*[\'"]([^\'"]+)', (source / '__init__.py').read_text()).group(1)
        bundle.writestr("setup-config.json", json.dumps({"version": version, "controllerAddress": controller, "monitorOnly": monitor_only,
                                                      "preserveDesktop": preserve_desktop,
                                                      "expectedComputer": expected_computer}, indent=2))
        bundle.writestr("README.txt", (root / "docs/windows-first-run.md").read_text().encode("utf-8-sig"))
        bundle.write(openssh, 'installers/' + manifest['openssh']['filename'])
        bundle.write(vcredist, 'installers/' + manifest['vcredist']['filename'])
        if payload is not None:
            bundle.writestr('desktop-engine.zip', payload, compress_type=zipfile.ZIP_STORED)
            bundle.writestr('desktop-payload.json', json.dumps({'filename':'desktop-engine.zip',
                'sha256':hashlib.sha256(payload).hexdigest(), 'sourceSha256':manifest['rustdesk']['sha256']}, indent=2))
        for file in (source / 'third_party').iterdir():
            if not monitor_only or file.name == 'Go-LICENSE.txt':
                bundle.write(file, 'third-party-licenses/' + file.name)
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
    parser.add_argument('--monitor-only', action='store_true')
    parser.add_argument('--preserve-desktop', action='store_true')
    parser.add_argument('--vc-runtime', type=Path, required=True)
    parser.add_argument('--expected-computer')
    parser.add_argument("--controller-address", default="LocalSubnet")
    args = parser.parse_args()
    print(build(args.output, args.rustdesk_installer, args.controller_address,
                args.openssh_installer, args.desktop_engine, args.monitor_only, args.vc_runtime,
                args.preserve_desktop, args.expected_computer))
