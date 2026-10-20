"""Optional macOS password storage, limited to this viewer's fixed target."""

import ctypes as c
import hashlib
import json

import paramiko

from .address import normalize_address, ssh_endpoint

SERVICE = b"gmssh-windows-bridge.desktop"


def monitor_keychain(config, factory=None):
    """Bind managed viewers to their pinned SSH identity, with verified old aliases."""
    factory = factory or DesktopKeychain
    old = f'ssh:{config.username.casefold()}@{config.target.casefold()}:{config.target_port}:{config.rustdesk_port}'
    hosts = paramiko.HostKeys(str(config.known_hosts))
    entry = hosts.lookup(ssh_endpoint(config.target, config.target_port))
    key = entry.get('ssh-ed25519') if entry else None
    if key is None:
        return factory(old)  # Preserve CLI profiles using other SSH host-key types.
    identifier = hashlib.sha256(key.asbytes() + b'\0' + config.username.lower().encode() + config.target_port.to_bytes(2, 'big')).hexdigest()[:32]
    accounts = [old]
    for target in getattr(config, 'desktop_credential_alias', ()):
        target = normalize_address(target)
        alias = hosts.lookup(ssh_endpoint(target, config.target_port))
        # An unverified endpoint must never select another machine's saved password.
        if alias and alias.get('ssh-ed25519') == key:
            accounts.append(f'ssh:{config.username.casefold()}@{target.casefold()}:{config.target_port}:{config.rustdesk_port}')
    primary = factory(f'ssh-device:{identifier}:{config.rustdesk_port}')
    return DeviceKeychain(primary, [factory(account) for account in dict.fromkeys(accounts)])


class DeviceKeychain:
    def __init__(self, primary, previous):
        self.primary, self.previous = primary, previous

    def exists(self):
        return any(store.exists() for store in [self.primary, *self.previous])

    def get(self):
        for store in [self.primary, *self.previous]:
            password = store.get()
            if password:
                return password
        return None

    def save(self, password):
        # Called only by the existing successful desktop-authentication flow.
        self.primary.save(password)


class WindowsLoginKeychain:
    """A separate opt-in item; never alias the remote-connection password."""
    def __init__(self, store):
        self.store = store

    @staticmethod
    def validate(value):
        if (not isinstance(value, dict) or set(value) != {'password', 'autoUnlock'} or
                type(value['autoUnlock']) is not bool or not isinstance(value['password'], str) or
                not 1 <= len(value['password'].encode('utf-8')) <= 1024 or
                any(ord(c) < 32 or ord(c) == 127 for c in value['password'])):
            raise ValueError('Invalid Windows login settings')
        return value

    def get(self):
        raw = self.store.get()
        return self.validate(json.loads(raw)) if raw is not None else None

    def save(self, value):
        self.store.save(json.dumps(self.validate(value), ensure_ascii=False, separators=(',', ':')))

    def clear(self):
        self.store.delete()


def windows_login_keychain(desktop_store, authorization=None):
    primary = desktop_store.primary if isinstance(desktop_store, DeviceKeychain) else desktop_store
    identity = primary.account.decode('utf-8')
    if authorization is not None:
        # Grant transport verifies TLS, not possession of the advertised SSH
        # private key. Include that actual authority and grant identity too.
        authority = json.dumps({'certificate': authorization['certificate'], 'id': authorization['id']}, sort_keys=True)
        identity += ':' + hashlib.sha256(authority.encode('utf-8')).hexdigest()
    return WindowsLoginKeychain(DesktopKeychain('windows-login:' + identity))


class DesktopKeychain:
    def __init__(self, account):
        self.account = account.encode("utf-8")
        self.security = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
        self.cf = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.cf.CFRelease.argtypes = [c.c_void_p]
        self.cf.CFRelease.restype = None
        self.security.SecKeychainFindGenericPassword.argtypes = [c.c_void_p, c.c_uint32, c.c_char_p,
            c.c_uint32, c.c_char_p, c.POINTER(c.c_uint32), c.POINTER(c.c_void_p), c.POINTER(c.c_void_p)]
        self.security.SecKeychainAddGenericPassword.argtypes = [c.c_void_p, c.c_uint32, c.c_char_p,
            c.c_uint32, c.c_char_p, c.c_uint32, c.c_void_p, c.c_void_p]
        self.security.SecKeychainItemModifyAttributesAndData.argtypes = [c.c_void_p, c.c_void_p, c.c_uint32, c.c_void_p]
        self.security.SecKeychainItemDelete.argtypes = [c.c_void_p]
        self.security.SecKeychainItemFreeContent.argtypes = [c.c_void_p, c.c_void_p]

    def _find(self, length=None, data=None, item=None):
        return self.security.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE,
            len(self.account), self.account, length, data, item)

    def exists(self):
        item = c.c_void_p()
        try:
            result = self._find(item=c.byref(item))
            if result == -25300:
                return False
            if result:
                raise OSError("macOS Keychain metadata access failed")
            return True
        finally:
            if item.value:
                self.cf.CFRelease(item)

    def get(self):
        length, data = c.c_uint32(), c.c_void_p()
        result = self._find(c.byref(length), c.byref(data))
        if result == -25300:  # errSecItemNotFound
            return None
        if result:
            raise OSError("macOS Keychain access failed")
        try:
            if not 1 <= length.value <= 4096:
                raise ValueError("invalid saved desktop credential")
            return c.string_at(data, length.value).decode("utf-8")
        finally:
            c.memset(data, 0, length.value)
            self.security.SecKeychainItemFreeContent(None, data)

    def save(self, password):
        encoded = password.encode("utf-8")
        if not 1 <= len(encoded) <= 4096:
            raise ValueError("invalid desktop credential")
        buffer = c.create_string_buffer(encoded)
        item = c.c_void_p()
        try:
            result = self._find(item=c.byref(item))
            if result == -25300:
                result = self.security.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE,
                    len(self.account), self.account, len(encoded), buffer, None)
            elif result == 0:
                result = self.security.SecKeychainItemModifyAttributesAndData(item, None, len(encoded), buffer)
            if result:
                raise OSError("macOS Keychain save failed")
        finally:
            c.memset(buffer, 0, len(buffer))
            if item.value:
                self.cf.CFRelease(item)

    def delete(self):
        item = c.c_void_p()
        try:
            result = self._find(item=c.byref(item))
            if result == -25300:
                return
            if result or self.security.SecKeychainItemDelete(item):
                raise OSError('macOS Keychain delete failed')
        finally:
            if item.value:
                self.cf.CFRelease(item)
