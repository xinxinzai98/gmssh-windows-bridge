"""Streaming worker: local data uses inherited FD 4, never a renderer-supplied path."""
import hashlib
import json
import os
try:
    import resource
except ImportError:
    resource = None
import signal
import stat
import sys
import time
from urllib.parse import urlsplit

from .file_stream import CHUNK, EMPTY_HASH, MAX_SIZE, StreamError
from .desktop_operations import valid_access_token

STOPPED=False


def emit(**value):
    print(json.dumps(value,separators=(',',':')),flush=True)


def check():
    if STOPPED:raise StreamError('PAUSED')


def snapshot(fd):
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode) or s.st_size>MAX_SIZE:raise StreamError('UNSUPPORTED_FILE')
    return dict(size=s.st_size,modifiedNs=str(s.st_mtime_ns),dev=str(s.st_dev&((1<<64)-1)),ino=str(s.st_ino&((1<<64)-1)))


def hash_fd(fd, size, progress=False):
    result=hashlib.sha256();offset=0;last=time.monotonic()
    while offset<size:
        check();chunk=os.pread(fd,min(1024*1024,size-offset),offset)
        if not chunk:raise StreamError('SOURCE_CHANGED')
        result.update(chunk);offset+=len(chunk)
        if progress and time.monotonic()-last>.3:emit(event='progress',phase='verifying',bytes=offset,total=size);last=time.monotonic()
    return result


class Peer:
    def __init__(self,value):
        from websockets.sync.client import connect
        u=urlsplit(value['url'])
        if u.scheme!='http' or u.hostname not in {'127.0.0.1','localhost','::1'} or not u.port or u.path!='/' or u.username or u.password or u.query or u.fragment or not valid_access_token(value['token']):raise StreamError('INVALID_TRANSFER')
        self.socket=connect('ws://'+u.netloc+'/operations',origin='http://'+u.netloc,proxy=None,open_timeout=3,close_timeout=1,max_size=4*1024*1024,max_queue=1)
        self.id=0;self.socket.send(json.dumps({'token':value['token']}))
        hello=json.loads(self.socket.recv(timeout=3))
        if hello.get('type')!='operations_ready':raise StreamError('LOCAL_SERVICE_UNAVAILABLE')

    def response(self):
        while True:
            check();data=self.socket.recv(timeout=30)
            if not isinstance(data,str):raise StreamError('INVALID_RESPONSE')
            reply=json.loads(data)
            if reply.get('id')!=self.id:raise StreamError('INVALID_RESPONSE')
            if reply.get('ok') is not True:
                code=reply.get('code')
                if code=='SSHPoolUnavailable':code='NEED_CONNECTION'
                raise StreamError(code if code in {'NEED_CONNECTION','PEER_CHANGED','SOURCE_CHANGED','PARTIAL_CHANGED','HASH_MISMATCH','CONFLICT','INVALID_TRANSFER','UNSUPPORTED_FILE','TRANSFER_LIMIT','ACCESS_DENIED','DISK_FULL'} else 'REMOTE_IO')
            if isinstance(reply.get('progress'),dict):
                p=reply['progress'];emit(event='progress',phase=str(p.get('phase','verifying'))[:20],bytes=p.get('bytes',0),total=p.get('total',0));continue
            return reply.get('result',{})

    def call(self,action,options):
        check();self.id+=1;self.socket.send(json.dumps(dict(id=self.id,op='transfer',action=action,options=options)));return self.response()

    def write(self,data):self.socket.send(data);return self.response()
    def read(self):
        data=self.socket.recv(timeout=30)
        if not isinstance(data,bytes) or len(data)>CHUNK:raise StreamError('INVALID_RESPONSE')
        return data
    def close(self):self.socket.close()


def prepared(**value):
    emit(event='prepared',**value)
    check()
    if json.loads(sys.stdin.buffer.readline(1024)).get('ack')!='prepared':raise StreamError('JOURNAL_WRITE_FAILED')


