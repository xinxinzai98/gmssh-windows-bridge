package main

import (
	"errors"
	"io"
	"sync"
	"time"
)

type pseudoTerminal interface {
	io.ReadWriteCloser
	Resize(int, int) error
	ExitCode() int
}
type terminalSession struct {
	pty             pseudoTerminal
	output          chan []byte
	done            chan struct{}
	once            sync.Once
	readMu, writeMu sync.Mutex
}

func newTerminalSession(pty pseudoTerminal) *terminalSession {
	t := &terminalSession{pty: pty, output: make(chan []byte, 2), done: make(chan struct{})}
	go func() {
		defer close(t.output)
		for {
			raw := make([]byte, 8192)
			n, err := pty.Read(raw)
			if n > 0 {
				select {
				case t.output <- raw[:n]:
				case <-t.done:
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return t
}
func (t *terminalSession) close() { t.once.Do(func() { close(t.done); t.pty.Close() }) }
func (t *terminalSession) read() (any, error) {
	t.readMu.Lock()
	defer t.readMu.Unlock()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case raw, ok := <-t.output:
		select {
		case <-t.done:
			return nil, errors.New("TERMINAL_CLOSED")
		default:
		}
		if !ok {
			return map[string]any{"closed": true, "exit": t.pty.ExitCode()}, nil
		}
		return map[string]any{"data": raw}, nil
	case <-timer.C:
		return map[string]bool{"waiting": true}, nil
	case <-t.done:
		return nil, errors.New("TERMINAL_CLOSED")
	}
}
func (t *terminalSession) write(raw []byte) (any, error) {
	if len(raw) > 8192 {
		return nil, errDenied
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	remaining := raw
	for len(remaining) > 0 {
		n, err := t.pty.Write(remaining)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, io.ErrShortWrite
		}
		remaining = remaining[n:]
	}
	return map[string]int{"written": len(raw)}, nil
}
