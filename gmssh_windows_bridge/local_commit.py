"""No-clobber download commit on inherited file and directory grants."""
import ctypes
import errno
import hashlib
import os
import stat
import sys
import time

from .file_stream import StreamError

UNSUPPORTED={errno.ENOSYS,errno.EINVAL,errno.ENOTSUP,errno.EOPNOTSUPP}


def io_code(error):
    if error.errno in {errno.ENOSPC,errno.EDQUOT}:return 'DISK_FULL'
    if error.errno==errno.EROFS:return 'READ_ONLY_VOLUME'
    if error.errno==errno.EFBIG:return 'FILE_TOO_LARGE'
    if error.errno in {errno.ENODEV,errno.ENXIO,errno.ESTALE,errno.EIO,errno.ENOTCONN,errno.ETIMEDOUT,errno.ENOENT}:return 'VOLUME_UNAVAILABLE'
    if error.errno in {errno.EPERM,errno.EACCES}:return 'ACCESS_DENIED'
    if error.errno==errno.EEXIST:return 'CONFLICT'
    if error.errno in UNSUPPORTED or error.errno==errno.EXDEV:return 'COMMIT_UNSUPPORTED'
    return 'TRANSFER_IO'


def identity(info):return {'dev':str(info.st_dev&((1<<64)-1)),'ino':str(info.st_ino&((1<<64)-1))}


def rename_exclusive(directory, source, target):
    """Native flags preserve both names when a competing destination exists."""
    libc=ctypes.CDLL(None,use_errno=True)
    symbol,flag=('renameatx_np',4) if sys.platform=='darwin' else ('renameat2',1)
    function=getattr(libc,symbol,None)
    if function is None:raise OSError(errno.ENOSYS,'exclusive rename unavailable')
    function.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
    function.restype=ctypes.c_int
    if function(directory,os.fsencode(source),directory,os.fsencode(target),flag):
        number=ctypes.get_errno();raise OSError(number,'exclusive rename failed')


def sync_directory(fd):
    try:os.fsync(fd);return True
    except OSError as error:
        if error.errno not in UNSUPPORTED:raise
        return False  # Some network/FAT drivers expose no directory flush operation.


def copy_target(value, prepared, progress, check, snapshot, hash_fd, file_fd, directory_fd):
    flags=os.O_RDWR|getattr(os,'O_NOFOLLOW',0)
    expected=value['copyProof']
    target_fd=os.open(value['target'],flags if expected else flags|os.O_CREAT|os.O_EXCL,0o600,dir_fd=directory_fd)
    try:
        target=snapshot(target_fd);source=snapshot(file_fd)
        if expected and any(target[k]!=expected[k] for k in ('dev','ino')) and not value['allowRebind']:raise StreamError('TARGET_CHANGED')
        offset=target['size']
        if offset>value['size'] or hash_fd(file_fd,offset,True).digest()!=hash_fd(target_fd,offset,True).digest() or snapshot(target_fd)!=target:raise StreamError('HASH_MISMATCH')
        prepared(size=value['size'],sha256=value['sha256'],localProof=source,directoryProof=identity(os.fstat(directory_fd)),copyProof=target,method='copy')
        last=time.monotonic();checkpoint=offset
        while offset<value['size']:
            check();data=os.pread(file_fd,min(65536,value['size']-offset),offset)
            if not data:raise StreamError('SOURCE_CHANGED')
            written=0
            while written<len(data):
                count=os.pwrite(target_fd,data[written:],offset+written)
                if not count:raise StreamError('DISK_FULL')
                written+=count
            offset+=len(data)
            if offset-checkpoint>=2*1024*1024 or time.monotonic()-last>.3:
                os.fsync(target_fd);progress(event='checkpoint',phase='copying',offset=offset);checkpoint=offset;last=time.monotonic()
        os.fsync(target_fd);final=snapshot(target_fd)
        if hash_fd(target_fd,value['size'],True).hexdigest()!=value['sha256'] or snapshot(target_fd)!=final:raise StreamError('HASH_MISMATCH')
        current=os.stat(value['target'],dir_fd=directory_fd,follow_symlinks=False)
        if not stat.S_ISREG(current.st_mode) or identity(current)!=identity(os.fstat(target_fd)):raise StreamError('TARGET_CHANGED')
        current=os.stat(value['source'],dir_fd=directory_fd,follow_symlinks=False)
        if not stat.S_ISREG(current.st_mode) or identity(current)!=identity(os.fstat(file_fd)):raise StreamError('PARTIAL_CHANGED')
        os.unlink(value['source'],dir_fd=directory_fd)
    finally:os.close(target_fd)


