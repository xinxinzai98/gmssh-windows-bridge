"""Wrap a complete, verified offline setup ZIP in one Windows x64 executable."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


def build(bundle, output, go):
    if output.exists():
        raise ValueError('choose a new output file')
    with zipfile.ZipFile(bundle) as archive:
        if archive.testzip() or 'setup-windows.ps1' not in archive.namelist():
            raise ValueError('invalid setup bundle')
    source = Path(__file__).resolve().parent / 'windows_installer'
    icon = source.parent.parent / 'gmssh_windows_bridge' / 'brand' / 'gmssh.ico'
    if not icon.is_file():
        raise ValueError('Windows installer icon is missing')
    with tempfile.TemporaryDirectory(prefix='gmssh-windows-exe-', dir='/private/tmp') as folder:
        stage = Path(folder)
        for name in ('main_windows.go', 'extract.go'):
            shutil.copyfile(source / name, stage / name)
        shutil.copyfile(bundle, stage / 'setup.zip')
        environment = {**os.environ, 'CGO_ENABLED':'0', 'GOTOOLCHAIN':'local', 'GOENV':'off',
                       'GOFLAGS':'', 'GOWORK':'off', 'GOTMPDIR':str(stage),
                       'GOCACHE':'/private/tmp/gmssh-go-build/cache', 'GOPATH':'/private/tmp/gmssh-go-build/gopath',
                       'GOMODCACHE':'/private/tmp/gmssh-go-build/modules', 'GOPROXY':'https://proxy.golang.org',
                       'GOSUMDB':'sum.golang.org', 'GOPRIVATE':'', 'GONOPROXY':'', 'GONOSUMDB':'',
                       'GOAUTH':'off', 'GOVCS':'*:off', 'GO111MODULE':'on'}
        environment.pop('GOOS', None)
        environment.pop('GOARCH', None)
        # MIT-licensed build-only tool, pinned and cached outside the repository.
        subprocess.run([str(go), 'run', 'github.com/akavel/rsrc@v0.10.2', '-arch', 'amd64',
                        '-ico', str(icon), '-o', 'rsrc_windows_amd64.syso'], cwd=stage, env=environment, check=True)
        environment.update({'GOOS':'windows', 'GOARCH':'amd64', 'GO111MODULE':'off'})
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([str(go), 'build', '-trimpath', '-ldflags=-s -w -H=windowsgui', '-o',
                        str(output.absolute()), '.'], cwd=stage, env=environment, check=True)
    return output, hashlib.sha256(output.read_bytes()).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--go', type=Path, required=True)
    args = parser.parse_args()
    print(build(args.bundle, args.output, args.go))
