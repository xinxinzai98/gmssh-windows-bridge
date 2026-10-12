"""Loopback Windows metrics bridge with opt-in native terminal and SFTP forwarding."""
import argparse
import base64
import hashlib
import logging
import os
from pathlib import Path
import socket
import threading
import time

import paramiko

from . import __version__
from .relay import relay

LOG = logging.getLogger("gmssh_windows_bridge")
SCRIPT = Path(__file__).with_name("collector.ps1").read_text(encoding="utf-8")
LOGIN_SCRIPT = Path(__file__).with_name("login.ps1").read_text(encoding="utf-8")
POWERSHELL_SCRIPT = Path(__file__).with_name("powershell.ps1").read_text(encoding="utf-8")
MAX_OUTPUT = 1024 * 1024
# Fingerprint of GMSSH 2.0.4's captured on-wire Bash terminal bootstrap.
# Never execute or distribute the client bootstrap body.
GMSSH_SHELL_SHA256 = "11c29ebc378ec289d8fc67c6c790f990be919fcc7bf5f70b934751dea478a379"


def gmssh_shell_request(command):
    return len(command) <= 65536 and hashlib.sha256(command.strip()).hexdigest() == GMSSH_SHELL_SHA256


def gmssh_login_payload(payload):
    # Linux preflight aliases for a native Windows terminal, not elevation.
    for name in (b"SUDO", b"SUDO_ACCESS"):
        field = b"__GMB_LOGIN_" + name + b"__="
        payload = payload.replace(field + b"0\n", field + b"1\n")
    return payload


def metric_mode(command):
    """Recognize metric requests, never evaluate the client-supplied shell body."""
    if len(command) > 65536:
        return None
    try:
        lines = command.decode("utf-8").strip().splitlines()
    except UnicodeDecodeError:
        return None
    for mode in ("fast", "slow"):
        marker = "__GMB_" + mode.upper() + "_METRICS__"
        if (len(lines) >= 3 and lines[0] == "sh -s <<'" + marker + "'"
                and lines[1] == "# " + marker and lines[-1] == marker):
            return mode
    return None


def login_probe(command):
    """Recognize GMSSH's combined preflight; never execute its Linux profile edits."""
    return (len(command) <= 65536 and command.lstrip().startswith(b'profile_state=$(')
            and all(marker in command for marker in
                    (b'__GMB_LOGIN_PROFILE__', b'__GMB_LOGIN_USER__', b'__GMB_LOGIN_SUDO__', b'__GMB_LOGIN_OS__')))


