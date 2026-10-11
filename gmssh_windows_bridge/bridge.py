"""Password-authenticated loopback SSH facade; remote execution is fixed and read-only."""
import argparse
import base64
import logging
import os
from pathlib import Path
import socket
import threading
import time

import paramiko

LOG = logging.getLogger("gmssh_windows_bridge")
SCRIPT = Path(__file__).with_name("collector.ps1").read_text(encoding="utf-8")
MAX_OUTPUT = 1024 * 1024


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


def collect(remote, mode, timeout):
    # The only remotely executed payload is our packaged collector.
    script = "$MetricMode = '" + mode + "'\n" + SCRIPT
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
    expected = b"__GMB_MEM_TOTAL_BYTES__=" if mode == "fast" else b"__GMB_OS_NAME__="
    if expected not in payload:
        raise ValueError("missing metrics; check Windows PowerShell/CIM availability")
    return payload


class Session(paramiko.ServerInterface):
    def __init__(self, config):
        self.config = config
        self.remote = None
        self.requests = []
        self.pending = {}
        self.lock = threading.Lock()
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
        except (paramiko.SSHException, OSError):
            remote.close()
            LOG.warning("Upstream authentication or host verification failed")
            return paramiko.AUTH_FAILED
        if self.remote:
            self.remote.close()
        self.remote = remote
        return paramiko.AUTH_SUCCESSFUL

    def check_channel_request(self, kind, chanid):
        with self.lock:
            self.requests = [c for c in self.requests if not c.closed]
            if kind != "session" or len(self.requests) >= 4:
                return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        return paramiko.OPEN_SUCCEEDED

    def check_channel_exec_request(self, channel, command):
        # Enqueue rather than send before Paramiko's exec-success reply.
        with self.lock:
            self.pending[channel.get_id()] = (channel, metric_mode(command))
        return True

    def handle(self, channel, mode):
        try:
            channel.settimeout(self.config.timeout)
            if mode is None:
                channel.sendall_stderr(b"Monitoring only: shell, sudo, SFTP and arbitrary commands are unsupported.\n")
                channel.send_exit_status(126)
                return
            cached = self.cache.get(mode)
            ttl = 2 if mode == "fast" else 30
            if cached and time.monotonic() - cached[0] < ttl:
                payload = cached[1]
            else:
                payload = collect(self.remote, mode, self.config.timeout)
                self.cache[mode] = (time.monotonic(), payload)
            channel.sendall(payload)
            channel.send_exit_status(0)
            LOG.info("%s metrics sent (%d bytes)", mode, len(payload))
        except Exception as exc:
            # Avoid logging credentials, caller command text, raw metrics or remote errors.
            LOG.warning("Collection failed (%s)", type(exc).__name__)
            try:
                channel.sendall_stderr(b"Windows metrics collection failed.\n")
                channel.send_exit_status(1)
            except (OSError, EOFError):
                pass
        finally:
            channel.close()


def serve(client, host_key, config, slots):
    transport = paramiko.Transport(client)
    transport.add_server_key(host_key)
    transport.banner_timeout = config.timeout
    transport.handshake_timeout = config.timeout
    transport.auth_timeout = config.timeout
    session = Session(config)
    deadline = time.monotonic() + config.timeout * 2
    try:
        transport.start_server(server=session)
        while transport.is_active():
            if not transport.is_authenticated() and time.monotonic() > deadline:
                break
            channel = transport.accept(0.1)
            if channel is not None:
                with session.lock:
                    session.requests.append(channel)
            # Serial execution bounds load and isolates the upstream SSH session.
            with session.lock:
                pending = list(session.pending.values())
                session.pending.clear()
            for channel, mode in pending:
                if not channel.closed:
                    session.handle(channel, mode)
    except (paramiko.SSHException, OSError, EOFError):
        LOG.info("Client disconnected")
    finally:
        transport.close()
        if session.remote:
            session.remote.close()
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
    parser.add_argument("--target", required=True, help="Windows SSH host or Tailscale IP")
    parser.add_argument("--username", required=True, help="Existing Windows SSH user")
    parser.add_argument("--target-port", type=int, default=22)
    parser.add_argument("--listen-port", type=int, default=22229)
    parser.add_argument("--known-hosts", type=Path, default=Path.home() / ".ssh/known_hosts")
    parser.add_argument("--host-key", type=Path, default=Path.home() / ".gmssh-windows-bridge/host_key")
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--verbose", action="store_true")
    config = parser.parse_args()
    if not (1 <= config.target_port <= 65535 and 1 <= config.listen_port <= 65535 and 3 <= config.timeout <= 120):
        parser.error("ports must be 1..65535 and timeout must be 3..120 seconds")
    if not config.known_hosts.is_file():
        parser.error("known_hosts missing: verify the Windows SSH host key first")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    LOG.setLevel(logging.INFO if config.verbose else logging.WARNING)
    key = load_key(config.host_key)
    slots = threading.BoundedSemaphore(8)
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", config.listen_port))
        listener.listen(8)
        print(f"Monitoring bridge ready: 127.0.0.1:{config.listen_port}", flush=True)
        try:
            while True:
                client, _ = listener.accept()
                if not slots.acquire(blocking=False):
                    client.close()
                    continue
                threading.Thread(target=serve, args=(client, key, config, slots), daemon=True).start()
        except KeyboardInterrupt:
            print("\nBridge stopped.")
