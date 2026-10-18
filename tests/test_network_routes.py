import ipaddress
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from gmssh_windows_bridge.network_routes import local_networks, route_info, prepare_routes, select_route
from gmssh_windows_bridge.bridge import Session
from tests.test_pairing import exported
from gmssh_windows_bridge.pairing import inspect_connection


class NetworkRouteTests(unittest.TestCase):
    def test_mac_prefixes_ignore_down_loopback_and_tunnel_interfaces(self):
        raw='''en0: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.0.2.5 netmask 0xffffff00 broadcast 192.0.2.255
\tinet6 2001:db8:1::5 prefixlen 64 autoconf
\tinet6 fe80::5%en0 prefixlen 64
utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500
\tinet 10.99.0.5 netmask 0xffffff00
en1: flags=8802<BROADCAST,SIMPLEX,MULTICAST> mtu 1500
\tinet 198.51.100.5 netmask 0xffffff00
lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
'''
        with patch('gmssh_windows_bridge.network_routes.sys.platform','darwin'),patch('gmssh_windows_bridge.network_routes.subprocess.run',return_value=SimpleNamespace(stdout=raw)) as run:
            networks=local_networks()
        self.assertEqual(set(map(str,networks)),{'192.0.2.0/24','2001:db8:1::/64'})
        self.assertEqual(route_info('2001:db8:1::42',networks)['scope'],'lan')
        self.assertEqual(route_info('10.99.0.42',networks)['scope'],'remote')
        self.assertEqual(route_info('2001:db8:2::42',None)['scope'],'unknown')
        self.assertNotIn('shell',run.call_args.kwargs)

    def test_linux_and_windows_prefixes_use_operational_interfaces(self):
        linux=json.dumps([{'flags':['UP','BROADCAST'],'addr_info':[{'local':'192.0.2.5','prefixlen':24}]},{'flags':['UP','POINTOPOINT'],'addr_info':[{'local':'10.99.0.5','prefixlen':24}]}])
        with patch('gmssh_windows_bridge.network_routes.sys.platform','linux'),patch('gmssh_windows_bridge.network_routes.shutil.which',return_value='/sbin/ip'),patch('gmssh_windows_bridge.network_routes.subprocess.run',return_value=SimpleNamespace(stdout=linux)):
            self.assertEqual(list(map(str,local_networks())),['192.0.2.0/24'])
        windows=json.dumps([{'IPAddress':'2001:db8:1::5','PrefixLength':64},{'IPAddress':'192.0.2.5','PrefixLength':0}])
        with patch('gmssh_windows_bridge.network_routes.sys.platform','win32'),patch('gmssh_windows_bridge.network_routes.subprocess.run',return_value=SimpleNamespace(stdout=windows)):
            self.assertEqual(list(map(str,local_networks())),['2001:db8:1::/64'])
        with patch('gmssh_windows_bridge.network_routes.subprocess.run',side_effect=OSError()),patch('gmssh_windows_bridge.network_routes.sys.platform','darwin'):
            self.assertIsNone(local_networks())

    def test_runtime_reconnect_selects_before_password_and_requires_pins_for_every_candidate(self):
        value=exported();value['addresses']=['192.0.2.42','2001:db8:1::42'];connection=inspect_connection(json.dumps(value))
        with tempfile.TemporaryDirectory() as folder:
            pins=Path(folder)/'known_hosts';pins.write_text(''.join(target+' '+connection['sshHostPublicKey']+'\n' for target in connection['addresses']))
            config=SimpleNamespace(target='192.0.2.42',target_port=22,username='gmssh',timeout=3,known_hosts=pins,auto_address=connection['addresses'])
            prepare_routes(config)
            with patch('gmssh_windows_bridge.pairing.choose_target',return_value={'target':'2001:db8:1::42','verified':True}) as choose,patch('gmssh_windows_bridge.bridge.paramiko.SSHClient') as factory,patch('gmssh_windows_bridge.network_routes.local_networks',return_value=[ipaddress.ip_network('2001:db8:1::/64')]):
                session=Session(config);self.assertEqual(session.check_auth_password('gmssh','synthetic-password'),0)
                factory.return_value.connect.assert_called_once_with('2001:db8:1::42',port=22,username='gmssh',password='synthetic-password',timeout=3,auth_timeout=3,banner_timeout=3,allow_agent=False,look_for_keys=False)
                self.assertEqual(config.route_status['scope'],'lan');self.assertEqual(factory.return_value.gmssh_route['family'],'IPv6');choose.assert_called_once()
            pins.write_text('192.0.2.42 '+connection['sshHostPublicKey']+'\n')
            with self.assertRaisesRegex(ValueError,'主机身份'):prepare_routes(config)
            config.auto_address=[];prepare_routes(config)
            with patch('gmssh_windows_bridge.pairing.choose_target') as choose:
                self.assertEqual(select_route(config),'192.0.2.42');choose.assert_not_called()

    def test_failed_identity_selection_never_sends_a_password(self):
        config=SimpleNamespace(target='192.0.2.42',username='gmssh',route_connection={'addresses':['192.0.2.42']},route_status={})
        with patch('gmssh_windows_bridge.pairing.choose_target',side_effect=ValueError('no pinned peer')),patch('gmssh_windows_bridge.bridge.paramiko.SSHClient') as factory:
            self.assertNotEqual(Session(config).check_auth_password('gmssh','synthetic-password'),0)
            factory.return_value.connect.assert_not_called()
