"""Literal target addresses; ports remain separate from IPv6 host text."""
import ipaddress
import re


def ssh_target(value):
    """CLI host syntax, including local fixtures; the port is always separate."""
    if not isinstance(value, str) or not value or value != value.strip() or '%' in value:
        raise ValueError('use an IP address or hostname; specify the port separately')
    if value.startswith('[') and value.endswith(']'):
        value = value[1:-1]
        if ':' not in value:
            raise ValueError('brackets require an IPv6 address')
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,252}', value):
            return value
        raise ValueError('use an IP address or hostname; specify the port separately') from None


def normalize_address(value):
    if not isinstance(value, str) or not value or value != value.strip() or '%' in value:
        raise ValueError('请输入有效的 IPv4 或 IPv6 地址。')
    try:
        address = ipaddress.ip_address(value)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
    except ValueError:
        raise ValueError('请输入有效的 IPv4 或 IPv6 地址。') from None
    if (address.is_loopback or address.is_multicast or address.is_unspecified or address.is_link_local
            or address == ipaddress.ip_address('255.255.255.255')):
        raise ValueError('请使用可连接目标电脑的单播地址，不能使用回环、链路本地或广播地址。')
    return str(address)


def parse_endpoint(value, port=22):
    if not isinstance(value, str) or len(value) > 128 or type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('连接地址或端口无效。')
    value = value.strip()
    embedded_port = None
    if value.startswith('['):
        match = re.fullmatch(r'\[([^\[\]]+)\](?::([0-9]{1,5}))?', value)
        if not match:
            raise ValueError('IPv6 和端口请使用 [IPv6]:端口 格式。')
        value, embedded_port = match.groups()
        if ':' not in value:
            raise ValueError('方括号仅用于 IPv6 地址。')
    elif value.count(':') == 1 and '.' in value:
        value, embedded_port = value.rsplit(':', 1)
        if not re.fullmatch(r'[0-9]{1,5}', embedded_port):
            raise ValueError('连接端口无效。')
    if embedded_port is not None:
        port = int(embedded_port)
    if not 1 <= port <= 65535:
        raise ValueError('连接端口应为 1–65535。')
    return {'target': normalize_address(value), 'port': port}


def ssh_endpoint(target, port):
    return target if port == 22 else f'[{target}]:{port}'


def connection_code_address(value):
    address = ipaddress.ip_address(normalize_address(value))
    return address.version == 6 or any(address in ipaddress.ip_network(network) for network in
        ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
