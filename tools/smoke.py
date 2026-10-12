"""Optional real Windows smoke check through an already-running local bridge."""
import argparse
import getpass
import base64
from pathlib import Path
import re
import time
import uuid
import paramiko

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--username', required=True)
parser.add_argument('--port', type=int, default=22229)
parser.add_argument('--known-hosts', type=Path, default=Path.home() / '.ssh/known_hosts')
parser.add_argument('--exercise-terminal', action='store_true', help='Test native exec and an interactive Windows shell')
parser.add_argument('--exercise-sftp', action='store_true', help='Create/read/rename/remove a unique temporary directory and file')
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
    if args.exercise_terminal:
        script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output 'BRIDGE_EXEC_OK'; [Console]::Error.WriteLine('BRIDGE_STDERR_OK'); exit 7"
        command = 'powershell.exe -NoProfile -EncodedCommand ' + base64.b64encode(script.encode('utf-16le')).decode()
        _, stdout, stderr = client.exec_command(command, timeout=15)
        assert b'BRIDGE_EXEC_OK' in stdout.read()
        assert b'BRIDGE_STDERR_OK' in stderr.read()
        assert stdout.channel.recv_exit_status() == 7
        channel = client.get_transport().open_session(timeout=10)
        channel.get_pty(width=80, height=24)
        channel.invoke_shell()
        channel.resize_pty(width=132, height=40)
        channel.sendall(b'echo BRIDGE_SHELL_%COMPUTERNAME%\r\nexit\r\n')
        output = bytearray()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            while channel.recv_ready():
                output.extend(channel.recv(32768))
            if channel.exit_status_ready():
                break
            time.sleep(0.02)
        channel.close()
        assert re.search(rb'BRIDGE_SHELL_[A-Za-z0-9][A-Za-z0-9-]+', output), 'Native Windows shell did not execute the command'
        print('PASS: real Windows exec stdout/stderr/exit status and interactive shell')
    else:
        _, stdout, _ = client.exec_command('echo unsupported', timeout=5)
        assert stdout.channel.recv_exit_status() == 126
    if args.exercise_sftp:
        with client.open_sftp() as files:
            files.get_channel().settimeout(15)
            home = files.normalize('.')
            folder = home.rstrip('/') + '/bridge-smoke-' + uuid.uuid4().hex
            first = folder + '/测试.bin'
            second = folder + '/renamed.bin'
            payload = bytes(range(256)) * 128
            files.mkdir(folder)
            try:
                with files.open(first, 'wb') as file:
                    file.write(payload)
                assert '测试.bin' in files.listdir(folder)
                files.rename(first, second)
                with files.open(second, 'rb') as file:
                    assert file.read() == payload
                assert files.stat(second).st_size == len(payload)
            finally:
                for file in (first, second):
                    try:
                        files.remove(file)
                    except FileNotFoundError:
                        pass
                files.rmdir(folder)
        print('PASS: real Windows SFTP unicode filename, binary transfer, rename and cleanup')
    print('PASS: real Windows metrics, ranges and disk units')
finally:
    client.close()
