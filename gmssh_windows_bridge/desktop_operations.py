"""Bounded Windows file/power requests and paired-device Wake-on-LAN."""

import base64
import errno
import hmac
import ipaddress
import json
import posixpath
import re
import secrets
import socket
import stat
import tempfile
import time
import unicodedata
import zipfile
from pathlib import Path

import paramiko
from . import readonly_tools
from .file_stream import FileStream, StreamError

MAX_CONTROL = 8192
MAX_CHUNK = 65536
MAX_FILE = 512 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_DEPTH = 32
TRANSFER_TIMEOUT = 600
# Windows implies /f for any /t > 0; the browser owns its cancelable countdown.
POWER_COMMANDS = {"restart": "shutdown.exe /r /t 0", "shutdown": "shutdown.exe /s /t 0", "cancel": "shutdown.exe /a"}
DRIVE_SCRIPT = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ConvertTo-Json -InputObject @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Select-Object -ExpandProperty DeviceID) -Compress"
DRIVE_COMMAND = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(DRIVE_SCRIPT.encode("utf-16le")).decode("ascii")
SYSTEM_SCRIPT = Path(__file__).with_name("system-info.ps1").read_text(encoding="utf-8")
SYSTEM_COMMAND = "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + base64.b64encode(SYSTEM_SCRIPT.encode("utf-16le")).decode("ascii")


class SSHPoolUnavailable(ValueError):
    pass


class OperationError(ValueError):
    pass


def connection_health(client, timeout):
    """Measure the authenticated peer's TCP endpoint, never the loopback bridge."""
    result = {"state": "unknown", "latencyMs": None}
    try:
        transport = client.get_transport()
        if transport is None or transport.is_active() is False or transport.is_authenticated() is False:
            return {**result, "state": "disconnected"}
        if transport.is_active() is not True or transport.is_authenticated() is not True:
            return result
        result["state"] = "connected"
        peer = transport.getpeername()
        if not isinstance(peer, tuple) or len(peer) < 2 or type(peer[1]) is not int or not 1 <= peer[1] <= 65535:
            return result
        parsed = ipaddress.ip_address(peer[0])
        if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
            return result
        address = str(parsed)
        started = time.monotonic()
        with socket.create_connection((address, peer[1]), timeout=min(timeout, 2)):
            result["latencyMs"] = round(max(0, time.monotonic() - started) * 1000, 1)
    except (AttributeError, OSError, TypeError, ValueError):
        pass
    return result


def valid_access_token(token):
    return isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token) is not None


