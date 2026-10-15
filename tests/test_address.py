import unittest

from gmssh_windows_bridge.address import normalize_address, parse_endpoint, ssh_endpoint, ssh_target


class AddressTests(unittest.TestCase):
    def test_literals_and_ports_are_unambiguous(self):
        for text, port, expected in [
            ('2001:0DB8:0000::0010', 22, ('2001:db8::10', 22)),
            ('2001:db8::10:2222', 22, ('2001:db8::10:2222', 22)),
            ('[2001:db8::10]:2222', 22, ('2001:db8::10', 2222)),
            ('[fd12:3456::10]', 2222, ('fd12:3456::10', 2222)),
            ('192.0.2.42:2222', 22, ('192.0.2.42', 2222)),
            ('::ffff:192.168.250.2', 22, ('192.168.250.2', 22)),
        ]:
            with self.subTest(text=text):
                self.assertEqual(parse_endpoint(text, port), dict(zip(('target', 'port'), expected)))
        self.assertEqual(ssh_endpoint('2001:db8::10', 2222), '[2001:db8::10]:2222')
        self.assertEqual(ssh_endpoint('2001:db8::10', 22), '2001:db8::10')

    def test_invalid_or_local_targets_fail_before_any_connection(self):
        for value in ['::1', '::', 'ff02::1', 'fe80::1', 'fe80::1%en0', '::ffff:127.0.0.1',
                      '127.0.0.1', '255.255.255.255', 'https://example.invalid', '[192.0.2.42]:22',
                      '[2001:db8::1]:0', '[2001:db8::1]:65536', '[2001:db8::1]:bad', 'not-an-address', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_endpoint(value)
        for port in [True, 0, 65536, '22']:
            with self.assertRaises(ValueError):
                parse_endpoint('2001:db8::10', port)

    def test_normalization_does_not_turn_endpoint_text_into_an_address(self):
        with self.assertRaises(ValueError):
            normalize_address('[2001:db8::10]:22')

    def test_cli_keeps_hostnames_and_local_fixtures_with_a_separate_port(self):
        for value, expected in [('lab-pc.local','lab-pc.local'),('[2001:0db8::0010]','2001:db8::10'),('::1','::1')]:
            self.assertEqual(ssh_target(value),expected)
        for value in ['[2001:db8::10]:22','host:22','https://host','fe80::1%en0']:
            with self.assertRaises(ValueError): ssh_target(value)
