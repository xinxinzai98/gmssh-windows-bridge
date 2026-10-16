"""Experimental local RustDesk viewer transport, protected by verified SSH."""

import argparse
import ipaddress
import hmac
import json
import logging
import mimetypes
import os
import secrets
import socket
import shutil
import subprocess
import sys
import threading
from contextlib import ExitStack
from http import HTTPStatus
from pathlib import Path
from urllib.parse import unquote, urlsplit

import paramiko

from .desktop_operations import MAX_CHUNK, SSHPoolUnavailable, handle_operations, valid_access_token, wake_settings
from .readonly_tools import now

MAX_FRAME = 16 * 1024 * 1024
MAX_INPUT = 16 * 1024
ASSETS = Path(__file__).with_name("desktop_web")


class TailnetError(ValueError):
    pass


class DesktopAccessError(ValueError):
    pass


# Keep the old desktop-only exception name for existing callers.
MonitorUnavailable = SSHPoolUnavailable


class MonitorDesktopPool:
    """Share authenticated monitoring transports, never their account passwords."""
    def __init__(self, rustdesk_port, timeout):
        self.port = rustdesk_port
        self.timeout = timeout
        self.changed = threading.Condition()
        self.clients = {}
        self.last_result = {}

    def attach(self, client):
        with self.changed:
            self.clients[client] = {"monitor": True, "leases": 0}
            self.last_result = {"code": "SSH_AUTHENTICATED", "sampledAt": now()}
            self.changed.notify_all()

    def record_failure(self, code):
        with self.changed:
            self.last_result = {"code": code if code in {"BadHostKeyException", "AuthenticationException", "TimeoutError", "NoValidConnectionsError"} else "SSH_UNAVAILABLE", "sampledAt": now()}

    def snapshot(self):
        with self.changed:
            borrowable = any(entry["monitor"] and client.get_transport() and client.get_transport().is_active() and client.get_transport().is_authenticated() for client, entry in self.clients.items())
            return {**self.last_result, "borrowable": bool(borrowable)}

    def detach(self, client):
        with self.changed:
            entry = self.clients.get(client)
            if entry is None:
                return
            entry["monitor"] = False
            close = entry["leases"] == 0
            if close:
                del self.clients[client]
        if close:
            client.close()

    def release(self, client):
        with self.changed:
            entry = self.clients[client]
            entry["leases"] -= 1
            close = not entry["monitor"] and entry["leases"] == 0
            if close:
                del self.clients[client]
        if close:
            client.close()

    def acquire(self, timeout=None):
        def ready():
            for client, entry in reversed(self.clients.items()):
                transport = client.get_transport()
                if entry["monitor"] and transport and transport.is_active() and transport.is_authenticated():
                    return client
            return None
        with self.changed:
            client = self.changed.wait_for(ready, timeout=self.timeout if timeout is None else timeout)
            if client is None:
                raise SSHPoolUnavailable("Connect this machine's monitoring session first")
            self.clients[client]["leases"] += 1
        lease = ExitStack()
        lease.callback(self.release, client)
        return lease, client

    def connect(self):
        lease, client = self.acquire()
        try:
            channel = client.get_transport().open_channel(
                "direct-tcpip", ("127.0.0.1", self.port), ("127.0.0.1", 0), timeout=self.timeout)
            return lease, channel
        except Exception:
            lease.close()
            raise


def tailnet_channel(config):
    """Bind direct access to a named, online peer in the running local tailnet."""
    if ipaddress.ip_address(config.target) not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("direct mode requires a Tailscale IPv4 address")
    try:
        result = subprocess.run([str(config.tailscale_cli), "status", "--json"],
                                capture_output=True, timeout=config.timeout, check=True,
                                env={**os.environ, "TAILSCALE_BE_CLI": "1"})
        state = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise TailnetError("本机 Tailscale 未返回有效状态，请检查客户端的配置访问。") from None
    except (OSError, subprocess.SubprocessError):
        raise TailnetError("无法调用本机 Tailscale，请确认客户端正在运行。") from None
    peers = [p for p in state.get("Peer", {}).values()
             if config.target in p.get("TailscaleIPs", [])]
    if state.get("BackendState") != "Running":
        raise TailnetError("本机 Tailscale 尚未连接。")
    if len(peers) != 1 or peers[0].get("HostName", "").casefold() != config.tailscale_name.casefold():
        raise TailnetError("Tailscale 目标地址与已配置的设备名称不符。")
    if not peers[0].get("Online"):
        raise TailnetError("目标 Windows 设备当前在 Tailscale 中离线。")
    return socket.create_connection((config.target, config.rustdesk_port), timeout=config.timeout)


