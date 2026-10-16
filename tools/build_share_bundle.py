"""Export public release packages from source, never from a running GMSSH profile."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import stat
import zipfile

ROOT_FILES = {'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'SECURITY.md', 'pyproject.toml', '.gitignore'}
SOURCE_DIRS = ('gmssh_windows_bridge', 'desktop-web', 'tools', 'tests', 'docs', 'examples', 'install', '.github')
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', 'build', 'dist', 'work', 'outputs', '.pytest_cache'}
PRIVATE_NAMES = {'.ds_store', 'catalog.json', 'connection.json', 'agent.json', 'readiness.json', 'launcher-config.json', 'installation-status.txt', 'startup-status.json',
                 'connect-meta.dat', 'connect-password.dat', 'connect-identity.dat', 'transfer-journal.json'}
PRIVATE_SUFFIXES = {'.key', '.pem', '.db', '.sqlite', '.sqlite3', '.log', '.pyc', '.exe', '.msi', '.dmg', '.whl', '.zip', '.gmsshbackup', '.part'}


def private_path(name):
    parts = Path(name).parts
    base = Path(name).name.lower()
    return (any(p in SKIP_DIRS or p.endswith(('.app', '.egg-info')) for p in parts)
            or name.startswith('gmssh_windows_bridge/desktop_web/') and re.search(r' \d+\.[^./]+$', base) is not None
            or base in PRIVATE_NAMES or base.startswith(('._', '.env', 'gmssh-connection', 'gmssh-readiness', 'gmssh-devices-'))
            or 'host_key' in base or 'known_hosts' in base or Path(base).suffix in PRIVATE_SUFFIXES)


def check_content(name, content, deny_values=()):
    patterns = {
        'personal home path': rb'/(?:Users|home)/[A-Za-z0-9_.-]+/',
        'private key': rb'-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{32,}',
        'access token': rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,})',
    }
    for label, pattern in patterns.items():
        if re.search(pattern, content):
            raise ValueError(f'{name}: {label}')
    for value in deny_values:
        if value and value.encode() in content:
            raise ValueError(f'{name}: private value')


def public_files(root, deny_values=()):
    files = {}
    candidates = [root / name for name in sorted(ROOT_FILES)]
    for directory in SOURCE_DIRS:
        folder = root / directory
        if folder.exists():
            candidates.extend(folder.rglob('*'))
    for file in candidates:
        name = file.relative_to(root).as_posix()
        if private_path(name):
            continue
        if file.is_symlink():
            raise ValueError(f'{name}: source symlinks are not exported')
        if not file.is_file():
            continue
        content = file.read_bytes()
        check_content(name, content, deny_values)
        files[name] = content
    return dict(sorted(files.items()))


def write_zip(destination, files):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            mode = 0o755 if name.endswith('.command') else 0o644
            entry.external_attr = (stat.S_IFREG | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content)


def checksums(files):
    return ''.join(hashlib.sha256(body).hexdigest() + '  ' + name + '\n' for name, body in sorted(files.items())).encode()


def check_windows(bundle, executable, version, deny_values=()):
    content = bundle.read_bytes()
    body = executable.read_bytes()
    if not body.startswith(b'MZ') or content not in body:
        raise ValueError('Windows executable does not embed the checked bundle')
    check_content(executable.name, body, deny_values)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if archive.testzip():
            raise ValueError('Damaged Windows bundle')
        config = json.loads(archive.read('setup-config.json'))
        expected = {'version': version, 'controllerAddress': 'LocalSubnet', 'monitorOnly': False,
                    'preserveDesktop': False, 'expectedComputer': None, 'runtimeSource': 'microsoft'}
        if config != expected:
            raise ValueError('Windows package has device-specific or unsupported settings')
        if 'installers/VC_redist.x64.exe' in archive.namelist():
            raise ValueError('Public package must obtain Microsoft runtime from Microsoft')
        if tuple(map(int, re.match(r'(\d+)\.(\d+)\.(\d+)a?(\d*)', version).groups(default='0'))) >= (0, 4, 0, 10):
            if __package__:
                from .build_windows_connect import source_digest
            else:
                from build_windows_connect import source_digest
            metadata = json.loads(archive.read('connect-payload.json'))
            if (metadata.get('filename') != 'gmssh-connect.exe' or metadata.get('protocol') != 1
                    or metadata.get('sourceSha256') != source_digest()
                    or metadata.get('sha256') != hashlib.sha256(archive.read('gmssh-connect.exe')).hexdigest()):
                raise ValueError('Connection-code helper source or payload mismatch')
        for name in archive.namelist():
            if Path(name).is_absolute() or '..' in Path(name).parts or Path(name).name.lower() in PRIVATE_NAMES:
                raise ValueError('Windows bundle contains a private or unsafe path')
            part = archive.read(name)
            check_content(name, part, deny_values)
            if name == 'desktop-engine.zip':
                with zipfile.ZipFile(io.BytesIO(part)) as engine:
                    if any(Path(n).suffix.lower() in {'.toml', '.db', '.log', '.key'} for n in engine.namelist()):
                        raise ValueError('Desktop engine contains runtime configuration')


def build(root, output, wheel, windows_bundle=None, windows_setup=None, deny_values=()):
    files = public_files(root, deny_values)
    version = re.search(rb'__version__\s*=\s*"([^"]+)"', files['gmssh_windows_bridge/__init__.py'])[1].decode()
    if not wheel.name.startswith('gmssh_windows_bridge-' + version + '-'):
        raise ValueError('Wheel version does not match public source')
    if output.exists():
        raise ValueError('Choose a new output directory; existing artifacts are preserved')
    with zipfile.ZipFile(wheel) as package:
        if package.testzip():
            raise ValueError('Damaged wheel')
        for name in package.namelist():
            if name.endswith('/'):
                continue
            if Path(name).is_absolute() or '..' in Path(name).parts:
                raise ValueError('Unsafe wheel path')
            content = package.read(name)
            check_content(name, content, deny_values)
            if name.startswith('gmssh_windows_bridge/') and files.get(name) != content:
                raise ValueError(f'{name}: wheel differs from current public source')
    if bool(windows_bundle) != bool(windows_setup):
        raise ValueError('Supply both Windows bundle and executable for verification')
    if windows_setup:
        check_windows(windows_bundle, windows_setup, version, deny_values)
    output.mkdir(parents=True)
    file_hashes = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    source_manifest = json.dumps({'version': version, 'files': file_hashes}, ensure_ascii=False, indent=2).encode()
    write_zip(output / f'GMSSH-Source-{version}.zip', {**files, 'PUBLIC-SOURCE-MANIFEST.json': source_manifest})
    mac = {'Install GMSSH.command': files['install/macos/Install GMSSH.command'],
           'requirements-macos.txt': files['install/macos/requirements-macos.txt'],
           'python-runtime.plist': files['install/macos/python-runtime.plist'],
           'README.txt': files['docs/getting-started.md'], 'LICENSE': files['LICENSE'], wheel.name: wheel.read_bytes()}
    mac['SHA256SUMS'] = checksums(mac)
    write_zip(output / f'GMSSH-Mac-Setup-{version}.zip', mac)
    shutil.copy2(wheel, output / wheel.name)
    if windows_setup:
        shutil.copyfile(windows_setup, output / f'GMSSH-Windows-Setup-{version}.exe')
    (output / 'README.txt').write_bytes(files['docs/getting-started.md'])
    (output / 'SHA256SUMS').write_bytes(checksums({p.name: p.read_bytes() for p in output.iterdir() if p.is_file()}))
    return {'version': version, 'sourceFiles': len(files), 'files': sorted(p.name for p in output.iterdir())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--wheel', type=Path)
    parser.add_argument('--windows-bundle', type=Path)
    parser.add_argument('--windows-setup', type=Path)
    parser.add_argument('--deny-values', type=Path, help='Private JSON string list; never copied into exports')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    deny = json.loads(args.deny_values.read_text()) if args.deny_values else []
    if not isinstance(deny, list) or any(not isinstance(value, str) for value in deny):
        parser.error('private deny values must be a JSON string list')
    try:
        if args.check_only:
            print(json.dumps({'publicFiles': len(public_files(root, deny)), 'check': 'passed'}))
        else:
            if not args.output or not args.wheel:
                parser.error('supply --output and --wheel, or --check-only')
            print(json.dumps(build(root, args.output, args.wheel, args.windows_bundle, args.windows_setup, deny)))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
