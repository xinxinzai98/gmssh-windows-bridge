"""Validate public Windows connection exports and check SSH identity, without login."""
import base64
import argparse
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import mimetypes

import paramiko

from .address import normalize_address, parse_endpoint, ssh_endpoint

MAX_EXPORT = 65536


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("连接文件包含重复字段。")
        result[key] = value
    return result


def _address(value):
    return normalize_address(value)


def inspect_connection(text):
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_EXPORT:
        raise ValueError("连接文件过大或格式无效。")
    def invalid_constant(_):
        raise ValueError("连接文件包含无效数值。")
    try:
        data = json.loads(text.lstrip("\ufeff"), object_pairs_hook=_object, parse_constant=invalid_constant)
    except json.JSONDecodeError:
        raise ValueError("请选择 Windows 安装器生成的 GMSSH-connection.json。") from None
    if not isinstance(data, dict) or type(data.get("schema")) is not int or data["schema"] != 1:
        raise ValueError("不支持此连接文件版本。")
    if any(re.search(r"password|passphrase|private.?key|authvalue|token", key, re.I) for key in data):
        raise ValueError("连接文件只应包含公开信息，请移除密码或私钥后重新导出。")
    computer, username = data.get("computer"), data.get("username")
    if not isinstance(computer, str) or not re.fullmatch(r"[\w .-]{1,63}", computer):
        raise ValueError("连接文件中的电脑名称无效。")
    if not isinstance(username, str) or not re.fullmatch(r"[\w .@\\-]{1,64}", username):
        raise ValueError("连接文件中的 SSH 账号无效。")
    port = data.get("sshPort")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("连接文件中的 SSH 端口无效。")
    desktop_auth = data.get('desktopAuth', 'manual')
    if desktop_auth not in ('manual', 'shared-ssh') and not (desktop_auth == 'controller' and isinstance(data.get('authorization'), dict)):
        raise ValueError('桌面认证方式无效，请从 Windows 托盘重新导出连接文件。')
    values = data.get("addresses")
    if not isinstance(values, list) or not 1 <= len(values) <= 32 or not all(isinstance(value, str) for value in values):
        raise ValueError("连接文件没有可用的网络地址。")
    try:
        addresses = list(dict.fromkeys(_address(value) for value in values))
    except (ValueError, ipaddress.AddressValueError):
        raise ValueError("连接文件包含无效的 IPv4 或 IPv6 地址。") from None
    public = data.get("sshHostPublicKey")
    if not isinstance(public, str) or not re.fullmatch(r"ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]{0,200})?", public):
        raise ValueError("连接文件缺少有效的 Ed25519 SSH 主机公钥。")
    try:
        blob = base64.b64decode(public.split()[1], validate=True)
        key = paramiko.Ed25519Key(data=blob)
        if key.asbytes() != blob:
            raise ValueError()
    except Exception:
        raise ValueError("SSH 主机公钥内容无效。") from None
    fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    reported = data.get("sshHostFingerprint")
    matches = re.findall(r"SHA256:[A-Za-z0-9+/]{43}(?=$|\s)", reported) if isinstance(reported, str) and len(reported) < 300 else []
    if len(matches) != 1 or not hmac.compare_digest(matches[0], fingerprint):
        raise ValueError("文件中的 SSH 公钥和指纹不一致，请重新核对 Windows 端连接信息。")
    physical = data.get("wakeAdapters", [])
    if not isinstance(physical, list) or len(physical) > 32:
        raise ValueError("网卡信息格式无效。")
    physical_addresses = {value.get("address") for value in physical if isinstance(value, dict) and isinstance(value.get("address"), str)}
    private = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    addresses.sort(key=lambda value: (value not in physical_addresses, not any(ipaddress.ip_address(value) in network for network in private)))
    adapters = []
    for value in physical:
        if not isinstance(value, dict) or value.get("address") not in addresses:
            continue
        mac, prefix = value.get("mac", ""), value.get("prefixLength")
        if (ipaddress.ip_address(value['address']).version != 4 or not isinstance(mac, str) or
                not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", mac) or type(prefix) is not int or not 1 <= prefix <= 30):
            continue
        if int(mac[:2], 16) & 1 or mac.replace(":", "") == "000000000000":
            continue
        network = ipaddress.ip_network(value["address"] + "/" + str(prefix), strict=False)
        adapters.append({"address": value["address"], "mac": mac.upper(), "prefixLength": prefix, "broadcast": str(network.broadcast_address)})
    identifier = hashlib.sha256(blob + b"\0" + username.lower().encode() + port.to_bytes(2, "big")).hexdigest()[:32]
    result = {"id": identifier, "schema": 1, "computer": computer, "username": username,
            "addresses": addresses, "sshPort": port, "sshHostPublicKey": "ssh-ed25519 " + key.get_base64(),
            "sshHostFingerprint": fingerprint, "desktopAuth": desktop_auth, "adapters": adapters}
    if 'authorization' in data:
        from .controller_access import configuration
        candidate = {**result, 'authorization': data['authorization']}
        code = configuration(candidate)
        result.update(id=code['id'], physicalId=identifier, desktopAuth='controller', authorization=data['authorization'])
    return result


def probe_identity(connection, target, timeout=5):
    if connection.get('authorization'):
        from .controller_access import probe_authorization
        return probe_authorization(connection, target, timeout=timeout)
    target = normalize_address(target)
    if target not in connection['addresses']:
        raise ValueError('请选择已核对连接信息中的地址。')
    sock = socket.create_connection((target, connection["sshPort"]), timeout=timeout)
    transport = paramiko.Transport(sock)
    try:
        transport.get_security_options().key_types = ["ssh-ed25519"]
        transport.start_client(timeout=timeout)
        actual = transport.get_remote_server_key()
        if actual.get_name() != "ssh-ed25519" or not hmac.compare_digest(actual.get_base64(), connection["sshHostPublicKey"].split()[1]):
            raise ValueError("这台电脑的 SSH 主机身份与连接文件不一致，已停止接入。")
        return {"target": target, "fingerprint": connection["sshHostFingerprint"], "verified": True}
    finally:
        transport.close()


def choose_target(connection, preferred=None, code=None):
    """Probe only supplied, pinned addresses. Never send a login or bearer token."""
    from .network_routes import local_networks, route_info
    def probe(target):
        probe_identity(connection, target, timeout=1.5)
        if code is not None and not connection.get('authorization'):
            from .connection_code import _PinnedConnection
            client = _PinnedConnection(target, code)
            client.timeout = 1.5
            try: client.connect()
            finally: client.close()
        return {'target': target, 'verified': True}
    networks = local_networks()
    groups = [[] for _ in range(4)]
    for target in connection['addresses']:
        route = route_info(target, networks)
        groups[(0 if route['scope'] == 'lan' else 2)+(0 if route['family'] == 'IPv6' else 1)].append(target)
    for addresses in groups:
        if preferred in addresses:
            try: return probe(preferred)
            except (ValueError, OSError, EOFError, paramiko.SSHException): addresses.remove(preferred)
        if not addresses:
            continue
        pool = ThreadPoolExecutor(max_workers=4)
        pending = {pool.submit(probe, target) for target in addresses}
        deadline = time.monotonic()+3.2
        try:
            while pending and time.monotonic() < deadline:
                done, pending = wait(pending, timeout=max(0, deadline-time.monotonic()), return_when=FIRST_COMPLETED)
                for future in done:
                    try: return future.result()
                    except (ValueError, OSError, EOFError, paramiko.SSHException): pass
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    raise ValueError('自动探测未找到通过主机身份核对的可用地址。请检查网络、主机身份或手动指定地址。')


def inspect_manual(data):
    endpoint = parse_endpoint(data.get('target'), data.get('port', 22))
    public = {'schema': 1, 'computer': data.get('computer'), 'username': data.get('username'),
              'sshPort': endpoint['port'], 'addresses': [endpoint['target']],
              'desktopAuth': 'shared-ssh' if data.get('sharedPassword') is True else 'manual'}
    # Validate user fields before making even an unauthenticated SSH connection.
    if (not isinstance(public['computer'], str) or not re.fullmatch(r'[\w .-]{1,63}', public['computer']) or
            not isinstance(public['username'], str) or not re.fullmatch(r'[\w .@\\-]{1,64}', public['username'])):
        raise ValueError('请填写有效的电脑名称和 SSH 账号。')
    sock = socket.create_connection((endpoint['target'], endpoint['port']), timeout=5)
    transport = paramiko.Transport(sock)
    try:
        transport.get_security_options().key_types = ['ssh-ed25519']
        transport.start_client(timeout=5)
        key = transport.get_remote_server_key()
        if key.get_name() != 'ssh-ed25519':
            raise ValueError('此入口需要 Ed25519 SSH 主机身份。')
        public['sshHostPublicKey'] = 'ssh-ed25519 ' + key.get_base64()
        public['sshHostFingerprint'] = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
    finally:
        transport.close()
    text = json.dumps(public, ensure_ascii=False)
    return {**inspect_connection(text), 'connectionText': text}


def test_credentials(connection, target, password):
    target = normalize_address(target)
    if not isinstance(password, str) or not password or len(password.encode()) > 1024:
        raise ValueError('请输入当前连接密码。')
    if connection.get('authorization'):
        from .controller_access import ControllerClient, configuration
        from .file_stream import StreamError
        client = ControllerClient(target, configuration(connection), token=password)
        try:
            client.authorize()
            return {'verified': True}
        except StreamError:
            raise ValueError('独立授权已失效或被撤销，请向服务端重新获取授权码。') from None
        finally:
            client.close()
    key = paramiko.Ed25519Key(data=base64.b64decode(connection['sshHostPublicKey'].split()[1]))
    client = paramiko.SSHClient()
    client.get_host_keys().add(ssh_endpoint(target, connection['sshPort']), 'ssh-ed25519', key)
    try:
        client.connect(target, port=connection['sshPort'], username=connection['username'], password=password,
                       allow_agent=False, look_for_keys=False, timeout=5, auth_timeout=5, banner_timeout=5)
        return {'verified': True}
    except paramiko.AuthenticationException:
        raise ValueError('连接密码认证未通过，原设备配置已保留。') from None
    finally:
        client.close()


class AssetHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        root = Path(__file__).with_name('desktop_web').resolve()
        if not re.fullmatch(r'/(?:ui-icons|brand)/[A-Za-z0-9_.-]+', self.path):
            self.send_error(404)
            return
        file = (root / self.path.lstrip('/')).resolve()
        if not file.is_relative_to(root) or not file.is_file():
            self.send_error(404)
            return
        content = file.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(content)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve-assets', action='store_true')
    parser.add_argument('--port', type=int, default=22243)
    args = parser.parse_args()
    if args.serve_assets:
        if not 0 <= args.port <= 65535:
            parser.error('invalid local port')
        with ThreadingHTTPServer(('127.0.0.1', args.port), AssetHandler) as server:
            print('GMSSH local assets: http://127.0.0.1:' + str(server.server_port) + '/', flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
        return 0
    logging.getLogger("paramiko").setLevel(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(MAX_EXPORT * 2 + 1)
        if len(raw) > MAX_EXPORT * 2:
            raise ValueError("请求过大。")
        request = json.loads(raw, object_pairs_hook=_object)
        if not isinstance(request, dict) or request.get("operation") not in ("inspect", "probe", "redeem-code", "endpoint", "manual", "test-login", "choose-target", "route-info"):
            raise ValueError("无效的接入操作。")
        text = request.get('connection')
        from .connection_code import PREFIX, inspect_code, redeem_code
        from .controller_access import PREFIX as AUTHORIZATION_PREFIX, ControllerClient, inspect_authorization, metadata_connection
        if request['operation'] == 'route-info':
            from .network_routes import local_networks, route_info
            targets = request.get('targets')
            if not isinstance(targets,list) or len(targets)>200 or any(not isinstance(v,str) or len(v)>128 for v in targets):
                raise ValueError('地址列表无效。')
            networks = local_networks(); routes=[]
            for value in dict.fromkeys(targets):
                try: routes.append({'address':value, **route_info(value,networks)})
                except ValueError: continue
            result={'routes':routes}
        elif request['operation'] == 'choose-target':
            if isinstance(text,str) and text.strip().startswith(AUTHORIZATION_PREFIX):
                code = inspect_authorization(text)
                connection = inspect_connection(metadata_connection(code))
            elif isinstance(text,str) and text.strip().startswith(PREFIX):
                code = inspect_code(text)
                connection = code['public']
            else:
                code = None
                connection = inspect_connection(text)
            result = choose_target(connection, request.get('preferred'), code)
        elif request['operation'] == 'endpoint':
            result = parse_endpoint(request.get('target'), request.get('port', 22))
        elif request['operation'] == 'manual':
            result = inspect_manual(request)
        elif request['operation'] == 'test-login':
            result = test_credentials(inspect_connection(text), request.get('target'), request.get('password'))
        elif request['operation'] == 'redeem-code':
            if isinstance(text,str) and text.strip().startswith(AUTHORIZATION_PREFIX):
                authorization = inspect_authorization(text)
                client = ControllerClient(request.get('target'), authorization)
                try:
                    client.authorize()
                    result = {'password': authorization['controller']['token'], 'permissions': client.policy}
                finally:
                    client.close()
            else:
                result = redeem_code(text, request.get('target'))
        elif request['operation'] == 'inspect' and isinstance(text,str) and text.strip().startswith(AUTHORIZATION_PREFIX):
            metadata = metadata_connection(inspect_authorization(text))
            result = {**inspect_connection(metadata), 'connectionText': metadata, 'fromCode': True, 'fromAuthorization': True}
        elif request['operation'] == 'inspect' and isinstance(text, str) and text.strip().startswith(PREFIX):
            code = inspect_code(text)
            result = {**code['public'], 'connectionText': code['connectionText'], 'fromCode': True}
        else:
            connection = inspect_connection(text)
            result = connection if request["operation"] == "inspect" else probe_identity(connection, request.get("target"))
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    except ValueError as error:
        message = {'SOURCE_DENIED':'此管理端的 IPv6 来源尚未获准。请在 Windows 服务端的「IPv6 接入」中添加管理端地址或网段，再重试。',
                   'AUTH_FAILED':'独立授权未通过，请核对授权码是否已撤销，以及此管理端来源是否获准接入。',
                   'REMOTE_IO':'无法连接独立授权服务，请检查 IPv6 来源范围、TCP 22257 和服务端状态。'}.get(getattr(error,'code',None),str(error))
        print(json.dumps({"ok": False, "message": message}, ensure_ascii=False))
        return 1
    except (OSError, EOFError, paramiko.SSHException):
        print(json.dumps({"ok": False, "message": "无法核对 Windows SSH，请检查地址、端口和网络可达性。"}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
