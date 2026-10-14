package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"syscall"
	"unsafe"
)

//go:embed setup.zip
var payload []byte

var shell = syscall.NewLazyDLL("shell32.dll")
var messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")

func wide(value string) *uint16 {
	p, err := syscall.UTF16PtrFromString(value)
	if err != nil {
		panic(err)
	}
	return p
}

func showError(err error) {
	message, title := wide("安装未完成："+err.Error()), wide("GMSSH Windows")
	messageBox.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}

func systemDirectory() (string, error) {
	buffer := make([]uint16, 32768)
	n, _, err := syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemDirectoryW").Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	if n == 0 || n >= uintptr(len(buffer)) {
		return "", fmt.Errorf("cannot find Windows system directory: %v", err)
	}
	return syscall.UTF16ToString(buffer[:n]), nil
}

func install() error {
	user := os.Getenv("USERNAME")
	if len(os.Args) == 3 && os.Args[1] == "--windows-user" { user = os.Args[2] }
	if !regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,64}$`).MatchString(user) { return fmt.Errorf("当前版本需要使用英文或数字名称的本机 Windows 账号") }
	admin, _, _ := shell.NewProc("IsUserAnAdmin").Call()
	if admin == 0 {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		verb, target, arguments := wide("runas"), wide(executable), wide("--windows-user "+user)
		result, _, _ := shell.NewProc("ShellExecuteW").Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(target)), uintptr(unsafe.Pointer(arguments)), 0, 1)
		if result <= 32 {
			return fmt.Errorf("管理员授权已取消或未完成")
		}
		return nil
	}
	system, err := systemDirectory()
	if err != nil {
		return err
	}
	root, err := os.MkdirTemp("", "gmssh-windows-setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(root)
	// Lock the elevated staging directory before writing executable scripts.
	for _, args := range [][]string{
		{root, "/setowner", "*S-1-5-32-544"},
		{root, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"},
	} {
		command := exec.Command(filepath.Join(system, "icacls.exe"), args...)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := command.Run(); err != nil {
			return fmt.Errorf("cannot secure installer directory: %w", err)
		}
	}
	if err := extractSetup(payload, root); err != nil {
		return err
	}
	command := exec.Command(filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
		"-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(root, "setup-windows.ps1"), "-WindowsUser", user)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	command.Dir = root
	if err := command.Run(); err != nil {
		return fmt.Errorf("请检查安装窗口报告的错误：%w", err)
	}
	return nil
}

func main() {
	if err := install(); err != nil {
		showError(err)
		os.Exit(1)
	}
}
