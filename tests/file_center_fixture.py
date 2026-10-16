"""Local-only file-center integration fixture. No real SSH client or device is used."""
import hashlib
import io
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_desktop_operations import MemoryFile, MemorySFTP
from gmssh_windows_bridge.desktop import MonitorDesktopPool, create_server
from gmssh_windows_bridge.desktop_operations import DRIVE_COMMAND
import gmssh_windows_bridge


def main():
    assert Path(gmssh_windows_bridge.__file__).resolve().parent == Path(__file__).resolve().parents[1]/'gmssh_windows_bridge'
    source=Path(sys.argv[1]).resolve();web=Path(sys.argv[2]).resolve()
    if web.exists(): raise SystemExit('Choose a fresh fixture directory')
    shutil.copytree(source,web)
    folder=web/'tests';folder.mkdir()
    for name in ('file-center-entry.html','files-test-driver.js','file-center-small.html'):
        shutil.copyfile(Path(__file__).with_name(name),folder/name)
    page=web/'files.html';page.write_text(page.read_text().replace('</html>','<script src="/tests/files-test-driver.js"></script></html>'))
    events=[];desktops=[];start=time.monotonic();big=b'GMSSH synthetic bounded file\n'*(16*1024*1024//28)
    class SlowSource(io.BytesIO):
        def __init__(self,body,label): super().__init__(body);self.label=label;self.reported=False
        def read(self,size=-1):
            chunk=super().read(size)
            if chunk: time.sleep(.015)
            elif not self.reported:self.reported=True;events.append(dict(device=self.label,event='download-end',time=time.monotonic()-start))
            return chunk
    class Storage(MemorySFTP):
        def __init__(self,label):
            super().__init__();self.label=label;self.data={"C:/传输测试/大文件.bin":big,"C:/传输测试/已有.txt":b'keep original'};self.directories={'C:/','C:/传输测试'}
        def open(self,path,mode,bufsize=-1):
            if mode=='rb' and path.endswith('/大文件.bin'):
                events.append(dict(device=self.label,event='download-start',time=time.monotonic()-start));return SlowSource(self.data[path],self.label)
            if mode=='wx':events.append(dict(device=self.label,event='upload-start',time=time.monotonic()-start))
            return super().open(path,mode,bufsize)
    class Channel:
        def __init__(self,store):self.store=store
        def settimeout(self,_):pass
        def invoke_subsystem(self,name):assert name=='sftp'
        def close(self):pass
    stores=[Storage('A'),Storage('B')];pools=[];servers=[];threads=[]
    def drive(_client,command,_timeout,**_kwargs):
        if command!=DRIVE_COMMAND:raise AssertionError('Only the fixed drive query is allowed')
        return b'["C:"]'
    def desktop():desktops.append(True);raise AssertionError('Desktop connection must not be opened')
    stop=threading.Event()
    with patch('gmssh_windows_bridge.desktop.ASSETS',web),patch('gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient',side_effect=lambda channel:channel.store),patch('gmssh_windows_bridge.desktop_operations.run_command',side_effect=drive):
        try:
            devices=[]
            for index,store in enumerate(stores):
                client=MagicMock();client.get_transport().open_session.side_effect=lambda _store=store,**_:Channel(_store)
                pool=MonitorDesktopPool(21118,2);pool.attach(client);pools.append(pool)
                token=('s' if index==0 else 't')*43
                cfg=SimpleNamespace(listen_port=0,target='192.0.2.'+str(41+index),username='synthetic',target_port=22,rustdesk_port=21118,timeout=2,monitor_channel=desktop,monitor_pool=pool,access_token=token)
                server=create_server(cfg);servers.append(server);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();threads.append(thread)
                devices.append(dict(machineId=str(index+1)*32,viewerUrl='http://127.0.0.1:'+str(server.socket.getsockname()[1])+'/',target=cfg.target,label='演示工作站 '+chr(65+index),accessToken=token))
            (web/'fixture-config.json').write_text(json.dumps(dict(schema='gmssh-file-fixture',backendVersion=gmssh_windows_bridge.__version__,devices=devices,bigHash=hashlib.sha256(big).hexdigest(),bigSize=len(big)),ensure_ascii=False))
            def status():
                while not stop.is_set():
                    value=dict(events=list(events),desktopConnections=len(desktops),leases=[sum(entry['leases'] for entry in pool.clients.copy().values()) for pool in pools],files=[{Path(name).name:hashlib.sha256(body).hexdigest() for name,body in store.data.copy().items() if not Path(name).name.startswith('.gmssh-upload-')} for store in stores])
                    temporary=web/'fixture-state.tmp';temporary.write_text(json.dumps(value));temporary.replace(web/'fixture-state.json');stop.wait(.05)
            reporter=threading.Thread(target=status,daemon=True);reporter.start()
            parent=ThreadingHTTPServer(('127.0.0.1',0),partial(SimpleHTTPRequestHandler,directory=str(web)))
            threading.Thread(target=parent.serve_forever,daemon=True).start()
            print('http://127.0.0.1:'+str(parent.server_port)+'/tests/file-center-entry.html',flush=True)
            while True:time.sleep(1)
        except KeyboardInterrupt:pass
        finally:
            stop.set()
            if 'parent' in locals():parent.shutdown();parent.server_close()
            for server in servers:server.shutdown();server.socket.close()


if __name__=='__main__':main()
