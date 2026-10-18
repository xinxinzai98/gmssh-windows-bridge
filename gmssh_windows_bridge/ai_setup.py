"""Human-operated setup, diagnostics and configuration; never exposed as MCP tools."""
import argparse
import asyncio
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile

from . import __version__
from .ai import Registry, Operations, TOOLS, PERMISSIONS, default_root, error_message, identifier
from .controller_access import inspect_authorization
from .file_stream import StreamError


def mcp_configuration(registry, style='json'):
    command = [sys.executable, '-I', '-m', 'gmssh_windows_bridge.ai', '--root', str(registry.root), 'mcp']
    names = sorted({item['credential']['reference'] for item in registry.devices() if item['allow'] and item['credential']['kind'] == 'env'})
    if style == 'json':
        return json.dumps({'mcpServers': {'gmssh': {'command': command[0], 'args': command[1:]}}}, ensure_ascii=False, indent=2)
    if style == 'codex':
        lines = ['[mcp_servers.gmssh]', 'command = '+json.dumps(command[0], ensure_ascii=False),
                 'args = '+json.dumps(command[1:], ensure_ascii=False), 'startup_timeout_sec = 20', 'tool_timeout_sec = 90']
        if names:
            lines.append('env_vars = '+json.dumps(names))
        return '\n'.join(lines)+'\n'
    if style == 'codex-cli':
        if names:
            raise StreamError('ENV_FORWARDING_REQUIRED')
        return shlex.join(['codex', 'mcp', 'add', 'gmssh', '--', *command])
    raise StreamError('INVALID_ARGUMENT')


async def _probe_mcp(registry):
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
    parameters = StdioServerParameters(command=sys.executable,
        args=['-I', '-m', 'gmssh_windows_bridge.ai', '--root', str(registry.root), 'mcp'])
    # Tool discovery cannot connect to a device or retrieve a device credential.
    with tempfile.TemporaryFile(mode='w+') as errors:
        async with stdio_client(parameters, errlog=errors) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                result = await session.list_tools()
                if {tool.name for tool in result.tools} != {tool['name'] for tool in TOOLS}:
                    raise StreamError('MCP_VERSION_MISMATCH')
                return len(result.tools)


def doctor(registry, check_mcp=False):
    devices = registry.devices()
    installed = importlib.util.find_spec('mcp') is not None
    checks = [{'id': 'configuration', 'state': 'passed', 'code': 'OK', 'devices': len(devices)},
              {'id': 'mcp', 'state': 'passed' if installed else 'failed', 'code': 'OK' if installed else 'AI_DEPENDENCY_REQUIRED'}]
    if installed:
        checks[-1]['version'] = importlib.metadata.version('mcp')
    if check_mcp and installed:
        try:
            count = asyncio.run(asyncio.wait_for(_probe_mcp(registry), timeout=15))
            checks.append({'id': 'stdio', 'state': 'passed', 'code': 'OK', 'tools': count})
        except Exception as error:
            checks.append({'id': 'stdio', 'state': 'failed', 'code': error.code if isinstance(error, StreamError) else 'MCP_CHECK_FAILED'})
    sources = []
    for device in devices:
        try:
            present = registry.credential_present(device)
            code = 'OK' if present else 'CREDENTIAL_REQUIRED'
        except OSError:
            present, code = False, 'LOCAL_ACCESS_DENIED'
        sources.append({'device': device['id'], 'enabled': bool(device['allow']), 'stored': present, 'code': code})
    return {'version': __version__, 'ready': all(check['state'] == 'passed' for check in checks), 'accessSources': sources,
            'checks': checks, 'deviceConnectionsAttempted': 0,
            'prepareCommand': shlex.join([sys.executable, '-m', 'pip', 'install', 'mcp>=1.30,<2'])}


