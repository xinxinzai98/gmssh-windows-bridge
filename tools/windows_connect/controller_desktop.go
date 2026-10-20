package main

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Only the pinned, supported RustDesk wire subset is accepted here. Unknown
// fields are rejected rather than treated as a new way to request a capability.
type wireField struct {
	number int
	kind   int
	value  uint64
	body   []byte
}

type windowsLogonState struct {
	session uint32
	locked  bool
}

// WTSINFOEX level 1 uses an eight-byte-aligned union on supported Windows 10+.
func decodeWindowsLogonState(session uint32, info []byte, hasUser bool) (windowsLogonState, error) {
	if len(info) < 20 || binary.LittleEndian.Uint32(info[:4]) != 1 ||
		binary.LittleEndian.Uint32(info[8:12]) != session {
		return windowsLogonState{}, errDesktopUnavailable
	}
	state := binary.LittleEndian.Uint32(info[12:16])
	// Before the first sign-in Windows reports Connected, with no WTS user.
	if state != 0 && !(state == 1 && !hasUser) {
		return windowsLogonState{}, errDesktopUnavailable
	}
	flags := binary.LittleEndian.Uint32(info[16:20])
	if hasUser && flags > 1 {
		return windowsLogonState{}, errDesktopUnavailable
	}
	return windowsLogonState{session: session, locked: !hasUser || flags == 0}, nil
}

func fields(raw []byte) ([]wireField, error) {
	result := []wireField{}
	for len(raw) > 0 {
		key, n := binary.Uvarint(raw)
		if n <= 0 || key>>3 == 0 || len(result) >= 64 {
			return nil, errDenied
		}
		raw = raw[n:]
		f := wireField{number: int(key >> 3), kind: int(key & 7)}
		switch f.kind {
		case 0:
			value, n := binary.Uvarint(raw)
			if n <= 0 {
				return nil, errDenied
			}
			f.value = value
			raw = raw[n:]
		case 2:
			size, n := binary.Uvarint(raw)
			if n <= 0 || size > uint64(len(raw)-n) {
				return nil, errDenied
			}
			f.body = raw[n : n+int(size)]
			raw = raw[n+int(size):]
		default:
			return nil, errDenied
		}
		result = append(result, f)
	}
	return result, nil
}
func uintField(number int, value uint64) []byte {
	raw := binary.AppendUvarint(nil, uint64(number<<3))
	return binary.AppendUvarint(raw, value)
}
func bytesField(number int, body []byte) []byte {
	raw := binary.AppendUvarint(nil, uint64(number<<3|2))
	raw = binary.AppendUvarint(raw, uint64(len(body)))
	return append(raw, body...)
}

func validateLocalDesktopPassword(password, computer string) error {
	conn, err := net.DialTimeout("tcp", "127.0.0.1:21118", 2*time.Second)
	if err != nil {
		return errDesktopUnavailable
	}
	return validateDesktopPassword(conn, password, computer, 10*time.Second)
}

// Perform only the normal view-only challenge/login before changing stored
// credentials. A rejection, timeout or different peer leaves the old state intact.
func validateDesktopPassword(conn net.Conn, password, computer string, timeout time.Duration) error {
	d := newDesktopSession(conn)
	defer d.close()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	sent := false
	for {
		select {
		case raw, ok := <-d.frames:
			if !ok {
				return errDesktopUnavailable
			}
			packet, err := fields(raw)
			if err != nil || len(packet) != 1 || packet[0].kind != 2 {
				return errDesktopUnavailable
			}
			switch packet[0].number {
			case 5:
				if _, err = d.write(raw, permissions{View: true}, password, "credential verification"); err != nil {
					return errDesktopUnavailable
				}
			case 9:
				if sent {
					return errDesktopUnavailable
				}
				login := bytesField(4, []byte("GMSSH-credential-verification"))
				login = append(login, bytesField(11, []byte("1.4.9"))...)
				login = append(login, bytesField(13, []byte("Web"))...)
				if _, err = d.write(bytesField(7, login), permissions{View: true}, password, "credential verification"); err != nil {
					return errDesktopUnavailable
				}
				sent = true
			case 8:
				reply, err := fields(packet[0].body)
				if !sent || err != nil || len(reply) != 1 || reply[0].kind != 2 {
					return errDesktopUnavailable
				}
				if reply[0].number == 1 && string(reply[0].body) == "Wrong Password" {
					return errDesktopCredential
				}
				if reply[0].number != 2 {
					return errDesktopUnavailable
				}
				peer, err := fields(reply[0].body)
				if err != nil {
					return errDesktopUnavailable
				}
				for _, f := range peer {
					if f.number == 2 && f.kind == 2 && strings.EqualFold(string(f.body), computer) {
						return nil
					}
				}
				return errDesktopUnavailable
			default:
				return errDesktopUnavailable
			}
		case <-timer.C:
			return errDesktopUnavailable
		}
	}
}
func appendWire(raw []byte, f wireField) []byte {
	if f.kind == 0 {
		return append(raw, uintField(f.number, f.value)...)
	}
	return append(raw, bytesField(f.number, f.body)...)
}

