import base64
import errno
import json
import shutil
import socket
import subprocess
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from gmssh_windows_bridge import readonly_tools as tools
from gmssh_windows_bridge.desktop import MonitorDesktopPool, create_server
from gmssh_windows_bridge.desktop_operations import OperationsSession, SSHPoolUnavailable, run_command
from gmssh_windows_bridge.readonly_cli import request


def result(tool='processes'):
    value = dict(schema=1, kind='windows', tool=tool, sampledAt='2026-01-01T00:00:00Z',
                 state='passed', code='OK', items=[], truncated=False)
    if tool == 'processes':
        value.update(items=[dict(pid=7, name='演示进程', cpuPercent=12.5, memoryBytes=4096)],
                     units=dict(cpu='logical-processors-normalized', memory='working-set', sampleSeconds=1, cores=4))
    return value


class ReadonlyTests(unittest.TestCase):
    def test_encoded_search_is_data_and_options_cannot_be_commands(self):
        search = "'; Stop-Service sshd; $(Get-Secret)"
        command = tools.command_for('processes', dict(limit=50, search=search, sort='cpu'))
        script = base64.b64decode(command.split()[-1]).decode('utf-16le')
        self.assertNotIn(search, script)
        encoded = script.split("FromBase64String('", 1)[1].split("'", 1)[0]
        self.assertEqual(json.loads(base64.b64decode(encoded))['search'], search)
        for name, options in [('kill', {}), ('processes', dict(limit=500, search='', sort='cpu')),
                              ('services', dict(limit=50, search='x\nrestart', sort='name')),
                              ('logs', dict(source='Security', limit=50, hours=24)),
                              ('log-detail', dict(source='system', recordId='1;whoami')),
                              ('capabilities', dict(cmd='anything'))]:
            with self.subTest(name=name, options=options), self.assertRaises(tools.ReadonlyInputError):
                tools.command_for(name, options)

    def test_ssh_uses_bounded_stdin_instead_of_a_long_default_shell_command(self):
        client=MagicMock();channel=client.get_transport().open_session.return_value
        channel.recv_ready.return_value=False;channel.recv_stderr_ready.return_value=False
        channel.exit_status_ready.return_value=True;channel.recv_exit_status.return_value=0
        script=tools.script_for('capabilities',{}).encode()
        self.assertLess(len(tools.STDIN_COMMAND),1024)
        run_command(client,tools.STDIN_COMMAND,1,stdin=script)
        channel.exec_command.assert_called_once_with(tools.STDIN_COMMAND)
        channel.sendall.assert_called_once_with(script);channel.shutdown_write.assert_called_once();channel.close.assert_called_once()

    def test_result_bounds_and_access_denied_are_distinct_from_empty_success(self):
        value = result(); self.assertEqual(tools.validate_result(value, 'processes')['items'][0]['name'], '演示进程')
        for key, invalid in [('pid', '7'), ('cpuPercent', float('nan')), ('cpuPercent', 101), ('memoryBytes', -1), ('name', '<x>'*100)]:
            value = result();value['items'][0][key] = invalid
            with self.subTest(key=key), self.assertRaises(tools.ReadonlyInputError): tools.validate_result(value, 'processes')
        empty = result('services');denied = {**empty, 'state': 'failed', 'code': 'ACCESS_DENIED'}
        self.assertEqual(tools.validate_result(empty, 'services')['state'], 'passed')
        self.assertEqual(tools.validate_result(denied, 'services')['state'], 'failed')

    def test_readonly_request_requires_existing_session_and_rejects_unknown_fields_first(self):
        pool, websocket = MagicMock(), MagicMock()
        pool.acquire.side_effect = SSHPoolUnavailable()
        session = OperationsSession(None, websocket, 1, pool=pool)
        with self.assertRaises(tools.ReadonlyInputError): session.request(dict(id=1, op='readonly', tool='kill', options={}))
        pool.acquire.assert_not_called()
        with self.assertRaises(SSHPoolUnavailable): session.request(dict(id=1, op='readonly', tool='processes', options=dict(limit=50,search='',sort='cpu')))
        pool.acquire.assert_called_once_with(timeout=0)

    def test_diagnostics_classify_network_failures_without_authentication(self):
        cfg=SimpleNamespace(target='192.0.2.42', target_port=22)
        for error, code in [(TimeoutError(), 'TCP_TIMEOUT'), (OSError(errno.ECONNREFUSED, 'private'), 'TCP_REFUSED'), (OSError(errno.ENETUNREACH, 'private'), 'TCP_UNREACHABLE'), (socket.gaierror(), 'ADDRESS_UNRESOLVED')]:
            with self.subTest(code=code), patch.object(tools.socket, 'create_connection', side_effect=error):
                pool=MonitorDesktopPool(21118,1);session=OperationsSession(None,MagicMock(),1,pool=pool)
                value=tools.diagnostics(session,cfg,MagicMock(),'fixed-command')
                self.assertEqual(value['stages'][1]['code'],code)
                self.assertEqual(value['stages'][3]['state'],'unchecked')
                self.assertIsNone(session.client)

    def test_key_change_auth_failure_and_disconnected_pool_observations(self):
        cfg=SimpleNamespace(target='192.0.2.42',target_port=22)
        for failure, stage, expected in [('BadHostKeyException','identity','HOST_KEY_CHANGED'),('AuthenticationException','auth','SSH_AUTH_FAILED')]:
            pool=MonitorDesktopPool(21118,1);pool.record_failure(failure)
            session=OperationsSession(None,MagicMock(),1,pool=pool)
            with patch.object(tools,'probe_tcp',return_value=dict(state='passed',code='TCP_REACHABLE')):
                value=tools.diagnostics(session,cfg,MagicMock(),'fixed-command')
            observed=next(item for item in value['stages'] if item['id']==stage)
            self.assertEqual(observed['state'],'failed');self.assertEqual(observed['code'],expected)
        pool.record_failure('arbitrary-secret');self.assertEqual(pool.snapshot()['code'],'SSH_UNAVAILABLE')

    def test_authenticated_diagnostics_only_open_fixed_monitor_query_and_sftp(self):
        pool=MonitorDesktopPool(21118,1);client=MagicMock();pool.attach(client)
        session=OperationsSession(None,MagicMock(),1,pool=pool)
        runner=MagicMock(return_value=json.dumps(dict.fromkeys(['computer','os','version','cpu','cores','memory','uptime','processes','disks','network'])).encode())
        with patch.object(tools,'probe_tcp',return_value=dict(state='passed',code='TCP_REACHABLE')), patch('gmssh_windows_bridge.desktop_operations.paramiko.SFTPClient'):
            value=tools.diagnostics(session,SimpleNamespace(target='192.0.2.42',target_port=22),runner,'fixed-monitor')
        self.assertTrue(all(stage['state']=='passed' for stage in value['stages']))
        runner.assert_called_once_with(client,'fixed-monitor',1)
        client.get_transport().open_session().invoke_subsystem.assert_called_once_with('sftp')
        client.connect.assert_not_called();session.close();pool.detach(client)

    def test_old_capability_payload_is_unknown_not_assumed_available(self):
        value=result('capabilities');value.update(versions=dict(server=None,engine=None,os='Windows'),capabilities=dict(processes=True,services=True,logs=False,sources=['system','application']))
        self.assertIsNone(tools.validate_result(value,'capabilities')['versions']['server'])
        self.assertFalse(tools.validate_result(value,'capabilities')['capabilities']['logs'])
        with self.assertRaises(tools.ReadonlyInputError): tools.validate_result({'version':'legacy'},'capabilities')

    def test_loopback_proxy_authenticates_but_never_creates_remote_login(self):
        pool=MonitorDesktopPool(21118,1)
        cfg=SimpleNamespace(listen_port=0,target='192.0.2.42',username='synthetic-user',target_port=22,rustdesk_port=21118,timeout=1,monitor_channel=MagicMock(),monitor_pool=pool,access_token='s'*43)
        with create_server(cfg) as server:
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            url='http://127.0.0.1:'+str(server.socket.getsockname()[1])+'/'
            denied=request(dict(url=url,token='x'*43,tool='capabilities',options={}))
            self.assertEqual(denied['error'],'LOCAL_ACCESS_DENIED')
            unavailable=request(dict(url=url,token='s'*43,tool='capabilities',options={}))
            self.assertEqual(unavailable['error'],'SSHPoolUnavailable')
            client=MagicMock();pool.attach(client)
            caps=result('capabilities');caps.update(versions=dict(server=None,engine=None,os='Windows'),capabilities=dict(processes=True,services=True,logs=True,sources=['system','application']))
            with patch('gmssh_windows_bridge.desktop_operations.run_command',return_value=json.dumps(caps).encode()):
                reply=request(dict(url=url,token='s'*43,tool='capabilities',options={}))
            self.assertEqual(reply['state'],'passed');client.connect.assert_not_called();pool.detach(client)
            server.shutdown();thread.join(2)
        with patch('websockets.sync.client.connect') as connector:
            connector.return_value.__enter__.return_value.recv.return_value=json.dumps(dict(type='error',code='OperationsUnavailable'))
            self.assertEqual(request(dict(url=url,token='s'*43,tool='capabilities',options={}))['error'],'QUERY_BUSY')
        for url in ['https://example.com/','http://192.0.2.42/','http://127.0.0.1:12/?token=private']:
            with self.assertRaises(ValueError): request(dict(url=url,token='s'*43,tool='capabilities',options={}))

    @unittest.skipUnless(shutil.which('powershell.exe') or shutil.which('pwsh'), 'native PowerShell unavailable; no remote Windows queried')
    def test_native_windows_readonly_queries_and_permission_failure(self):
        program=shutil.which('powershell.exe') or shutil.which('pwsh')
        for tool,options in [('capabilities',{}),('processes',dict(limit=50,search='',sort='cpu')),('services',dict(limit=50,search='',sort='name')),('logs',dict(source='system',hours=1,limit=50))]:
            command=tools.command_for(tool,options).split()[-1]
            completed=subprocess.run([program,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',command],capture_output=True,timeout=30,check=True)
            value=tools.validate_result(json.loads(completed.stdout.decode('utf-8-sig')),tool)
            self.assertIn(value['state'],{'passed','failed','unsupported'})
        script="function Get-WinEvent { throw [UnauthorizedAccessException]::new('denied') }; $options=@{tool='logs';source='system';hours=1;limit=50};\n"+tools.SCRIPT
        completed=subprocess.run([program,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],capture_output=True,check=True,timeout=15)
        self.assertEqual(json.loads(completed.stdout.decode('utf-8-sig'))['code'],'ACCESS_DENIED')


if __name__ == '__main__': unittest.main()
