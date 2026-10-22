"""Streaming worker: local data uses inherited FD 4, never a renderer-supplied path."""
import errno
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
from . import __version__

STOPPED=False
DIAGNOSTICS=False
CURRENT_STAGE='worker-start'
STARTUP_TIMEOUT=5


def emit(**value):
    print(json.dumps(value,separators=(',',':')),flush=True)


def check():
    if STOPPED:raise StreamError('PAUSED')


def stage(value):
    global CURRENT_STAGE
    CURRENT_STAGE=value
    if DIAGNOSTICS:emit(event='stage',stage=value)


def failure(code,error):
    details={}
    if DIAGNOSTICS:
        cause=error.__cause__ if isinstance(error,StreamError) and error.__cause__ is not None else error
        kind=type(cause).__name__
        allowed={'StreamError','TimeoutError','ConnectionRefusedError','ConnectionResetError','BrokenPipeError','PermissionError','FileNotFoundError','OSError','ValueError','TypeError','JSONDecodeError'}
        details['diagnostic']={'stage':CURRENT_STAGE,'version':__version__,'errorType':kind if kind in allowed else 'UnexpectedError'}
        number=getattr(cause,'errno',None)
        if type(number) is int and 0<=number<=65535:details['diagnostic']['errno']=number
    emit(event='error',code=code,**details)


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
        from websockets.exceptions import ConnectionClosed,InvalidHandshake
        u=urlsplit(value['url'])
        if u.scheme!='http' or u.hostname not in {'127.0.0.1','localhost','::1'} or not u.port or u.path!='/' or u.username or u.password or u.query or u.fragment or not valid_access_token(value['token']):raise StreamError('INVALID_TRANSFER')
        deadline=time.monotonic()+STARTUP_TIMEOUT;reason='LOCAL_SERVICE_UNAVAILABLE';last_error=None;self.id=0
        while True:
            check();remaining=deadline-time.monotonic()
            if remaining<=0:raise StreamError(reason) from last_error
            self.socket=None;ready=False
            try:
                stage('local-connect')
                self.context=connect('ws://'+u.netloc+'/operations',origin='http://'+u.netloc,proxy=None,open_timeout=min(1,remaining),close_timeout=.25,max_size=4*1024*1024,max_queue=1)
                self.socket=self.context.__enter__()
                stage('local-auth');self.socket.send(json.dumps({'token':value['token']}))
                hello=json.loads(self.socket.recv(timeout=max(0,min(1,deadline-time.monotonic()))))
                if not isinstance(hello,dict):raise StreamError('INVALID_RESPONSE')
                if hello.get('type')=='operations_ready':ready=True;return
                if hello.get('code')=='DesktopAccessError':raise StreamError('LOCAL_AUTH_FAILED')
                if hello.get('code')!='OperationsUnavailable':raise StreamError('PROTOCOL_UNSUPPORTED')
                reason='LOCAL_SERVICE_BUSY'
            except TimeoutError as error:reason='LOCAL_SERVICE_TIMEOUT';last_error=error
            except ConnectionClosed as error:reason='LOCAL_SERVICE_UNAVAILABLE';last_error=error
            except InvalidHandshake:raise StreamError('PROTOCOL_UNSUPPORTED') from None
            except OSError as error:
                if error.errno not in {errno.ECONNREFUSED,errno.ECONNRESET,errno.ETIMEDOUT,errno.ENETUNREACH,errno.EHOSTUNREACH}:raise
                reason='LOCAL_SERVICE_UNAVAILABLE';last_error=error
            finally:
                if self.socket is not None and not ready:self.close()
            check();time.sleep(max(0,min(.1,deadline-time.monotonic())))

    def receive(self,timeout=30):
        from websockets.exceptions import ConnectionClosed
        try:return self.socket.recv(timeout=timeout)
        except TimeoutError as error:raise StreamError('OPERATION_TIMEOUT') from error
        except (ConnectionClosed,OSError) as error:raise StreamError('CONNECTION_CLOSED') from error

    def send(self,data):
        from websockets.exceptions import ConnectionClosed
        try:self.socket.send(data)
        except (ConnectionClosed,OSError) as error:raise StreamError('CONNECTION_CLOSED') from error

    def response(self):
        while True:
            check();data=self.receive()
            if not isinstance(data,str):raise StreamError('INVALID_RESPONSE')
            reply=json.loads(data)
            if reply.get('id')!=self.id:raise StreamError('INVALID_RESPONSE')
            if reply.get('ok') is not True:
                code=reply.get('code')
                if code=='SSHPoolUnavailable':code='NEED_CONNECTION'
                raise StreamError(code if code in {'NEED_CONNECTION','PEER_CHANGED','SOURCE_CHANGED','PARTIAL_CHANGED','HASH_MISMATCH','CONFLICT','INVALID_TRANSFER','UNSUPPORTED_FILE','TRANSFER_LIMIT','ACCESS_DENIED','AUTH_FAILED','SERVER_UPGRADE_REQUIRED','SESSION_CLOSED','OPERATION_TIMEOUT','OPERATION_INTERRUPTED','DISK_FULL'} else 'REMOTE_IO')
            if isinstance(reply.get('progress'),dict):
                p=reply['progress'];emit(event='progress',phase=str(p.get('phase','verifying'))[:20],bytes=p.get('bytes',0),total=p.get('total',0));continue
            return reply.get('result',{})

    def call(self,action,options):
        check();self.id+=1;self.send(json.dumps(dict(id=self.id,op='transfer',action=action,options=options)));return self.response()

    def write(self,data):self.send(data);return self.response()
    def read(self):
        data=self.receive()
        if not isinstance(data,bytes) or len(data)>CHUNK:raise StreamError('INVALID_RESPONSE')
        return data
    def close(self):self.context.__exit__(None,None,None)