def frame_header(size):
    if not 0 <= size <= MAX_FRAME:
        raise ValueError("RustDesk frame exceeds limit")
    width = 1 if size <= 0x3f else 2 if size <= 0x3fff else 3 if size <= 0x3fffff else 4
    return ((size << 2) | (width - 1)).to_bytes(width, "little")


def read_frame(channel, stopped):
    def exact(size):
        data = bytearray()
        while len(data) < size:
            if stopped.is_set():
                raise EOFError
            try:
                part = channel.recv(size - len(data))
            except socket.timeout:
                continue
            if not part:
                raise EOFError
            data.extend(part)
        return bytes(data)

    first = exact(1)
    width = (first[0] & 3) + 1
    size = int.from_bytes(first + exact(width - 1), "little") >> 2
    if size > MAX_FRAME:
        raise ValueError("RustDesk frame exceeds limit")
    return exact(size)


def connect_target(config, password):
    client = paramiko.SSHClient()  # RejectPolicy is the default.
    try:
        client.load_host_keys(str(config.known_hosts))
        client.connect(config.target, port=config.target_port, username=config.username,
                       password=password, allow_agent=False, look_for_keys=False,
                       timeout=config.timeout, auth_timeout=config.timeout,
                       banner_timeout=config.timeout)
        return client
    except Exception:
        client.close()
        raise


def forward(websocket, channel, remember=None):
    stopped = threading.Event()
    channel.settimeout(1)

    def receive():
        received = False
        try:
            while not stopped.is_set():
                websocket.send(read_frame(channel, stopped))
                received = True
        except Exception:
            if not received and not stopped.is_set():
                try:
                    websocket.send(json.dumps({"type": "error", "message":
                        "传输已连接，但 RustDesk 未返回握手。请检查 Windows 上的 RustDesk、直接 IP 访问和端口。"}, ensure_ascii=False))
                except Exception:
                    pass
        finally:
            stopped.set()
            websocket.close()

    reader = threading.Thread(target=receive, daemon=True)
    reader.start()
    try:
        for message in websocket:
            if isinstance(message, str) and remember is not None:
                try:
                    if len(message.encode("utf-8")) > 8192:
                        raise ValueError()
                    data = json.loads(message)
                    if (not isinstance(data, dict) or set(data) != {"remember"} or
                            not isinstance(data["remember"], str) or not 1 <= len(data["remember"].encode("utf-8")) <= 4096):
                        raise ValueError()
                    remember(data["remember"])
                    websocket.send(json.dumps({"type": "credential_saved"}))
                except Exception:
                    websocket.send(json.dumps({"type": "credential_error"}))
                continue
            if not isinstance(message, bytes) or len(message) > MAX_INPUT:
                websocket.close(1008, "binary control frame required")
                break
            channel.sendall(frame_header(len(message)) + message)
    finally:
        stopped.set()
        channel.close()
        websocket.close()
        reader.join(timeout=3)


