"""Build a local macOS launcher from the installed, unchanged GMSSH runtime."""

import argparse
import ctypes
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid


def write_asar(destination, files):
    offset = 0
    tree = {"files": {}}
    for name, body in files.items():
        digest = hashlib.sha256(body).hexdigest()
        tree["files"][name] = {"size": len(body), "offset": str(offset), "integrity": {
            "algorithm": "SHA256", "hash": digest, "blockSize": 4194304, "blocks": [digest]}}
        offset += len(body)
    header = json.dumps(tree, separators=(",", ":")).encode()
    padding = (-len(header)) % 4
    pickle = struct.pack("<II", 4 + len(header) + padding, len(header)) + header + b"\0" * padding
    destination.write_bytes(struct.pack("<II", 4, len(pickle)) + pickle + b"".join(files.values()))
    return hashlib.sha256(header).hexdigest()


def refresh_executable_uuid(path):
    """Give this copied 64-bit executable its own local-network privacy identity."""
    data = bytearray(path.read_bytes())
    if len(data) < 32 or struct.unpack_from('<I', data)[0] != 0xFEEDFACF:
        raise ValueError('the launcher requires a thin 64-bit GMSSH executable')
    commands, size = struct.unpack_from('<II', data, 16)
    offset, end = 32, 32 + size
    if end > len(data):
        raise ValueError('invalid Mach-O load commands')
    for _ in range(commands):
        if offset + 8 > end:
            break
        command, length = struct.unpack_from('<II', data, offset)
        if length < 8 or offset + length > end:
            break
        if command == 0x1B and length == 24:  # LC_UUID
            data[offset + 8:offset + 24] = uuid.uuid4().bytes
            path.write_bytes(data)
            return
        offset += length
    raise ValueError('the GMSSH executable has no valid UUID command')


def monitor_options(config):
    """Keep monitoring optional and give each target its own pinned SSH identity."""
    if config.monitor_port is None:
        if config.monitor_username or config.monitor_known_hosts or config.monitor_host_key:
            raise ValueError("monitor settings require --monitor-port")
        return None
    if not 1 <= config.monitor_port <= 65535 or config.monitor_port == config.port:
        raise ValueError("monitor port must be valid and different from the desktop port")
    if not 1 <= config.monitor_target_port <= 65535:
        raise ValueError("invalid Windows SSH port")
    if not config.monitor_username or not config.monitor_known_hosts or not config.monitor_host_key:
        raise ValueError("monitoring requires a username, verified known_hosts and a dedicated host-key path")
    known_hosts = config.monitor_known_hosts.expanduser().resolve()
    if not known_hosts.is_file():
        raise ValueError("verify the Windows SSH host key before enabling monitoring")
    return {"port": config.monitor_port, "targetPort": config.monitor_target_port,
            "username": config.monitor_username, "knownHosts": str(known_hosts),
            "hostKey": str(config.monitor_host_key.expanduser().absolute()),
            "forwardTerminal": getattr(config, 'monitor_terminal', True)}


def native_profile(config, source):
    """The vendor's local servers live in user data, outside its signed app."""
    with (source / 'MacOS/GMSSH').open('rb') as executable:
        header = executable.read(8)
    if len(header) != 8:
        raise ValueError('invalid GMSSH executable')
    magic, cpu = struct.unpack('<II', header)
    architecture = {0x0100000C: 'arm64', 0x01000007: 'x64'}.get(cpu)
    if magic != 0xFEEDFACF or architecture is None:
        raise ValueError('unsupported GMSSH executable architecture')
    profile = (config.profile or Path.home() / 'Library/Application Support/GMSSH').expanduser().absolute()
    servers = [profile / f'serve/app/gs/bin/gs_main_mac_{architecture}', profile / f'serve/multi/gmb_multi_server_mac_{architecture}']
    if any(not file.is_file() or file.stat().st_size == 0 for file in servers):
        raise ValueError('GMSSH 本地服务资源尚未初始化。请先打开官方 GMSSH，确认设备首页可用后退出再安装；自定义 --profile 也必须包含已初始化的 serve 资源。')
    return profile


