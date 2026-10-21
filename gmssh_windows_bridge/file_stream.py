"""Resumable, bounded SFTP operations on an already pinned SSH lease."""
import base64
import errno
import hashlib
import json
import posixpath
import re
import stat
import time

CHUNK = 65536
MAX_SIZE = 1024 ** 4
EMPTY_HASH = hashlib.sha256(b'').hexdigest()


def read_ahead(file, offset, size):
    # Paramiko otherwise constructs a request list for the entire file. Keep
    # each window at 256 KiB (eight native requests), including for a 1 TiB
    # file. The producer can finish queuing this window even if it is cancelled.
    end = min(size, offset + CHUNK * 4)
    if end > offset and callable(getattr(file, 'prefetch', None)):
        file.prefetch(file_size=end, max_concurrent_requests=8)
    return end


class StreamError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def integer(value, maximum=MAX_SIZE):
    if type(value) is not int or not 0 <= value <= maximum: raise StreamError('INVALID_TRANSFER')
    return value


def digest(value):
    if not isinstance(value, str) or re.fullmatch('[0-9a-f]{64}', value) is None: raise StreamError('INVALID_TRANSFER')
    return value


def path(value):
    from .desktop_operations import normalize_path
    if not isinstance(value, str) or len(value) > 1024: raise StreamError('INVALID_TRANSFER')
    return normalize_path(value)


def metadata(info):
    if not stat.S_ISREG(info.st_mode or 0): raise StreamError('UNSUPPORTED_FILE')
    return {'size': integer(info.st_size), 'modified': integer(int(info.st_mtime))}


