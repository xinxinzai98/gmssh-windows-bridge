"""Offline, reversible update of an existing 0.4.0a38 Mac enhancement app.

This module runs from the release wheel using an existing Python interpreter.
It never installs a runtime, starts the app, or reads device/keychain stores.
"""
from __future__ import annotations

import argparse
import base64
import csv
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

from . import __version__
from .macos_launcher import write_asar

BASE_VERSION = '0.4.0a38'
APP_ID = 'local.gmssh.windows.launcher'
PACKAGE = 'gmssh_windows_bridge'
APP_FILES = ('Contents/Resources/app.asar', 'Contents/Info.plist',
             'Contents/MacOS/GMSSH', 'Contents/_CodeSignature/CodeResources')


def run(args):
    result = subprocess.run([str(a) for a in args], check=True, capture_output=True, text=True)
    return result.stdout


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('更新文件不是普通文件：' + str(path))
    if path.stat().st_uid != os.getuid():
        raise ValueError('请使用拥有现用客户端的账号更新。')


def tree_is_regular(root):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('更新目录不能是链接或缺失。')
    for path in root.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('更新目录含有链接或特殊文件。')


def read_asar(path):
    regular(path)
    raw = path.read_bytes()
    if len(raw) < 16 or len(raw) > 32 * 1024 * 1024:
        raise ValueError('增强端 ASAR 大小不受支持。')
    marker, length, payload, size = struct.unpack_from('<4I', raw)
    if marker != 4 or length != payload + 4 or size > length - 8 or 8 + length > len(raw):
        raise ValueError('增强端 ASAR 头无效。')
    header = raw[16:16 + size]
    files = {}
    for name, entry in json.loads(header)['files'].items():
        if '/' in name or '\\' in name or name in ('.', '..') or set(entry) - {'size', 'offset', 'integrity'}:
            raise ValueError('只支持本项目的平面增强 ASAR。')
        start, count = 8 + length + int(entry['offset']), entry['size']
        if not isinstance(count, int) or count < 0 or start < 8 + length or start + count > len(raw):
            raise ValueError('增强端 ASAR 文件范围无效。')
        body = raw[start:start + count]
        if entry.get('integrity', {}).get('hash') != hashlib.sha256(body).hexdigest():
            raise ValueError('增强端 ASAR 文件完整性不匹配。')
        files[name] = body
    return files, hashlib.sha256(header).hexdigest()


def read_wheel(path):
    regular(path)
    files = {}
    dist = f'{PACKAGE}-{__version__}.dist-info'
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            name = item.filename
            if (item.is_dir() or name in files or PurePosixPath(name).is_absolute()
                    or '..' in PurePosixPath(name).parts or '\\' in name
                    or not name.startswith((PACKAGE + '/', dist + '/'))
                    or stat.S_ISLNK(item.external_attr >> 16) or item.file_size > 16 * 1024 * 1024):
                raise ValueError('更新 wheel 含有不支持的路径或文件。')
            files[name] = archive.read(item)
            if len(files) > 2000 or sum(map(len, files.values())) > 64 * 1024 * 1024:
                raise ValueError('更新 wheel 超出大小限制。')
    record = dist + '/RECORD'
    rows = list(csv.reader(io.StringIO(files[record].decode())))
    if len(rows) != len(files) or {r[0] for r in rows} != files.keys():
        raise ValueError('更新 wheel 的 RECORD 清单不完整。')
    for name, digest, length in rows:
        if name == record and not digest and not length:
            continue
        expected = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(files[name]).digest()).rstrip(b'=').decode()
        if digest != expected or length != str(len(files[name])):
            raise ValueError('更新 wheel 文件校验失败。')
    if files.get(PACKAGE + '/__init__.py', b'').find(('"' + __version__ + '"').encode()) < 0:
        raise ValueError('更新 wheel 版本不匹配。')
    return files, dist


def runtime_layout(python):
    script = """import json,sys,sysconfig
print(json.dumps({'prefix':sys.prefix,'base':sys.base_prefix,'site':sysconfig.get_path('purelib'),'version':list(sys.version_info[:2])}))"""
    value = json.loads(run([python, '-I', '-c', script]))
    prefix, site = Path(value['prefix']).resolve(), Path(value['site']).resolve()
    if (prefix == Path(value['base']).resolve() or not site.is_relative_to(prefix) or site == prefix
            or tuple(value['version']) < (3, 10) or prefix.stat().st_uid != os.getuid()):
        raise ValueError('只更新增强端现有的独立运行环境，不修改共享或系统 Python。')
    return prefix, site


