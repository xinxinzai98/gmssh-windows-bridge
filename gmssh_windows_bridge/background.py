"""Detach the local bridge with redirected logs; no password storage or autostart."""
import os
from pathlib import Path
import subprocess
import sys
import time


def start_background(config):
    log = config.background_log.resolve()
    log.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args = [sys.executable, '-m', 'gmssh_windows_bridge',
            '--target', config.target, '--username', config.username,
            '--target-port', str(config.target_port), '--listen-port', str(config.listen_port),
            '--timeout', str(config.timeout), '--shell', config.shell,
            '--known-hosts', str(config.known_hosts.resolve()),
            '--host-key', str(config.host_key.resolve())]
    if getattr(config, 'desktop_port', None) is not None:
        args.extend(['--desktop-port', str(config.desktop_port),
                     '--rustdesk-port', str(config.rustdesk_port)])
    for flag in ('enable_terminal', 'enable_sftp', 'gmssh_terminal', 'verbose'):
        if getattr(config, flag):
            args.append('--' + flag.replace('_', '-'))
    options = {'start_new_session': True} if os.name != 'nt' else {
        'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'ab', buffering=0) as output:
        offset = os.fstat(output.fileno()).st_size
        child = subprocess.Popen(args, cwd=Path(__file__).resolve().parent.parent,
                                 stdin=subprocess.DEVNULL, stdout=output,
                                 stderr=subprocess.STDOUT, **options)
    ready = f'Monitoring bridge ready: 127.0.0.1:{config.listen_port}'.encode()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f'bridge failed to start; see {log}')
        with log.open('rb') as output:
            output.seek(offset)
            if ready in output.read():
                return child.pid, log
        time.sleep(0.05)
    child.terminate()
    child.wait(timeout=5)
    raise TimeoutError(f'bridge startup timed out; see {log}')
