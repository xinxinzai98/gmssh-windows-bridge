"""Test-only network routing: a synthetic address reaches the loopback Go broker."""
import runpy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gmssh_windows_bridge import controller_access
from gmssh_windows_bridge.connection_code import _PinnedConnection

port = int(sys.argv[1])
class LoopbackPinned(_PinnedConnection):
    def __init__(self, target, code):
        if target != '192.168.250.2':
            raise ValueError('Only the named synthetic target is allowed')
        super().__init__('127.0.0.1', {**code, 'port': port})
controller_access._PinnedConnection = LoopbackPinned
args = sys.argv[2:]
if len(args) < 2 or args[0] != '-m':
    raise ValueError('Test wrapper requires an explicit project module')
module = args[1]
sys.argv = [module, *args[2:]]
runpy.run_module(module, run_name='__main__')
