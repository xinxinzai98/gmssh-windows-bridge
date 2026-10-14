import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from types import SimpleNamespace

from gmssh_windows_bridge.macos_launcher import monitor_options, refresh_executable_uuid, write_asar


class LauncherArchiveTest(unittest.TestCase):
    def test_copied_executable_has_an_independent_uuid_without_other_byte_changes(self):
        header = struct.pack('<8I', 0xFEEDFACF, 0, 0, 2, 1, 24, 0, 0)
        original = header + struct.pack('<II', 0x1B, 24) + b's' * 16 + b'unchanged code'
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'GMSSH'
            executable.write_bytes(original)
            refresh_executable_uuid(executable)
            updated = executable.read_bytes()
            self.assertNotEqual(updated[40:56], original[40:56])
            self.assertEqual(updated[:40] + updated[56:], original[:40] + original[56:])
            executable.write_bytes(original[:32])
            with self.assertRaises(ValueError): refresh_executable_uuid(executable)
            self.assertEqual(executable.read_bytes(), original[:32])

    def test_archive_offsets_and_integrity_match_native_pickle_format(self):
        files = {'package.json': b'{"main":"launcher.cjs"}', 'launcher.cjs': b'// synthetic launcher\n'}
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / 'app.asar'
            digest = write_asar(destination, files)
            raw = destination.read_bytes()
            marker, header_size, payload_size, text_size = struct.unpack('<4I', raw[:16])
            self.assertEqual(marker, 4)
            self.assertEqual(header_size, payload_size + 4)
            header = raw[16:16 + text_size]
            self.assertEqual(hashlib.sha256(header).hexdigest(), digest)
            entries = json.loads(header)['files']
            for name, body in files.items():
                item = entries[name]
                start = 8 + header_size + int(item['offset'])
                self.assertEqual(raw[start:start + item['size']], body)
                self.assertEqual(item['integrity']['hash'], hashlib.sha256(body).hexdigest())

    def test_monitoring_is_opt_in_and_requires_distinct_verified_paths(self):
        cfg = SimpleNamespace(port=22243, monitor_port=None, monitor_target_port=22,
                              monitor_username=None, monitor_known_hosts=None, monitor_host_key=None)
        self.assertIsNone(monitor_options(cfg))
        cfg.monitor_username = 'synthetic-user'
        with self.assertRaises(ValueError): monitor_options(cfg)
        with tempfile.TemporaryDirectory() as directory:
            cfg.monitor_known_hosts = Path(directory) / 'known_hosts'
            cfg.monitor_host_key = Path(directory) / 'bridge_host_key'
            cfg.monitor_port = 22244
            with self.assertRaises(ValueError): monitor_options(cfg)
            cfg.monitor_known_hosts.write_text('# synthetic test fixture\n')
            result = monitor_options(cfg)
            self.assertEqual(result['username'], 'synthetic-user')
            self.assertTrue(Path(result['knownHosts']).samefile(cfg.monitor_known_hosts))
            self.assertEqual(result['hostKey'], str(cfg.monitor_host_key))
            self.assertNotIn('password', result)
            self.assertFalse(cfg.monitor_host_key.exists())
            for port in (0, 22243, 65536):
                cfg.monitor_port = port
                with self.assertRaises(ValueError): monitor_options(cfg)
