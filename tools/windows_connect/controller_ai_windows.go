//go:build windows

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"
)

// The tray owns the UI worker in the interactive user session. No service-session
// input injection, extra TCP listener, passwords or arbitrary script paths.
func runAIDesktop(ctx context.Context, owner string, args json.RawMessage) (any, error) {
	session, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("WTSGetActiveConsoleSessionId").Call()
	if uint32(session) == 0xffffffff {
		return nil, aiFailure("NO_INTERACTIVE_SESSION")
	}
	name, _ := syscall.UTF16PtrFromString(fmt.Sprintf(`\\.\pipe\GMSSH.AI.%d`, session))
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		if err == syscall.Errno(231) {
			return nil, aiFailure("DESKTOP_BUSY")
		}
		return nil, aiFailure("DESKTOP_WORKER_UNAVAILABLE")
	}
	file := os.NewFile(uintptr(handle), "gmssh-ai-pipe")
	defer file.Close()
	deadline, _ := ctx.Deadline()
	if deadline.IsZero() {
		deadline = time.Now().Add(8 * time.Second)
	}
	if file.SetDeadline(deadline) != nil {
		return nil, aiFailure("DESKTOP_WORKER_UNAVAILABLE")
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			file.Close()
		case <-done:
		}
	}()
	raw, _ := json.Marshal(map[string]any{"owner": owner, "request": args})
	if _, err = file.Write(append(raw, '\n')); err != nil {
		return nil, aiFailure("DESKTOP_OUTCOME_UNKNOWN")
	}
	line, err := bufio.NewReader(io.LimitReader(file, 4*1024*1024+1)).ReadBytes('\n')
	if err != nil || len(line) > 4*1024*1024 {
		return nil, aiFailure("DESKTOP_OUTCOME_UNKNOWN")
	}
	var result struct {
		OK     bool           `json:"ok"`
		Code   string         `json:"code"`
		Result map[string]any `json:"result"`
	}
	if json.Unmarshal(line, &result) != nil {
		return nil, aiFailure("INVALID_RESPONSE")
	}
	if !result.OK {
		allowed := map[string]bool{"DESKTOP_LOCKED": true, "AI_PAUSED": true, "STALE_TARGET": true, "TARGET_NOT_FOUND": true, "AMBIGUOUS_TARGET": true, "UNSUPPORTED_PATTERN": true, "FOCUS_DENIED": true, "DESKTOP_OUTCOME_UNKNOWN": true, "DESKTOP_BUSY": true, "INVALID_QUERY": true, "QUERY_FAILED": true, "PASSWORD_FIELD": true}
		if allowed[result.Code] {
			return nil, aiFailure(result.Code)
		}
		return nil, aiFailure("DESKTOP_QUERY_FAILED")
	}
	return result.Result, nil
}
