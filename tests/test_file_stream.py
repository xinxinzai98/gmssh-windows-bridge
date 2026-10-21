import hashlib
import os
import errno
import json
import threading
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock,patch
from gmssh_windows_bridge.file_stream import FileStream,StreamError,EMPTY_HASH,CHUNK,read_ahead,MAX_SIZE
from tests.stream_fixture import LocalSFTP,client_for


class FileStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=LocalSFTP(self.root);self.client=client_for(self.store)
        self.owner=SimpleNamespace(ssh_nowait=lambda:self.client,files=lambda:self.store)
        self.stream=FileStream(self.owner);self.addCleanup(self.stream.close)
        self.peer=self.stream.peer();self.body=b'synthetic content'+b'x'*100000
        self.opts={'path':'C:/uploaded.bin','peer':self.peer,'token':'a'*32,'size':len(self.body),'sha256':hashlib.sha256(self.body).hexdigest()}
    def call(self, action, **values):return self.stream.request(action,values,lambda **_:None)
    def start(self):return self.call('prepare-upload',**self.opts,offset=0,prefixSha256=EMPTY_HASH)
    def chunk(self, value):
        self.call('write',offset=self.stream.offset,length=len(value));return self.stream.write(value)
    def test_upload_resume_and_lost_final_ack(self):
        self.start();self.chunk(self.body[:CHUNK]);self.stream.close()
        state=self.call('upload-status',**self.opts);self.assertEqual(state['offset'],CHUNK)
        self.call('prepare-upload',**self.opts,offset=CHUNK,prefixSha256=hashlib.sha256(self.body[:CHUNK]).hexdigest())
        self.chunk(self.body[CHUNK:]);self.call('finish-upload')
        self.assertEqual((self.root/'uploaded.bin').read_bytes(),self.body)
        self.assertTrue(self.call('upload-status',**self.opts)['completed'])
        self.call('discard',**self.opts);self.assertEqual(list(self.root.iterdir()),[self.root/'uploaded.bin'])

    def test_prefetch_is_bounded_and_a_delayed_write_failure_never_commits(self):
        reads=[]
        fake=SimpleNamespace(prefetch=lambda **values:reads.append(values))
        self.assertEqual(read_ahead(fake,0,MAX_SIZE),CHUNK*4)
        self.assertEqual(read_ahead(fake,MAX_SIZE-3,MAX_SIZE),MAX_SIZE)
        self.assertEqual(reads,[{'file_size':CHUNK*4,'max_concurrent_requests':8},
                                {'file_size':MAX_SIZE,'max_concurrent_requests':8}])
        self.assertEqual(read_ahead(SimpleNamespace(),0,0),0)
        opened=self.store.open;enabled=[];fail=[True]
        class DelayedFile:
            def __init__(self,file):self.file=file
            def __getattr__(self,key):return getattr(self.file,key)
            def set_pipelined(self,value):enabled.append(value)
            def close(self):
                self.file.close()
                if fail[0]:fail[0]=False;raise OSError('synthetic delayed SFTP write failure')
        def open_file(name,mode,bufsize=-1):
            file=opened(name,mode,bufsize)
            return DelayedFile(file) if name.endswith('.part') and mode=='wx' else file
        with patch.object(self.store,'open',side_effect=open_file):
            self.start();self.chunk(self.body[:CHUNK]);self.chunk(self.body[CHUNK:])
            with self.assertRaises(OSError):self.call('finish-upload')
        self.assertEqual(enabled,[True]);self.assertFalse((self.root/'uploaded.bin').exists())
        self.stream.close()
        self.assertEqual(self.call('upload-status',**self.opts)['offset'],len(self.body))
        self.call('prepare-upload',**self.opts,offset=len(self.body),prefixSha256=self.opts['sha256'])
        self.call('finish-upload');self.assertEqual((self.root/'uploaded.bin').read_bytes(),self.body)
    def test_download_resume_and_change_detection(self):
        (self.root/'source.bin').write_bytes(self.body)
        values={'path':'C:/source.bin','peer':self.peer,'expected':None,'offset':CHUNK,'prefixSha256':hashlib.sha256(self.body[:CHUNK]).hexdigest()}
        meta=self.call('prepare-download',**values);reply,data=self.call('read',offset=CHUNK);self.assertEqual(data,self.body[CHUNK:]);self.call('finish-download')
        (self.root/'source.bin').write_bytes(b'y'*len(self.body))
        values.update(expected={k:meta[k] for k in ('size','modified','sha256')})
        with self.assertRaisesRegex(StreamError,'SOURCE_CHANGED'):self.call('prepare-download',**values)
    def test_rejects_corrupt_partial_host_change_and_existing_target(self):
        self.start();self.chunk(self.body[:CHUNK]);self.stream.close()
        with self.assertRaisesRegex(StreamError,'PARTIAL_CHANGED'):self.call('prepare-upload',**self.opts,offset=CHUNK,prefixSha256=EMPTY_HASH)
        with self.assertRaisesRegex(StreamError,'PEER_CHANGED'):self.call('peer',expected='another peer')
        (self.root/'uploaded.bin').write_bytes(b'keep')
        with self.assertRaisesRegex(StreamError,'CONFLICT'):self.call('upload-status',**self.opts)
        self.assertEqual((self.root/'uploaded.bin').read_bytes(),b'keep')
    @unittest.skipIf(os.name=='nt','symlink creation requires additional Windows privileges')
    def test_walk_preserves_empty_directory_and_rejects_symlinks(self):
        (self.root/'folder').mkdir();(self.root/'folder/empty').mkdir();(self.root/'folder/one').write_bytes(b'1')
        rows=self.call('walk',path='C:/folder',peer=self.peer)['entries']
        self.assertEqual({r['relative'] for r in rows},{'','empty','one'})
        (self.root/'folder/link').symlink_to(self.root/'folder/one')
        with self.assertRaisesRegex(StreamError,'UNSUPPORTED_FILE'):self.call('walk',path='C:/folder',peer=self.peer)
    def test_mkdir_is_idempotent_and_conflict_protects_file(self):
        self.call('mkdir',path='C:/empty',peer=self.peer);self.call('mkdir',path='C:/empty',peer=self.peer)
        (self.root/'file').write_bytes(b'keep')
        with self.assertRaisesRegex(StreamError,'CONFLICT'):self.call('mkdir',path='C:/file',peer=self.peer)
    def test_empty_files_and_strict_schema(self):
        self.opts.update(size=0,sha256=EMPTY_HASH);self.start();self.call('finish-upload');self.assertEqual((self.root/'uploaded.bin').stat().st_size,0)
        for action,values in [('peer',{}),('read',{'offset':False}),('mkdir',{'path':'C:/x','peer':self.peer,'command':'bad'})]:
            with self.subTest(action=action),self.assertRaises(StreamError):self.call(action,**values)
    def test_binary_disk_error_reply_keeps_the_write_request_id(self):
        from tests.test_desktop_operations import FakeWebSocket
        from gmssh_windows_bridge.desktop_operations import OperationsSession,handle_operations
        ws=FakeWebSocket([json.dumps({'token':'s'*43}),
            json.dumps(dict(id=1,op='transfer',action='prepare-upload',options={**self.opts,'offset':0,'prefixSha256':EMPTY_HASH})),
            json.dumps(dict(id=2,op='transfer',action='write',options={'offset':0,'length':1})),b'x'])
        original=self.store.open
        def opened(name,mode,bufsize=-1):
            value=original(name,mode,bufsize)
            if name.endswith('.part'):
                result=MagicMock(wraps=value);result.write.side_effect=OSError(errno.ENOSPC,'synthetic full disk');return result
            return value
        with patch.object(OperationsSession,'files',return_value=self.store),patch.object(OperationsSession,'ssh_nowait',return_value=self.client),patch.object(self.store,'open',side_effect=opened):
            handle_operations(SimpleNamespace(timeout=1,access_token='s'*43),ws,threading.BoundedSemaphore(1))
        failure=[r for r in ws.replies() if r.get('code')=='DISK_FULL']
        self.assertEqual(len(failure),1);self.assertEqual(failure[0]['id'],2)

    def test_session_close_keeps_owned_partial(self):
        self.start();self.chunk(self.body[:CHUNK]);self.stream.close()
        self.assertEqual((self.root/('.gmssh-transfer-'+'a'*32+'.part')).stat().st_size,CHUNK)


if __name__=='__main__':unittest.main()
