package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net"
	"testing"
)

func TestWindowsLoginRequiresDesktopInputAndBoundedPasswordOnly(t *testing.T) {
	packet := bytesField(34, bytesField(2, []byte("synthetic-中文-password")))
	allowed := permissions{View: true, Input: true}
	actual, _, err := permittedPacket(packet, allowed, "", "", "", "", true)
	if err != nil || !bytes.Equal(actual, packet) {
		t.Fatal("bounded OSLogin rejected")
	}
	if _, _, err = permittedPacket(packet, allowed, "", "", "", "", false); err == nil {
		t.Fatal("OSLogin before desktop login accepted")
	}
	if _, _, err = permittedPacket(packet, permissions{View: true}, "", "", "", "", true); err == nil {
		t.Fatal("read-only grant accepted OSLogin")
	}
	for _, body := range [][]byte{
		bytesField(2, nil), bytesField(2, bytes.Repeat([]byte("x"), 1025)),
		bytesField(2, []byte("synthetic\npassword")), bytesField(2, []byte{0xff}),
		append(bytesField(2, []byte("synthetic")), bytesField(2, []byte("duplicate"))...),
		append(bytesField(1, []byte("other-user")), bytesField(2, []byte("synthetic"))...),
	} {
		if _, _, err = permittedPacket(bytesField(34, body), allowed, "", "", "", "", true); err == nil {
			t.Fatal("invalid or expanded OSLogin accepted")
		}
	}
}

func TestWindowsLogonStateRejectsUnknownHeadersAndDistinguishesPrelogin(t *testing.T) {
	info := make([]byte, 20)
	binary.LittleEndian.PutUint32(info[:4], 1)
	binary.LittleEndian.PutUint32(info[8:12], 7)
	for _, test := range []struct {
		flags           uint32
		hasUser, locked bool
	}{
		{0, true, true}, {1, true, false}, {1, false, true}, {0xffffffff, false, true},
	} {
		binary.LittleEndian.PutUint32(info[16:20], test.flags)
		state, err := decodeWindowsLogonState(7, info, test.hasUser)
		if err != nil || state.session != 7 || state.locked != test.locked {
			t.Fatal("incorrect WTS lock/prelogin state")
		}
	}
	if _, err := decodeWindowsLogonState(7, info, true); err == nil {
		t.Fatal("unknown WTS flags accepted")
	}
	binary.LittleEndian.PutUint32(info[16:20], 1)
	binary.LittleEndian.PutUint32(info[12:16], 1)
	if state, err := decodeWindowsLogonState(7, info, false); err != nil || !state.locked {
		t.Fatal("Windows prelogin Connected state rejected")
	}
	if _, err := decodeWindowsLogonState(7, info, true); err == nil {
		t.Fatal("connected user session mistaken for prelogin")
	}
	binary.LittleEndian.PutUint32(info[12:16], 0)
	if _, err := decodeWindowsLogonState(8, info, true); err == nil {
		t.Fatal("another session accepted")
	}
	if _, err := decodeWindowsLogonState(7, info[:19], true); err == nil {
		t.Fatal("truncated WTS header accepted")
	}
	binary.LittleEndian.PutUint32(info[12:16], 4)
	if _, err := decodeWindowsLogonState(7, info, true); err == nil {
		t.Fatal("disconnected console accepted")
	}
	binary.LittleEndian.PutUint32(info[12:16], 0)
	binary.LittleEndian.PutUint32(info[:4], 2)
	if _, err := decodeWindowsLogonState(7, info, true); err == nil {
		t.Fatal("unknown WTS level accepted")
	}
}

func TestWindowsUnlockWakesOnlyLockedSessionAndNeverFallsBackToPasswordKeys(t *testing.T) {
	secret := "synthetic-Windows-password"
	packet := bytesField(34, bytesField(2, []byte(secret)))
	locked, unlocked := windowsLogonState{session: 1, locked: true}, windowsLogonState{session: 1}
	for _, test := range []struct {
		name             string
		states           []windowsLogonState
		failAt           int
		connected, input bool
		kinds            []int
		want             error
	}{
		{"locked", []windowsLogonState{locked, locked}, 0, true, true, []int{10, 10, 34}, nil},
		{"unlocked", []windowsLogonState{unlocked}, 0, true, true, nil, nil},
		{"unlocked-during-activation", []windowsLogonState{locked, unlocked}, 0, true, true, []int{10, 10}, nil},
		{"session-changed", []windowsLogonState{locked, {session: 2, locked: true}}, 0, true, true, []int{10, 10}, errDesktopUnavailable},
		{"unknown-state", nil, 1, true, true, nil, errDesktopUnavailable},
		{"unknown-after-activation", []windowsLogonState{locked}, 2, true, true, []int{10, 10}, errDesktopUnavailable},
		{"unconfirmed-desktop", nil, 0, false, true, nil, errDenied},
		{"read-only-grant", nil, 0, true, false, nil, errDenied},
	} {
		t.Run(test.name, func(t *testing.T) {
			a, z := net.Pipe()
			defer z.Close()
			d := newDesktopSession(a)
			d.mu.Lock()
			d.loginSent = true
			if test.connected {
				d.state = "connected"
			}
			d.mu.Unlock()
			queries := 0
			d.logonState = func() (windowsLogonState, error) {
				queries++
				if queries == test.failAt {
					return windowsLogonState{}, errDesktopUnavailable
				}
				if queries > len(test.states) {
					return windowsLogonState{}, errors.New("unexpected state query")
				}
				return test.states[queries-1], nil
			}
			received := make(chan [][]byte, 1)
			go func() {
				var frames [][]byte
				for {
					raw, err := fixtureReadFrame(z)
					if err != nil {
						received <- frames
						return
					}
					frames = append(frames, raw)
				}
			}()
			_, err := d.write(packet, permissions{View: true, Input: test.input}, "", "test")
			d.close()
			frames := <-received
			if !errors.Is(err, test.want) || len(frames) != len(test.kinds) {
				t.Fatal("incorrect guarded unlock result", err, len(frames))
			}
			for i, raw := range frames {
				fields, err := fields(raw)
				if err != nil || len(fields) != 1 || fields[0].number != test.kinds[i] {
					t.Fatal("unsafe activation/login packet")
				}
				if test.kinds[i] == 34 {
					if !bytes.Equal(raw, packet) {
						t.Fatal("Windows password left OSLogin")
					}
				} else if bytes.Contains(raw, []byte(secret)) {
					t.Fatal("activation contains a password")
				}
			}
			if (!test.connected || !test.input) && queries != 0 {
				t.Fatal("unauthorized request queried or activated the desktop")
			}
		})
	}
}
