"""Experimental local RustDesk viewer transport, protected by verified SSH."""

import argparse
import json
import logging
import mimetypes
import socket
import threading
from http import HTTPStatus
from pathlib import Path
from urllib.parse import unquote, urlsplit

import paramiko

MAX_FRAME = 16 * 1024 * 1024
MAX_INPUT = 16 * 1024
ASSETS = Path(__file__).with_name("desktop_web")


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


def forward(websocket, channel):
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
                        "SSH 已验证，但 RustDesk 未返回握手。请检查 Windows 上的 RustDesk、直接 IP 访问和端口。"}, ensure_ascii=False))
                except Exception:
                    pass
        finally:
            stopped.set()
            websocket.close()

    reader = threading.Thread(target=receive, daemon=True)
    reader.start()
    try:
        for message in websocket:
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
        if not isinstance(credentials, dict) or set(credentials) != {"password"}:
            raise ValueError("invalid credentials envelope")
        password = credentials["password"]
        if not isinstance(password, str) or not 1 <= len(password.encode("utf-8")) <= 4096:
            raise ValueError("invalid password")
        client = connect_target(config, password)
        del password, credentials, raw
        channel = client.get_transport().open_channel(
            "direct-tcpip", ("127.0.0.1", config.rustdesk_port), ("127.0.0.1", 0),
            timeout=config.timeout)
        # A channel-open acknowledgement isn't proof that RustDesk is listening.
        websocket.send(json.dumps({"type": "ssh_ready"}))
        forward(websocket, channel)
    except Exception as error:
        if isinstance(error, paramiko.AuthenticationException):
            message = "Windows SSH 密码验证失败。"
        elif isinstance(error, (paramiko.BadHostKeyException, paramiko.SSHException)) and not isinstance(error, paramiko.ChannelException):
            message = "SSH 连接或主机密钥核验失败，请检查可信 known_hosts。"
        elif isinstance(error, paramiko.ChannelException):
            message = "无法经 SSH 连接 Windows 本机 RustDesk。请确认直接 IP 访问已启用、端口正确且 SSH 允许转发。"
        elif isinstance(error, (ValueError, UnicodeError)):
            message = "本地登录请求无效。"
        else:
            message = "桌面传输连接失败或已关闭。"
        try:
            websocket.send(json.dumps({"type": "error", "message": message}, ensure_ascii=False))
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

    listener = socket.create_server(("127.0.0.1", config.listen_port))
    port = listener.getsockname()[1]
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    origins = [f"http://{host}" for host in hosts]
    slots = threading.BoundedSemaphore(2)
    logger = logging.Logger("gmssh-windows-desktop", level=logging.CRITICAL)
    logger.addHandler(logging.NullHandler())

    def request(connection, request):
        try:
            if request.headers.get("Host") not in hosts:
                return connection.respond(HTTPStatus.FORBIDDEN, "Local host required\n")
            url = urlsplit(request.path)
            if url.path == "/socket" and not url.query:
                return None
            if url.path == "/config.json":
                body = json.dumps({"target": config.target, "username": config.username,
                                   "target_port": config.target_port}).encode()
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
                "default-src 'none'; script-src 'self'; style-src 'self'; "
                "connect-src 'self' " + " ".join(origin.replace("http:", "ws:") for origin in origins) + "; "
                "base-uri 'none'; form-action 'none'; object-src 'none'; "
                "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* file:")
            return response
        except (KeyError, ValueError, OSError):
            return connection.respond(HTTPStatus.BAD_REQUEST, "Invalid request\n")

    try:
        return serve(lambda websocket: handle_connection(config, websocket, slots), sock=listener,
                     origins=origins, process_request=request, logger=logger, server_header=None,
                     compression=None, max_size=MAX_INPUT, max_queue=4, close_timeout=2,
                     open_timeout=config.timeout)
    except Exception:
        listener.close()
        raise


def main():
    parser = argparse.ArgumentParser(description="Experimental free RustDesk viewer over verified SSH")
    parser.add_argument("--target", required=True)
    parser.add_argument("--username", required=True)
    parser.add_argument("--target-port", type=int, default=22)
    parser.add_argument("--known-hosts", type=Path, default=Path.home() / ".ssh" / "known_hosts")
    parser.add_argument("--rustdesk-port", type=int, default=21118)
    parser.add_argument("--listen-port", type=int, default=22240)
    parser.add_argument("--timeout", type=float, default=15)
    config = parser.parse_args()
    config.known_hosts = config.known_hosts.expanduser().resolve()
    if not config.known_hosts.is_file():
        parser.error("known_hosts must contain the previously verified Windows host key")
    if not all(1 <= port <= 65535 for port in (config.target_port, config.rustdesk_port, config.listen_port)) or not 1 <= config.timeout <= 60:
        parser.error("invalid port or timeout")
    if not (ASSETS / "index.html").is_file():
        parser.error("build desktop-web first; frontend assets are unavailable")
    try:
        with create_server(config) as server:
            print(f"RustDesk desktop preview: http://127.0.0.1:{config.listen_port}/", flush=True)
            server.serve_forever()
    except ImportError:
        parser.error("install optional desktop support with: pip install '.[desktop]'")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
