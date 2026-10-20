package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func preservedFixture(t *testing.T) (store, string, string) {
	t.Helper()
	s, password := fixture(t)
	for _, name := range []string{"agent.json", "connection.json"} {
		raw, _ := os.ReadFile(filepath.Join(s.root, name))
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		value["username"] = "Existing User"
		if name == "agent.json" {
			delete(value, "managedAccountSid")
			value["unifiedPassword"] = false
			value["installationMode"] = "preserve-existing"
			value["accountSid"] = "S-1-5-21-1000"
		}
		raw, _ = json.Marshal(value)
		if err := os.WriteFile(filepath.Join(s.root, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	s.validatePassword = func(user, secret string) error {
		if user != "Existing User" || secret != *password {
			return errors.New("invalid synthetic credential")
		}
		return nil
	}
	s.validateDesktop = func(secret, computer string) error {
		if secret != "synthetic-separate-desktop-password" || computer != "LAB-PC" {
			return errDesktopCredential
		}
		return nil
	}
	return s, *password, "synthetic-separate-desktop-password"
}

func TestPreservedAccountKeepsSeparateDesktopSecretOffEnrollmentWire(t *testing.T) {
	s, password, desktop := preservedFixture(t)
	if s.initialize(password) == nil {
		t.Fatal("preserved desktop accepted a missing credential")
	}
	if err := s.initializeCredentials(password, desktop); err != nil {
		t.Fatal(err)
	}
	m, err := s.meta()
	if err != nil || m.Binding.Username != "Existing User" || m.Binding.ManagedSID != "S-1-5-21-1000" {
		t.Fatal("existing account identity not bound")
	}
	secret, err := s.storedCredential(m)
	if err != nil || secret.Password != password || secret.DesktopPassword != desktop {
		t.Fatal("separate encrypted credentials not retained")
	}
	encoded, err := s.code(nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(encoded, codePrefix))
	if bytes.Contains(raw, []byte(password)) || bytes.Contains(raw, []byte(desktop)) || !bytes.Contains(raw, []byte(`"desktopAuth":"manual"`)) {
		t.Fatal("public code lost manual legacy-desktop mode or leaked credentials")
	}
	request := httptest.NewRequest("POST", "/v1/connect", strings.NewReader(`{"schema":1}`))
	request.RemoteAddr = "192.168.250.19:5000"
	request.Header.Set("Authorization", "Bearer "+m.Token)
	reply := httptest.NewRecorder()
	s.handler().ServeHTTP(reply, request)
	var response map[string]any
	if json.Unmarshal(reply.Body.Bytes(), &response) != nil || reply.Code != 200 || response["password"] != password || len(response) != 4 || bytes.Contains(reply.Body.Bytes(), []byte(desktop)) {
		t.Fatal("legacy enrollment exported the desktop credential or changed its contract")
	}
	raw, _ = os.ReadFile(filepath.Join(s.root, "agent.json"))
	var agent map[string]any
	json.Unmarshal(raw, &agent)
	agent["accountSid"] = "S-1-5-21-9999"
	raw, _ = json.Marshal(agent)
	os.WriteFile(filepath.Join(s.root, "agent.json"), raw, 0600)
	if _, err := s.meta(); err == nil {
		t.Fatal("replaced existing account retained an authorization")
	}
}

func TestPreservedBindingRechecksTheRequiredAdministratorRole(t *testing.T) {
	s, password, desktop := preservedFixture(t)
	administrator := true
	calls := 0
	s.validateBinding = func(b binding) error {
		calls++
		if !b.RequireAdministrator || b.Username != "Existing User" {
			t.Fatal("preserved administrator requirement lost")
		}
		if !administrator {
			return errUnavailable
		}
		return nil
	}
	if err := s.initializeCredentials(password, desktop); err != nil {
		t.Fatal(err)
	}
	if _, err := s.meta(); err != nil {
		t.Fatal(err)
	}
	administrator = false
	if _, err := s.meta(); err == nil {
		t.Fatal("demoted account retained server authorization")
	}
	if calls < 2 {
		t.Fatal("binding was not rechecked")
	}
}

func TestPreservedControllerDesktopUsesOnlyItsSeparateEngineCredential(t *testing.T) {
	s, password, desktop := preservedFixture(t)
	if err := s.initializeCredentials(password, desktop); err != nil {
		t.Fatal(err)
	}
	m, _ := s.meta()
	b, _ := brokerFixture(t)
	b.store = s
	a, z := net.Pipe()
	t.Cleanup(func() { z.Close() })
	b.openDesktop = func() (net.Conn, error) { return a, nil }
	id, token := grantFixture(t, b, m.Token, "Preserved", permissions{View: true})
	session := openFixture(t, b, id, token, "desktop")
	b.mu.Lock()
	d := b.sessions[session].desktop
	b.mu.Unlock()
	d.mu.Lock()
	d.salt = "salt"
	d.challenge = "challenge"
	d.mu.Unlock()
	received := make(chan []byte, 1)
	go func() { raw := make([]byte, 65536); n, _ := z.Read(raw); received <- raw[:n] }()
	login := bytesField(7, bytesField(1, []byte("127.0.0.1")))
	args, _ := json.Marshal(map[string]any{"data": login})
	status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "desktop-write", Session: session, Args: args}, id, token)
	if status != 200 {
		t.Fatal("preserved desktop login rejected")
	}
	expected, _, err := permittedPacket(login, permissions{View: true}, desktop, "salt", "challenge", "Preserved", false)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case packet := <-received:
		if len(packet) == 0 {
			t.Fatal("no engine packet")
		}
		width := int(packet[0]&3) + 1
		if len(packet) < width || !bytes.Equal(packet[width:], expected) {
			t.Fatal("desktop login did not use the separate credential")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("engine packet timed out")
	}
}

func TestPreservedDesktopFailureLeavesCredentialsCodesAndGrantsUntouched(t *testing.T) {
	s, password, desktop := preservedFixture(t)
	if err := s.initializeCredentials(password, desktop); err != nil {
		t.Fatal(err)
	}
	m, _ := s.meta()
	b := newControllerBroker(s)
	id, token := grantFixture(t, b, m.Token, "Keep existing authorization", permissions{View: true, Input: true})
	private := filepath.Join(s.root, "private")
	files, _ := os.ReadDir(private)
	before := map[string][]byte{}
	for _, file := range files {
		before[file.Name()], _ = os.ReadFile(filepath.Join(private, file.Name()))
	}
	code, _ := s.code(nil)
	for _, failure := range []error{errDesktopCredential, errDesktopUnavailable} {
		s.validateDesktop = func(secret, computer string) error { return failure }
		if err := s.initializeCredentials(password, desktop); !errors.Is(err, failure) {
			t.Fatal("desktop validation failure was ignored")
		}
		for name, body := range before {
			after, err := os.ReadFile(filepath.Join(private, name))
			if err != nil || !bytes.Equal(body, after) {
				t.Fatal("failed desktop validation altered existing state", name)
			}
		}
		if after, err := s.code(nil); err != nil || code != after {
			t.Fatal("failed verification rotated the existing code")
		}
		if status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, id, token); status != 200 {
			t.Fatal("failed verification invalidated the independent authorization")
		}
	}
	s.validateDesktop = nil
	if err := s.initializeCredentials(password, desktop); !errors.Is(err, errDesktopUnavailable) {
		t.Fatal("missing desktop validator failed open")
	}
	s, password, desktop = preservedFixture(t)
	s.validateDesktop = func(secret, computer string) error { return errDesktopCredential }
	if err := s.initializeCredentials(password, desktop); !errors.Is(err, errDesktopCredential) {
		t.Fatal("wrong first desktop credential was accepted")
	}
	if files, _ = os.ReadDir(filepath.Join(s.root, "private")); len(files) != 0 {
		t.Fatal("failed first verification created an identity or credentials")
	}
}