def ensure_stopped(app):
    for line in run(['/bin/ps', '-ww', '-axo', 'pid=,comm=']).splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[1].startswith(str(app) + '/'):
            raise ValueError('请先从菜单正常退出 GMSSH 增强端，再运行更新；不要强制结束进程。')


def executable_uuid(path):
    raw = path.read_bytes()
    if len(raw) < 32 or struct.unpack_from('<I', raw)[0] != 0xFEEDFACF:
        raise ValueError('增强端程序不是受支持的 64 位 Mach-O。')
    commands, size = struct.unpack_from('<II', raw, 16)
    offset, end = 32, 32 + size
    if end > len(raw):
        raise ValueError('增强端程序头无效。')
    for _ in range(commands):
        if offset + 8 > end:
            break
        command, length = struct.unpack_from('<II', raw, offset)
        if length < 8 or offset + length > end:
            break
        if command == 0x1B and length == 24:
            return raw[offset + 8:offset + 24]
        offset += length
    raise ValueError('增强端缺少有效的主程序 UUID。')


def inspect(app, recovery=None):
    app = app.expanduser().resolve(strict=True)
    if app.suffix != '.app':
        raise ValueError('请选择现用的增强端 App。')
    source = recovery if recovery else app
    for name in APP_FILES:
        regular(source / name)
    if not recovery:
        run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    info = plistlib.loads((source / 'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != APP_ID or info.get('GMSSHBridgeVersion') not in (BASE_VERSION, __version__):
        raise ValueError('此更新器只支持 0.4.0a38 的现有增强端，请保留当前应用。')
    files, digest = read_asar(source / APP_FILES[0])
    if info['ElectronAsarIntegrity']['Resources/app.asar']['hash'] != digest:
        raise ValueError('App 元数据与增强 ASAR 不一致。')
    config = json.loads(files['launcher-config.json'])
    python = config['python']
    if not isinstance(python, str) or not Path(python).is_absolute():
        raise ValueError('现用运行环境路径无效。')
    prefix, site = runtime_layout(python)
    if not recovery:
        tree_is_regular(site / PACKAGE)
    regular(app / 'Contents/Resources/launcher-entitlements.plist')
    ensure_stopped(app)
    return {'app': app, 'info': info, 'files': files, 'python': python, 'prefix': prefix, 'site': site}


def replace_bytes(path, body, mode):
    descriptor, staged = tempfile.mkstemp(prefix='.gmssh-update-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(staged, mode)
        os.replace(staged, path)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


@contextmanager
def update_lock(prefix):
    import fcntl
    # The kernel releases this lock even after an interrupted updater. Keep the
    # inode in place so another invocation cannot accidentally lock a new file.
    descriptor = os.open(prefix / '.gmssh-update.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+b') as handle:
        item = os.fstat(handle.fileno())
        if not stat.S_ISREG(item.st_mode) or item.st_uid != os.getuid() or item.st_nlink != 1:
            raise ValueError('更新锁文件不受支持。')
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('另一个更新或回退正在运行，请稍后再试。') from error
        yield


def restore(state, backup):
    app, site = state['app'], state['site']
    manifest = json.loads((backup / 'manifest.json').read_text())
    if manifest['app'] != str(app) or manifest['site'] != str(site):
        raise ValueError('回退记录不属于此客户端和运行环境。')
    for name in APP_FILES:
        regular(backup / name)
        if hashlib.sha256((backup / name).read_bytes()).hexdigest() != manifest['files'][name]:
            raise ValueError('回退文件校验失败，请保留现场。')
    old_dist = f'{PACKAGE}-{BASE_VERSION}.dist-info'
    new_dist = f'{PACKAGE}-{__version__}.dist-info'
    # Preserve the replaced version as evidence; never recursively delete installed files.
    for name in (PACKAGE, new_dist):
        original = backup / ('runtime-' + (PACKAGE if name == PACKAGE else old_dist))
        destination = site / name
        if original.exists():
            displaced = backup / ('replaced-' + name)
            if displaced.exists():
                raise ValueError('回退目标已存在，请保留现场。')
            if destination.exists():
                destination.rename(displaced)
            original.rename(site / (PACKAGE if name == PACKAGE else old_dist))
    for name in APP_FILES:
        source = backup / name
        regular(source)
        replace_bytes(app / name, source.read_bytes(), stat.S_IMODE(source.stat().st_mode))
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    (backup / 'ROLLED_BACK').write_text('Restored original application and runtime files.\n')


def apply(state, wheel_files, dist):
    app, site, prefix = state['app'], state['site'], state['prefix']
    old_dist = f'{PACKAGE}-{BASE_VERSION}.dist-info'
    if state['info']['GMSSHBridgeVersion'] == __version__:
        raise ValueError('此客户端已是当前版本，未重复更新。')
    tree_is_regular(site / old_dist)
    if (site / dist).exists():
        raise ValueError('目标版本的运行环境记录已存在，请保留现场。')
    backup = prefix / '.gmssh-updates' / __version__
    backup.parent.mkdir(mode=0o700, exist_ok=True)
    if backup.exists():
        raise ValueError('已有此版本的更新记录，请先检查：' + str(backup))
    with update_lock(prefix):
        with tempfile.TemporaryDirectory(prefix='.gmssh-update-stage-', dir=site) as directory:
            stage = Path(directory)
            for name, body in wheel_files.items():
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                path.chmod(0o644)
            run([state['python'], '-I', '-c',
                 "import sys;sys.path.insert(0,sys.argv[1]);import gmssh_windows_bridge.desktop,websockets,paramiko", stage])
            files = dict(state['files'])
            files['gmssh-workspace.js'] = wheel_files[PACKAGE + '/desktop_web/gmssh-workspace.js']
            digest = write_asar(stage / 'app.asar', files)
            info = dict(state['info'])
            info['ElectronAsarIntegrity'] = dict(info['ElectronAsarIntegrity'])
            info['ElectronAsarIntegrity']['Resources/app.asar'] = dict(info['ElectronAsarIntegrity']['Resources/app.asar'], hash=digest)
            info['GMSSHBridgeVersion'] = __version__
            original_uuid = executable_uuid(app / 'Contents/MacOS/GMSSH')
            ensure_stopped(app)
            backup.mkdir(mode=0o700)
            for name in APP_FILES:
                target = backup / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(app / name, target)
            (backup / 'manifest.json').write_text(json.dumps({'app': str(app), 'site': str(site),
                'files': {name: hashlib.sha256((backup / name).read_bytes()).hexdigest() for name in APP_FILES}}, ensure_ascii=False))
            try:
                (site / PACKAGE).rename(backup / ('runtime-' + PACKAGE))
                (site / old_dist).rename(backup / ('runtime-' + old_dist))
                (stage / PACKAGE).rename(site / PACKAGE)
                (stage / dist).rename(site / dist)
                replace_bytes(app / APP_FILES[0], (stage / 'app.asar').read_bytes(), 0o644)
                replace_bytes(app / APP_FILES[1], plistlib.dumps(info), 0o644)
                run(['/usr/bin/codesign', '--force', '--sign', '-', '--entitlements',
                     app / 'Contents/Resources/launcher-entitlements.plist', app])
                run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
                if executable_uuid(app / 'Contents/MacOS/GMSSH') != original_uuid:
                    raise ValueError('主程序 UUID 发生变化，已停止更新。')
                if read_asar(app / APP_FILES[0])[0]['launcher-config.json'] != state['files']['launcher-config.json']:
                    raise ValueError('连接配置校验未通过。')
                run([state['python'], '-I', '-c',
                     "import gmssh_windows_bridge as b;import gmssh_windows_bridge.desktop;assert b.__version__==" + repr(__version__)])
            except BaseException:
                restore(state, backup)
                raise
    return backup


def main():
    parser = argparse.ArgumentParser(description='更新现有 GMSSH 增强端；先正常退出客户端。')
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--app', type=Path, default=Path.home() / 'Applications/GMSSH 局域网增强端.app')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.exit(1, '此更新器仅在 Mac 本机运行。\n')
    try:
        wheel_files, dist = read_wheel(args.wheel)
        state = inspect(args.app, recovery=args.rollback)
        if args.rollback:
            expected = state['prefix'] / '.gmssh-updates' / __version__
            if args.rollback.resolve() != expected.resolve():
                raise ValueError('请选择此运行环境保存的更新回退目录。')
            with update_lock(state['prefix']):
                restore(state, expected)
            print('已恢复更新前的客户端与组件；应用保持关闭。')
        elif args.check:
            print('更新前置检查通过；未修改客户端或运行环境。')
        else:
            backup = apply(state, wheel_files, dist)
            print('更新完成：' + __version__ + '。请打开原来的增强端查看新界面。')
            print('回退文件保存在：' + str(backup))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        print('更新未完成：' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
