"""Long-lived connection codes; credentials are retrieved only over pinned TLS."""
import base64
import hmac
import http.client
import json
import re
import socket
import ssl

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from .pairing import _object, inspect_connection, probe_identity
from .address import connection_code_address, normalize_address

PREFIX = 'GMSSH-CONNECT1.'
PORT = 22257
MAX_CODE = 32768
MAX_REPLY = 8192


def inspect_code(text):
    if not isinstance(text, str) or len(text.encode('utf-8')) > MAX_CODE:
        raise ValueError('连接码过大或格式无效。')
    text = text.strip()
    if not text.startswith(PREFIX):
        raise ValueError('请粘贴 Windows 服务端复制的连接码。')
    encoded = text[len(PREFIX):]
    if not re.fullmatch(r'[A-Za-z0-9_-]+', encoded):
        raise ValueError('连接码内容无效，请重新复制。')
    try:
        raw = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(raw).decode().rstrip('=') != encoded:
            raise ValueError()
        data = json.loads(raw, object_pairs_hook=_object)
    except (ValueError, UnicodeError):
        raise ValueError('连接码内容无效，请重新复制。') from None
    if not isinstance(data, dict) or set(data) != {'schema', 'connection', 'port', 'certificate', 'token'} or type(data['schema']) is not int or data['schema'] != 1:
        raise ValueError('不支持此连接码版本。')
    if type(data['port']) is not int or data['port'] != PORT or not isinstance(data['token'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', data['token']):
        raise ValueError('连接码中的接入凭证或端口无效。')
    try:
        token = base64.urlsafe_b64decode(data['token'] + '=')
        if len(token) != 32 or base64.urlsafe_b64encode(token).decode().rstrip('=') != data['token']:
            raise ValueError()
    except ValueError:
        raise ValueError('连接码中的接入凭证无效。') from None
    public_text = json.dumps(data['connection'], ensure_ascii=False, separators=(',', ':'))
    public = inspect_connection(public_text)
    if public['desktopAuth'] != 'shared-ssh' or not all(connection_code_address(value) for value in public['addresses']):
        raise ValueError('连接码需要使用统一连接密码，以及局域网 IPv4 或可用 IPv6 地址。')
    certificate = data['certificate']
    if not isinstance(certificate, str) or len(certificate) > 4096 or certificate.count('-----BEGIN CERTIFICATE-----') != 1:
        raise ValueError('连接码中的设备证书无效。')
    try:
        cert = x509.load_pem_x509_certificate(certificate.encode('ascii'))
        canonical = cert.public_bytes(serialization.Encoding.PEM).decode()
        if canonical.strip() != certificate.strip():
            raise ValueError()
        name = 'gmssh-' + public['id'] + '.local'
        if name not in cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName):
            raise ValueError()
    except (ValueError, UnicodeError, x509.ExtensionNotFound):
        raise ValueError('连接码中的设备证书与主机身份不一致。') from None
    return {'public': public, 'connectionText': public_text, 'certificate': canonical,
            'token': data['token'], 'port': PORT, 'serverName': name}


class _PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, target, code):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_verify_locations(cadata=code['certificate'])
        super().__init__(target, code['port'], timeout=8, context=context)
        self.server_name = code['serverName']
        self.expected_certificate = ssl.PEM_cert_to_DER_cert(code['certificate'])

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.server_name)
            if not hmac.compare_digest(self.sock.getpeercert(binary_form=True), self.expected_certificate):
                raise ssl.SSLCertVerificationError('unexpected device certificate')
        except Exception:
            raw.close()
            if self.sock:
                self.sock.close()
            raise


def redeem_code(text, target):
    code = inspect_code(text)
    public = code['public']
    target = normalize_address(target)
    if not connection_code_address(target):
        raise ValueError('此地址不在连接码支持的范围内，请使用手动添加。')
    # Check the existing SSH identity before sending this access credential.
    probe_identity({**public, 'addresses': [target]}, target)
    connection = None
    try:
        connection = _PinnedConnection(target, code)
        connection.request('POST', '/v1/connect', body=b'{"schema":1}', headers={
            'Content-Type': 'application/json', 'Authorization': 'Bearer ' + code['token']})
        response = connection.getresponse()
        if response.status in (401, 403):
            raise ValueError('连接码已失效或被重置，请从 Windows 服务端重新复制。')
        if response.status != 200:
            raise ValueError('Windows 一键接入暂不可用，请检查服务端状态或使用手动添加。')
        raw = response.read(MAX_REPLY + 1)
        if len(raw) > MAX_REPLY:
            raise ValueError('Windows 接入响应无效。')
        try:
            result = json.loads(raw, object_pairs_hook=_object)
        except (ValueError, UnicodeError):
            raise ValueError('Windows 接入响应无效。') from None
        if not isinstance(result, dict) or set(result) != {'schema', 'username', 'fingerprint', 'password'} or type(result['schema']) is not int or result['schema'] != 1 or result['username'] != public['username'] or result['fingerprint'] != public['sshHostFingerprint']:
            raise ValueError('Windows 接入响应与这台电脑的身份不一致。')
        password = result['password']
        if not isinstance(password, str) or not password or len(password.encode('utf-8')) > 1024:
            raise ValueError('Windows 接入响应无效。')
        return {'password': password}
    except (OSError, ssl.SSLError, http.client.HTTPException):
        raise ValueError('无法验证或连接此电脑的一键接入服务，请检查网络可达性、来源授权、证书和系统时间。') from None
    finally:
        code['token'] = ''
        if connection:
            connection.close()
