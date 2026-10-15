"""Real local IPv6 SSH channels with synthetic metrics/files; no remote Windows claim."""
import base64
from pathlib import Path
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest

import paramiko

from gmssh_windows_bridge.bridge import serve
from gmssh_windows_bridge.desktop import MonitorDesktopPool
from test_forwarding import Files, Upstream
from test_bridge import request


class IPv6TransportTests(unittest.TestCase):
    def test_monitor_terminal_sftp_and_fixed_desktop_share_a_pinned_ipv6_session(self):
        listener=socket.socket(socket.AF_INET6,socket.SOCK_STREAM)
        try:
            listener.bind(('::1',0));listener.listen(1);listener.settimeout(5)
        except OSError:
            listener.close();self.skipTest('IPv6 loopback unavailable')
        key=paramiko.RSAKey.generate(2048)
        transports=[];destinations=[];peers=[];errors=[]

        class Fixture(Upstream):
            def check_auth_password(self,user,password):
                return paramiko.AUTH_SUCCESSFUL if (user,password)==('synthetic','synthetic') else paramiko.AUTH_FAILED

            def check_channel_direct_tcpip_request(self,channel_id,origin,destination):
                destinations.append(destination)
                self.direct_id=channel_id
                return paramiko.OPEN_SUCCEEDED if destination==('127.0.0.1',21118) else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

            def _execute(self,channel,command):
                if command.startswith(b'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '):
                    script=base64.b64decode(command.split()[-1]).decode('utf-16le')
                    if "$MetricMode = 'fast'" not in script:
                        raise ValueError('unexpected collector')
                    channel.sendall(b'__GMB_CPU_USAGE__=12\n__GMB_MEM_TOTAL_BYTES__=16384\n')
                    channel.send_exit_status(0);channel.close()
                else: super()._execute(channel,command)

        fixture=Fixture()
        def echo(channel):
            try: channel.sendall(channel.recv(64))
            finally: channel.close()

        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            known=root/'known_hosts';known.write_text(f'[::1]:{listener.getsockname()[1]} {key.get_name()} {key.get_base64()}\n')
            def upstream():
                try:
                    connection,peer=listener.accept();peers.append(peer[0])
                    remote=paramiko.Transport(connection);transports.append(remote);remote.add_server_key(key)
                    remote.set_subsystem_handler('sftp',paramiko.SFTPServer,Files,root=root)
                    remote.start_server(server=fixture)
                    while remote.is_active():
                        channel=remote.accept(0.05)
                        if channel is not None and channel.get_id()==getattr(fixture,'direct_id',None):
                            threading.Thread(target=echo,args=(channel,),daemon=True).start()
                        while not fixture.commands.empty():
                            channel,command=fixture.commands.get_nowait()
                            threading.Thread(target=fixture.execute,args=(channel,command),daemon=True).start()
                except (EOFError,OSError,paramiko.SSHException): pass
                except Exception as error: errors.append(type(error).__name__)
            upstream_thread=threading.Thread(target=upstream,daemon=True);upstream_thread.start()
            pool=MonitorDesktopPool(21118,3)
            cfg=SimpleNamespace(username='synthetic',target='::1',target_port=listener.getsockname()[1],timeout=3,
                                known_hosts=known,desktop_sessions=pool,enable_terminal=True,enable_sftp=True,shell='default')
            left,right=socket.socketpair();slots=threading.BoundedSemaphore(1);slots.acquire()
            bridge_thread=threading.Thread(target=serve,args=(left,key,cfg,slots),daemon=True);bridge_thread.start()
            client=paramiko.Transport(right)
            try:
                client.connect(hostkey=key,username='synthetic',password='synthetic')
                for command,expected,status in [(request('fast'),b'__GMB_CPU_USAGE__=12\n__GMB_MEM_TOTAL_BYTES__=16384\n',0),(b'hostname',b'forwarded:hostname',7)]:
                    channel=client.open_session(timeout=3);channel.settimeout(3);channel.exec_command(command)
                    self.assertEqual(channel.makefile('rb').read(),expected);self.assertEqual(channel.recv_exit_status(),status)
                shell=client.open_session(timeout=3);shell.settimeout(3);shell.get_pty();shell.invoke_shell()
                self.assertEqual(shell.recv(64),b'synthetic-shell-ready\n');shell.sendall(b'abcde 0123456789')
                self.assertEqual(shell.makefile('rb').read(),b'input:abcde 0123456789')
                with paramiko.SFTPClient.from_transport(client) as files:
                    with files.open('/roundtrip.txt','wb') as stream: stream.write(b'synthetic IPv6 transfer')
                    with files.open('/roundtrip.txt','rb') as stream: self.assertEqual(stream.read(),b'synthetic IPv6 transfer')
                    files.remove('/roundtrip.txt')
                lease,desktop=pool.connect()
                try:
                    desktop.sendall(b'synthetic-desktop-frame');self.assertEqual(desktop.recv(64),b'synthetic-desktop-frame')
                finally: desktop.close();lease.close()
                self.assertEqual(destinations,[('127.0.0.1',21118)]);self.assertEqual(peers,['::1'])
                self.assertEqual(len(transports),1)
            finally:
                client.close();bridge_thread.join(5)
                for transport in transports: transport.close()
                listener.close();upstream_thread.join(5);left.close();right.close()
            self.assertFalse(bridge_thread.is_alive());self.assertFalse(upstream_thread.is_alive());self.assertEqual(errors,[])
