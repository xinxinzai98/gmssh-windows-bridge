import subprocess
import sys
import unittest
from pathlib import Path


@unittest.skipUnless(sys.platform == 'win32', 'native Windows argument parser required')
class WindowsSetupTests(unittest.TestCase):
    def test_password_arguments_roundtrip_without_changing_settings(self):
        script = Path(__file__).resolve().parents[1] / 'gmssh_windows_bridge/setup-desktop.ps1'
        result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(script), '-SelfTest'],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)
