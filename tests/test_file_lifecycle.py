import unittest
from unittest.mock import MagicMock

from gmssh_windows_bridge.desktop import MonitorDesktopPool
from gmssh_windows_bridge.desktop_operations import OperationsSession


class FileLifecycleTests(unittest.TestCase):
    def test_file_lease_survives_monitor_and_desktop_close_and_releases_last(self):
        pool=MonitorDesktopPool(21118,1);client=MagicMock();pool.attach(client)
        desktop_lease,_=pool.acquire()
        files=OperationsSession(None,MagicMock(),1,pool=pool)
        self.assertIs(files.ssh(),client)
        pool.detach(client);desktop_lease.close()
        client.close.assert_not_called()
        self.assertIs(files.ssh(),client)
        files.close();client.close.assert_called_once();self.assertFalse(pool.clients)


if __name__=='__main__':unittest.main()
