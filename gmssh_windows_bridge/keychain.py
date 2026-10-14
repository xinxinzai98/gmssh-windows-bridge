"""Optional macOS password storage, limited to this viewer's fixed target."""

import ctypes as c

SERVICE = b"gmssh-windows-bridge.desktop"


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
