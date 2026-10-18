"""Read local interface prefixes and route only to supplied, pinned peers."""
import base64
import hashlib
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys

from .address import normalize_address, ssh_endpoint


def local_networks():
    """None means unavailable. Private/public address classes do not imply locality."""
    try:
        pairs = []
        if sys.platform == 'darwin':
            raw = subprocess.run(['/sbin/ifconfig', '-a'], capture_output=True, text=True,
                                 timeout=2, check=True).stdout
            active = False
            for line in raw.splitlines():
                if line and not line[0].isspace():
                    flags = set((re.search(r'<([^>]+)>', line) or ['', ''])[1].split(','))
                    active = 'UP' in flags and 'RUNNING' in flags and not flags & {'LOOPBACK', 'POINTOPOINT'}
                if not active:
                    continue
                v4 = re.match(r'\s+inet (\S+) netmask (\S+)', line)
                v6 = re.match(r'\s+inet6 ([^%\s]+)(?:%\S+)? prefixlen (\d+)', line)
                if v4:
                    mask = v4[2]
                    if mask.startswith('0x'):
                        mask = str(ipaddress.IPv4Address(int(mask, 16)))
                    pairs.append((v4[1], mask))
                elif v6:
                    pairs.append((v6[1], v6[2]))
        elif sys.platform == 'win32':
            executable = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                                      r'System32\WindowsPowerShell\v1.0\powershell.exe')
            script = "$ErrorActionPreference='Stop';$i=@(Get-NetIPInterface -ConnectionState Connected|Select-Object -ExpandProperty InterfaceIndex -Unique);@(Get-NetIPAddress|Where-Object {$_.InterfaceIndex -in $i -and $_.AddressState -in @('Preferred','Deprecated')}|Select-Object IPAddress,PrefixLength)|ConvertTo-Json -Compress"
            raw = subprocess.run([executable, '-NoProfile', '-NonInteractive', '-Command', script],
                                 capture_output=True, text=True, timeout=3, check=True).stdout
            pairs = [(row['IPAddress'].split('%')[0], row['PrefixLength']) for row in json.loads(raw or '[]')]
        else:
            executable = shutil.which('ip')
            if not executable:
                return None
            raw = subprocess.run([executable, '-j', 'address', 'show', 'up'], capture_output=True,
                                 text=True, timeout=2, check=True).stdout
            for interface in json.loads(raw):
                if set(interface.get('flags', [])) & {'LOOPBACK', 'POINTOPOINT'}:
                    continue
                pairs.extend((row['local'], row['prefixlen']) for row in interface.get('addr_info', []))
        networks = set()
        for address, prefix in pairs:
            try:
                ip = ipaddress.ip_address(address)
                network = ipaddress.ip_network(f'{ip}/{prefix}', strict=False)
                if network.prefixlen and not (ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast):
                    networks.add(network)
            except ValueError:
                continue
        return list(networks)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None


def route_info(target, networks):
    ip = ipaddress.ip_address(normalize_address(target))
    scope = 'unknown' if networks is None else 'lan' if any(ip.version == n.version and ip in n for n in networks) else 'remote'
    return {'target': str(ip), 'scope': scope, 'family': 'IPv6' if ip.version == 6 else 'IPv4'}


def prepare_routes(config):
    """Pin every candidate before enabling automatic runtime selection."""
    values = getattr(config, 'auto_address', [])
    config.route_status = {}
    if not values:
        config.route_connection = None
        return
    addresses = list(dict.fromkeys([normalize_address(config.target), *(normalize_address(v) for v in values)]))
    if len(addresses) > 32:
        raise ValueError('自动连接最多保存 32 个已提供的地址。')
    if getattr(config, 'controller_configuration', None):
        from .controller_access import metadata_connection
        from .pairing import inspect_connection
        connection = inspect_connection(metadata_connection(config.controller_configuration))
        if any(value not in connection['addresses'] for value in addresses):
            raise ValueError('自动地址不在独立授权的主机配置中。')
        connection['addresses'] = addresses
    else:
        import paramiko
        pins = paramiko.HostKeys(str(config.known_hosts))
        entry = pins.lookup(ssh_endpoint(config.target, config.target_port))
        key = entry.get('ssh-ed25519') if entry else None
        if key is None or any(not (entry := pins.lookup(ssh_endpoint(value, config.target_port))) or entry.get('ssh-ed25519') != key for value in addresses):
            raise ValueError('自动连接地址缺少一致的 SSH 主机身份，已停止启动。')
        connection = {'addresses': addresses, 'sshPort': config.target_port,
                      'sshHostPublicKey': 'ssh-ed25519 '+key.get_base64(),
                      'sshHostFingerprint': 'SHA256:'+base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')}
    config.route_connection = connection


def select_route(config):
    connection = getattr(config, 'route_connection', None)
    if connection is None:
        return config.target
    from .pairing import choose_target
    return choose_target(connection, preferred=config.route_status.get('target', config.target))['target']


def record_route(config, client, target):
    try:
        target = normalize_address(target)
        info = route_info(target, local_networks())
    except ValueError:
        return  # Legacy CLI hostname profiles remain fixed to their configured host.
    client.gmssh_route = info
    state = getattr(config, 'route_status', None)
    if isinstance(state, dict):
        changed = state != info
        state.clear(); state.update(info)
        if changed and (getattr(config, 'session_events', False) or getattr(config, 'auto_address', [])):
            print('GMSSH_ROUTE '+json.dumps(info, separators=(',', ':')), flush=True)