def preview(registry, text):
    code = inspect_authorization(text)
    existing = next((item for item in registry.devices() if item['id'] == code['id']), None)
    return {'id': code['id'], 'computer': code['public']['computer'], 'addresses': code['public']['addresses'], 'fingerprint': code['public']['sshHostFingerprint'],
            'name': existing['name'] if existing else code['public']['computer'], 'existing': existing is not None,
            'allow': existing['allow'] if existing else ['inspect'], 'granted': code['controller']['permissions']}


def overview(registry):
    devices, checks = registry.devices(), registry.checks()
    rows = []
    for device in devices:
        try:
            present = registry.credential_present(device)
        except OSError:
            present = None
        rows.append({**registry.public(device), 'source': device['credential']['kind'], 'accessStored': present,
                     'lastCheck': checks.get(device['id']) if device['allow'] else None})
    return {'devices': rows, 'version': __version__}


class Setup:
    def __init__(self, registry, connector=None):
        self.registry = registry
        self.operations = Operations(registry, **({'connector': connector} if connector else {}))

    def request(self, value):
        if not isinstance(value, dict) or set(value) != {'action', 'data'} or not isinstance(value['data'], dict):
            raise StreamError('INVALID_ARGUMENT')
        action, data = value['action'], value['data']
        fields = {'list': set(), 'preview': {'code'}, 'enroll': {'code', 'name', 'allow', 'replace'},
                  'configure': {'device', 'allow'}, 'credential': {'device', 'value'},
                  'doctor': {'checkMCP'}, 'check': {'device'}, 'config': {'format'}, 'history': {'device'}, 'task': {'device', 'taskId'}}
        if not isinstance(action, str) or action not in fields or set(data) != fields[action]:
            raise StreamError('INVALID_ARGUMENT')
        if 'allow' in data and (not isinstance(data['allow'], list) or any(not isinstance(v, str) or v not in PERMISSIONS for v in data['allow']) or len(data['allow']) != len(set(data['allow']))):
            raise StreamError('INVALID_ARGUMENT')
        if action == 'list':
            return overview(self.registry)
        if action == 'preview':
            return preview(self.registry, data['code'])
        if action == 'enroll':
            if type(data['replace']) is not bool:
                raise StreamError('INVALID_ARGUMENT')
            public = preview(self.registry, data['code'])
            if data['replace']:
                if not public['existing']:
                    raise StreamError('DEVICE_NOT_ENABLED')
                return self.registry.replace_authorization(public['id'], data['code'], data['allow'])
            return self.registry.enroll(data['code'], data['name'], data['allow'])
        if action == 'configure':
            return self.registry.configure(data['device'], data['allow'])
        if action == 'credential':
            return self.registry.update_credential(data['device'], data['value'])
        if action == 'doctor':
            if type(data['checkMCP']) is not bool:
                raise StreamError('INVALID_ARGUMENT')
            return doctor(self.registry, data['checkMCP'])
        if action == 'check':
            return self.operations.call('device_access_check', {'device': data['device']})
        if action == 'history':
            device = next((v for v in self.registry.devices() if v['id'] == identifier(data['device'])), None)
            if device is None:
                raise StreamError('DEVICE_NOT_ENABLED')
            return {**self.registry.task_history(device['id'], 200), 'canQuery': 'terminal' in device['allow']}
        if action == 'task':
            return self.operations.call('task_get', {'device': data['device'], 'taskId': data['taskId']})
        if action == 'config':
            return {'format': data['format'], 'text': mcp_configuration(self.registry, data['format'])}
        raise StreamError('INVALID_ARGUMENT')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=default_root())
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise StreamError('INVALID_ARGUMENT')
        from .pairing import _object
        result = Setup(Registry(args.root)).request(json.loads(raw, object_pairs_hook=_object))
        reply = {'ok': True, 'data': result}
    except Exception as error:
        code = error.code if isinstance(error, StreamError) else 'INVALID_ARGUMENT' if isinstance(error, (ValueError, TypeError, KeyError)) else 'SETUP_FAILED'
        reply = {'ok': False, 'code': code, 'message': error_message(code)}
    print(json.dumps(reply, ensure_ascii=False, allow_nan=False))
    return 0 if reply['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
