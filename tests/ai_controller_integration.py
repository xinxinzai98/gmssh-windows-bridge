"""Opt-in real pinned-TLS Python/Go AI integration; all data/peers are disposable."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from gmssh_windows_bridge.ai import Registry, Operations
from gmssh_windows_bridge.connection_code import _PinnedConnection
from gmssh_windows_bridge.controller_access import ControllerClient, configuration
from gmssh_windows_bridge.pairing import inspect_connection
from gmssh_windows_bridge.file_stream import StreamError


def run(go):
    if os.name == 'nt':
        raise ValueError('This disposable process-group harness runs on Unix controllers')
    repo = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix='gmssh-ai-integration-') as temporary:
        root = Path(temporary)
        env = {**os.environ, 'GMSSH_CONTROLLER_FIXTURE': str(root), 'GO111MODULE': 'off'}
        with (root/'gateway.log').open('w') as log:
            process = subprocess.Popen([go, 'test', '-run', '^TestControllerLoopbackFixture$', '-count=1'], cwd=repo/'tools'/'windows_connect', env=env, stdout=log, stderr=log, start_new_session=True)
            try:
                for _ in range(400):
                    if (root/'gateway.json').is_file():
                        break
                    if process.poll() is not None:
                        raise ValueError('Disposable Go fixture did not start')
                    time.sleep(.05)
                value = json.loads((root/'gateway.json').read_text())
                full_code, view_code = value['full']['code'], value['view']['code']
                port = value['port']

                class LocalPinned(_PinnedConnection):
                    def __init__(self, target, code):
                        if target != '192.168.250.2':
                            raise ValueError('Only the synthetic peer is allowed')
                        super().__init__('127.0.0.1', {**code, 'port': port})

                @contextmanager
                def connector(registry, device):
                    public = inspect_connection(json.dumps(device['connection']))
                    client = ControllerClient('192.168.250.2', configuration(public), token=registry.credential(device))
                    try:
                        client.ai_capabilities = client.authorize()
                        original_call = client.call
                        def traced_call(action, *args, **kwargs):
                            try:
                                return original_call(action, *args, **kwargs)
                            except StreamError as error:
                                print(json.dumps({'syntheticFailedAction': action, 'code': error.code,
                                                  'fileArgs': {key: value for key, value in kwargs.get('args', {}).items() if key in {'path', 'target', 'mode', 'handle', 'length', 'offset'}}}), file=sys.stderr)
                                raise
                        client.call = traced_call
                        yield client
                    finally:
                        client.close()

                registry = Registry(root/'ai')
                full = registry.enroll(full_code, 'Synthetic full', ['inspect', 'terminal', 'files', 'view', 'input'], env='GMSSH_AI_TEST_FULL')
                view = registry.enroll(view_code, 'Synthetic view', ['inspect', 'terminal', 'files', 'view', 'input'], env='GMSSH_AI_TEST_VIEW')
                readonly = registry.enroll(value['readonly']['code'], 'Synthetic server read-only', ['files'], env='GMSSH_AI_TEST_READONLY')
                tokens = {'GMSSH_AI_TEST_FULL': value['full']['code'], 'GMSSH_AI_TEST_VIEW': value['view']['code'], 'GMSSH_AI_TEST_READONLY': value['readonly']['code']}
                from gmssh_windows_bridge.controller_access import inspect_authorization
                tokens = {name: inspect_authorization(code)['controller']['token'] for name, code in tokens.items()}
                checks = []
                with patch.dict(os.environ, tokens), patch('gmssh_windows_bridge.controller_access._PinnedConnection', LocalPinned):
                    operations = Operations(registry, connector)
                    def call(tool, device=full['id'], **args):
                        reply = operations.call(tool, {'device': device, **args})
                        if not reply['ok']:
                            raise ValueError(tool+': '+reply['error']['code'])
                        return reply['result']

                    assert call('device_context')['environment']['computer'] == 'LAB-PC'
                    checks.append('pinned TLS environment query')
                    task = call('powershell_run', script='synthetic-ai-exit-7', requestKey='1'*32)
                    result = call('task_wait', taskId=task['taskId'], timeout=5)
                    assert result['finished'] and not result['waitTimedOut']
                    assert result['exitCode'] == 7 and '中文' in result['output']
                    assert call('powershell_run', script='synthetic-ai-exit-7', requestKey='1'*32)['taskId'] == task['taskId']
                    checks.append('async exit, UTF-8 output and reconnect deduplication')
                    persisted = Operations(Registry(registry.root), connector)
                    history = persisted.call('tasks_list', {'device': full['id']})['result']
                    assert history['tasks'][0]['taskId'] == task['taskId'] and history['tasks'][0]['exitCode'] == 7
                    assert history['remoteStateChecked'] is False
                    assert not call('tasks_list', device=view['id'])['tasks']
                    checks.append('restart-safe local receipts isolated by authorization')
                    waiting = call('powershell_run', script='synthetic-ai-wait', requestKey='2'*32)
                    call('task_cancel', taskId=waiting['taskId'])
                    for _ in range(100):
                        result = call('task_get', taskId=waiting['taskId'])
                        if result['state'] == 'cancelled': break
                        time.sleep(.01)
                    assert result['state'] == 'cancelled'
                    checks.append('remote cancellation')
                    original = call('files_read', path='C:/source.txt')
                    call('files_preview', path='C:/source.txt', content='changed 中文\n', expectedSha256=original['sha256'])
                    applied = call('files_apply', path='C:/source.txt', content='changed 中文\n', expectedSha256=original['sha256'])
                    assert call('files_read', path='C:/source.txt')['text'] == 'changed 中文\n'
                    call('files_restore', path='C:/source.txt', backup=applied['backup'], backupSha256=original['sha256'], expectedSha256=applied['sha256'])
                    assert call('files_read', path='C:/source.txt')['sha256'] == original['sha256']
                    checks.append('controller SFTP read, diff, apply and backup restore')
                    long_content = '中文🙂'*9000+'\n'
                    long_edit = call('files_apply', path='C:/source.txt', content=long_content, expectedSha256=original['sha256'])
                    page = call('files_read', path='C:/source.txt', limit=1)
                    assert page['truncated'] and page['nextByte'] is not None
                    text = page['text']
                    while page['nextByte'] is not None:
                        page = call('files_read', path='C:/source.txt', startByte=page['nextByte'], expectedSha256=long_edit['sha256'])
                        text += page['text']
                    assert text == long_content
                    call('files_restore', path='C:/source.txt', backup=long_edit['backup'], backupSha256=original['sha256'], expectedSha256=long_edit['sha256'])
                    checks.append('whole UTF-8 long-line continuation over controller SFTP')
                    content = '\ufeffname=测试\r\nport=22257\r\n'
                    created = call('files_create', path='C:/new-config.txt', content=content)
                    found = call('files_find_text', path='C:/new-config.txt', query='port=22257')
                    assert found['items'][0]['line'] == 2 and found['sha256'] == created['sha256']
                    preview = call('files_replace_preview', path='C:/new-config.txt', oldText='port=22257', newText='port=22258', expectedSha256=created['sha256'])
                    assert preview['changed'] and not preview['bomChanged']
                    assert call('files_read', path='C:/new-config.txt')['sha256'] == created['sha256']
                    replaced = call('files_replace', path='C:/new-config.txt', oldText='port=22257', newText='port=22258', expectedSha256=created['sha256'])
                    assert call('files_find_text', path='C:/new-config.txt', query='port=22258')['sha256'] == replaced['sha256']
                    conflict = operations.call('files_create', {'device': full['id'], 'path': 'C:/new-config.txt', 'content': 'must not overwrite'})
                    assert not conflict['ok'] and conflict['error']['code'] == 'ALREADY_EXISTS'
                    call('files_restore', path='C:/new-config.txt', backup=replaced['backup'], backupSha256=created['sha256'], expectedSha256=replaced['sha256'])
                    assert call('files_read', path='C:/new-config.txt')['sha256'] == created['sha256']
                    checks.append('verified create, literal search, precise edit and no-overwrite over controller SFTP')
                    registry.configure(full['id'], ['files_read'])
                    catalog = call('device_tools')
                    assert catalog['readOnly'] and catalog['remoteStateChecked'] is False
                    assert 'files_apply' not in {row['name'] for row in catalog['tools']}
                    access = call('device_access_check')
                    assert access['code'] == 'OK' and access['effective']['files_read'] and not access['effective']['files']
                    assert call('files_find_text', path='C:/new-config.txt', query='port=22257')['sha256'] == created['sha256']
                    readonly_preview = call('files_replace_preview', path='C:/new-config.txt', oldText='port=22257', newText='port=22258', expectedSha256=created['sha256'])
                    assert readonly_preview['changed']
                    for tool, args in [('files_replace', {'path':'C:/new-config.txt','oldText':'port=22257','newText':'port=22258','expectedSha256':created['sha256']}),
                                       ('files_create', {'path':'C:/denied-new.txt','content':'blocked'}), ('powershell_run', {'script':'blocked'})]:
                        denied = operations.call(tool, {'device':full['id'], **args})
                        assert not denied['ok'] and denied['error']['code'] == 'ACCESS_DENIED'
                    assert call('files_read', path='C:/new-config.txt')['sha256'] == created['sha256']
                    checks.append('local read-only profile permits previews, blocks writes and intersects server file grants')
                    server_access = call('device_access_check', device=readonly['id'])
                    assert server_access['features']['serverFileAccess'] == 'read-only'
                    assert server_access['effective']['files_read'] and not server_access['effective']['files']
                    observed = call('files_read', device=readonly['id'], path='C:/source.txt')
                    assert observed['sha256'] == original['sha256']
                    call('files_replace_preview', device=readonly['id'], path='C:/source.txt', oldText=observed['text'], newText='preview only', expectedSha256=observed['sha256'])
                    for tool,args in [('files_create', {'path':'C:/server-denied.txt','content':'denied'}),
                                      ('files_replace', {'path':'C:/source.txt','oldText':observed['text'],'newText':'denied','expectedSha256':observed['sha256']})]:
                        denied = operations.call(tool, {'device':readonly['id'], **args})
                        assert not denied['ok'] and denied['error']['code'] == 'ACCESS_DENIED', denied
                    assert call('files_read', device=readonly['id'], path='C:/source.txt')['sha256'] == original['sha256']
                    checks.append('server-enforced read-only blocks writes even when the local client permits them')
                    for tool, args in [('powershell_run', {'script': 'untrusted'}), ('files_read', {'path': 'C:/source.txt'}),
                                       ('files_find_text', {'path': 'C:/source.txt', 'query': 'one'}), ('files_create', {'path': 'C:/denied.txt', 'content': 'denied'}),
                                       ('files_replace_preview', {'path': 'C:/source.txt', 'oldText': 'one', 'newText': 'two', 'expectedSha256': original['sha256']}),
                                       ('files_replace', {'path': 'C:/source.txt', 'oldText': 'one', 'newText': 'two', 'expectedSha256': original['sha256']}),
                                       ('desktop_act', {'snapshot': 'a'*32, 'target': 'b'*32, 'action': 'invoke'})]:
                        denied = operations.call(tool, {'device': view['id'], **args})
                        assert not denied['ok'] and denied['error']['code'] == 'ACCESS_DENIED', (tool, denied)
                    checks.append('server-side view-only permission isolation')
                return {'ok': True, 'scope': 'disposable loopback only; no Windows native execution', 'checks': checks}
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--go', default='go')
    print(json.dumps(run(parser.parse_args().go)))