def _build_launcher(config, output):
    monitor = monitor_options(config)
    source = config.gmssh_app.resolve() / "Contents"
    # Read-only verification: refuse a modified or unexpected vendor installation.
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(source.parent)],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    info = plistlib.loads((source / "Info.plist").read_bytes())
    if info["CFBundleIdentifier"] != "com.gmssh.com" or info["CFBundleShortVersionString"] != "2.0.4":
        raise ValueError("this preview launcher has only been checked against GMSSH 2.0.4")
    profile = native_profile(config, source)
    subprocess.run([str(config.python), "-c", "import gmssh_windows_bridge.desktop, websockets"], check=True)
    if output.exists():
        raise ValueError("choose a new output path; an existing launcher is never overwritten")
    if output.suffix != ".app":
        raise ValueError("output must be an .app bundle")
    contents = output / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    shutil.copyfile(source / "MacOS/GMSSH", contents / "MacOS/GMSSH")
    (contents / "MacOS/GMSSH").chmod(0o755)
    # macOS privacy may conflate different apps that share a main executable UUID.
    refresh_executable_uuid(contents / "MacOS/GMSSH")
    # Native APFS clone: helper executables must resolve inside our own bundle.
    # A framework symlink makes child processes resolve the vendor's app instead.
    subprocess.run(["cp", "-cR", str(source / "Frameworks"), str(contents / "Frameworks")], check=True)
    for resource in (source / "Resources").iterdir():
        if resource.name != "app.asar":
            subprocess.run(["cp", "-cR", str(resource), str(contents / "Resources" / resource.name)], check=True)
    here = Path(__file__).parent
    payload = {"vendorAsar": str(source / "Resources/app.asar"), "python": str(config.python.absolute()),
               "target": config.target, "port": config.port,
               "label": config.label, "machineId": config.machine_id,
               "profile": str(profile)}
    payload["keychain"] = config.keychain
    payload["monitor"] = monitor
    payload["pairingOnly"] = getattr(config, 'pairing_only', False)
    from .desktop_operations import wake_settings
    wake = wake_settings(config)
    if wake:
        payload['wake'] = {'mac': config.wake_mac, 'broadcast': config.wake_broadcast}
    if monitor is None and not payload['pairingOnly']:
        payload.update(tailscaleName=config.tailscale_name, tailscaleCli=str(config.tailscale_cli.absolute()))
    if config.profile:
        config.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    digest = write_asar(contents / "Resources/app.asar", {
        "package.json": json.dumps({"name": "GMSSH", "version": "2.0.4", "main": "launcher.cjs"}).encode(),
        "launcher.cjs": (here / "launcher.cjs").read_bytes(),
        "file-tasks.cjs": (here / "file-tasks.cjs").read_bytes(),
        "pairing.cjs": (here / "pairing.cjs").read_bytes(),
        "device-backup.cjs": (here / "device-backup.cjs").read_bytes(),
        "readonly-tools.cjs": (here / "readonly-tools.cjs").read_bytes(),
        "launcher-config.json": json.dumps(payload, ensure_ascii=False).encode(),
        "gmssh-entry.js": (here / "desktop_web/gmssh-entry.js").read_bytes(),
        "gmssh-home.js": (here / "desktop_web/gmssh-home.js").read_bytes(),
        "gmssh-pairing.js": (here / "desktop_web/gmssh-pairing.js").read_bytes(),
        "gmssh-backup.js": (here / "desktop_web/gmssh-backup.js").read_bytes(),
        "gmssh-tools.js": (here / "desktop_web/gmssh-tools.js").read_bytes(),
        "gmssh-files.js": (here / "desktop_web/gmssh-files.js").read_bytes(),
        "gmssh-qr.js": (here / "desktop_web/gmssh-qr.js").read_bytes(),
        "jsQR.js": (here / "desktop_web/vendor/jsQR.js").read_bytes(),
        "gmssh-theme.css": (here / "desktop_web/gmssh-theme.css").read_bytes(),
    })
    brand = here / 'brand/gmssh.icns'
    if brand.is_file():
        shutil.copyfile(brand, contents / 'Resources/gmssh.icns')
        # GMSSH also sets the Dock image from this runtime resource.
        shutil.copyfile(brand, contents / 'Resources/icon.icns')
        info['CFBundleIconFile'] = 'gmssh.icns'
    info["CFBundleIdentifier"] = "local.gmssh.windows.launcher"
    if config.profile:
        info["CFBundleIdentifier"] += '.preview'
    info["CFBundleDisplayName"] = output.stem
    # Electron finds its existing helper bundles using the vendor's CFBundleName.
    info['NSLocalNetworkUsageDescription'] = '连接你添加的局域网电脑，提供监控、终端、文件传输和远程桌面。'
    info['NSCameraUsageDescription'] = '仅在你点击扫码后，使用摄像头在本机识别电脑连接二维码。'
    info.pop("CFBundleURLTypes", None)
    info["ElectronAsarIntegrity"]["Resources/app.asar"]["hash"] = digest
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    entitlements = contents / "Resources/launcher-entitlements.plist"
    entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit": True,
        "com.apple.security.cs.allow-unsigned-executable-memory": True,
        "com.apple.security.cs.disable-library-validation": True}))
    # Finder adds these metadata attributes to local builds; never traverse a
    # symlink here, so the original installation cannot be altered.
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    libc.removexattr.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    for attempt in range(2):
        for root, _, names in os.walk(output, followlinks=False):
            for item in [Path(root), *(Path(root) / n for n in names)]:
                if not item.is_symlink():
                    for attribute in (b"com.apple.FinderInfo", b"com.apple.ResourceFork"):
                        libc.removexattr(os.fsencode(item), attribute, 0)
        signed = subprocess.run(["codesign", "--force", "--sign", "-", "--entitlements", str(entitlements), str(output)],
                                capture_output=True)
        if signed.returncode == 0:
            break
        # iCloud/Finder can attach package metadata during the first signing pass.
        if attempt or b"resource fork" not in signed.stderr:
            signed.check_returncode()
    subprocess.run(["codesign", "--verify", "--strict", str(output)], check=True)
    return output