class FileStream:
    def __init__(self, owner, path_validator=path, name_validator=None):
        self.owner = owner
        self.path = path_validator
        if name_validator is None:
            from .desktop_operations import validate_name
            name_validator = validate_name
        self.name = name_validator
        self.file = None
        self.mode = None
        self.pending = None
        self.offset = 0
        self.read_ahead_until = 0

    def peer(self, expected=None):
        client = self.owner.ssh_nowait()
        key = client.get_transport().get_remote_server_key().asbytes()
        value = 'SHA256:' + base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip('=')
        if expected is not None and expected != value: raise StreamError('PEER_CHANGED')
        return value

    @property
    def sftp(self): return self.owner.files()

    def exists(self, name):
        try: return self.sftp.lstat(name)
        except OSError as error:
            if error.errno != errno.ENOENT: raise
            return None

    def hashes(self, file, size, prefix, progress):
        full, head = hashlib.sha256(), hashlib.sha256()
        copied = 0; last = time.monotonic(); prefetched = 0
        file.seek(0)
        while copied < size:
            if copied >= prefetched: prefetched = read_ahead(file, copied, size)
            chunk = file.read(min(CHUNK, size-copied))
            if not chunk: raise StreamError('SOURCE_CHANGED')
            full.update(chunk)
            if copied < prefix: head.update(chunk[:prefix-copied])
            copied += len(chunk)
            if time.monotonic()-last > .5:
                progress(phase='hashing', bytes=copied, total=size); last=time.monotonic()
        if file.read(1): raise StreamError('SOURCE_CHANGED')
        return full.hexdigest(), head

    def part_names(self, options):
        destination = self.path(options['path']); token = options['token']
        if not isinstance(token,str) or re.fullmatch('[0-9a-f]{32}',token) is None: raise StreamError('INVALID_TRANSFER')
        part = posixpath.join(posixpath.dirname(destination),'.gmssh-transfer-'+token+'.part')
        return destination, part, part+'.json'

    def load_meta(self, name):
        info=self.exists(name)
        if info is None:return None
        if not stat.S_ISREG(info.st_mode or 0) or info.st_size>4096:raise StreamError('PARTIAL_CHANGED')
        with self.sftp.open(name,'rb') as source: raw=source.read(4097)
        try:value=json.loads(raw.decode('utf-8'))
        except (ValueError,UnicodeError):raise StreamError('PARTIAL_CHANGED') from None
        if not isinstance(value,dict):raise StreamError('PARTIAL_CHANGED')
        return value

    def write_meta(self, name, value, create=False):
        if not create:
            info=self.exists(name)
            if info is None or not stat.S_ISREG(info.st_mode or 0):raise StreamError('PARTIAL_CHANGED')
        with self.sftp.open(name,'wx' if create else 'wb',bufsize=0) as target:
            target.write(json.dumps(value,separators=(',',':')).encode())

    def upload_state(self, options, progress):
        peer=self.peer(options['peer']);destination,part,sidecar=self.part_names(options)
        size=integer(options['size']);sha=digest(options['sha256'])
        wanted={'schema':1,'peer':peer,'size':size,'sha256':sha,'parent':posixpath.dirname(destination)}
        stored=self.load_meta(sidecar);info=self.exists(part)
        if stored is not None and any(stored.get(k)!=v for k,v in wanted.items()):raise StreamError('SOURCE_CHANGED')
        if stored and stored.get('target')==destination and stored.get('committing') and info is None:
            final=self.exists(destination)
            if final and metadata(final)['size']==size:
                with self.sftp.open(destination,'rb') as source: actual,_=self.hashes(source,size,0,progress)
                if actual==sha:return {'completed':True,'offset':size,'sha256':sha,'peer':peer},wanted,part,sidecar
            raise StreamError('PARTIAL_CHANGED')
        if self.exists(destination) is not None:raise StreamError('CONFLICT')
        if info is None:
            if stored is not None and stored.get('committing'):raise StreamError('PARTIAL_CHANGED')
            return {'completed':False,'offset':0,'prefixSha256':EMPTY_HASH,'peer':peer},wanted,part,sidecar
        current=metadata(info)
        if stored is None or current['size']>size:raise StreamError('PARTIAL_CHANGED')
        with self.sftp.open(part,'rb') as source: prefix,_=self.hashes(source,current['size'],0,progress)
        return {'completed':False,'offset':current['size'],'prefixSha256':prefix,'peer':peer},wanted,part,sidecar

    def request(self, action, options, progress):
        fields={'peer':{'expected'},'mkdir':{'path','peer'},'walk':{'path','peer'},'prepare-download':{'path','peer','expected','offset','prefixSha256'},
                'read':{'offset'},'finish-download':set(),'upload-status':{'path','peer','token','size','sha256'},
                'prepare-upload':{'path','peer','token','size','sha256','offset','prefixSha256'},'write':{'offset','length'},
                'finish-upload':set(),'discard':{'path','peer','token','size','sha256'}}
        if not isinstance(action,str) or action not in fields or not isinstance(options,dict) or set(options)!=fields[action]:raise StreamError('INVALID_TRANSFER')
        if action=='peer':return {'protocol':1,'peer':self.peer(options['expected']),'chunk':CHUNK,'maximum':MAX_SIZE}
        if action=='mkdir':
            peer=self.peer(options['peer']);name=self.path(options['path']);info=self.exists(name)
            if info is None:self.sftp.mkdir(name)
            elif not stat.S_ISDIR(info.st_mode or 0):raise StreamError('CONFLICT')
            return {'peer':peer,'created':True}
        if action=='walk':
            peer=self.peer(options['peer']);root=self.path(options['path']);rows=[];pending=[('',0)]
            while pending:
                relative,depth=pending.pop()
                if depth>32:raise StreamError('TRANSFER_LIMIT')
                directory=posixpath.join(root,relative)
                if not stat.S_ISDIR(self.sftp.lstat(directory).st_mode or 0):raise StreamError('UNSUPPORTED_FILE')
                rows.append({'relative':relative,'directory':True,'size':0,'modified':0})
                iterator=self.sftp.listdir_iter(directory,read_aheads=1)
                for item in iterator:
                    child=posixpath.join(relative,self.name(item.filename));self.path(posixpath.join(root,child))
                    if len(rows)+len(pending)>=2000:raise StreamError('TRANSFER_LIMIT')
                    if stat.S_ISDIR(item.st_mode or 0):pending.append((child,depth+1))
                    else:rows.append({'relative':child,'directory':False,**metadata(item)})
                progress(phase='listing',bytes=len(rows),total=0)
            return {'peer':peer,'entries':rows}
        if action=='discard':
            peer=self.peer(options['peer']);destination,part,sidecar=self.part_names(options)
            wanted={'schema':1,'peer':peer,'size':integer(options['size']),'sha256':digest(options['sha256']),'parent':posixpath.dirname(destination)}
            stored=self.load_meta(sidecar);info=self.exists(part)
            if stored is None:
                if info is not None:raise StreamError('PARTIAL_CHANGED')
                return {'discarded':True}
            if any(stored.get(k)!=v for k,v in wanted.items()):raise StreamError('SOURCE_CHANGED')
            if info is not None:
                if metadata(info)['size']>wanted['size']:raise StreamError('PARTIAL_CHANGED')
                self.close();self.sftp.remove(part)
            self.sftp.remove(sidecar)
            return {'discarded':True}
        if action in {'upload-status','prepare-upload'}:
            state,wanted,part,sidecar=self.upload_state(options,progress)
            if action=='upload-status' or state['completed']:return state
            if self.file is not None:raise StreamError('TRANSFER_BUSY')
            offset=integer(options['offset']);prefix=digest(options['prefixSha256'])
            if offset!=state['offset'] or prefix!=state['prefixSha256']:raise StreamError('PARTIAL_CHANGED')
            if self.exists(part) is None:
                if self.exists(sidecar) is None:self.write_meta(sidecar,wanted,create=True)
                try:self.file=self.sftp.open(part,'wx',bufsize=0)
                except Exception:
                    self.sftp.remove(sidecar);raise
            else:self.file=self.sftp.open(part,'r+b',bufsize=0)
            self.file.seek(offset)
            if callable(getattr(self.file,'set_pipelined',None)):self.file.set_pipelined(True)
            self.mode='upload';self.offset=offset;self.details=wanted;self.destination=self.path(options['path']);self.part=part;self.sidecar=sidecar
            return state
        if action=='prepare-download':
            self.peer(options['peer']);name=self.path(options['path']);info=metadata(self.sftp.lstat(name));expected=options['expected']
            if expected is not None and (not isinstance(expected,dict) or set(expected)!={'size','modified','sha256'}):raise StreamError('INVALID_TRANSFER')
            if expected is not None and any(expected.get(k)!=v for k,v in info.items()):raise StreamError('SOURCE_CHANGED')
            offset=integer(options['offset']);prefix=digest(options['prefixSha256'])
            if offset>info['size'] or self.file is not None:raise StreamError('PARTIAL_CHANGED')
            source=self.sftp.open(name,'rb')
            try:
                sha,head=self.hashes(source,info['size'],offset,progress)
                if expected is not None and digest(expected['sha256'])!=sha:raise StreamError('SOURCE_CHANGED')
                if head.hexdigest()!=prefix:raise StreamError('PARTIAL_CHANGED')
                if metadata(self.sftp.lstat(name))!=info:raise StreamError('SOURCE_CHANGED')
                source.seek(offset);self.file=source;self.mode='download';self.offset=offset;self.read_ahead_until=offset;self.details={**info,'sha256':sha};self.source_path=name;self.hasher=head
                return {'peer':self.peer(),'offset':offset,**self.details}
            except Exception:source.close();raise
        if action=='read':
            if self.mode!='download' or self.file is None or integer(options['offset'])!=self.offset:raise StreamError('INVALID_TRANSFER')
            if self.offset >= self.read_ahead_until:self.read_ahead_until=read_ahead(self.file,self.offset,self.details['size'])
            data=self.file.read(min(CHUNK,self.details['size']-self.offset))
            if not data and self.offset!=self.details['size']:raise StreamError('SOURCE_CHANGED')
            self.offset+=len(data);self.hasher.update(data)
            return {'offset':self.offset,'length':len(data)},data
        if action=='write':
            if self.mode!='upload' or self.file is None or self.pending is not None or integer(options['offset'])!=self.offset:raise StreamError('INVALID_TRANSFER')
            length=integer(options['length'],CHUNK)
            if not length or length+self.offset>self.details['size']:raise StreamError('INVALID_TRANSFER')
            self.pending=length
            return {'ready':True}
        if action=='finish-download':
            if self.mode!='download' or self.offset!=self.details['size'] or self.hasher.hexdigest()!=self.details['sha256']:raise StreamError('SOURCE_CHANGED')
            if metadata(self.sftp.lstat(self.source_path))!={k:self.details[k] for k in ('size','modified')}:raise StreamError('SOURCE_CHANGED')
            result={'sha256':self.hasher.hexdigest(),'offset':self.offset};self.close();return result
        if action=='finish-upload':
            if self.mode!='upload' or self.offset!=self.details['size'] or self.pending is not None:raise StreamError('INVALID_TRANSFER')
            self.file.close();self.file=None
            with self.sftp.open(self.part,'rb') as source:sha,_=self.hashes(source,self.offset,0,progress)
            if sha!=self.details['sha256']:raise StreamError('HASH_MISMATCH')
            if self.exists(self.destination) is not None:raise StreamError('CONFLICT')
            self.write_meta(self.sidecar,{**self.details,'target':self.destination,'committing':True})
            self.sftp.rename(self.part,self.destination)
            self.mode=None
            return {'sha256':sha,'offset':self.offset,'completed':True}
        raise StreamError('INVALID_TRANSFER')

    def write(self, data):
        if self.mode!='upload' or self.pending is None or not isinstance(data,bytes) or len(data)!=self.pending:raise StreamError('INVALID_TRANSFER')
        written=0
        while written<len(data):
            count=self.file.write(data[written:])
            if count is None:break  # Paramiko's write contract returns None after writing all bytes.
            if not isinstance(count,int) or count<=0:raise StreamError('DISK_FULL')
            written+=count
        self.file.flush();self.offset+=len(data);self.pending=None
        return {'offset':self.offset}

    def close(self):
        if self.file is not None:self.file.close()
        self.file=None;self.mode=None;self.pending=None
        self.read_ahead_until=0
