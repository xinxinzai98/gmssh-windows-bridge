"""Optional real Windows smoke check through an already-running local bridge."""
import argparse
import getpass
from pathlib import Path
import paramiko

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--username', required=True)
parser.add_argument('--port', type=int, default=22229)
parser.add_argument('--known-hosts', type=Path, default=Path.home() / '.ssh/known_hosts')
args = parser.parse_args()
client = paramiko.SSHClient()
client.load_host_keys(str(args.known_hosts))
client.connect('127.0.0.1', port=args.port, username=args.username,
               password=getpass.getpass('Existing Windows SSH password: '),
               allow_agent=False, look_for_keys=False, timeout=10)
try:
    text = ''
    for mode in ('FAST', 'SLOW'):
        marker = '__GMB_' + mode + '_METRICS__'
        command = "sh -s <<'" + marker + "'\n# " + marker + "\n# smoke check\n" + marker
        _, stdout, _ = client.exec_command(command, timeout=30)
        text += stdout.read().decode('utf-8')
        assert stdout.channel.recv_exit_status() == 0, 'Collector failed'
    values = dict(line.split('=', 1) for line in text.splitlines() if line.startswith('__GMB_') and '=' in line)
    assert 0 <= float(values['__GMB_CPU_USAGE__']) <= 100
    assert int(values['__GMB_CPU_CORES__']) > 0
    assert 0 <= int(values['__GMB_CPU_IDLE__']) <= int(values['__GMB_CPU_TOTAL__'])
    assert 0 <= int(values['__GMB_MEM_USED_BYTES__']) <= int(values['__GMB_MEM_TOTAL_BYTES__'])
    assert int(values['__GMB_MEM_TOTAL_BYTES__']) > 0
    assert 'Windows' in values['__GMB_OS_NAME__']
    disks = [line.split('\t') for line in text.splitlines() if '\t' in line]
    assert disks, 'No fixed volumes returned'
    for disk in disks:
        assert len(disk) == 6 and disk[0].startswith('/dev/windows/')
        assert 0 <= int(disk[4]) <= int(disk[2]) and int(disk[3]) == 1
    _, stdout, _ = client.exec_command('echo unsupported', timeout=5)
    assert stdout.channel.recv_exit_status() == 126
    print('PASS: real Windows metrics, ranges, disk units and command rejection')
finally:
    client.close()