def build_launcher(config):
    output = config.output.absolute()
    if output.exists():
        raise ValueError("choose a new output path; an existing launcher is never overwritten")
    # Build and sign off iCloud: File Provider can attach FinderInfo while a
    # newly-created .app is being signed. Moving the signed bundle is supported.
    with tempfile.TemporaryDirectory(prefix="gmssh-launcher-") as temporary:
        staged = _build_launcher(config, Path(temporary) / output.name)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staged), str(output))
    subprocess.run(["codesign", "--verify", "--strict", str(output)], check=True)
    return output


def main():
    parser = argparse.ArgumentParser(description="Build a personal one-click GMSSH Windows desktop launcher on macOS")
    parser.add_argument("--gmssh-app", type=Path, default=Path("/Applications/极目Linux桌面.app"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--target")
    parser.add_argument("--pairing-only", action="store_true", help="Start a general controller and import Windows connection files from the UI")
    parser.add_argument("--tailscale-name", help="Optional legacy direct-Tailscale preview; LAN monitoring does not use this")
    parser.add_argument("--tailscale-cli", type=Path, default=Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
    parser.add_argument("--port", type=int, default=22243)
    parser.add_argument("--label", default="Windows 桌面")
    parser.add_argument("--machine-id")
    parser.add_argument("--monitor-port", type=int, help="Start the existing read-only monitoring bridge with the desktop")
    parser.add_argument("--monitor-target-port", type=int, default=22)
    parser.add_argument("--monitor-username", help="Existing Windows SSH account; password stays in the GMSSH login flow")
    parser.add_argument("--monitor-known-hosts", type=Path, help="Previously verified Windows SSH host keys")
    parser.add_argument("--monitor-host-key", type=Path, help="Dedicated local bridge host-key file for this Windows device")
    parser.add_argument('--monitor-terminal', action=argparse.BooleanOptionalAction, default=True, help='Enable the native Windows PowerShell terminal for this monitored device')
    parser.add_argument('--wake-mac', help='Previously paired physical network-adapter MAC; hardware WoL must already be enabled')
    parser.add_argument('--wake-broadcast', help='Actual local subnet broadcast IPv4 address for this paired device')
    parser.add_argument("--keychain", action="store_true", help="Offer opt-in macOS Keychain storage in the viewer")
    parser.add_argument("--profile", type=Path, help="Separate browser state for previews; GMSSH machine data may still be shared")
    config = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("this local launcher requires macOS")
    try:
        if not 1 <= config.port <= 65535:
            raise ValueError("use a valid local desktop port")
        if config.pairing_only:
            if config.target or config.monitor_port is not None or config.tailscale_name or config.wake_mac or config.wake_broadcast:
                raise ValueError('--pairing-only cannot be combined with a fixed target')
        elif not config.target:
            raise ValueError('use --pairing-only or specify --target')
        elif config.monitor_port is not None:
            from .address import ssh_target
            config.target = ssh_target(config.target)
        elif not config.tailscale_name or ipaddress.ip_address(config.target) not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("LAN desktop requires the monitoring SSH settings; direct Tailscale is a legacy opt-in")
        print(build_launcher(config))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.error(f"launcher build failed ({type(error).__name__}): {error}")


if __name__ == "__main__":
    main()
