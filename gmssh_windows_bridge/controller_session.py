"""Native GMSSH compatibility using revocable HTTPS grants instead of SSH passwords."""
from pathlib import Path

import paramiko

from .bridge import Session, metric_mode, login_probe
from .controller_access import ControllerClient, configuration
from .pairing import inspect_connection


class ControllerSession(Session):
    def check_auth_password(self, username, password):
        self.attempts += 1
        if username != self.config.username or self.attempts > 3 or not isinstance(password, str) or len(password) != 43:
            return paramiko.AUTH_FAILED
        client = None
        try:
            from .network_routes import select_route, record_route
            target = select_route(self.config)
            client = ControllerClient(target, self.config.controller_configuration, token=password)
            client.authorize()
            record_route(self.config, client, target)
        except Exception as error:
            if client is not None: client.close()
            pool = getattr(self.config, 'desktop_sessions', None)
            if pool is not None:
                code = getattr(error, 'code', '')
                pool.record_failure('BadHostKeyException' if code == 'PEER_CHANGED' else 'AuthenticationException' if code == 'AUTH_FAILED' else 'NoValidConnectionsError')
            return paramiko.AUTH_FAILED
        if self.remote:
            self.close_remote()
        self.remote = client
        if getattr(self.config, 'desktop_sessions', None) is not None:
            self.config.desktop_sessions.attach(client)
        return paramiko.AUTH_SUCCESSFUL

    def check_channel_pty_request(self, *args):
        if not self.remote or not self.remote.policy.get('terminal'):
            return False
        return super().check_channel_pty_request(*args)

    def check_channel_exec_request(self, channel, command):
        if (metric_mode(command) is None and not login_probe(command) and command.strip() not in (b'id -nu', b'id -un')
                and (not self.remote or not self.remote.policy.get('terminal'))):
            return self.enqueue(channel, 'unsupported')
        return super().check_channel_exec_request(channel, command)

    def check_channel_shell_request(self, channel):
        return bool(self.remote and self.remote.policy.get('terminal') and super().check_channel_shell_request(channel))


def prepare(config):
    file = Path(config.controller_connection)
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 65536:
        raise ValueError('独立授权的本机配置不可读。')
    connection = inspect_connection(file.read_text(encoding='utf-8'))
    code = configuration(connection)
    if config.username != code['public']['username'] or config.target not in code['public']['addresses']:
        raise ValueError('独立授权的本机入口与目标不一致。')
    config.controller_configuration = code
    config.session_factory = ControllerSession
    config.gmssh_terminal = config.enable_terminal = True
    config.shell = 'powershell'

    def policy():
        pool = getattr(config, 'desktop_sessions', None)
        if pool is not None:
            with pool.changed:
                for client in reversed(pool.clients):
                    if getattr(client, 'controller_protocol', None) == 2 and client.is_active():
                        return dict(client.policy)
        return dict(code['controller']['permissions'])
    config.controller_policy = policy
