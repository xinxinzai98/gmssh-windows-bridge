import json
import socket
import threading
import time
import unittest
from unittest.mock import patch

from websockets.sync.server import serve
from gmssh_windows_bridge.file_stream import StreamError
from gmssh_windows_bridge.transfer_worker import Peer


class TransferStartupTests(unittest.TestCase):
    def server(self, handler, delay=0):
        listener=socket.socket();listener.bind(('127.0.0.1',0))
        port=listener.getsockname()[1];ready=threading.Event();state={}
        def run():
            time.sleep(delay);listener.listen()
            state['server']=serve(handler,sock=listener,compression=None)
            ready.set();state['server'].serve_forever()
        thread=threading.Thread(target=run,daemon=True);thread.start()
        def close():
            ready.wait(3)
            if 'server' in state:state['server'].shutdown()
            listener.close();thread.join(3)
        self.addCleanup(close)
        if not delay:ready.wait(3)
        return {'url':f'http://127.0.0.1:{port}/','token':'s'*43}

    def test_cold_local_listener_waits_before_sending_the_first_operation(self):
        operations=[]
        def handle(ws):
            json.loads(ws.recv());ws.send(json.dumps({'type':'operations_ready'}))
            request=json.loads(ws.recv());operations.append(request['action'])
            ws.send(json.dumps({'id':request['id'],'ok':True,'result':{'protocol':1}}))
            try:ws.recv()
            except Exception:pass
        value=self.server(handle,delay=.25)
        peer=Peer(value)
        try:self.assertEqual(peer.call('peer',{'expected':None}),{'protocol':1})
        finally:peer.close()
        self.assertEqual(operations,['peer'])

    def test_local_authorization_rejection_is_explicit_and_never_retried(self):
        connections=[]
        def handle(ws):
            connections.append(1);ws.recv()
            ws.send(json.dumps({'type':'error','code':'DesktopAccessError'}));ws.close()
        value=self.server(handle)
        with self.assertRaisesRegex(StreamError,'LOCAL_AUTH_FAILED'):Peer(value)
        self.assertEqual(len(connections),1)

    def test_a_lost_write_response_is_classified_without_replaying_the_write(self):
        class Socket:
            def __init__(self):self.sent=[]
            def send(self,value):self.sent.append(value)
            def recv(self,**_):raise TimeoutError('synthetic private detail, must never be shown')
        peer=Peer.__new__(Peer);peer.socket=Socket();peer.id=0
        with self.assertRaisesRegex(StreamError,'OPERATION_TIMEOUT'):
            peer.call('write',{'offset':0,'length':1})
        self.assertEqual(len(peer.socket.sent),1)

    def test_only_the_read_only_peer_probe_waits_for_the_monitoring_connection(self):
        from gmssh_windows_bridge.transfer_worker import transfer
        actions=[]
        def handle(ws):
            ws.recv();ws.send(json.dumps({'type':'operations_ready'}))
            for number in range(3):
                request=json.loads(ws.recv());actions.append(request['action'])
                reply={'id':request['id'],'ok':False,'code':'SSHPoolUnavailable'} if number<2 else {'id':request['id'],'ok':True,'result':{'protocol':1,'peer':'synthetic-pin'}}
                ws.send(json.dumps(reply))
            try:ws.recv()
            except Exception:pass
        value=self.server(handle)
        self.assertEqual(transfer({**value,'kind':'probe'}),{'peer':'synthetic-pin'})
        self.assertEqual(actions,['peer']*3)

    def test_busy_startup_has_a_deadline_and_does_not_send_file_operations(self):
        operations=[]
        def handle(ws):
            request=json.loads(ws.recv());operations.append(set(request))
            ws.send(json.dumps({'type':'error','code':'OperationsUnavailable'}));ws.close()
        value=self.server(handle)
        with patch('gmssh_windows_bridge.transfer_worker.STARTUP_TIMEOUT',.2):
            with self.assertRaisesRegex(StreamError,'LOCAL_SERVICE_BUSY'):Peer(value)
        self.assertTrue(operations);self.assertTrue(all(keys=={'token'} for keys in operations))

    def test_error_metadata_is_opt_in_and_never_contains_raw_exception_text(self):
        import errno
        import gmssh_windows_bridge.transfer_worker as worker
        with patch.object(worker,'DIAGNOSTICS',True),patch.object(worker,'CURRENT_STAGE','local-connect'),patch.object(worker,'emit') as emit:
            worker.failure('LOCAL_SERVICE_UNAVAILABLE',ConnectionRefusedError(errno.ECONNREFUSED,'secret-token /private/user/file'))
            value=emit.call_args.kwargs
            self.assertEqual(value['diagnostic']['stage'],'local-connect');self.assertEqual(value['diagnostic']['errno'],errno.ECONNREFUSED)
            self.assertNotIn('secret-token',json.dumps(value));self.assertNotIn('/private/',json.dumps(value))
        with patch.object(worker,'DIAGNOSTICS',False),patch.object(worker,'emit') as emit:
            worker.failure('TRANSFER_IO',ValueError('private detail'))
            self.assertEqual(emit.call_args.kwargs,{'event':'error','code':'TRANSFER_IO'})


if __name__=='__main__':unittest.main()