func TestPreservedDesktopCredentialUsesNormalReadOnlyLoginAndChecksPeer(t *testing.T) {
	password := "synthetic-separate-desktop-password"
	for _, test := range []struct {
		name  string
		reply []byte
		want  error
	}{
		{"accepted", bytesField(2, bytesField(2, []byte("lab-pc"))), nil},
		{"wrong-password", bytesField(1, []byte("Wrong Password")), errDesktopCredential},
		{"different-peer", bytesField(2, bytesField(2, []byte("OTHER-PC"))), errDesktopUnavailable},
		{"extra-auth", bytesField(1, []byte("synthetic-extra-auth")), errDesktopUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, engine := net.Pipe()
			defer engine.Close()
			done := make(chan error, 1)
			go func() {
				fail := func(err error) { done <- err }
				if err := fixtureFrame(engine, bytesField(9, append(bytesField(1, []byte("salt")), bytesField(2, []byte("challenge"))...))); err != nil {
					fail(err)
					return
				}
				raw, err := fixtureReadFrame(engine)
				if err != nil {
					fail(err)
					return
				}
				top, err := fields(raw)
				if err != nil || len(top) != 1 || top[0].number != 7 {
					fail(errors.New("not a normal login"))
					return
				}
				login, err := fields(top[0].body)
				if err != nil {
					fail(err)
					return
				}
				h1 := sha256.Sum256([]byte(password + "salt"))
				expected := sha256.Sum256(append(h1[:], []byte("challenge")...))
				matched, readOnly := false, false
				for _, f := range login {
					if f.number == 2 {
						matched = bytes.Equal(f.body, expected[:])
					}
					if f.number == 6 {
						options, _ := fields(f.body)
						for _, option := range options {
							if option.number == 12 {
								readOnly = option.value == 2
							}
						}
					}
				}
				if !matched || !readOnly || bytes.Contains(raw, []byte(password)) {
					fail(errors.New("unsafe credential verification"))
					return
				}
				keepalive := bytesField(5, uintField(1, 7))
				if err = fixtureFrame(engine, keepalive); err != nil {
					fail(err)
					return
				}
				if raw, err = fixtureReadFrame(engine); err != nil || !bytes.Equal(raw, keepalive) {
					fail(errors.New("keepalive not echoed"))
					return
				}
				fail(fixtureFrame(engine, bytesField(8, test.reply)))
				engine.Close()
			}()
			if err := validateDesktopPassword(client, password, "LAB-PC", time.Second); !errors.Is(err, test.want) {
				t.Fatal("wrong verification result", err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
	client, engine := net.Pipe()
	defer engine.Close()
	start := time.Now()
	if err := validateDesktopPassword(client, password, "LAB-PC", 20*time.Millisecond); !errors.Is(err, errDesktopUnavailable) || time.Since(start) > time.Second {
		t.Fatal("unresponsive engine did not fail within the bounded wait")
	}
}