def transfer(value):
    if value.get('kind')=='commit':
        from .local_commit import commit
        return commit(value,prepared,emit,check,snapshot,hash_fd)
    peer=Peer(value)
    try:
        identity=peer.call('peer',{'expected':value.get('peer')})
        if identity.get('protocol')!=1:raise StreamError('PROTOCOL_UNSUPPORTED')
        host=identity['peer'];kind=value['kind']
        if kind=='probe':return {'peer':host}
        if kind=='walk':return peer.call('walk',{'path':value['remote'],'peer':host})
        if kind=='mkdir':return peer.call('mkdir',{'path':value['remote'],'peer':host})
        base={'path':value['remote'],'peer':host,'token':value['partToken']}
        if kind=='discard':return peer.call('discard',{**base,'size':value['size'],'sha256':value['sha256']})
        fd=4;initial=snapshot(fd)
        if kind=='upload':
            if initial!=value['localProof']:raise StreamError('SOURCE_CHANGED')
            size=initial['size'];sha=hash_fd(fd,size,True).hexdigest()
            if snapshot(fd)!=initial or value.get('sha256') not in {None,sha}:raise StreamError('SOURCE_CHANGED')
            status=peer.call('upload-status',{**base,'size':size,'sha256':sha})
            prepared(peer=host,size=size,sha256=sha)
            if status.get('completed'):return {'sha256':sha,'offset':size,'peer':host}
            offset=status['offset'];running=hash_fd(fd,offset,True)
            if running.hexdigest()!=status['prefixSha256']:raise StreamError('PARTIAL_CHANGED')
            peer.call('prepare-upload',{**base,'size':size,'sha256':sha,'offset':offset,'prefixSha256':running.hexdigest()})
            last=time.monotonic();checkpoint=offset
            while offset<size:
                check();chunk=os.pread(fd,min(CHUNK,size-offset),offset)
                if not chunk:raise StreamError('SOURCE_CHANGED')
                peer.call('write',{'offset':offset,'length':len(chunk)});reply=peer.write(chunk)
                if reply.get('offset')!=offset+len(chunk):raise StreamError('INVALID_RESPONSE')
                offset+=len(chunk);running.update(chunk)
                if offset-checkpoint>=2*1024*1024 or time.monotonic()-last>.3:
                    emit(event='checkpoint',offset=offset,sha256=running.hexdigest());checkpoint=offset;last=time.monotonic()
            if snapshot(fd)!=initial or running.hexdigest()!=sha:raise StreamError('SOURCE_CHANGED')
            finish=peer.call('finish-upload',{})
            if finish.get('sha256')!=sha:raise StreamError('HASH_MISMATCH')
            return {'sha256':sha,'offset':size,'peer':host}
        if kind!='download':raise StreamError('INVALID_TRANSFER')
        offset=initial['size'];running=hash_fd(fd,offset,True)
        meta=peer.call('prepare-download',{'path':value['remote'],'peer':host,'expected':value.get('expected'),'offset':offset,'prefixSha256':running.hexdigest()})
        prepared(peer=host,size=meta['size'],expected={k:meta[k] for k in ('size','modified','sha256')})
        last=time.monotonic();checkpoint=offset
        while offset<meta['size']:
            check();reply=peer.call('read',{'offset':offset});chunk=peer.read()
            if reply.get('length')!=len(chunk) or reply.get('offset')!=offset+len(chunk) or not chunk or offset+len(chunk)>meta['size']:raise StreamError('INVALID_RESPONSE')
            written=0
            while written<len(chunk):
                count=os.pwrite(fd,chunk[written:],offset+written)
                if not count:raise StreamError('DISK_FULL')
                written+=count
            offset+=len(chunk);running.update(chunk)
            if offset-checkpoint>=2*1024*1024 or time.monotonic()-last>.3:
                os.fsync(fd);emit(event='checkpoint',offset=offset,sha256=running.hexdigest());checkpoint=offset;last=time.monotonic()
        finish=peer.call('finish-download',{});os.fsync(fd)
        if finish.get('sha256')!=meta['sha256'] or running.hexdigest()!=meta['sha256']:raise StreamError('HASH_MISMATCH')
        disk_proof=snapshot(fd)
        if disk_proof['size']!=offset or hash_fd(fd,offset,True).hexdigest()!=meta['sha256'] or snapshot(fd)!=disk_proof:raise StreamError('HASH_MISMATCH')
        return {'sha256':running.hexdigest(),'offset':offset,'peer':host}
    finally:peer.close()


def main():
    def stop(_signal,_frame):
        global STOPPED
        STOPPED=True
    signal.signal(signal.SIGTERM,stop)
    try:
        raw=sys.stdin.buffer.readline(8193)
        if len(raw)>8192:raise StreamError('INVALID_TRANSFER')
        result=transfer(json.loads(raw))
        peak=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else 0
        emit(event='done',result=result,peakRssBytes=int(peak if sys.platform=='darwin' else peak*1024))
    except StreamError as error:emit(event='error',code=error.code)
    except OSError as error:
        from .local_commit import io_code
        emit(event='error',code=io_code(error))
    except Exception:emit(event='error',code='TRANSFER_IO')


if __name__=='__main__':main()