func safeOptions(raw []byte, p permissions) ([]byte, error) {
	quality := uint64(3)
	if len(raw) > 0 {
		fs, err := fields(raw)
		if err != nil {
			return nil, err
		}
		seen := map[int]bool{}
		for _, f := range fs {
			if seen[f.number] {
				return nil, errDenied
			}
			seen[f.number] = true
			switch f.number {
			case 1:
				if f.kind != 0 || (f.value != 2 && f.value != 3 && f.value != 4) {
					return nil, errDenied
				}
				quality = f.value
			case 3, 7, 8, 12:
				if f.kind != 0 || f.value > 2 {
					return nil, errDenied
				}
			case 10:
				if f.kind != 2 || len(f.body) > 128 {
					return nil, errDenied
				}
			default:
				return nil, errDenied
			}
		}
	}
	keyboard, clipboard := uint64(2), uint64(2)
	if p.Input {
		keyboard = 1
	}
	if p.Clipboard {
		clipboard = 1
	}
	result := append(uintField(1, quality), uintField(3, 1)...)
	result = append(result, uintField(7, 2)...)
	result = append(result, uintField(8, clipboard)...)
	result = append(result, bytesField(10, append(uintField(1, 1), uintField(4, 1)...))...)
	return append(result, uintField(12, keyboard)...), nil
}

