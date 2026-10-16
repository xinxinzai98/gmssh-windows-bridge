"""One bounded query to a loopback viewer; no remote login or credential storage."""
import json
import sys
from urllib.parse import urlsplit

from .desktop_operations import valid_access_token
from .readonly_tools import options_for


def request(value):
    from websockets.sync.client import connect
    if not isinstance(value, dict) or set(value) != {'url', 'token', 'tool', 'options'}:
        raise ValueError('INVALID_QUERY')
    url = urlsplit(value['url'])
    if url.scheme != 'http' or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or not url.port or url.username or url.password or url.path != '/' or url.query or url.fragment or not valid_access_token(value['token']):
        raise ValueError('INVALID_QUERY')
    tool = value['tool']
    if tool == 'diagnostics':
        if value['options'] != {}:
            raise ValueError('INVALID_QUERY')
        query = {'id': 1, 'op': 'diagnostics'}
    else:
        options_for(tool, value['options'])
        query = {'id': 1, 'op': 'readonly', 'tool': tool, 'options': value['options']}
    with connect('ws://' + url.netloc + '/operations', origin='http://' + url.netloc,
                 open_timeout=3, close_timeout=1, max_size=262144, proxy=None) as websocket:
        websocket.send(json.dumps({'token': value['token']}))
        greeting = json.loads(websocket.recv(timeout=3))
        if greeting.get('type') != 'operations_ready':
            return {'error': {'OperationsUnavailable': 'QUERY_BUSY', 'DesktopAccessError': 'LOCAL_ACCESS_DENIED'}.get(greeting.get('code'), 'LOCAL_SERVICE_UNAVAILABLE')}
        websocket.send(json.dumps(query))
        reply = json.loads(websocket.recv(timeout=22))
        if reply.get('id') != 1 or reply.get('ok') is not True:
            return {'error': reply.get('code') if reply.get('code') in {'SSHPoolUnavailable', 'INVALID_QUERY', 'QUERY_FAILED'} else 'QUERY_UNSUPPORTED'}
        return reply['result']


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('INVALID_QUERY')
        result = request(json.loads(raw))
    except TimeoutError:
        result = {'error': 'QUERY_TIMEOUT'}
    except Exception:
        result = {'error': 'LOCAL_SERVICE_UNAVAILABLE'}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