def collect(remote, mode, timeout):
    # The only remotely executed payload is our packaged collector.
    script = LOGIN_SCRIPT if mode == "login" else "$MetricMode = '" + mode + "'\n" + SCRIPT
    # This fixed script has no significant indentation. Removing blank/comment
    # lines keeps it below cmd.exe's limit without stdin handling differences.
    script = "\n".join(line.strip() for line in script.splitlines()
                       if line.strip() and not line.lstrip().startswith("#"))
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    if len(encoded) > 7800:
        raise ValueError("collector exceeds Windows SSH command-line budget")
    transport = remote.get_transport()
    if transport is None or not transport.is_active():
        raise ConnectionError("Windows SSH session closed")
    deadline = time.monotonic() + timeout
    channel = transport.open_session(timeout=timeout)
    output = bytearray()
    error_size = 0
    try:
        channel.settimeout(timeout)
        channel.exec_command("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded)
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("collector deadline exceeded")
            while channel.recv_ready():
                output.extend(channel.recv(32768))
                if len(output) > MAX_OUTPUT:
                    raise ValueError("collector output too large")
            while channel.recv_stderr_ready():
                error_size += len(channel.recv_stderr(32768))
                if error_size > MAX_OUTPUT:
                    raise ValueError("collector stderr too large")
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                if channel.recv_exit_status() != 0:
                    raise RuntimeError("Windows collector returned an error")
                break
            time.sleep(0.02)
    finally:
        channel.close()
    payload = bytes(output).replace(b"\r\n", b"\n")
    expected = {"fast": b"__GMB_MEM_TOTAL_BYTES__=", "slow": b"__GMB_OS_NAME__=",
                "login": b"__GMB_LOGIN_USER__="}[mode]
    if expected not in payload:
        raise ValueError("missing metrics; check Windows PowerShell/CIM availability")
    return payload


class Session(paramiko.ServerInterface):
    def __init__(self, config):
        self.config = config
        self.remote = None
        self.requests = {}
        self.pending = {}
        self.claimed = set()
        self.ptys = {}
        self.upstreams = {}
        self.lock = threading.Lock()
        self.cache_lock = threading.Lock()
        self.cache = {}
        self.attempts = 0

    def get_allowed_auths(self, username):
        return "password"

    def check_auth_password(self, username, password):
        self.attempts += 1
        if username != self.config.username or self.attempts > 3:
            return paramiko.AUTH_FAILED
        remote = paramiko.SSHClient()
        try:
            remote.load_host_keys(str(self.config.known_hosts))
            remote.connect(self.config.target, port=self.config.target_port,
                           username=username, password=password,
                           timeout=self.config.timeout, auth_timeout=self.config.timeout,
                           banner_timeout=self.config.timeout,
                           allow_agent=False, look_for_keys=False)
        except (paramiko.SSHException, OSError) as exc:
            remote.close()
            LOG.warning("Upstream connection failed (%s)", type(exc).__name__)
            return paramiko.AUTH_FAILED
        if self.remote:
            self.remote.close()
        self.remote = remote
        return paramiko.AUTH_SUCCESSFUL

    def check_channel_request(self, kind, chanid):
        with self.lock:
            self.requests = {i: c for i, c in self.requests.items() if c is None or not c.closed}
            if kind != "session" or len(self.requests) >= 4:
                return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
            self.requests[chanid] = None
        return paramiko.OPEN_SUCCEEDED

    def enqueue(self, channel, kind, payload=None):
        with self.lock:
            chanid = channel.get_id()
            if chanid in self.claimed:
                return False
            self.claimed.add(chanid)
            self.pending[chanid] = (channel, kind, payload)
        return True

    def check_channel_exec_request(self, channel, command):
        # Enqueue rather than send before Paramiko's exec-success reply.
        mode = metric_mode(command)
        if mode is not None:
            return self.enqueue(channel, "metrics", mode)
        if getattr(self.config, "enable_terminal", False) and login_probe(command):
            return self.enqueue(channel, "metrics", "login")
        if getattr(self.config, "gmssh_terminal", False):
            if gmssh_shell_request(command):
                return self.enqueue(channel, "shell")
            if command.strip() in (b"id -nu", b"id -un"):
                return self.enqueue(channel, "identity")
        if getattr(self.config, "enable_terminal", False) and len(command) <= 65536:
            return self.enqueue(channel, "exec", command)
        return self.enqueue(channel, "unsupported")

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        if not getattr(self.config, "enable_terminal", False):
            return False
        with self.lock:
            self.ptys[channel.get_id()] = (term, width, height, pixelwidth, pixelheight)
        return True

    def check_channel_window_change_request(self, channel, width, height, pixelwidth, pixelheight):
        chanid = channel.get_id()
        with self.lock:
            previous = self.ptys.get(chanid)
            if previous is None:
                return False
            self.ptys[chanid] = (previous[0], width, height, pixelwidth, pixelheight)
            upstream = self.upstreams.get(chanid)
        if upstream is not None:
            try:
                upstream.resize_pty(width, height, pixelwidth, pixelheight)
            except (paramiko.SSHException, OSError):
                return False
        return True

    def check_channel_shell_request(self, channel):
        return getattr(self.config, "enable_terminal", False) and self.enqueue(channel, "shell")

    def check_channel_subsystem_request(self, channel, name):
        return (name == "sftp" and getattr(self.config, "enable_sftp", False)
                and self.enqueue(channel, "sftp"))

    def forward(self, channel, kind, payload):
        transport = self.remote.get_transport() if self.remote else None
        if transport is None or not transport.is_active():
            raise ConnectionError("Windows SSH session closed")
        upstream = transport.open_session(timeout=self.config.timeout)
        try:
            upstream.settimeout(self.config.timeout)
            chanid = channel.get_id()
            with self.lock:
                pty = self.ptys.get(chanid)
            if pty is not None and kind in ("shell", "exec"):
                term, width, height, pw, ph = pty
                if isinstance(term, bytes):
                    term = term.decode("ascii", errors="replace")
                upstream.get_pty(term, width, height, pw, ph)
            with self.lock:
                self.upstreams[chanid] = upstream
            if kind == "shell":
                shell = getattr(self.config, "shell", "default")
                if shell == "powershell":
                    encoded = base64.b64encode(POWERSHELL_SCRIPT.encode("utf-16le")).decode("ascii")
                    upstream.exec_command("powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand " + encoded)
                elif shell == "cmd":
                    upstream.exec_command("cmd.exe")
                else:
                    upstream.invoke_shell()
                if getattr(self.config, "gmssh_terminal", False):
                    channel.sendall(b"[GMSSH Windows bridge] Native Windows shell; no privilege elevation.\r\n")
            elif kind == "sftp":
                upstream.invoke_subsystem("sftp")
            else:
                upstream.exec_command(payload)
            LOG.info("Native %s channel opened", kind)
            relay(channel, upstream, self.config.timeout)
        finally:
            try:
                upstream.close()
            except (paramiko.SSHException, OSError, EOFError):
                pass
            with self.lock:
                self.upstreams.pop(channel.get_id(), None)

    def handle(self, channel, kind, payload=None):
        try:
            channel.settimeout(self.config.timeout)
            if kind in ("exec", "shell", "sftp"):
                self.forward(channel, kind, payload)
                return
            if kind not in ("metrics", "identity"):
                channel.sendall_stderr(b"Monitoring only: shell, sudo, SFTP and arbitrary commands are unsupported.\n")
                channel.send_exit_status(126)
                return
            mode = "login" if kind == "identity" else payload
            with self.cache_lock:
                cached = self.cache.get(mode)
                ttl = 2 if mode == "fast" else 30
                if cached and time.monotonic() - cached[0] < ttl:
                    payload = cached[1]
                else:
                    payload = collect(self.remote, mode, self.config.timeout)
                    self.cache[mode] = (time.monotonic(), payload)
            if kind == "identity":
                field = b"__GMB_LOGIN_USER__="
                payload = next(line[len(field):] + b"\n" for line in payload.splitlines()
                               if line.startswith(field))
            elif mode == "login" and getattr(self.config, "gmssh_terminal", False):
                payload = gmssh_login_payload(payload)
            channel.sendall(payload)
            channel.send_exit_status(0)
            LOG.info("%s metrics sent (%d bytes)", mode, len(payload))
        except Exception as exc:
            # Avoid logging credentials, caller command text, raw metrics or remote errors.
            LOG.warning("%s request failed (%s)", kind, type(exc).__name__)
            try:
                channel.sendall_stderr(b"Windows SSH request failed.\n")
                channel.send_exit_status(1)
            except (OSError, EOFError):
                pass
        finally:
            try:
                channel.close()
            except (paramiko.SSHException, OSError, EOFError):
                pass
            with self.lock:
                self.requests.pop(channel.get_id(), None)
                self.claimed.discard(channel.get_id())
                self.ptys.pop(channel.get_id(), None)


def serve(client, host_key, config, slots):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    transport.banner_timeout = config.timeout
    transport.handshake_timeout = config.timeout
    transport.auth_timeout = config.timeout
    session = Session(config)
    workers = []
    deadline = time.monotonic() + config.timeout * 2
    try:
        transport.start_server(server=session)
        while transport.is_active():
            if not transport.is_authenticated() and time.monotonic() > deadline:
                break
            channel = transport.accept(0.1)
            if channel is not None:
                with session.lock:
                    session.requests[channel.get_id()] = channel
            with session.lock:
                pending = list(session.pending.values())
                session.pending.clear()
            workers = [worker for worker in workers if worker.is_alive()]
            for channel, kind, payload in pending:
                if not channel.closed:
                    worker = threading.Thread(target=session.handle, args=(channel, kind, payload), daemon=True)
                    workers.append(worker)
                    worker.start()
    except (paramiko.SSHException, OSError, EOFError):
        LOG.info("Client disconnected")
    finally:
        transport.close()
        if session.remote:
            session.remote.close()
        for worker in workers:
            worker.join(1)
        slots.release()


def load_key(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        key = paramiko.RSAKey.generate(3072)
        # Exclusive creation avoids key replacement if another instance starts.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            key.write_private_key(stream)
    return paramiko.RSAKey.from_private_key_file(str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument("--target", required=True, help="Windows SSH host or Tailscale IP")
    parser.add_argument("--username", required=True, help="Existing Windows SSH user")
    parser.add_argument("--target-port", type=int, default=22)
    parser.add_argument("--listen-port", type=int, default=22229)
    parser.add_argument("--known-hosts", type=Path, default=Path.home() / ".ssh/known_hosts")
    parser.add_argument("--host-key", type=Path, default=Path.home() / ".gmssh-windows-bridge/host_key")
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--shell", choices=("default", "cmd", "powershell"), default="default",
                        help="Interactive shell only; leaves Windows OpenSSH DefaultShell unchanged")
    parser.add_argument("--background", action="store_true", help="Start a detached local bridge and return its PID")
    parser.add_argument("--background-log", type=Path,
                        default=Path.home() / ".gmssh-windows-bridge/bridge.log")
    parser.add_argument("--enable-terminal", action="store_true",
                        help="Allow native Windows shell and exec using the authenticated account")
    parser.add_argument("--enable-sftp", action="store_true",
                        help="Allow native Windows SFTP, including file writes allowed by that account")
    parser.add_argument("--gmssh-terminal", action="store_true",
                        help="Adapt GMSSH 2.0.4 Linux preflight/bootstrap to a native Windows terminal; no elevation")
    config = parser.parse_args()
    if config.gmssh_terminal:
        config.enable_terminal = True
    if not (1 <= config.target_port <= 65535 and 1 <= config.listen_port <= 65535 and 3 <= config.timeout <= 120):
        parser.error("ports must be 1..65535 and timeout must be 3..120 seconds")
    if not config.known_hosts.is_file():
        parser.error("known_hosts missing: verify the Windows SSH host key first")
    if config.background:
        from .background import start_background
        try:
            pid, log = start_background(config)
        except (OSError, RuntimeError, TimeoutError) as exc:
            parser.error(str(exc))
        print(f"Background bridge started (PID {pid}); log: {log}", flush=True)
        print(f"Stop with Stop-Process -Id {pid}" if os.name == 'nt' else f"Stop with kill {pid}", flush=True)
        return
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    LOG.setLevel(logging.INFO if config.verbose else logging.WARNING)
    key = load_key(config.host_key)
    slots = threading.BoundedSemaphore(8)
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", config.listen_port))
        listener.listen(8)
        print(f"Monitoring bridge ready: 127.0.0.1:{config.listen_port}", flush=True)
        if config.gmssh_terminal:
            print("GMSSH 2.0.4 Windows terminal enabled; Windows account permissions unchanged.", flush=True)
        try:
            while True:
                client, _ = listener.accept()
                if not slots.acquire(blocking=False):
                    client.close()
                    continue
                threading.Thread(target=serve, args=(client, key, config, slots), daemon=True).start()
        except KeyboardInterrupt:
            print("\nBridge stopped.")
