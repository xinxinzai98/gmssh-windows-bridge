import base64
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest

from gmssh_windows_bridge.keychain import monitor_keychain


class KeychainIdentityTests(unittest.TestCase):
    def test_verified_address_changes_reuse_only_the_same_device_credential(self):
        with tempfile.TemporaryDirectory() as temporary:
            kind=b'ssh-ed25519'
            key='ssh-ed25519 '+base64.b64encode(struct.pack('!I',len(kind))+kind+struct.pack('!I',32)+b'k'*32).decode()
            other='ssh-ed25519 '+base64.b64encode(struct.pack('!I',len(kind))+kind+struct.pack('!I',32)+b'x'*32).decode()
            hosts=Path(temporary)/'known_hosts'
            hosts.write_text('[2001:db8::10]:2222 '+key+'\n[192.168.250.2]:2222 '+key+'\n[192.168.250.3]:2222 '+other+'\n')
            values={'ssh:gmssh@192.168.250.2:2222:21118':'synthetic-old-password',
                    'ssh:gmssh@192.168.250.3:2222:21118':'unrelated-secret'}
            reads=[]
            class Store:
                def __init__(self, account): self.account=account
                def exists(self): return self.account in values
                def get(self): reads.append(self.account);return values.get(self.account)
                def save(self,password):values[self.account]=password
            cfg=SimpleNamespace(target='2001:db8::10',target_port=2222,username='gmssh',rustdesk_port=21118,
                                known_hosts=hosts,desktop_credential_alias=['192.168.250.2','192.168.250.3'])
            store=monitor_keychain(cfg,Store)
            self.assertTrue(store.exists());self.assertEqual(reads,[])
            self.assertEqual(store.get(),'synthetic-old-password')
            self.assertNotIn('ssh:gmssh@192.168.250.3:2222:21118',reads)
            store.save('synthetic-confirmed-password')
            cfg.target='192.168.250.2';cfg.desktop_credential_alias=[]
            again=monitor_keychain(cfg,Store)
            self.assertEqual(again.primary.account,store.primary.account)
            self.assertEqual(again.get(),'synthetic-confirmed-password')
            self.assertEqual(values['ssh:gmssh@192.168.250.2:2222:21118'],'synthetic-old-password')

    def test_invalid_or_missing_alias_is_never_read(self):
        # Public key fixtures above exercise old-address compatibility without
        # loading the macOS Security framework or reading a real Keychain.
        from gmssh_windows_bridge.keychain import DeviceKeychain
        class Broken:
            def exists(self): raise OSError('locked synthetic keychain')
        with self.assertRaises(OSError): DeviceKeychain(Broken(),[]).exists()
