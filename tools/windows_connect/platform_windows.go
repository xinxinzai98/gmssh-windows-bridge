//go:build windows

package main

import (
	"os"
	"strings"
	"syscall"
	"unsafe"
)

type dataBlob struct {
	Size uint32
	Data *byte
}

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var protectProc = crypt32.NewProc("CryptProtectData")
var unprotectProc = crypt32.NewProc("CryptUnprotectData")
var freeProc = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
var logonProc = syscall.NewLazyDLL("advapi32.dll").NewProc("LogonUserW")

func dpapi(body []byte, encrypt bool) ([]byte, error) {
	if len(body) == 0 {
		return nil, errUnavailable
	}
	input := dataBlob{Size: uint32(len(body)), Data: &body[0]}
	var output dataBlob
	var ok uintptr
	if encrypt {
		ok, _, _ = protectProc.Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 5, uintptr(unsafe.Pointer(&output)))
	} else {
		ok, _, _ = unprotectProc.Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	}
	if ok == 0 || output.Data == nil || output.Size == 0 {
		return nil, errUnavailable
	}
	defer freeProc.Call(uintptr(unsafe.Pointer(output.Data)))
	buffer := unsafe.Slice(output.Data, int(output.Size))
	defer clear(buffer)
	return append([]byte(nil), buffer...), nil
}

func protectLocal(body []byte) ([]byte, error)   { return dpapi(body, true) }
func unprotectLocal(body []byte) ([]byte, error) { return dpapi(body, false) }

func validateLocalPassword(username, password string) error {
	name, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return errUnavailable
	}
	domain, _ := syscall.UTF16PtrFromString(".")
	secret, err := syscall.UTF16FromString(password)
	if err != nil {
		return errUnavailable
	}
	defer clear(secret)
	var token syscall.Handle
	ok, _, _ := logonProc.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&secret[0])), 3, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return errCredential
	}
	syscall.CloseHandle(token)
	return nil
}

func validatePlatformBinding(b binding) error {
	host, err := os.Hostname()
	if err != nil {
		return errMachineBinding
	}
	sid, _, _, err := syscall.LookupSID("", host+"\\"+b.Username)
	if err != nil {
		return errAccountBinding
	}
	text, err := sid.String()
	if err != nil || text != b.ManagedSID {
		return errAccountBinding
	}
	if (b.RequireAdministrator || strings.EqualFold(b.Username, "gmssh")) && !existingLocalAdministrator(b.Username) {
		return errAdminBinding
	}
	return nil
}

// Query account membership, rather than the caller's potentially UAC-filtered token.
func existingLocalAdministrator(username string) bool {
	administrators, err := syscall.StringToSid("S-1-5-32-544")
	if err != nil {
		return false
	}
	name, _, _, err := administrators.LookupAccount("")
	if err != nil {
		return false
	}
	user, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return false
	}
	api := syscall.NewLazyDLL("netapi32.dll")
	var buffer uintptr
	var entries, total uint32
	result, _, _ := api.NewProc("NetUserGetLocalGroups").Call(0, uintptr(unsafe.Pointer(user)), 0, 1, uintptr(unsafe.Pointer(&buffer)), 0xffffffff, uintptr(unsafe.Pointer(&entries)), uintptr(unsafe.Pointer(&total)))
	if buffer != 0 {
		defer api.NewProc("NetApiBufferFree").Call(buffer)
	}
	if result != 0 || buffer == 0 || entries > 4096 {
		return false
	}
	type groupName struct{ name *uint16 }
	for _, group := range unsafe.Slice((*groupName)(unsafe.Pointer(buffer)), int(entries)) {
		if group.name == nil {
			return false
		}
		var units []uint16
		for i := 0; i < 257; i++ {
			value := *(*uint16)(unsafe.Add(unsafe.Pointer(group.name), uintptr(i)*2))
			if value == 0 {
				break
			}
			units = append(units, value)
		}
		if len(units) > 256 {
			return false
		}
		if strings.EqualFold(syscall.UTF16ToString(units), name) {
			return true
		}
	}
	return false
}