func permittedPacket(raw []byte, p permissions, password, salt, challenge, name string, loginSent bool) ([]byte, bool, error) {
	if len(raw) > 16384 {
		return nil, false, errDenied
	}
	top, err := fields(raw)
	if err != nil || len(top) != 1 || top[0].kind != 2 {
		return nil, false, errDenied
	}
	f := top[0]
	if f.number == 5 {
		if len(f.body) > 128 {
			return nil, false, errDenied
		}
		fs, err := fields(f.body)
		if err != nil {
			return nil, false, err
		}
		for _, v := range fs {
			if v.kind != 0 || v.number < 1 || v.number > 4 {
				return nil, false, errDenied
			}
		}
		return raw, false, nil
	}
	if f.number == 7 {
		if loginSent || salt == "" || challenge == "" || !p.View {
			return nil, false, errDenied
		}
		fs, err := fields(f.body)
		if err != nil {
			return nil, false, err
		}
		result := []byte{}
		seen := map[int]bool{}
		options := []byte(nil)
		for _, v := range fs {
			if seen[v.number] {
				return nil, false, errDenied
			}
			seen[v.number] = true
			switch v.number {
			case 1, 2, 4, 5, 11, 13:
				if v.kind != 2 || len(v.body) > 1024 {
					return nil, false, errDenied
				}
				if v.number == 4 || v.number == 11 || v.number == 13 {
					result = appendWire(result, v)
				}
			case 6:
				if v.kind != 2 {
					return nil, false, errDenied
				}
				options = v.body
			case 9:
				if v.kind != 0 || v.value > 1 {
					return nil, false, errDenied
				}
				result = appendWire(result, v)
			default:
				return nil, false, errDenied
			}
		}
		first := sha256.Sum256(append([]byte(password), []byte(salt)...))
		second := sha256.Sum256(append(first[:], []byte(challenge)...))
		clear(first[:])
		result = append(result, bytesField(1, []byte("127.0.0.1"))...)
		result = append(result, bytesField(2, second[:])...)
		result = append(result, bytesField(5, []byte("GMSSH · "+name))...)
		safe, err := safeOptions(options, p)
		if err != nil {
			return nil, false, err
		}
		result = append(result, bytesField(6, safe)...)
		clear(second[:])
		return bytesField(7, result), true, nil
	}
	if !loginSent {
		return nil, false, errDenied
	}
	switch f.number {
	case 34: // RustDesk >=1.5.1 checks its logon screen before accepting OSLogin.
		if !p.Input {
			return nil, false, errDenied
		}
		fs, err := fields(f.body)
		if err != nil || len(fs) != 1 || fs[0].number != 2 || fs[0].kind != 2 || len(fs[0].body) == 0 || len(fs[0].body) > 1024 || !utf8.Valid(fs[0].body) {
			return nil, false, errDenied
		}
		for _, b := range fs[0].body {
			if b < 32 || b == 127 {
				return nil, false, errDenied
			}
		}
		return raw, false, nil
	case 10, 15:
		if !p.Input {
			return nil, false, errDenied
		}
		return raw, false, nil
	case 16:
		if !p.Clipboard {
			return nil, false, errDenied
		}
		fs, err := fields(f.body)
		if err != nil {
			return nil, false, err
		}
		for _, v := range fs {
			if v.number == 2 && v.kind == 2 && len(v.body) <= 8192 && utf8.Valid(v.body) {
				continue
			}
			if (v.number == 1 || v.number == 3 || v.number == 4 || v.number == 5) && v.kind == 0 && v.value == 0 {
				continue
			}
			return nil, false, errDenied
		}
		return raw, false, nil
	case 19:
		fs, err := fields(f.body)
		if err != nil || len(fs) != 1 {
			return nil, false, errDenied
		}
		v := fs[0]
		switch v.number {
		case 7:
			if v.kind != 2 {
				return nil, false, errDenied
			}
			safe, err := safeOptions(v.body, p)
			return bytesField(19, bytesField(7, safe)), false, err
		case 5:
			if v.kind != 2 {
				return nil, false, errDenied
			}
			display, err := fields(v.body)
			if err != nil {
				return nil, false, err
			}
			index := uint64(0)
			for _, d := range display {
				if d.number != 1 || d.kind != 0 || d.value > 31 {
					return nil, false, errDenied
				}
				index = d.value
			}
			return bytesField(19, bytesField(5, uintField(1, index))), false, nil
		case 10, 12:
			if v.kind != 0 || v.value > 1 {
				return nil, false, errDenied
			}
			return raw, false, nil
		}
		return nil, false, errDenied
	}
	return nil, false, errDenied
}

type desktopSession struct {
	conn            net.Conn
	frames          chan []byte
	done            chan struct{}
	once            sync.Once
	mu              sync.Mutex
	writeMu         sync.Mutex
	readMu          sync.Mutex
	salt, challenge string
	loginSent       bool
	state           string
	logonState      func() (windowsLogonState, error)
}

