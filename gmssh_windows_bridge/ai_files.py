"""Bounded SFTP reads, searches and edits with hashes and retained backups."""
import difflib
import errno
import hashlib
import posixpath
import stat
import time
import uuid

from .desktop_operations import normalize_path, validate_name
from .file_stream import StreamError

MAX_TEXT = 1024 * 1024


def remote_path(value):
    if not isinstance(value, str) or len(value) > 1024:
        raise StreamError('INVALID_ARGUMENT')
    return normalize_path(value)


def checked_path(sftp, value, missing=False):
    value = remote_path(value)
    parts = value[3:].split('/')
    current = value[:3]
    for index, part in enumerate(parts):
        if not part:
            continue
        validate_name(part)
        current = posixpath.join(current, part)
        try:
            info = sftp.lstat(current)
        except FileNotFoundError:
            if missing and index == len(parts)-1:
                return value
            raise
        if stat.S_ISLNK(info.st_mode):
            raise StreamError('UNSUPPORTED_FILE')
    return value


def read_bytes(sftp, path):
    path = checked_path(sftp, path)
    before = sftp.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_TEXT:
        raise StreamError('FILE_LIMIT')
    with sftp.open(path, 'rb') as source:
        parts, size = [], 0
        while size <= MAX_TEXT:
            chunk = source.read(min(65536, MAX_TEXT+1-size))
            if not chunk:
                break
            parts.append(chunk)
            size += len(chunk)
        raw = b''.join(parts)
    after = sftp.lstat(path)
    if len(raw) > MAX_TEXT or len(raw) != before.st_size or (before.st_size, before.st_mtime) != (after.st_size, after.st_mtime):
        raise StreamError('SOURCE_CHANGED')
    return raw


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def text_bytes(value):
    if not isinstance(value, str) or '\x00' in value:
        raise StreamError('INVALID_ARGUMENT')
    raw = value.encode('utf-8')
    if len(raw) > MAX_TEXT:
        raise StreamError('FILE_LIMIT')
    return raw


def read(sftp, path, start_line=1, limit=100, start_byte=None, expected_sha256=None):
    if type(start_line) is not int or start_line < 1 or type(limit) is not int or not 1 <= limit <= 200:
        raise StreamError('INVALID_ARGUMENT')
    path = remote_path(path)
    raw = read_bytes(sftp, path)
    sha = digest(raw)
    if expected_sha256 is not None and sha != expected_sha256:
        raise StreamError('SOURCE_CHANGED')
    try:
        lines = raw.decode('utf-8-sig').splitlines(keepends=True)
    except UnicodeError:
        raise StreamError('TEXT_ENCODING_UNSUPPORTED') from None
    bom = 3 if raw.startswith(b'\xef\xbb\xbf') else 0
    if start_byte is not None:
        if type(start_byte) is not int or not 0 <= start_byte <= len(raw) or start_byte > 0 and expected_sha256 is None:
            raise StreamError('INVALID_ARGUMENT')
        start = bom if start_byte == 0 else start_byte
        # Offsets are raw UTF-8 file bytes, including a possible BOM.
        try:
            raw[:start].decode('utf-8')
        except UnicodeError:
            raise StreamError('INVALID_ARGUMENT') from None
        end = min(len(raw), start+32768)
        next_line = None
        truncated = end < len(raw)
    else:
        start = bom+len(''.join(lines[:start_line-1]).encode('utf-8'))
        selected = ''.join(lines[start_line-1:start_line-1+limit]).encode('utf-8')
        truncated = len(selected) > 32768
        end = start+min(len(selected), 32768)
        next_line = start_line+limit if not truncated and start_line-1+limit < len(lines) else None
    # Return a continuation at the next whole character, including within a line.
    content = raw[start:end].decode('utf-8', 'ignore')
    end = start+len(content.encode('utf-8'))
    return {'path': path, 'sha256': sha, 'size': len(raw), 'startLine': start_line if start_byte is None else None,
            'totalLines': len(lines), 'text': content, 'truncated': truncated,
            'nextLine': next_line, 'startByte': start, 'nextByte': end if end < len(raw) else None, 'eof': end == len(raw)}