def handle_connection(config, websocket, slots):
    if not slots.acquire(blocking=False):
        websocket.send(json.dumps({"type": "error", "message": "桌面连接数量已达上限。"}))
        websocket.close(1008)
        return
    client = None
    channel = None
    try:
        raw = websocket.recv(timeout=config.timeout)
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > 8192:
            raise ValueError("invalid credentials envelope")
        credentials = json.loads(raw)
        keychain = getattr(config, "keychain_store", None)
        if (not isinstance(credentials, dict) or "password" not in credentials or
                not set(credentials) <= {"password", "saved", "token"} or
                ("saved" in credentials and (keychain is None or credentials["saved"] is not True))):
            raise ValueError("invalid credentials envelope")
        if getattr(config, "access_token", ""):
            token = credentials.get("token")
            if (not isinstance(token, str) or len(token) > 128 or
                    not hmac.compare_digest(token.encode("utf-8"), config.access_token.encode("ascii"))):
                raise DesktopAccessError("local desktop authorization required")
        password = credentials["password"]
        direct = getattr(config, "direct_tailscale", False)
        shared = getattr(config, "monitor_channel", None)
        if not isinstance(password, str) or not (0 if direct or shared else 1) <= len(password.encode("utf-8")) <= 4096:
            raise ValueError("invalid password")
        if shared:
            client, channel = shared()
        elif direct:
            channel = tailnet_channel(config)
        else:
            client = connect_target(config, password)
            channel = client.get_transport().open_channel(
                "direct-tcpip", ("127.0.0.1", config.rustdesk_port), ("127.0.0.1", 0),
                timeout=config.timeout)
        if credentials.get("saved"):
            try:
                saved = keychain.get()
                if saved:
                    websocket.send(json.dumps({"type": "desktop_credential", "password": saved}))
                del saved
            except Exception:
                websocket.send(json.dumps({"type": "credential_error"}))
        del password, credentials, raw
        # A channel-open acknowledgement isn't proof that RustDesk is listening.
        websocket.send(json.dumps({"type": "tailscale_ready" if direct else "ssh_ready"}))
        forward(websocket, channel, keychain.save if keychain is not None else None)
    except Exception as error:
        if isinstance(error, DesktopAccessError):
            message = "本机桌面授权已失效，请重新从启动器打开。"
        elif isinstance(error, MonitorUnavailable):
            message = "请先在 GMSSH 连接这台机器的监控，再点击蓝色桌面图标。"
        elif isinstance(error, TailnetError):
            message = str(error)
        elif isinstance(error, paramiko.AuthenticationException):
            message = "Windows SSH 密码验证失败。"
        elif isinstance(error, (paramiko.BadHostKeyException, paramiko.SSHException)) and not isinstance(error, paramiko.ChannelException):
            message = "SSH 连接或主机密钥核验失败，请检查可信 known_hosts。"
        elif isinstance(error, paramiko.ChannelException):
            message = "无法经 SSH 连接 Windows 本机 RustDesk。请确认直接 IP 访问已启用、端口正确且 SSH 允许转发。"
        elif isinstance(error, (ValueError, UnicodeError)):
            message = "本地登录请求无效，或目标设备身份未通过核对。"
        else:
            message = "桌面传输连接失败或已关闭。"
        try:
            websocket.send(json.dumps({"type": "error", "message": message, "code": type(error).__name__}, ensure_ascii=False))
        except Exception:
            pass
    finally:
        if channel:
            channel.close()
        if client:
            client.close()
        slots.release()


def create_server(config):
    # Optional dependency: importing this module must not alter normal bridge use.
    from websockets.sync.server import serve

    wake = wake_settings(config)
    if (wake is not None or getattr(config, "keychain_store", None) is not None or getattr(config, "monitor_channel", None) or
            getattr(config, "monitor_pool", None) is not None) and not valid_access_token(getattr(config, "access_token", "")):
        raise ValueError("Saved credentials, shared monitoring and Wake-on-LAN require a private desktop session token")

    listener = socket.create_server(("127.0.0.1", config.listen_port))
    port = listener.getsockname()[1]
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origins = [f"http://{host}" for host in hosts]
    slots = threading.BoundedSemaphore(2)
    operation_slots = threading.BoundedSemaphore(2)
    logger = logging.Logger("gmssh-windows-desktop", level=logging.CRITICAL)
    logger.addHandler(logging.NullHandler())

    def request(connection, request):
        try:
            if request.headers.get("Host") not in hosts:
                return connection.respond(HTTPStatus.FORBIDDEN, "Local host required\n")
            url = urlsplit(request.path)
            if url.path in {"/socket", "/operations"} and not url.query:
                return None
            if url.path == "/config.json":
                keychain = getattr(config, "keychain_store", None)
                saved = False
                if keychain is not None:
                    try:
                        saved = bool(keychain.exists())
                    except OSError:
                        pass  # Manual login remains available if Keychain is locked.
                operations = getattr(config, "monitor_pool", None) is not None and valid_access_token(getattr(config, "access_token", ""))
                body = json.dumps({"target": config.target, "username": config.username,
                                   "target_port": config.target_port,
                                   "transport": "monitor" if getattr(config, "monitor_channel", None) else
                                                "tailscale" if getattr(config, "direct_tailscale", False) else "ssh",
                                   "keychain": keychain is not None, "has_saved_password": saved,
                                   "requires_token": bool(getattr(config, "access_token", "")),
                                   "capabilities": {"files": operations, "power": operations,
                                                    "wake": wake is not None and valid_access_token(getattr(config, "access_token", ""))}}).encode()
                content_type = "application/json; charset=utf-8"
            else:
                path = (ASSETS / (unquote(url.path).lstrip("/") or "index.html")).resolve()
                if not path.is_relative_to(ASSETS.resolve()) or not path.is_file():
                    return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
                body = path.read_bytes()
                content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            response = connection.respond(HTTPStatus.OK, "")
            response.body = body
            del response.headers["Content-Type"]
            del response.headers["Content-Length"]
            response.headers["Content-Type"] = content_type
            response.headers["Content-Length"] = str(len(body))
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
                "connect-src 'self' " + " ".join(origin.replace("http:", "ws:") for origin in origins) + "; "
                "base-uri 'none'; form-action 'none'; object-src 'none'; "
                "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* file:")
            return response
        except (KeyError, ValueError, OSError):
            return connection.respond(HTTPStatus.BAD_REQUEST, "Invalid request\n")

    try:
        return serve(lambda websocket: handle_operations(config, websocket, operation_slots)
                     if urlsplit(websocket.request.path).path == "/operations" else handle_connection(config, websocket, slots), sock=listener,
                     origins=origins, process_request=request, logger=logger, server_header=None,
                     compression=None, max_size=MAX_CHUNK, max_queue=4, close_timeout=2,
                     open_timeout=config.timeout)
    except Exception:
        listener.close()
        raise


