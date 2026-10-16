"""Disk-backed synthetic SFTP fixture; binds loopback and never connects a device."""
import json
import os
from pathlib import Path
import stat
import sys
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gmssh_windows_bridge.desktop import MonitorDesktopPool, create_server


class LocalSFTP:
    def __init__(self, root): self.root=Path(root)
    def path(self, value):
        if not value.startswith('C:/') or '..' in value.split('/'): raise ValueError('synthetic path')
        return self.root/value[3:]
    def lstat(self, value): return self.path(value).lstat()
    stat=lstat
    def open(self, value, mode, bufsize=-1):
        modes={'wx':'xb','wb':'wb','rb':'rb','r+b':'r+b'}
        return open(self.path(value),modes[mode],buffering=bufsize)
    def listdir_iter(self, value, read_aheads=1):
        for file in self.path(value).iterdir():
            s=file.lstat()
            yield SimpleNamespace(filename=file.name,st_mode=s.st_mode,st_size=s.st_size,st_mtime=s.st_mtime)
    def listdir_attr(self, value): return list(self.listdir_iter(value))
    def mkdir(self, value): self.path(value).mkdir()
    def remove(self, value): self.path(value).unlink()
    def rename(self, source, target):
        os.link(self.path(source),self.path(target));self.path(source).unlink()
    def close(self): pass


def client_for(store):
    class Channel:
        def settimeout(self, _): pass
        def invoke_subsystem(self, name): assert name=='sftp'
        def close(self): pass
    client=MagicMock();client.get_transport().open_session.side_effect=lambda **_:Channel()
    client.get_transport().get_remote_server_key().asbytes.side_effect=lambda:(store.root/'.fixture-host-key').read_bytes() if (store.root/'.fixture-host-key').exists() else b'fixed synthetic SSH host key'
    return client


def main():
    import gmssh_windows_bridge
    assert Path(gmssh_windows_bridge.__file__).resolve().parent==Path(__file__).resolve().parents[1]/'gmssh_windows_bridge'
    store=LocalSFTP(sys.argv[1]);client=client_for(store);pool=MonitorDesktopPool(21118,2);pool.attach(client)
    config=SimpleNamespace(listen_port=0,target='192.0.2.40',username='synthetic',target_port=22,timeout=3,monitor_pool=pool,monitor_channel=lambda:None,access_token='s'*43)
    from gmssh_windows_bridge.desktop_operations import DRIVE_COMMAND,OperationsSession
    original=OperationsSession.request
    def request(session,data):
        marker=store.root/'.fixture-disconnect-on-read'
        if data.get('op')=='transfer' and data.get('action')=='read' and data.get('options',{}).get('offset',0)>=1024*1024 and marker.exists():
            marker.unlink();session.websocket.close(1011,'synthetic disconnect');return
        return original(session,data)
    from gmssh_windows_bridge.desktop import ASSETS
    assets=Path(sys.argv[2]) if len(sys.argv)>2 else ASSETS
    with patch('gmssh_windows_bridge.desktop_operations.OperationsSession.request',request),patch('gmssh_windows_bridge.desktop.ASSETS',assets),patch('gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient',return_value=store),patch('gmssh_windows_bridge.desktop_operations.run_command',side_effect=lambda _c,cmd,*a,**kw:b'["C:"]' if cmd==DRIVE_COMMAND else b''):
        server=create_server(config)
        print(json.dumps({'url':'http://127.0.0.1:'+str(server.socket.getsockname()[1])+'/','token':'s'*43}),flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.shutdown();server.socket.close()


if __name__=='__main__':main()