def commit(value, prepared, progress, check, snapshot, hash_fd, file_fd=4, directory_fd=5):
    if set(value)!={'kind','source','target','sha256','size','expected','directoryProof','copyProof','allowRebind'} or value['kind']!='commit':raise StreamError('INVALID_TRANSFER')
    for name in (value['source'],value['target']):
        if not isinstance(name,str) or name in {'','.','..'} or '/' in name or '\x00' in name:raise StreamError('INVALID_TRANSFER')
    directory=os.fstat(directory_fd)
    if not stat.S_ISDIR(directory.st_mode) or identity(directory)!=value['directoryProof']:raise StreamError('TARGET_CHANGED')
    before=snapshot(file_fd)
    if before!=value['expected'] or before['size']!=value['size']:raise StreamError('PARTIAL_CHANGED')
    current=os.stat(value['source'],dir_fd=directory_fd,follow_symlinks=False)
    if not stat.S_ISREG(current.st_mode) or identity(current)!={k:before[k] for k in ('dev','ino')}:raise StreamError('PARTIAL_CHANGED')
    if hash_fd(file_fd,before['size'],True).hexdigest()!=value['sha256'] or snapshot(file_fd)!=before:raise StreamError('HASH_MISMATCH')
    if value['source']!=value['target']:os.fsync(file_fd)
    prepared(size=before['size'],sha256=value['sha256'],localProof=before,directoryProof=identity(directory))
    check()
    if type(value['allowRebind']) is not bool:raise StreamError('INVALID_TRANSFER')
    method='existing'
    if value['source']!=value['target']:
        # Recheck the granted entry after the journal acknowledgement.
        current=os.stat(value['source'],dir_fd=directory_fd,follow_symlinks=False)
        if identity(current)!={k:before[k] for k in ('dev','ino')} or not stat.S_ISREG(current.st_mode):raise StreamError('PARTIAL_CHANGED')
        try:target=os.stat(value['target'],dir_fd=directory_fd,follow_symlinks=False)
        except FileNotFoundError:target=None
        if target is not None:
            if value['copyProof'] is not None:
                copy_target(value,prepared,progress,check,snapshot,hash_fd,file_fd,directory_fd);method='copy'
            else:
                if not stat.S_ISREG(target.st_mode) or identity(target)!=identity(current):raise StreamError('CONFLICT')
                # Recover an interrupted 0.4a17 hard-link commit without rewriting it.
                os.unlink(value['source'],dir_fd=directory_fd);method='legacy-link'
        else:
            try:rename_exclusive(directory_fd,value['source'],value['target']);method='rename'
            except OSError as error:
                if error.errno not in UNSUPPORTED:raise
                try:os.link(value['source'],value['target'],src_dir_fd=directory_fd,dst_dir_fd=directory_fd,follow_symlinks=False)
                except OSError as fallback:
                    if fallback.errno not in UNSUPPORTED:raise
                    copy_target(value,prepared,progress,check,snapshot,hash_fd,file_fd,directory_fd);method='copy'
                else:os.unlink(value['source'],dir_fd=directory_fd);method='link'
    final_fd=os.open(value['target'],os.O_RDONLY|getattr(os,'O_NOFOLLOW',0),dir_fd=directory_fd)
    try:
        final=snapshot(final_fd)
        if final['size']!=value['size']:raise StreamError('HASH_MISMATCH')
        # FAT and network clients can change file IDs on rename.
        if method!='copy' and any(final[k]!=before[k] for k in ('dev','ino')) and hash_fd(final_fd,final['size'],True).hexdigest()!=value['sha256']:raise StreamError('HASH_MISMATCH')
    finally:os.close(final_fd)
    synced=sync_directory(directory_fd)
    return {'sha256':value['sha256'],'offset':before['size'],'method':method,'directorySynced':synced}
