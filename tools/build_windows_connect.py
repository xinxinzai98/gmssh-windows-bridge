"""Build the small Windows connection-code helper from public Go source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def source_files():
    source = Path(__file__).resolve().parent / 'windows_connect'
    files = {name: (source / name).read_bytes() for name in ('core.go', 'main.go', 'platform_windows.go', 'qr_png.go', 'controllers.go', 'controller_desktop.go', 'controller_files.go', 'controller_platform_windows.go', 'controller_info.go', 'controller_terminal.go', 'controller_conpty_windows.go')}
    for file in sorted((source / 'qr').rglob('*')):
        if file.is_file() and (file.suffix == '.go' or file.name in {'LICENSE', 'PROVENANCE.json'}):
            files[file.relative_to(source).as_posix()] = file.read_bytes()
    return files


def source_digest():
    return hashlib.sha256(b''.join(name.encode() + b'\0' + body for name, body in sorted(source_files().items()))).hexdigest()


def build(output, go='go'):
    if output.exists():
        raise ValueError('choose a new output directory; existing binaries are preserved')
    files = source_files()
    digest = source_digest()
    output.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory(prefix='gmssh-connect-build-') as temporary:
            stage = Path(temporary)
            for name, body in files.items():
                (stage / name).parent.mkdir(parents=True, exist_ok=True)
                (stage / name).write_bytes(body)
            environment = {**os.environ, 'GO111MODULE': 'off', 'GOOS': 'windows', 'GOARCH': 'amd64', 'CGO_ENABLED': '0'}
            executable = output.resolve() / 'gmssh-connect.exe'
            roots = [name for name in files if '/' not in name and name.endswith('.go')]
            subprocess.run([str(go), 'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -H=windowsgui', '-o', str(executable), *roots], cwd=stage, env=environment, check=True)
        metadata = {'filename': executable.name, 'protocol': 1, 'controllerProtocol': 2, 'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'sourceSha256': digest}
        (output / 'connect-payload.json').write_text(json.dumps(metadata, indent=2) + '\n')
        return metadata
    except Exception:
        # Only this newly created build directory is disposable.
        shutil.rmtree(output)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--go', default='go')
    arguments = parser.parse_args()
    print(json.dumps(build(arguments.output, arguments.go)))
