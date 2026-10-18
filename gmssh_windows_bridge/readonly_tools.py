"""Fixed, bounded Windows queries and diagnostics over an existing authenticated SSH lease."""
import base64
import datetime
import errno
import ipaddress
import json
import math
import socket
import time
from pathlib import Path

from . import __version__

SCRIPT = Path(__file__).with_name('readonly-tools.ps1').read_text(encoding='utf-8-sig')
TOOLS = {'capabilities', 'processes', 'services', 'logs', 'log-detail'}
_STDIN_SCRIPT = "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))"
STDIN_COMMAND = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(_STDIN_SCRIPT.encode('utf-16le')).decode()


class ReadonlyInputError(ValueError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def options_for(tool, values):
    if not isinstance(tool, str) or tool not in TOOLS or not isinstance(values, dict):
        raise ReadonlyInputError('只读查询类型无效。')
    fields = {'capabilities': set(), 'processes': {'limit', 'search', 'sort'},
              'services': {'limit', 'search', 'sort'}, 'logs': {'source', 'limit', 'hours'},
              'log-detail': {'source', 'recordId'}}[tool]
    if set(values) != fields:
        raise ReadonlyInputError('只读查询字段无效。')
    if 'limit' in values and (type(values['limit']) is not int or values['limit'] not in {50, 100, 200}):
        raise ReadonlyInputError('查询条数只支持 50、100 或 200。')
    if 'search' in values and (not isinstance(values['search'], str) or len(values['search']) > 64 or any(ord(c) < 32 for c in values['search'])):
        raise ReadonlyInputError('搜索内容最多 64 字符，不接受控制字符。')
    if 'sort' in values and (not isinstance(values['sort'], str) or values['sort'] not in ({'name', 'cpu', 'memory', 'pid'} if tool == 'processes' else {'name', 'state'})):
        raise ReadonlyInputError('排序方式无效。')
    if 'source' in values and (not isinstance(values['source'], str) or values['source'] not in {'system', 'application'}):
        raise ReadonlyInputError('日志源无效。')
    if 'hours' in values and (type(values['hours']) is not int or values['hours'] not in {1, 6, 24}):
        raise ReadonlyInputError('日志范围只支持最近 1、6 或 24 小时。')
    if 'recordId' in values and (type(values['recordId']) is not int or not 1 <= values['recordId'] <= 2**53-1):
        raise ReadonlyInputError('日志记录 ID 无效。')
    return {'tool': tool, **values}


def script_for(tool, values):
    options = base64.b64encode(json.dumps(options_for(tool, values), ensure_ascii=False).encode()).decode()
    return "$options=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + options + "')) | ConvertFrom-Json\n" + SCRIPT


def command_for(tool, values):
    # Used for native Windows regression without an SSH shell in between.
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(script_for(tool, values).encode('utf-16le')).decode()


def validate_result(value, tool):
    if not isinstance(value, dict) or value.get('schema') != 1 or value.get('kind') != 'windows' or value.get('tool') != tool or value.get('state') not in {'passed', 'failed', 'unsupported'}:
        raise ReadonlyInputError('只读查询返回格式无效。')
    if value.get('code') not in {'OK', 'ACCESS_DENIED', 'QUERY_FAILED', 'EVENT_LOG_UNAVAILABLE', 'TOOL_UNAVAILABLE'} or not isinstance(value.get('items'), list) or len(value['items']) > (1 if tool == 'log-detail' else 200):
        raise ReadonlyInputError('只读查询返回内容超出限制。')
    if not isinstance(value.get('sampledAt'), str) or len(value['sampledAt']) > 40 or type(value.get('truncated')) is not bool:
        raise ReadonlyInputError('只读查询采样信息无效。')
    allowed = {'processes': {'pid', 'name', 'cpuPercent', 'memoryBytes'},
               'services': {'name', 'displayName', 'state', 'startType'},
               'logs': {'recordId', 'source', 'time', 'level', 'provider', 'eventId', 'preview'},
               'log-detail': {'recordId', 'source', 'time', 'level', 'provider', 'eventId', 'message', 'messageTruncated'}}
    result = {key: value[key] for key in ('schema', 'kind', 'tool', 'sampledAt', 'state', 'code', 'items', 'truncated')}
    for item in value['items']:
        if not isinstance(item, dict) or set(item) != allowed.get(tool, set()):
            raise ReadonlyInputError('只读查询项目格式无效。')
        for key, field in item.items():
            if isinstance(field, str) and len(field) > (4096 if key == 'message' else 128) or isinstance(field, float) and not math.isfinite(field):
                raise ReadonlyInputError('只读查询字段无效。')
        if tool == 'processes':
            if type(item['pid']) is not int or item['pid'] < 0 or not isinstance(item['name'], str):
                raise ReadonlyInputError('进程标识无效。')
            if item['cpuPercent'] is not None and (type(item['cpuPercent']) not in (int, float) or not 0 <= item['cpuPercent'] <= 100):
                raise ReadonlyInputError('进程 CPU 数值无效。')
            if item['memoryBytes'] is not None and (type(item['memoryBytes']) is not int or not 0 <= item['memoryBytes'] <= 2**53-1):
                raise ReadonlyInputError('进程内存数值无效。')
        elif tool == 'services' and any(not isinstance(field, str) for field in item.values()):
            raise ReadonlyInputError('服务字段无效。')
        elif tool in {'logs', 'log-detail'}:
            if type(item['recordId']) is not int or not 1 <= item['recordId'] <= 2**53-1 or type(item['eventId']) is not int or not 0 <= item['eventId'] <= 65535 or item['source'] not in {'system', 'application'} or any(not isinstance(item[key], str) for key in ('time', 'level', 'provider')):
                raise ReadonlyInputError('日志字段无效。')
            if tool == 'log-detail' and (not isinstance(item['message'], str) or type(item['messageTruncated']) is not bool) or tool == 'logs' and not isinstance(item['preview'], str):
                raise ReadonlyInputError('日志正文格式无效。')
    if tool == 'capabilities':
        caps, versions = value.get('capabilities'), value.get('versions')
        if not isinstance(caps, dict) or set(caps) != {'processes', 'services', 'logs', 'sources'} or any(type(caps[key]) is not bool for key in ('processes', 'services', 'logs')) or caps['sources'] != ['system', 'application']:
            raise ReadonlyInputError('设备能力信息无效。')
        if not isinstance(versions, dict) or set(versions) != {'server', 'engine', 'os'} or any(field is not None and (not isinstance(field, str) or len(field) > 128) for field in versions.values()):
            raise ReadonlyInputError('设备版本信息无效。')
        result.update(capabilities=caps, versions={'controller': __version__, 'bridge': __version__, **versions})
    if tool == 'processes':
        if value['state'] != 'passed':
            return result
        units = value.get('units')
        if not isinstance(units, dict) or set(units) != {'cpu', 'memory', 'sampleSeconds', 'cores'} or units.get('cpu') != 'logical-processors-normalized' or units.get('memory') != 'working-set' or type(units.get('sampleSeconds')) not in (int, float) or not 0 < units['sampleSeconds'] <= 60 or type(units.get('cores')) is not int or not 1 <= units['cores'] <= 4096:
            raise ReadonlyInputError('进程采样口径无效。')
        result['units'] = units
    return result


def query(client, tool, values, timeout, run):
    if getattr(client, 'controller_protocol', None) == 2:
        options_for(tool, values)
        return validate_result(json.loads(client.readonly(tool, values).decode('utf-8-sig')), tool)
    script = script_for(tool, values).encode('utf-8')
    return validate_result(json.loads(run(client, STDIN_COMMAND, timeout, max_output=262144, stdin=script).decode('utf-8-sig')), tool)


def probe_tcp(target, port, timeout=2):
    sampled = now()
    try:
        parsed = ipaddress.ip_address(target)
        if parsed.is_loopback or parsed.is_unspecified or parsed.is_multicast:
            return {'state': 'unchecked', 'code': 'NON_DEVICE_TARGET', 'sampledAt': sampled, 'latencyMs': None}
    except ValueError:
        pass
    try:
        started = time.monotonic()
        with socket.create_connection((target, port), timeout=min(2, timeout)):
            return {'state': 'passed', 'code': 'TCP_REACHABLE', 'sampledAt': sampled, 'latencyMs': round((time.monotonic()-started)*1000, 1)}
    except socket.gaierror:
        code = 'ADDRESS_UNRESOLVED'
    except (TimeoutError, socket.timeout):
        code = 'TCP_TIMEOUT'
    except OSError as error:
        code = 'TCP_REFUSED' if error.errno == errno.ECONNREFUSED else 'TCP_UNREACHABLE'
    return {'state': 'failed', 'code': code, 'sampledAt': sampled, 'latencyMs': None}


def diagnostics(session, config, run, system_command):
    sampled = now()
    controller = bool(getattr(config, 'controller_connection', None))
    snapshot = session.pool.snapshot() if session.pool and hasattr(session.pool, 'snapshot') else {}
    if not isinstance(snapshot, dict):
        snapshot = {}
    stages = [{'id': 'target', 'state': 'passed', 'code': 'SAVED_TARGET', 'sampledAt': sampled}]
    if isinstance(getattr(config, 'target', None), str) and type(getattr(config, 'target_port', None)) is int:
        port = config.controller_configuration['port'] if controller else config.target_port
        stages.append({'id': 'tcp', **probe_tcp(config.target, port, session.timeout)})
    else:
        stages.append({'id': 'tcp', 'state': 'unchecked', 'code': 'TARGET_UNKNOWN', 'sampledAt': sampled})
    code = snapshot.get('code', 'SSH_NOT_OBSERVED')
    auth_time = snapshot.get('sampledAt') or sampled
    authenticated = snapshot.get('borrowable') is True
    stages.append({'id': 'identity', 'state': 'passed' if authenticated else 'failed' if code == 'BadHostKeyException' else 'unchecked', 'code': 'SSH_PIN_VERIFIED' if authenticated else 'HOST_KEY_CHANGED' if code == 'BadHostKeyException' else 'IDENTITY_NOT_OBSERVED', 'sampledAt': auth_time})
    stages.append({'id': 'auth', 'state': 'passed' if authenticated else 'failed' if code == 'AuthenticationException' else 'unchecked', 'code': 'SSH_AUTHENTICATED' if authenticated else 'SSH_AUTH_FAILED' if code == 'AuthenticationException' else 'SSH_SESSION_REQUIRED', 'sampledAt': auth_time})
    if controller:
        stages[-2]['code'] = 'TLS_PIN_VERIFIED' if authenticated else 'TLS_PIN_CHANGED' if code == 'BadHostKeyException' else 'IDENTITY_NOT_OBSERVED'
        stages[-1]['code'] = 'CONTROLLER_AUTHENTICATED' if authenticated else 'CONTROLLER_AUTH_FAILED' if code == 'AuthenticationException' else 'CONTROLLER_SESSION_REQUIRED'
    if authenticated:
        try:
            session.ssh_nowait()
            info = json.loads(run(session.client, system_command, session.timeout).decode('utf-8-sig'))
            if not isinstance(info, dict) or set(info) != {'computer', 'os', 'version', 'cpu', 'cores', 'memory', 'uptime', 'processes', 'disks', 'network'}:
                raise ReadonlyInputError('Invalid monitoring response')
            stages.append({'id': 'monitor', 'state': 'passed', 'code': 'MONITOR_OK', 'sampledAt': now()})
        except Exception:
            stages.append({'id': 'monitor', 'state': 'failed', 'code': 'MONITOR_QUERY_FAILED', 'sampledAt': now()})
        try:
            if controller and session.client.policy.get('files') is not True:
                raise PermissionError()
            session.files()
            stages.append({'id': 'files', 'state': 'passed', 'code': 'CONTROLLER_FILES_READY' if controller else 'SFTP_READY', 'sampledAt': now()})
        except PermissionError:
            stages.append({'id': 'files', 'state': 'failed', 'code': 'ACCESS_DENIED', 'sampledAt': now()})
        except Exception:
            stages.append({'id': 'files', 'state': 'failed', 'code': 'SFTP_UNAVAILABLE', 'sampledAt': now()})
    else:
        for stage in ('monitor', 'files'):
            stages.append({'id': stage, 'state': 'unchecked', 'code': 'SSH_SESSION_REQUIRED', 'sampledAt': sampled})
    return {'schema': 1, 'kind': 'windows', 'tool': 'diagnostics', 'sampledAt': now(), 'versions': {'controller': __version__, 'bridge': __version__}, 'stages': stages}
