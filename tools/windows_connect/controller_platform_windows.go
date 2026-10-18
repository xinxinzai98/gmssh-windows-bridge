//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

func isReparsePoint(name string) bool {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return true
	}
	attrs, err := syscall.GetFileAttributes(p)
	return err != nil || attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}
func renameControllerFile(old, new string) error {
	a, err := syscall.UTF16PtrFromString(old)
	if err != nil {
		return err
	}
	b, err := syscall.UTF16PtrFromString(new)
	if err != nil {
		return err
	}
	return syscall.MoveFile(a, b)
}
func controllerDrives() []string {
	mask, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetLogicalDrives").Call()
	result := []string{}
	for i := 0; i < 26; i++ {
		if mask&(1<<i) != 0 {
			result = append(result, string(rune('A'+i))+":/")
		}
	}
	return result
}

type limitedOutput struct {
	body   bytes.Buffer
	cancel context.CancelFunc
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	if w.body.Len()+len(p) > 256*1024 {
		w.cancel()
		return 0, errors.New("OUTPUT_LIMIT")
	}
	return w.body.Write(p)
}

func runControllerCommand(ctx context.Context, username, password, kind, command string) ([]byte, int, error) {
	name, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return nil, 0, errUnavailable
	}
	domain, _ := syscall.UTF16PtrFromString(".")
	secret, err := syscall.UTF16FromString(password)
	if err != nil {
		return nil, 0, errUnavailable
	}
	defer clear(secret)
	var token syscall.Handle
	ok, _, _ := logonProc.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&secret[0])), 2, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return nil, 0, errDenied
	}
	defer syscall.CloseHandle(token)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	system := filepath.Join(os.Getenv("SystemRoot"), "System32")
	var cmd *exec.Cmd
	if kind == "power" {
		args := map[string][]string{"restart": {"/r", "/t", "0"}, "shutdown": {"/s", "/t", "0"}, "cancel": {"/a"}}[command]
		if args == nil {
			return nil, 0, errDenied
		}
		cmd = exec.CommandContext(ctx, filepath.Join(system, "shutdown.exe"), args...)
	} else if kind == "terminal" {
		units := utf16.Encode([]rune("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + command))
		raw := make([]byte, len(units)*2)
		for i, v := range units {
			binary.LittleEndian.PutUint16(raw[i*2:], v)
		}
		cmd = exec.CommandContext(ctx, filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
		clear(raw)
	} else {
		return nil, 0, errDenied
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Token: syscall.Token(token), HideWindow: true}
	output := &limitedOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = output
	err = cmd.Run()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if ctx.Err() != nil {
		return nil, code, ctx.Err()
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil, code, err
	}
	return output.body.Bytes(), code, nil
}

func runControllerInfo(ctx context.Context, file, prefix string) ([]byte, error) {
	// Only a fixed, service-owned script name from infoScript reaches this function.
	script := prefix
	if file != "" {
		executable, err := os.Executable()
		if err != nil {
			return nil, err
		}
		name := filepath.Join(filepath.Dir(executable), file)
		info, err := os.Lstat(name)
		if err != nil || !info.Mode().IsRegular() || info.Size() > 128*1024 || isReparsePoint(name) {
			return nil, errUnavailable
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			return nil, err
		}
		script += string(bytes.TrimPrefix(raw, []byte{239, 187, 191}))
	}
	bootstrap := "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))"
	units := utf16.Encode([]rune(bootstrap))
	raw := make([]byte, len(units)*2)
	for i, v := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], v)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Stdin = strings.NewReader(script)
	output := &limitedOutput{cancel: cancel}
	cmd.Stdout = output
	cmd.Stderr = output
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return output.body.Bytes(), nil
}
