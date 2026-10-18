import hashlib
import io
from pathlib import Path
import tempfile
import unittest

from gmssh_windows_bridge.file_stream import EMPTY_HASH, StreamError
from gmssh_windows_bridge.linux_files import LinuxPeer, fingerprint, posix_path
from tests.linux_sftp_fixture import SSHFixture


class LinuxFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.host = SSHFixture(self.root)
        self.addCleanup(self.host.close)
        self.node = dict(host='127.0.0.1', port=self.host.port, username='fixture', authType='pass', authValue='synthetic-password', peer=fingerprint(self.host.key))

    def peer(self, nodes=None, inspect=False):
        peer = LinuxPeer({'ssh': nodes or [self.node]}, inspect=inspect)
        self.addCleanup(peer.close)
        return peer

    def test_unknown_and_changed_key_never_receive_password(self):
        peer = self.peer([{**self.node, 'peer': None}], inspect=True)
        self.assertEqual(peer.trust['peer'], self.node['peer'])
        self.assertEqual(self.host.auth, [])
        with self.assertRaisesRegex(StreamError, 'HOST_UNVERIFIED'):
            self.peer([{**self.node, 'peer': None}])
        with self.assertRaisesRegex(StreamError, 'PEER_CHANGED'):
            self.peer([{**self.node, 'peer': 'SHA256:'+'a'*43}])
        self.assertEqual(self.host.auth, [])

    def test_posix_files_stream_resume_without_overwrite(self):
        peer = self.peer()
        body = '中文 : ? * . '.encode()*10000
        target = '/report:?.bin'
        options = dict(path=target, peer=self.node['peer'], token='b'*32, size=len(body), sha256=hashlib.sha256(body).hexdigest())
        peer.call('prepare-upload', {**options, 'offset': 0, 'prefixSha256': EMPTY_HASH})
        peer.call('write', {'offset': 0, 'length': 50000})
        peer.write(body[:50000])
        peer.close()
        peer = self.peer()
        state = peer.call('upload-status', options)
        self.assertEqual(state['offset'], 50000)
        peer.call('prepare-upload', {**options, 'offset': 50000, 'prefixSha256': hashlib.sha256(body[:50000]).hexdigest()})
        for offset in range(50000, len(body), 65536):
            chunk = body[offset:offset+65536]
            peer.call('write', {'offset': offset, 'length': len(chunk)})
            peer.write(chunk)
        peer.call('finish-upload', {})
        self.assertEqual((self.root/target[1:]).read_bytes(), body)
        self.assertTrue(peer.call('upload-status', options)['completed'])
        self.assertIn(target[1:], [e['name'] for e in peer.listing('/')['entries']])
        peer.call('prepare-download', dict(path=target, peer=self.node['peer'], expected=None, offset=0, prefixSha256=EMPTY_HASH))
        result = bytearray()
        while len(result) < len(body):
            peer.call('read', {'offset': len(result)})
            result.extend(peer.read())
        peer.call('finish-download', {})
        self.assertEqual(result, body)

    def test_auth_failure_and_private_key(self):
        with self.assertRaisesRegex(StreamError, 'AUTH_FAILED'):
            self.peer([{**self.node, 'authValue': 'incorrect'}])
        key = io.StringIO()
        self.host.user_key.write_private_key(key)
        peer = self.peer([{**self.node, 'authType': 'ca', 'authValue': key.getvalue()}])
        self.assertEqual(peer.listing('/')['entries'], [])

    def test_bastion_chain_authenticates_and_pins_each_hop(self):
        bastion = SSHFixture(self.root)
        self.addCleanup(bastion.close)
        bastion.destinations.add(self.host.port)
        first = {**self.node, 'port': bastion.port, 'peer': fingerprint(bastion.key)}
        peer = self.peer([first, self.node])
        self.assertEqual(peer.call('peer', {'expected': self.node['peer']})['peer'], self.node['peer'])
        self.assertEqual(len(bastion.auth), 1)
        self.assertEqual(len(self.host.auth), 1)

    def test_no_symlink_navigation_and_no_dot_segments(self):
        (self.root/'folder').mkdir()
        (self.root/'link').symlink_to(self.root/'folder')
        peer = self.peer()
        self.assertEqual([e['name'] for e in peer.listing('/')['entries']], ['folder'])
        for target in ['/link', '/link/sub']:
            with self.assertRaisesRegex(StreamError, 'UNSUPPORTED_FILE'):
                peer.listing(target)
        for target in ['/../x', '/foo/./x', 'C:/x', '/bad\x00']:
            with self.assertRaises(StreamError):
                posix_path(target)


if __name__ == '__main__':
    unittest.main()
