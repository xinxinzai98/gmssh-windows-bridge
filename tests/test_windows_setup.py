import subprocess
import sys
import unittest
from pathlib import Path


@unittest.skipUnless(sys.platform == 'win32', 'native Windows argument parser required')
class WindowsSetupTests(unittest.TestCase):
    def test_connection_code_guards_without_changing_system_settings(self):
        script = Path(__file__).with_name('windows-connect-checks.ps1')
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)

    def test_upgrade_and_rollback_touch_only_temporary_fixture_files(self):
        script = Path(__file__).with_name('windows-maintenance-checks.ps1')
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)

    def test_runtime_download_without_real_network_or_installation(self):
        script = Path(__file__).with_name('windows-runtime-checks.ps1')
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)

    def test_preflight_and_readiness_without_changing_system_settings(self):
        script = Path(__file__).with_name('windows-setup-checks.ps1')
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)

    def test_password_arguments_roundtrip_without_changing_settings(self):
        script = Path(__file__).resolve().parents[1] / 'gmssh_windows_bridge/setup-desktop.ps1'
        result = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(script), '-SelfTest'],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS:', result.stdout)