def main():
    parser = argparse.ArgumentParser(description="Experimental free RustDesk viewer over verified SSH or Tailscale")
    parser.add_argument("--target", required=True)
    parser.add_argument("--username", default="")
    parser.add_argument("--target-port", type=int, default=22)
    parser.add_argument("--known-hosts", type=Path, default=Path.home() / ".ssh" / "known_hosts")
    parser.add_argument("--rustdesk-port", type=int, default=21118)
    parser.add_argument("--listen-port", type=int, default=22240)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--direct-tailscale", action="store_true", help="Use an existing encrypted tailnet instead of SSH")
    parser.add_argument("--tailscale-name", help="Exact Windows peer hostname; required in direct Tailscale mode")
    parser.add_argument("--tailscale-cli", type=Path, default=shutil.which("tailscale") or "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
    parser.add_argument("--keychain", action="store_true", help="Offer explicit opt-in RustDesk password storage in macOS Keychain")
    parser.add_argument("--wake-mac", help="Paired Windows NIC MAC; requires Wake-on-LAN to be enabled on that device")
    parser.add_argument("--wake-broadcast", help="Connected LAN broadcast IPv4; private address ending in .255, fixed UDP 9")
    config = parser.parse_args()
    try:
        wake = wake_settings(config)
    except ValueError as error:
        parser.error(str(error))
    config.known_hosts = config.known_hosts.expanduser().resolve()
    if config.direct_tailscale:
        try:
            tailnet_ip = ipaddress.ip_address(config.target)
            if tailnet_ip not in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError()
        except ValueError:
            parser.error("direct Tailscale mode requires a literal 100.64.0.0/10 IPv4 address")
        if not config.tailscale_name or not config.tailscale_cli.is_file():
            parser.error("direct Tailscale mode requires --tailscale-name and an installed Tailscale CLI")
    elif (config.username or wake is None) and (not config.username or not config.known_hosts.is_file()):
        parser.error("known_hosts must contain the previously verified Windows host key")
    if not all(1 <= port <= 65535 for port in (config.target_port, config.rustdesk_port, config.listen_port)) or not 1 <= config.timeout <= 60:
        parser.error("invalid port or timeout")
    if not (ASSETS / "index.html").is_file():
        parser.error("build desktop-web first; frontend assets are unavailable")
    config.keychain_store = None
    config.access_token = ""
    if config.keychain:
        if sys.platform != "darwin" or not config.direct_tailscale:
            parser.error("Keychain preview requires macOS and direct Tailscale mode")
        from .keychain import DesktopKeychain
        config.keychain_store = DesktopKeychain(f"tailscale:{config.tailscale_name.casefold()}@{config.target}:{config.rustdesk_port}")
        config.access_token = secrets.token_urlsafe(32)
    if wake is not None and not config.access_token:
        config.access_token = secrets.token_urlsafe(32)
    try:
        with create_server(config) as server:
            suffix = "#token=" + config.access_token if config.access_token else ""
            print(f"RustDesk desktop preview: http://127.0.0.1:{config.listen_port}/{suffix}", flush=True)
            server.serve_forever()
    except ImportError:
        parser.error("install optional desktop support with: pip install '.[desktop]'")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
