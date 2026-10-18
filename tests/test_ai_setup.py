import base64
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch

from gmssh_windows_bridge.ai import Registry, Operations, PERMISSIONS, TOOLS
from gmssh_windows_bridge.ai_setup import Setup, doctor, mcp_configuration, preview
from gmssh_windows_bridge.file_stream import StreamError
from tests.test_connection_code import public_connection, certificate


class AISetupTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)/'private space';self.registry=Registry(self.root)
        self.public=public_connection();cert,_=certificate(self.public)
        self.token='s'*43
        self.policy=dict(view=True,input=True,files=True,terminal=True,clipboard=False,power=False)
        self.payload={'schema':2,'connection':self.public,'port':22257,'certificate':cert,'controller':{'id':'f'*32,'name':'Synthetic AI','token':self.token,'permissions':self.policy}}
        self.code=self.encode(self.payload)
        self.record=self.registry.enroll(self.code,'Synthetic PC',sorted(PERMISSIONS),env='GMSSH_AI_TEST_SECRET')
        self.id=self.record['id'];self.connections=0;self.paused=False
        case=self
        class Client:
            controller_protocol=2
            ai_capabilities={'aiProtocol':1}
            policy=case.policy
            def call(self,action,**values):
                case.assertEqual(action,'ai-desktop');case.assertEqual(values,{'args':{'operation':'context'}})
                return {'unlocked':True,'paused':case.paused}
        self.client=Client()
        @contextmanager
        def connector(registry,device):
            self.connections+=1
            yield self.client
        self.setup=Setup(self.registry,connector)

    @staticmethod
    def encode(payload):
        return 'GMSSH-AUTH2.'+base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')

    def test_preview_contains_identity_and_no_authorization_secret(self):
        result=preview(self.registry,self.code)
        self.assertTrue(result['existing']);self.assertEqual(result['id'],self.id)
        self.assertEqual(result['fingerprint'],self.public['sshHostFingerprint'])
        self.assertNotIn(self.token,json.dumps(result));self.assertNotIn('certificate',result)
        self.assertEqual(self.connections,0)

    def test_real_permission_snapshot_is_dated_and_invalidated_on_local_change(self):
        self.client.policy={**self.policy,'terminal':False}
        result=self.setup.request({'action':'check','data':{'device':self.id}})
        self.assertTrue(result['ok']);self.assertEqual(result['result']['state'],'partial')
        self.assertEqual(result['result']['code'],'PERMISSIONS_REDUCED')
        self.assertFalse(result['result']['effective']['terminal'])
        cached=self.setup.request({'action':'list','data':{}})['devices'][0]['lastCheck']
        self.assertEqual(cached['checkedAt'],result['result']['checkedAt'])
        self.assertNotIn(self.token,json.dumps(cached))
        self.registry.configure(self.id,['inspect'])
        self.assertIsNone(self.setup.request({'action':'list','data':{}})['devices'][0]['lastCheck'])

    def test_pause_is_separate_from_grant_and_disabled_devices_never_connect(self):
        self.paused=True
        result=self.setup.operations.call('device_access_check',{'device':self.id})
        self.assertEqual(result['result']['code'],'AI_PAUSED')
        self.assertTrue(result['result']['effective']['input'])
        self.registry.configure(self.id,[]);before=self.connections
        result=self.setup.operations.call('device_access_check',{'device':self.id})
        self.assertEqual(result['error']['code'],'ACCESS_DENIED');self.assertEqual(self.connections,before)

    def test_credential_update_rejects_wrong_identity_and_preserves_config(self):
        changed=json.loads(json.dumps(self.payload));changed['controller']['id']='a'*32
        before=(self.root/'ai-devices.json').read_bytes()
        with patch('gmssh_windows_bridge.keychain.DesktopKeychain') as keychain:
            with self.assertRaisesRegex(StreamError,'IDENTITY_MISMATCH'):
                self.registry.replace_authorization(self.id,self.encode(changed),['inspect'])
            keychain.assert_not_called()
        self.assertEqual((self.root/'ai-devices.json').read_bytes(),before)

    def test_same_authorization_can_refresh_only_its_keychain_entry(self):
        with self.registry.lock():
            devices=self.registry.devices();devices[0]['credential']={'kind':'keychain','reference':'ai:'+self.id};self.registry.save(devices)
        with patch('gmssh_windows_bridge.ai.sys.platform','darwin'),patch('gmssh_windows_bridge.keychain.DesktopKeychain') as keychain:
            value=self.registry.replace_authorization(self.id,self.code,['inspect'])
            self.assertEqual(value['id'],self.id)
            keychain.assert_called_once_with('ai:'+self.id);keychain.return_value.save.assert_called_once_with(self.token)
        self.assertEqual(len(self.registry.devices()),1)
        self.assertNotIn(self.token,(self.root/'ai-devices.json').read_text())

    def test_configuration_formats_forward_names_without_secret_values(self):
        with patch.dict(os.environ,{'GMSSH_AI_TEST_SECRET':'not-for-export'}):
            raw=mcp_configuration(self.registry,'json');toml=mcp_configuration(self.registry,'codex')
        self.assertNotIn('not-for-export',raw+toml)
        value=json.loads(raw)['mcpServers']['gmssh'];self.assertEqual(value['args'][0],'-I')
        self.assertIn('env_vars = ["GMSSH_AI_TEST_SECRET"]',toml)
        self.assertIn('[mcp_servers.gmssh]',toml)
        if sys.version_info>=(3,11):
            import tomllib
            parsed=tomllib.loads(toml)['mcp_servers']['gmssh'];self.assertEqual(parsed['args'],value['args'])
        with self.assertRaisesRegex(StreamError,'ENV_FORWARDING_REQUIRED'):
            mcp_configuration(self.registry,'codex-cli')
        self.registry.configure(self.id,[])
        parts=shlex.split(mcp_configuration(self.registry,'codex-cli'))
        self.assertEqual(parts[:5],['codex','mcp','add','gmssh','--']);self.assertIn(str(self.root),parts)

    def test_local_doctor_never_connects_or_fetches_a_password(self):
        with patch.object(self.registry,'credential',side_effect=AssertionError('secret fetch')),patch('gmssh_windows_bridge.ai.connect_device',side_effect=AssertionError('network')):
            report=doctor(self.registry,check_mcp=True)
        self.assertTrue(report['ready'],report)
        self.assertEqual(report['deviceConnectionsAttempted'],0)
        self.assertEqual(report['checks'][-1]['tools'],len(TOOLS))
        self.assertNotIn(self.token,json.dumps(report))

    def test_setup_rejects_unexpected_fields_and_cache_rejects_private_payloads(self):
        with self.assertRaisesRegex(StreamError,'INVALID_ARGUMENT'):
            self.setup.request({'action':'doctor','data':{'checkMCP':True,'command':'unexpected'}})
        with self.registry.lock():
            self.registry._save_json('ai-status.json',{'schema':1,'devices':{self.id:{'state':'passed','code':'OK','checkedAt':'2026-01-01','effective':{},'features':{},'secret':'must-not-pass'}}})
        with self.assertRaisesRegex(StreamError,'CONFIG_UNSAFE'):
            self.registry.checks()

    def test_task_history_is_local_and_only_explicit_query_uses_terminal_access(self):
        device=self.registry.devices()[0]
        self.registry.remember_task(device,{'taskId':'a'*32,'state':'running','code':'OK','exitCode':None},'b'*32)
        value=self.setup.request({'action':'history','data':{'device':self.id}})
        self.assertTrue(value['canQuery']);self.assertEqual(value['tasks'][0]['taskId'],'a'*32)
        self.assertFalse(value['remoteStateChecked']);self.assertEqual(self.connections,0)
        def get(action,**values):
            self.assertEqual(action,'ai-task-get');self.assertEqual(values,{'args':{'taskId':'a'*32,'offset':0}})
            return {'taskId':'a'*32,'state':'completed','code':'OK','exitCode':0,'output':'synthetic output'}
        self.client.call=get
        value=self.setup.request({'action':'task','data':{'device':self.id,'taskId':'a'*32}})
        self.assertTrue(value['ok']);self.assertEqual(self.connections,1)
        self.assertNotIn('synthetic output',(self.root/'ai-tasks.json').read_text())
        self.registry.configure(self.id,[])
        value=self.setup.request({'action':'history','data':{'device':self.id}})
        self.assertFalse(value['canQuery']);self.assertEqual(value['tasks'][0]['state'],'completed')
        denied=self.setup.request({'action':'task','data':{'device':self.id,'taskId':'a'*32}})
        self.assertEqual(denied['error']['code'],'ACCESS_DENIED');self.assertEqual(self.connections,1)
        with self.assertRaisesRegex(StreamError,'INVALID_ARGUMENT'):
            self.setup.request({'action':'task','data':{'device':self.id,'taskId':'a'*32,'script':'forbidden'}})


if __name__=='__main__':
    unittest.main()
