"""Disposable local SSH/PTY probe; input and output never contain real credentials."""
import base64
import hashlib
import json
import sys
import threading

import paramiko


def main():
    value = json.loads(sys.stdin.buffer.readline(65536))
    if value['mode'] == 'desktop':
        from websockets.sync.client import connect
        from urllib.parse import urlsplit
        url = urlsplit(value['url'])
        if url.scheme != 'http' or url.hostname != '127.0.0.1':
            raise ValueError('Only the disposable local viewer is allowed')
        with connect('ws://'+url.netloc+'/socket', origin='http://'+url.netloc, proxy=None, open_timeout=5, close_timeout=1) as ws:
            ws.send(json.dumps({'password': '', 'token': value['accessToken']}))
            permissions = None
            for _ in range(5):
                reply = ws.recv(timeout=8)
                if isinstance(reply, str):
                    data = json.loads(reply)
                    if data.get('type') == 'controller_permissions': permissions = data['permissions']
                elif reply and reply[0] == 9*8+2:
                    break
                else:
                    raise ValueError('missing RustDesk challenge')
            if permissions is None:
                raise ValueError('server policy was not forwarded')
            ws.send(bytes([7*8+2, 0]))  # Windows broker injects the held password response.
            reply = ws.recv(timeout=8)
            if not isinstance(reply, bytes) or not reply or reply[0] != 8*8+2:
                raise ValueError('missing authenticated desktop response')
            print(json.dumps({'ok': True, 'permissions': permissions, 'noDesktopPasswordSubmitted': True}), flush=True)
        return
    if value['mode'] == 'manage':
        from gmssh_windows_bridge.controller_access import inspect_authorization, _PinnedConnection
        code = inspect_authorization(value['code'])
        connection = _PinnedConnection('192.168.250.2', code)
        try:
            connection.request('POST', '/v2/manage', body=json.dumps(value['request']).encode(), headers={'Authorization': 'Bearer '+value['owner'], 'Content-Type': 'application/json'})
            response = connection.getresponse(); result = json.loads(response.read(65536))
            print(json.dumps({'ok': response.status == 200 and result.get('ok') is True, 'result': result.get('result')}), flush=True)
        finally:
            connection.close()
        return
    client = paramiko.SSHClient()
    # The only SSH destination here is our disposable, loopback test bridge.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect('127.0.0.1', port=value['port'], username=value['username'], password=value['token'], look_for_keys=False, allow_agent=False, timeout=8)
        if value['mode'] == 'terminal':
            channel = client.get_transport().open_session()
            channel.get_pty('xterm', 100, 30)
            channel.invoke_shell()
            text = '中文'.encode()+b'\x1b[A\x03\r'; channel.sendall(text); channel.settimeout(8); data = bytearray()
            while not data.endswith(text):
                chunk = channel.recv(32768)
                if not chunk: raise ValueError('missing terminal echo')
                data.extend(chunk)
            channel.resize_pty(120, 40)
            channel.close()
            print(json.dumps({'ok': True, 'unicodeAndVT': True}), flush=True)
        else:
            command = "sh -s <<'__GMB_FAST_METRICS__'\n# __GMB_FAST_METRICS__\nignored synthetic body\n__GMB_FAST_METRICS__"
            def sample():
                _, output, _ = client.exec_command(command)
                raw = output.read()
                if b'__GMB_MEM_TOTAL_BYTES__=' not in raw: raise ValueError('missing synthetic metrics')
            sample(); print(json.dumps({'ok': True, 'metrics': True}), flush=True)
            if value['mode'] == 'monitor':
                stopped = threading.Event()
                threading.Thread(target=lambda: (sys.stdin.buffer.read(), stopped.set()), daemon=True).start()
                while not stopped.wait(2):
                    try: sample()
                    except Exception: break
    except (paramiko.SSHException, OSError):
        print(json.dumps({'ok': False, 'denied': True}), flush=True)
    finally:
        client.close()


if __name__ == '__main__':
    main()