def search(sftp, path, query='', recursive=False):
    if not isinstance(query, str) or len(query) > 128 or type(recursive) is not bool:
        raise StreamError('INVALID_ARGUMENT')
    path = checked_path(sftp, path)
    pending, rows, scanned = [(path, 0)], [], 0
    deadline = time.monotonic()+10
    truncated = False
    while pending and not truncated:
        parent, depth = pending.pop(0)
        checked_path(sftp, parent)
        # Iteration is bounded even on native SSH servers with huge directories.
        iterator = sftp.listdir_iter(parent, read_aheads=1) if hasattr(sftp, 'listdir_iter') else iter(sftp.listdir_attr(parent))
        try:
            for entry in iterator:
                scanned += 1
                if scanned > 2000 or time.monotonic() > deadline:
                    truncated = True
                    break
                name = validate_name(entry.filename)
                child = posixpath.join(parent, name)
                if stat.S_ISLNK(entry.st_mode):
                    continue
                directory = stat.S_ISDIR(entry.st_mode)
                if query.casefold() in name.casefold():
                    rows.append({'name': name, 'path': child, 'directory': directory,
                                 'size': entry.st_size, 'modified': int(entry.st_mtime)})
                    if len(rows) >= 200:
                        truncated = True
                        break
                if directory and recursive:
                    if depth < 4:
                        pending.append((child, depth+1))
                    else:
                        truncated = True
        finally:
            if hasattr(iterator, 'close'):
                iterator.close()
    return {'path': path, 'items': rows, 'scanned': scanned, 'truncated': truncated or bool(pending)}


def preview(sftp, path, content, expected_sha256):
    path = remote_path(path)
    old, new = read_bytes(sftp, path), text_bytes(content)
    if digest(old) != expected_sha256:
        raise StreamError('SOURCE_CHANGED')
    try:
        before = old.decode('utf-8-sig')
    except UnicodeError:
        raise StreamError('TEXT_ENCODING_UNSUPPORTED') from None
    lines = list(difflib.unified_diff(before.splitlines(True), content.splitlines(True), fromfile=path, tofile=path))
    shortened = any(len(line) > 512 for line in lines)
    diff = ''.join(line if len(line) <= 512 else line[:512]+'…\n' for line in lines)
    return {'path': path, 'beforeSha256': digest(old), 'afterSha256': digest(new),
            'diff': diff[:32768], 'truncated': shortened or len(diff) > 32768, 'changed': old != new}


def apply(sftp, path, content, expected_sha256):
    """No overwrite rename. Original and recovery paths survive any failed commit."""
    path = remote_path(path)
    old, new = read_bytes(sftp, path), text_bytes(content)
    if digest(old) != expected_sha256:
        raise StreamError('SOURCE_CHANGED')
    if old == new:
        return {'path': path, 'sha256': digest(new), 'changed': False}
    token = uuid.uuid4().hex
    parent = posixpath.dirname(path)
    temporary = posixpath.join(parent, '.gmssh-ai-'+token+'.tmp')
    backup = posixpath.join(parent, '.gmssh-ai-'+token+'.bak')
    moved, created, retain = False, False, False
    try:
        with sftp.open(temporary, 'wx') as target:
            created = True
            target.write(new)
        # Preserve ordinary SFTP mode bits when available (ACLs remain server-owned).
        try:
            mode = stat.S_IMODE(sftp.lstat(path).st_mode)
            if mode:
                sftp.chmod(temporary, mode)
        except (AttributeError, OSError):
            pass
        if digest(read_bytes(sftp, temporary)) != digest(new) or digest(read_bytes(sftp, path)) != expected_sha256:
            raise StreamError('SOURCE_CHANGED')
        sftp.rename(path, backup)
        moved = True
        if digest(read_bytes(sftp, backup)) != expected_sha256:
            raise StreamError('SOURCE_CHANGED')
        # SFTP standard rename fails when a competing writer created the target.
        sftp.rename(temporary, path)
        created = False  # The candidate was moved; there is no owned temp to remove.
        if digest(read_bytes(sftp, path)) != digest(new):
            raise StreamError('VERIFY_FAILED')
        return {'path': path, 'sha256': digest(new), 'changed': True,
                'backup': backup, 'backupSha256': expected_sha256}
    except Exception as error:
        if moved:
            try:
                sftp.lstat(path)
            except OSError as missing:
                if missing.errno == errno.ENOENT:
                    try:
                        sftp.rename(backup, path)
                        moved = False
                    except OSError:
                        pass
            if moved:
                # Caller receives the exact retained original path for recovery.
                failure = StreamError('EDIT_RECOVERY_REQUIRED')
                retain = True
                failure.recovery = {'path': path, 'backup': backup, **({'temporary': temporary} if created else {})}
                raise failure from None
        raise error
    finally:
        if created and not retain:
            try:
                sftp.remove(temporary)
            except (OSError, StreamError):
                pass