def wake_settings(config):
    mac = getattr(config, "wake_mac", None)
    broadcast = getattr(config, "wake_broadcast", None)
    if not mac and not broadcast:
        return None
    if not isinstance(mac, str) or not isinstance(broadcast, str) or type(getattr(config, "wake_port", 9)) is not int or getattr(config, "wake_port", 9) != 9:
        raise OperationError("唤醒配置需要固定网卡 MAC、同网段广播地址和 UDP 9。")
    if re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{12}", mac) is None:
        raise OperationError("唤醒 MAC 必须是 6 字节网卡地址。")
    address = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    if address == bytes(6) or address[0] & 1:
        raise OperationError("唤醒 MAC 不能是全零、广播或组播地址。")
    try:
        ip = ipaddress.IPv4Address(broadcast)
    except ipaddress.AddressValueError:
        raise OperationError("唤醒广播地址必须是私有 IPv4 的同网段广播地址。") from None
    # Static fallback: the operator must supply the connected LAN's broadcast.
    if (not any(ip in ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")) or
            ip.packed[-1] != 255):
        raise OperationError("唤醒广播地址仅支持以 .255 结尾的私有 IPv4；必须与本机实际子网一致。")
    return address, str(ip)


def send_wake(mac, broadcast, timeout):
    packet = b"\xff" * 6 + mac * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        udp.settimeout(min(timeout, 5))
        if udp.sendto(packet, (broadcast, 9)) != len(packet):
            raise OperationError("唤醒请求未完整发送，请重试。")


def validate_name(name):
    if (not isinstance(name, str) or not 1 <= len(name) <= 255 or name in {".", ".."} or
            name.endswith((".", " ")) or any(c in '<>:"/\\|?*' or unicodedata.category(c) in {"Cc", "Cs"} for c in name) or
            re.fullmatch(r"CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]", name.split(".", 1)[0].rstrip(" "), re.IGNORECASE)):
        raise OperationError("文件名无效，请使用普通 Windows 文件名。")
    return name


def normalize_path(path, allow_root=False):
    if allow_root and path in ("", "/"):
        return "/"
    if not isinstance(path, str) or re.match(r"^[A-Za-z]:[/\\]", path) is None:
        raise OperationError("路径无效，请选择本机磁盘中的绝对路径。")
    path = path.replace("\\", "/")
    parts = [part for part in path[3:].split("/") if part]
    for part in parts:
        validate_name(part)
    return path[0].upper() + ":/" + "/".join(parts)


def decode_request(raw):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_CONTROL:
        raise OperationError("操作请求无效或超过大小限制。")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise OperationError("操作请求必须是 JSON 对象。")
    return data


def send_reply(websocket, request_id=None, **fields):
    if request_id is not None:
        fields = {"id": request_id, **fields}
    websocket.send(json.dumps(fields, ensure_ascii=False))


def run_command(client, command, timeout, max_output=MAX_CHUNK, stdin=None):
    """Run only packaged allowlisted commands; discard remote stderr details."""
    if getattr(client, 'controller_protocol', None) == 2:
        output = client.run_command(command, timeout, stdin)
        if len(output) > max_output:
            raise OperationError('返回内容超过大小限制。')
        return output
    deadline = time.monotonic() + timeout
    channel = client.get_transport().open_session(timeout=timeout)
    output = bytearray()
    error_size = 0
    try:
        channel.settimeout(timeout)
        channel.exec_command(command)
        if stdin is not None:
            if not isinstance(stdin, bytes) or len(stdin) > MAX_CHUNK:
                raise OperationError("查询脚本超过限制。")
            channel.sendall(stdin)
            channel.shutdown_write()
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError()
            if channel.recv_ready():
                output.extend(channel.recv(32768))
            if channel.recv_stderr_ready():
                error_size += len(channel.recv_stderr(32768))
            if len(output) > max_output or error_size > MAX_CHUNK:
                raise OperationError("Windows 返回内容超过限制。")
            if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
                if channel.recv_exit_status() != 0:
                    raise OperationError("Windows 未接受请求，请检查账号权限或当前状态。")
                return bytes(output)
            time.sleep(0.02)
    finally:
        channel.close()


class OperationsSession:
    def __init__(self, client, websocket, timeout, pool=None, wake=None, config=None):
        self.client = client
        self.websocket = websocket
        self.timeout = timeout
        self.pool = pool
        self.lease = None
        self.wake = wake
        self.sftp = None
        self.upload = None
        self.config = config
        self.stream = FileStream(self)
        self.stream_request_id = None

    def ssh(self):
        if self.client is None:
            if self.pool is None:
                raise SSHPoolUnavailable()
            self.lease, self.client = self.pool.acquire()
        return self.client

    def files(self):
        if self.sftp is None:
            if getattr(self.ssh(), 'controller_protocol', None) == 2:
                self.sftp = self.client.open_sftp()
                return self.sftp
            channel = self.ssh().get_transport().open_session(timeout=self.timeout)
            try:
                channel.settimeout(self.timeout)
                channel.invoke_subsystem("sftp")
                self.sftp = paramiko.SFTPClient(channel)
            except Exception:
                channel.close()
                raise
        return self.sftp

    def ssh_nowait(self):
        if self.client is None:
            if self.pool is None:
                raise SSHPoolUnavailable()
            self.lease, self.client = self.pool.acquire(timeout=0)
        return self.client

    def exists(self, path):
        try:
            self.files().lstat(path)
            return True
        except OSError as error:
            if error.errno != errno.ENOENT:
                raise
            return False

    def send_download(self, request_id, source, name, size, deadline):
        send_reply(self.websocket, request_id, ok=True, name=name, size=size)
        received = 0
        while received < size:
            if time.monotonic() >= deadline:
                raise OperationError("下载超时，请重试。")
            chunk = source.read(min(MAX_CHUNK, size - received))
            if not chunk:
                raise OperationError("文件在下载过程中发生变化，请重试。")
            self.websocket.send(chunk)
            received += len(chunk)
        if source.read(1):
            raise OperationError("文件在下载过程中发生变化，请重试。")
        send_reply(self.websocket, request_id, ok=True, done=True, bytes=received)

    def download_folder(self, request_id, path):
        if len(path.rstrip('/')) <= 2:
            raise OperationError("请选择普通文件夹，不支持整盘打包。")
        sftp = self.files()
        if not stat.S_ISDIR(sftp.lstat(path).st_mode or 0):
            raise OperationError("请选择普通文件夹，不跟随文件链接。")
        name = validate_name(posixpath.basename(path))
        deadline = time.monotonic() + TRANSFER_TIMEOUT
        entries, total, copied = 0, 0, 0
        pending = [(path, name, 0)]
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as stream:
            with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
                while pending:
                    directory, relative, depth = pending.pop()
                    if depth > MAX_DEPTH:
                        raise OperationError("文件夹层级过深，请分批下载。")
                    entries += 1
                    if entries > MAX_ENTRIES or time.monotonic() >= deadline:
                        raise OperationError("文件夹项目过多或打包超时，请分批下载。")
                    archive.writestr(relative + '/', b'')
                    send_reply(self.websocket, request_id, ok=True, phase='preparing', bytes=copied, entries=entries)
                    for item in sftp.listdir_iter(directory, read_aheads=1):
                        child = validate_name(item.filename)
                        source_path, archive_path = posixpath.join(directory, child), relative + '/' + child
                        mode = item.st_mode or 0
                        if stat.S_ISDIR(mode):
                            pending.append((source_path, archive_path, depth + 1))
                            if len(pending) + entries > MAX_ENTRIES:
                                raise OperationError("文件夹项目过多，请分批下载。")
                            continue
                        entries += 1
                        if not stat.S_ISREG(mode) or type(item.st_size) is not int or item.st_size < 0:
                            raise OperationError("文件夹包含链接或特殊文件，请选择普通文件后分批下载。")
                        total += item.st_size
                        if entries > MAX_ENTRIES or total > MAX_FILE:
                            raise OperationError("文件夹下载暂限 2000 项和 512 MiB，请分批下载。")
                        with sftp.open(source_path, 'rb') as source, archive.open(archive_path, 'w') as target:
                            remaining = item.st_size
                            while remaining:
                                if time.monotonic() >= deadline:
                                    raise OperationError("文件夹打包超时，请分批下载。")
                                chunk = source.read(min(MAX_CHUNK, remaining))
                                if not chunk:
                                    raise OperationError("文件在打包过程中发生变化，请重试。")
                                target.write(chunk); remaining -= len(chunk); copied += len(chunk)
                                send_reply(self.websocket, request_id, ok=True, phase='preparing', bytes=copied, entries=entries)
                            if source.read(1):
                                raise OperationError("文件在打包过程中发生变化，请重试。")
            size = stream.tell()
            if size > MAX_FILE:
                raise OperationError("打包文件超过 512 MiB，请分批下载。")
            stream.seek(0)
            download_name = name.encode('utf-8')[:240].decode('utf-8', 'ignore') + '.zip'
            self.send_download(request_id, stream, download_name, size, deadline)

    def cancel_upload(self):
        upload = self.upload
        if upload is not None:
            try:
                if upload["file"] is not None:
                    upload["file"].close()
            finally:
                upload["file"] = None
                # Only this connection's successfully created exclusive temporary file.
                try:
                    self.sftp.remove(upload["temporary"])
                except OSError as error:
                    if error.errno != errno.ENOENT:
                        raise
                self.upload = None

    def close(self):
        try:
            try:self.stream.close()
            finally:self.cancel_upload()
        finally:
            try:
                if self.sftp is not None:
                    self.sftp.close()
            finally:
                lease, self.lease = self.lease, None
                if lease is not None:
                    lease.close()

    def receive_chunk(self, data):
        if self.stream.pending is not None:
            result=self.stream.write(data)
            send_reply(self.websocket,self.stream_request_id,ok=True,result=result)
            return
        upload = self.upload
        if upload is None or not 1 <= len(data) <= MAX_CHUNK:
            raise OperationError("没有待接收的上传，或文件块超过 64 KiB。")
        if time.monotonic() >= upload["deadline"] or upload["bytes"] + len(data) > upload["size"]:
            raise OperationError("上传超时或文件大小与声明不符。")
        upload["file"].write(data)
        upload["bytes"] += len(data)
        send_reply(self.websocket, upload["id"], ok=True, bytes=upload["bytes"])

    def request(self, data):
        request_id = data.get("id")
        if type(request_id) is not int or not 1 <= request_id <= 2 ** 53 - 1:
            raise OperationError("操作 id 必须是正整数。")
        op = data.get("op")
        fields = {"list": {"id", "op", "path"}, "download": {"id", "op", "path"},
                  "download-folder": {"id", "op", "path"}, "mkdir": {"id", "op", "path"},
                  "upload-start": {"id", "op", "path", "name", "size"}, "upload-finish": {"id", "op"},
                  "upload-cancel": {"id", "op"}, "power": {"id", "op", "action"}, "wake": {"id", "op"},
                  "system-info": {"id", "op"}, "readonly": {"id", "op", "tool", "options"},
                  "diagnostics": {"id", "op"}, "transfer": {"id", "op", "action", "options"}}
        if not isinstance(op, str) or op not in fields or set(data) != fields[op]:
            raise OperationError("操作类型或请求字段无效。")
        if self.upload is not None and (op not in {"upload-finish", "upload-cancel"} or request_id != self.upload["id"]):
            raise OperationError("请先使用当前上传 id 完成或取消传输。")
        if self.stream.mode and op!='transfer':raise OperationError("请先完成当前文件传输。")
        if op == "transfer":
            progress=lambda **value:send_reply(self.websocket,request_id,ok=True,progress=value)
            result=self.stream.request(data['action'],data['options'],progress)
            self.stream_request_id=request_id
            payload=None
            if isinstance(result,tuple):result,payload=result
            send_reply(self.websocket,request_id,ok=True,result=result)
            if payload is not None:self.websocket.send(payload)
        elif op == "readonly":
            readonly_tools.options_for(data["tool"], data["options"])
            result = readonly_tools.query(self.ssh_nowait(), data["tool"], data["options"], self.timeout, run_command)
            send_reply(self.websocket, request_id, ok=True, result=result)
        elif op == "diagnostics":
            result = readonly_tools.diagnostics(self, self.config, run_command, SYSTEM_COMMAND)
            send_reply(self.websocket, request_id, ok=True, result=result)
        elif op == "system-info":
            info = json.loads(run_command(self.ssh(), SYSTEM_COMMAND, self.timeout).decode("utf-8-sig"))
            if not isinstance(info, dict) or set(info) != {"computer", "os", "version", "cpu", "cores", "memory", "uptime", "processes", "disks", "network"}:
                raise OperationError("设备信息格式无效。")
            info["connection"] = connection_health(self.client, self.timeout)
            send_reply(self.websocket, request_id, ok=True, info=info)
        elif op == "list":
            path = normalize_path(data["path"], allow_root=True)
            if path != '/' and getattr(self.ssh(), 'controller_protocol', None) == 2:
                listing = self.files().listing(path)
                send_reply(self.websocket, request_id, ok=True, **listing)
                return
            if path == "/":
                drives = json.loads(run_command(self.ssh(), DRIVE_COMMAND, self.timeout).decode("utf-8-sig"))
                if not isinstance(drives, list) or any(not isinstance(d, str) or re.fullmatch(r"[A-Za-z]:", d) is None for d in drives):
                    raise OperationError("Windows 磁盘列表无效。")
                entries = [{"name": d.upper(), "directory": True, "size": 0, "modified": 0} for d in drives]
            else:
                items = self.files().listdir_attr(path)
                entries = [{"name": item.filename, "directory": stat.S_ISDIR(item.st_mode or 0),
                            "size": item.st_size or 0, "modified": item.st_mtime or 0} for item in items[:MAX_ENTRIES]]
            truncated = len(entries) > MAX_ENTRIES if path == "/" else len(items) > MAX_ENTRIES
            send_reply(self.websocket, request_id, ok=True, path=path, entries=entries[:MAX_ENTRIES], truncated=truncated)
        elif op == "download":
            path = normalize_path(data["path"])
            info = self.files().stat(path)
            if not stat.S_ISREG(info.st_mode or 0) or type(info.st_size) is not int or not 0 <= info.st_size <= MAX_FILE:
                raise OperationError("请选择不超过 512 MiB 的普通文件。")
            deadline = time.monotonic() + TRANSFER_TIMEOUT
            with self.sftp.open(path, "rb") as source:
                self.send_download(request_id, source, posixpath.basename(path), info.st_size, deadline)
        elif op == "download-folder":
            self.download_folder(request_id, normalize_path(data["path"]))
        elif op == "mkdir":
            path = normalize_path(data["path"])
            if self.exists(path):
                if not stat.S_ISDIR(self.files().lstat(path).st_mode or 0):
                    raise OperationError("同名项目不是普通文件夹，未覆盖。")
                created = False
            else:
                self.files().mkdir(path); created = True
            send_reply(self.websocket, request_id, ok=True, path=path, created=created)
        elif op == "upload-start":
            directory = normalize_path(data["path"])
            name = validate_name(data["name"])
            size = data["size"]
            if type(size) is not int or not 0 <= size <= MAX_FILE:
                raise OperationError("上传文件不得超过 512 MiB。")
            sftp = self.files()
            if not stat.S_ISDIR(sftp.stat(directory).st_mode or 0):
                raise OperationError("上传目标必须是文件夹。")
            target = posixpath.join(directory, name)
            if self.exists(target):
                raise OperationError("同名文件已经存在，上传不会覆盖。")
            temporary = posixpath.join(directory, ".gmssh-upload-" + secrets.token_hex(12) + ".part")
            remote_file = sftp.open(temporary, "wx", bufsize=0)
            self.upload = {"id": request_id, "file": remote_file, "temporary": temporary, "target": target,
                           "size": size, "bytes": 0, "deadline": time.monotonic() + TRANSFER_TIMEOUT}
            send_reply(self.websocket, request_id, ok=True, ready=True)
        elif op == "upload-finish":
            upload = self.upload
            if upload is None or upload["bytes"] != upload["size"] or time.monotonic() >= upload["deadline"]:
                raise OperationError("上传未完整接收或已超时。")
            upload["file"].close()
            upload["file"] = None
            if self.exists(upload["target"]):
                raise OperationError("同名文件已经存在，上传不会覆盖。")
            # SFTP's standard rename requires the target to be absent; never posix_rename.
            self.sftp.rename(upload["temporary"], upload["target"])
            self.upload = None
            send_reply(self.websocket, request_id, ok=True, done=True, bytes=upload["bytes"])
        elif op == "upload-cancel":
            self.cancel_upload()
            send_reply(self.websocket, request_id, ok=True, canceled=True)
        elif op == "power":
            action = data["action"]
            if not isinstance(action, str) or action not in POWER_COMMANDS:
                raise OperationError("电源操作只支持 restart、shutdown 或 cancel。")
            run_command(self.ssh(), POWER_COMMANDS[action], self.timeout)
            send_reply(self.websocket, request_id, ok=True, action=action, requested=True, delay=0,
                       message="已请求取消待执行的关机或重启。" if action == "cancel" else "已提交电源请求；未保存的应用可能阻止操作，Windows 是否完成仍需核实。")
        elif op == "wake":
            if self.wake is None:
                raise OperationError("这台设备尚未配置同网段 Wake-on-LAN。")
            send_wake(*self.wake, self.timeout)
            send_reply(self.websocket, request_id, ok=True, sent=True, message="唤醒请求已发送，等待设备上线。")


def handle_operations(config, websocket, slots):
    if not slots.acquire(blocking=False):
        send_reply(websocket, type="error", message="操作连接数量已达上限。", code="OperationsUnavailable")
        websocket.close(1008)
        return
    session = None
    try:
        credentials = decode_request(websocket.recv(timeout=config.timeout))
        expected = getattr(config, "access_token", "")
        token = credentials.get("token")
        if (set(credentials) != {"token"} or not valid_access_token(expected) or not isinstance(token, str) or
                len(token) > 128 or not hmac.compare_digest(token.encode("utf-8"), expected.encode("ascii"))):
            send_reply(websocket, type="error", message="本机操作授权已失效，请重新从启动器打开。", code="DesktopAccessError")
            return
        session = OperationsSession(None, websocket, config.timeout, pool=getattr(config, "monitor_pool", None), wake=wake_settings(config), config=config)
        send_reply(websocket, type="operations_ready")
        while True:
            raw = websocket.recv(timeout=60 if session.upload is not None else 300)
            request_id = session.stream_request_id if session.stream.pending is not None else session.upload["id"] if session.upload is not None else None
            try:
                if isinstance(raw, bytes):
                    session.receive_chunk(raw)
                else:
                    data = decode_request(raw)
                    candidate_id = data.get("id")
                    request_id = candidate_id if type(candidate_id) is int and 1 <= candidate_id <= 2 ** 53 - 1 else None
                    session.request(data)
            except Exception as error:
                try:
                    session.cancel_upload()
                except Exception:
                    pass
                if isinstance(error, StreamError):
                    send_reply(websocket,request_id,ok=False,code=error.code,message="文件传输校验未通过。")
                elif isinstance(error,OSError) and error.errno in {errno.EACCES,errno.EPERM,errno.ENOSPC}:
                    send_reply(websocket,request_id,ok=False,code="DISK_FULL" if error.errno==errno.ENOSPC else "ACCESS_DENIED",message="文件权限或存储空间不足。")
                elif isinstance(error, SSHPoolUnavailable):
                    send_reply(websocket, request_id, ok=False, message="请先在 GMSSH 连接这台机器的监控，再打开工具。", code="SSHPoolUnavailable")
                else:
                    message = str(error) if isinstance(error, (OperationError, readonly_tools.ReadonlyInputError)) else "Windows 请求失败，请检查权限和连接。"
                    send_reply(websocket, request_id, ok=False, message=message, code="INVALID_QUERY" if isinstance(error, readonly_tools.ReadonlyInputError) else "QUERY_FAILED")
    except Exception:
        try:
            send_reply(websocket, type="error", message="操作通道请求无效、超时或连接已关闭。", code="OperationsUnavailable")
        except Exception:
            pass
    finally:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass
        try:
            websocket.close()
        finally:
            slots.release()