def prepared(**value):
    emit(event='prepared',**value)
    check()
    if json.loads(sys.stdin.buffer.readline(1024)).get('ack')!='prepared':raise StreamError('JOURNAL_WRITE_FAILED')


def transfer(value):
    if value.get('kind')=='commit':
        stage('saving')
        from .local_commit import commit
        return commit(value,prepared,emit,check,snapshot,hash_fd)
    if 'ssh' in value:
        from .linux_files import LinuxPeer
        peer=LinuxPeer(value, inspect=value.get('kind')=='inspect-ssh')
    else:
        peer=Peer(value)
    try:
        if value.get('kind')=='inspect-ssh':
            return {'trust':peer.trust}
        stage('peer-ready');deadline=time.monotonic()+STARTUP_TIMEOUT
        while True:
            try:identity=peer.call('peer',{'expected':value.get('peer')});break
            except StreamError as error:
                if error.code!='NEED_CONNECTION' or time.monotonic()>=deadline:raise
                check();time.sleep(.1)
        if identity.get('protocol')!=1:raise StreamError('PROTOCOL_UNSUPPORTED')
        host=identity['peer'];kind=value['kind']
        if kind=='probe':return {'peer':host}
        if kind=='list' and 'ssh' in value:return peer.listing(value['remote'])
        if kind=='fs-mkdir' and 'ssh' in value:
            target=peer.stream.path(value['remote']);existed=peer.stream.exists(target) is not None
            peer.call('mkdir',{'path':target,'peer':host})
            return {'path':target,'created':not existed}
        if kind=='walk':return peer.call('walk',{'path':value['remote'],'peer':host})
        if kind=='mkdir':return peer.call('mkdir',{'path':value['remote'],'peer':host})
        base={'path':value['remote'],'peer':host,'token':value['partToken']}
        if kind=='discard':return peer.call('discard',{**base,'size':value['size'],'sha256':value['sha256']})
        stage('local-file');fd=4;initial=snapshot(fd)
        if kind=='upload':
            if initial!=value['localProof']:raise StreamError('SOURCE_CHANGED')
            stage('verifying');size=initial['size'];sha=hash_fd(fd,size,True).hexdigest()
            if snapshot(fd)!=initial or value.get('sha256') not in {None,sha}:raise StreamError('SOURCE_CHANGED')
            stage('file-prepare');status=peer.call('upload-status',{**base,'size':size,'sha256':sha})
            prepared(peer=host,size=size,sha256=sha)
            if status.get('completed'):return {'sha256':sha,'offset':size,'peer':host}
            offset=status['offset'];running=hash_fd(fd,offset,True)
            if running.hexdigest()!=status['prefixSha256']:raise StreamError('PARTIAL_CHANGED')
            peer.call('prepare-upload',{**base,'size':size,'sha256':sha,'offset':offset,'prefixSha256':running.hexdigest()})
            stage('transferring');last=time.monotonic();checkpoint=offset
            while offset<size:
                check();chunk=os.pread(fd,min(CHUNK,size-offset),offset)
                if not chunk:raise StreamError('SOURCE_CHANGED')
                peer.call('write',{'offset':offset,'length':len(chunk)});reply=peer.write(chunk)
                if reply.get('offset')!=offset+len(chunk):raise StreamError('INVALID_RESPONSE')
                offset+=len(chunk);running.update(chunk)
                if offset-checkpoint>=2*1024*1024 or time.monotonic()-last>.3:
                    emit(event='checkpoint',offset=offset,sha256=running.hexdigest());checkpoint=offset;last=time.monotonic()
            if snapshot(fd)!=initial or running.hexdigest()!=sha:raise StreamError('SOURCE_CHANGED')
            stage('verifying');finish=peer.call('finish-upload',{})
            if finish.get('sha256')!=sha:raise StreamError('HASH_MISMATCH')
            return {'sha256':sha,'offset':size,'peer':host}
        if kind!='download':raise StreamError('INVALID_TRANSFER')
        offset=initial['size'];running=hash_fd(fd,offset,True)
        stage('file-prepare');meta=peer.call('prepare-download',{'path':value['remote'],'peer':host,'expected':value.get('expected'),'offset':offset,'prefixSha256':running.hexdigest()})
        prepared(peer=host,size=meta['size'],expected={k:meta[k] for k in ('size','modified','sha256')})
        stage('transferring');last=time.monotonic();checkpoint=offset
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
        stage('verifying');disk_proof=snapshot(fd)
        if disk_proof['size']!=offset or hash_fd(fd,offset,True).hexdigest()!=meta['sha256'] or snapshot(fd)!=disk_proof:raise StreamError('HASH_MISMATCH')
        return {'sha256':running.hexdigest(),'offset':offset,'peer':host}
    finally:peer.close()


def main():
    global DIAGNOSTICS,CURRENT_STAGE
    DIAGNOSTICS=False;CURRENT_STAGE='worker-start'
    def stop(_signal,_frame):
        global STOPPED
        STOPPED=True
    signal.signal(signal.SIGTERM,stop)
    try:
        raw=sys.stdin.buffer.readline(4*1024*1024+1)
        if len(raw)>4*1024*1024:raise StreamError('INVALID_TRANSFER')
        value=json.loads(raw)
        if not isinstance(value,dict):raise StreamError('INVALID_TRANSFER')
        diagnostic=value.pop('diagnostics',None)
        DIAGNOSTICS=type(diagnostic) is int and diagnostic==1
        result=transfer(value)
        peak=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource else 0
        emit(event='done',result=result,peakRssBytes=int(peak if sys.platform=='darwin' else peak*1024))
    except StreamError as error:failure(error.code,error)
    except OSError as error:
        from .local_commit import io_code
        failure(io_code(error),error)
    except Exception as error:failure('TRANSFER_IO',error)


if __name__=='__main__':main()
