//go:build windows

package main

// Windows pseudoconsole bindings follow Microsoft's documented lifecycle:
// https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session
// Handles stay in the service; a job object terminates this shell's descendants.
import (
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var consoleKernel = syscall.NewLazyDLL("kernel32.dll")
var createConsole = consoleKernel.NewProc("CreatePseudoConsole")
var resizeConsole = consoleKernel.NewProc("ResizePseudoConsole")
var closeConsole = consoleKernel.NewProc("ClosePseudoConsole")
var initializeAttributes = consoleKernel.NewProc("InitializeProcThreadAttributeList")
var updateAttribute = consoleKernel.NewProc("UpdateProcThreadAttribute")
var deleteAttributes = consoleKernel.NewProc("DeleteProcThreadAttributeList")
var createProcessAsUser = syscall.NewLazyDLL("advapi32.dll").NewProc("CreateProcessAsUserW")
var createJob = consoleKernel.NewProc("CreateJobObjectW")
var configureJob = consoleKernel.NewProc("SetInformationJobObject")
var assignJob = consoleKernel.NewProc("AssignProcessToJobObject")
var resumeThread = consoleKernel.NewProc("ResumeThread")

type consoleStartup struct {
	Info       syscall.StartupInfo
	Attributes uintptr
}
type jobBasicLimits struct {
	ProcessTime, JobTime int64
	Flags                uint32
	Minimum, Maximum     uintptr
	Processes            uint32
	Affinity             uintptr
	Priority, Scheduling uint32
}
type jobLimits struct {
	Basic                                                      jobBasicLimits
	IO                                                         [6]uint64
	ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory uintptr
}
type windowsTerminal struct {
	console       uintptr
	process, job  syscall.Handle
	input, output *os.File
	once          sync.Once
	mu            sync.RWMutex
	closed        bool
}

func consoleSize(width, height int) uintptr {
	return uintptr(uint32(uint16(width)) | uint32(uint16(height))<<16)
}

func openControllerTerminal(username, password string, width, height int) (pseudoTerminal, error) {
	if width < 1 || width > 512 || height < 1 || height > 512 || createConsole.Find() != nil || resizeConsole.Find() != nil || closeConsole.Find() != nil {
		return nil, errUnavailable
	}
	name, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return nil, errDenied
	}
	domain, _ := syscall.UTF16PtrFromString(".")
	secret, err := syscall.UTF16FromString(password)
	if err != nil {
		return nil, errDenied
	}
	defer clear(secret)
	var token syscall.Handle
	ok, _, _ := logonProc.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&secret[0])), 2, 0, uintptr(unsafe.Pointer(&token)))
	if ok == 0 {
		return nil, errDenied
	}
	defer syscall.CloseHandle(token)
	var ptyInput, input, output, ptyOutput syscall.Handle
	if err = syscall.CreatePipe(&ptyInput, &input, nil, 0); err != nil {
		return nil, err
	}
	if err = syscall.CreatePipe(&output, &ptyOutput, nil, 0); err != nil {
		syscall.CloseHandle(ptyInput)
		syscall.CloseHandle(input)
		return nil, err
	}
	var console uintptr
	ret, _, _ := createConsole.Call(consoleSize(width, height), uintptr(ptyInput), uintptr(ptyOutput), 0, uintptr(unsafe.Pointer(&console)))
	syscall.CloseHandle(ptyInput)
	syscall.CloseHandle(ptyOutput)
	if ret != 0 {
		syscall.CloseHandle(input)
		syscall.CloseHandle(output)
		return nil, errUnavailable
	}
	terminal := &windowsTerminal{console: console, input: os.NewFile(uintptr(input), "console-input"), output: os.NewFile(uintptr(output), "console-output")}
	complete := false
	defer func() {
		if !complete {
			terminal.Close()
		}
	}()
	var size uintptr
	initializeAttributes.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	if size == 0 || size > 1024*1024 {
		return nil, errUnavailable
	}
	attributes := make([]byte, size)
	ok, _, _ = initializeAttributes.Call(uintptr(unsafe.Pointer(&attributes[0])), 1, 0, uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return nil, errUnavailable
	}
	defer deleteAttributes.Call(uintptr(unsafe.Pointer(&attributes[0])))
	ok, _, _ = updateAttribute.Call(uintptr(unsafe.Pointer(&attributes[0])), 0, 0x20016, console, unsafe.Sizeof(console), 0, 0)
	if ok == 0 {
		return nil, errUnavailable
	}
	startup := consoleStartup{}
	startup.Info.Cb = uint32(unsafe.Sizeof(startup))
	startup.Attributes = uintptr(unsafe.Pointer(&attributes[0]))
	program := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	application, _ := syscall.UTF16PtrFromString(program)
	bootstrap := "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;function global:prompt {'PS '+(Get-Location).Path+'> '}"
	units := utf16.Encode([]rune(bootstrap))
	script := make([]byte, len(units)*2)
	for i, v := range units {
		binary.LittleEndian.PutUint16(script[i*2:], v)
	}
	command, _ := syscall.UTF16FromString("\"" + program + "\" -NoLogo -NoProfile -NoExit -EncodedCommand " + base64.StdEncoding.EncodeToString(script))
	directory, _ := syscall.UTF16PtrFromString(filepath.Join(os.Getenv("SystemRoot"), "System32"))
	var process syscall.ProcessInformation
	userenv := syscall.NewLazyDLL("userenv.dll")
	var environment uintptr
	created, _, _ := userenv.NewProc("CreateEnvironmentBlock").Call(uintptr(unsafe.Pointer(&environment)), uintptr(token), 0)
	if created == 0 {
		return nil, errUnavailable
	}
	defer userenv.NewProc("DestroyEnvironmentBlock").Call(environment)
	ok, _, _ = createProcessAsUser.Call(uintptr(token), uintptr(unsafe.Pointer(application)), uintptr(unsafe.Pointer(&command[0])), 0, 0, 0, 0x00080000|0x00000400|0x00000004, environment, uintptr(unsafe.Pointer(directory)), uintptr(unsafe.Pointer(&startup)), uintptr(unsafe.Pointer(&process)))
	runtime.KeepAlive(attributes)
	if ok == 0 {
		return nil, errUnavailable
	}
	terminal.process = process.Process
	defer syscall.CloseHandle(process.Thread)
	job, _, _ := createJob.Call(0, 0)
	if job == 0 {
		return nil, errUnavailable
	}
	terminal.job = syscall.Handle(job)
	limits := jobLimits{}
	limits.Basic.Flags = 0x2000
	ok, _, _ = configureJob.Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		return nil, errUnavailable
	}
	ok, _, _ = assignJob.Call(job, uintptr(process.Process))
	if ok == 0 {
		return nil, errUnavailable
	}
	resumed, _, _ := resumeThread.Call(uintptr(process.Thread))
	if resumed == 0xffffffff {
		return nil, errUnavailable
	}
	complete = true
	return terminal, nil
}
func (t *windowsTerminal) Read(raw []byte) (int, error)  { return t.output.Read(raw) }
func (t *windowsTerminal) Write(raw []byte) (int, error) { return t.input.Write(raw) }
func (t *windowsTerminal) Resize(width, height int) error {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.closed {
		return errUnavailable
	}
	if width < 1 || width > 512 || height < 1 || height > 512 {
		return errDenied
	}
	ret, _, _ := resizeConsole.Call(t.console, consoleSize(width, height))
	if ret != 0 {
		return errUnavailable
	}
	return nil
}
func (t *windowsTerminal) ExitCode() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.closed {
		return -1
	}
	if t.process == 0 {
		return -1
	}
	var code uint32
	if syscall.GetExitCodeProcess(t.process, &code) != nil || code == 259 {
		return -1
	}
	return int(code)
}
func (t *windowsTerminal) Close() error {
	t.once.Do(func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		t.closed = true
		if t.job != 0 {
			syscall.CloseHandle(t.job)
		}
		if t.process != 0 {
			syscall.TerminateProcess(t.process, 1)
		}
		if t.input != nil {
			t.input.Close()
		}
		if t.output != nil {
			t.output.Close()
		}
		if t.console != 0 {
			closeConsole.Call(t.console)
		}
		if t.process != 0 {
			syscall.CloseHandle(t.process)
		}
	})
	return nil
}