func newDesktopSession(conn net.Conn) *desktopSession {
	d := &desktopSession{conn: conn, frames: make(chan []byte, 1), done: make(chan struct{}), state: "handshaking", logonState: controllerLogonState}
	go d.receive()
	return d
}
func (d *desktopSession) close() { d.once.Do(func() { close(d.done); d.conn.Close() }) }
func (d *desktopSession) snapshot() string {
	select {
	case <-d.done:
		return "disconnected"
	default:
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}
func (d *desktopSession) receive() {
	defer d.close()
	defer close(d.frames)
	for {
		first := make([]byte, 1)
		if _, err := io.ReadFull(d.conn, first); err != nil {
			return
		}
		width := int(first[0]&3) + 1
		header := make([]byte, 4)
		header[0] = first[0]
		if _, err := io.ReadFull(d.conn, header[1:width]); err != nil {
			return
		}
		size := binary.LittleEndian.Uint32(header) >> 2
		if size > 16*1024*1024 {
			return
		}
		raw := make([]byte, size)
		if _, err := io.ReadFull(d.conn, raw); err != nil {
			return
		}
		top, err := fields(raw)
		if err != nil || len(top) != 1 {
			return
		}
		if top[0].number == 9 {
			hash, err := fields(top[0].body)
			if err != nil {
				return
			}
			salt, challenge := "", ""
			for _, f := range hash {
				if f.kind != 2 || len(f.body) > 1024 || !utf8.Valid(f.body) {
					return
				}
				if f.number == 1 {
					salt = string(f.body)
				} else if f.number == 2 {
					challenge = string(f.body)
				} else {
					return
				}
			}
			d.mu.Lock()
			d.salt, d.challenge = salt, challenge
			d.state = "authenticating"
			d.mu.Unlock()
		}
		if top[0].number == 8 {
			reply, err := fields(top[0].body)
			if err != nil || len(reply) != 1 {
				return
			}
			d.mu.Lock()
			if d.loginSent {
				if reply[0].number == 2 {
					d.state = "connected"
				} else {
					d.state = "auth_failed"
				}
			}
			d.mu.Unlock()
		}
		select {
		case d.frames <- raw:
		case <-d.done:
			return
		}
	}
}
func (d *desktopSession) read(p permissions) (any, error) {
	d.readMu.Lock()
	defer d.readMu.Unlock()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-d.done:
			return nil, errors.New("DESKTOP_CLOSED")
		case raw, ok := <-d.frames:
			if !ok {
				return nil, errors.New("DESKTOP_CLOSED")
			}
			top, err := fields(raw)
			if err != nil || len(top) != 1 {
				return nil, errDenied
			}
			n := top[0].number
			if !p.Clipboard && (n == 16 || n == 20 || n == 28) {
				continue
			}
			if n == 11 || n == 20 {
				continue
			}
			select {
			case <-d.done:
				return nil, errors.New("DESKTOP_CLOSED")
			default:
			}
			return map[string]any{"data": raw}, nil
		case <-timer.C:
			return map[string]bool{"waiting": true}, nil
		}
	}
}
func (d *desktopSession) write(raw []byte, p permissions, password, name string) (any, error) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	d.mu.Lock()
	salt, challenge, sent, state := d.salt, d.challenge, d.loginSent, d.state
	d.mu.Unlock()
	safe, login, err := permittedPacket(raw, p, password, salt, challenge, name, sent)
	if err != nil {
		return nil, err
	}
	packet, _ := fields(safe)
	if len(packet) == 1 && packet[0].number == 34 {
		if state != "connected" {
			return nil, errDenied
		}
		if d.logonState == nil {
			return nil, errDesktopUnavailable
		}
		// The password always stays in guarded OSLogin. Normal mouse activation
		// is allowed only after a live Windows lock/prelogin check, and never on
		// an unlocked desktop. Recheck after activation before sending a secret.
		before, err := d.logonState()
		if err != nil {
			return nil, errDesktopUnavailable
		}
		if !before.locked {
			return map[string]bool{"written": true}, nil
		}
		for _, mask := range []uint64{9, 10} {
			if err := d.sendPacket(bytesField(10, uintField(1, mask))); err != nil {
				return nil, err
			}
		}
		timer := time.NewTimer(1200 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-d.done:
			return nil, errDesktopUnavailable
		case <-timer.C:
		}
		after, err := d.logonState()
		if err != nil || after.session != before.session {
			return nil, errDesktopUnavailable
		}
		if !after.locked {
			return map[string]bool{"written": true}, nil
		}
	}
	if login {
		d.mu.Lock()
		d.loginSent = true
		d.mu.Unlock()
	}
	if err := d.sendPacket(safe); err != nil {
		return nil, err
	}
	return map[string]bool{"written": true}, nil
}

func (d *desktopSession) sendPacket(raw []byte) error {
	width := 1
	for len(raw) > (1<<(8*width-2))-1 && width < 4 {
		width++
	}
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(raw)<<2|width-1))
	d.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	packet := append(header[:width], raw...)
	defer clear(packet)
	for len(packet) > 0 {
		n, err := d.conn.Write(packet)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		packet = packet[n:]
	}
	return nil
}
