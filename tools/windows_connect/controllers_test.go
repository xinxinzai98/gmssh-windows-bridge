package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func controllerCall(t *testing.T, b *controllerBroker, route string, body any, id, token string) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", route, bytes.NewReader(raw))
	request.RemoteAddr = "192.168.250.19:5000"
	if route == "/v2/manage" {
		request.RemoteAddr = "127.0.0.1:5000"
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GMSSH-Controller", id)
	reply := httptest.NewRecorder()
	b.serve(reply, request)
	var data map[string]any
	if json.Unmarshal(reply.Body.Bytes(), &data) != nil {
		t.Fatal(reply.Body.String())
	}
	return reply.Code, data
}

type echoTerminal struct {
	data       chan []byte
	done       chan struct{}
	once       sync.Once
	dimensions [2]int
	mu         sync.Mutex
}

func (t *echoTerminal) Read(raw []byte) (int, error) {
	select {
	case data := <-t.data:
		return copy(raw, data), nil
	case <-t.done:
		return 0, io.EOF
	}
}
func (t *echoTerminal) Write(raw []byte) (int, error) {
	copyRaw := append([]byte(nil), raw...)
	select {
	case t.data <- copyRaw:
		return len(raw), nil
	case <-t.done:
		return 0, io.EOF
	}
}
func (t *echoTerminal) Resize(w, h int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.dimensions = [2]int{w, h}
	return nil
}
func (t *echoTerminal) Close() error  { t.once.Do(func() { close(t.done) }); return nil }
func (t *echoTerminal) ExitCode() int { return 0 }

func TestTerminalPreservesVTBytesAndRevocationClosesOnlyItsPTY(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Terminal", permissions{Terminal: true})
	pty := &echoTerminal{data: make(chan []byte), done: make(chan struct{})}
	opens := 0
	b.openTerminal = func(user, password string, w, h int) (pseudoTerminal, error) {
		opens++
		if user != "gmssh" || password != "synthetic-connection-password" {
			t.Fatal("terminal did not use held account credential")
		}
		pty.Resize(w, h)
		return pty, nil
	}
	session := openFixture(t, b, id, token, "terminal")
	status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-start", Session: session, Args: json.RawMessage(`{"width":0,"height":25}`)}, id, token)
	if status != 403 || opens != 0 {
		t.Fatal("invalid PTY size reached platform API")
	}
	status, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-start", Session: session, Args: json.RawMessage(`{"width":100,"height":30}`)}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	input := []byte("中文\x1b[A\x03\r")
	args, _ := json.Marshal(map[string]any{"data": input})
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-write", Session: session, Args: args}, id, token)
	if status != 200 {
		t.Fatal("PTY input rejected")
	}
	status, reply = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-read", Session: session, Args: json.RawMessage(`{}`)}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	output, err := base64.StdEncoding.DecodeString(reply["result"].(map[string]any)["data"].(string))
	if err != nil || !bytes.Equal(input, output) {
		t.Fatal("UTF-8/control bytes changed")
	}
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-resize", Session: session, Args: json.RawMessage(`{"width":120,"height":40}`)}, id, token)
	if status != 200 {
		t.Fatal("PTY resize rejected")
	}
	pty.mu.Lock()
	dimensions := pty.dimensions
	pty.mu.Unlock()
	if dimensions != [2]int{120, 40} {
		t.Fatal("PTY dimensions not forwarded")
	}
	status, _ = controllerCall(t, b, "/v2/manage", controllerRequest{Action: "revoke", ID: id}, "", owner)
	if status != 200 {
		t.Fatal("revoke failed")
	}
	select {
	case <-pty.done:
	case <-time.After(time.Second):
		t.Fatal("revoked PTY kept running")
	}
}

func TestReadonlyQueriesNeverAcceptCallerScriptsOrUnboundedFilters(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Readonly", permissions{View: true})
	calls := 0
	b.readInfo = func(_ context.Context, file, prefix string) ([]byte, error) {
		calls++
		if file != "readonly-tools.ps1" || !strings.HasPrefix(prefix, "$options=") {
			t.Fatal("unexpected collector")
		}
		return []byte("synthetic readonly result"), nil
	}
	valid := json.RawMessage(`{"tool":"processes","options":{"limit":50,"search":"中文' ; command","sort":"cpu"}}`)
	status, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "info", Args: valid}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	for _, bad := range []string{`{"tool":"arbitrary-script","options":{}}`, `{"tool":"processes","options":{"limit":500000,"search":"","sort":"cpu"}}`, `{"tool":"processes","options":{"limit":50,"search":"","sort":"cpu; command"}}`, `{"tool":"capabilities","options":{"command":"not allowed"}}`} {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "info", Args: json.RawMessage(bad)}, id, token)
		if status != 403 {
			t.Fatal("unvalidated query accepted")
		}
	}
	if calls != 1 {
		t.Fatal("invalid query reached PowerShell")
	}
}
func brokerFixture(t *testing.T) (*controllerBroker, string) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	m, err := s.meta()
	if err != nil {
		t.Fatal(err)
	}
	b := newControllerBroker(s)
	t.Cleanup(func() {
		b.mu.Lock()
		closing := []*controllerSession{}
		for _, s := range b.sessions {
			s.close()
			closing = append(closing, s)
		}
		b.mu.Unlock()
		for _, s := range closing {
			select {
			case <-s.finished:
			case <-time.After(2 * time.Second):
				t.Error("session cleanup did not finish")
			}
		}
	})
	return b, m.Token
}

func TestControllerSessionsExpireAndStaleAccountSecretsDoNotRepeatLogins(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Terminal", permissions{Terminal: true})
	session := openFixture(t, b, id, token, "terminal")
	valid := b.store.validatePassword
	attempts := 0
	b.store.validatePassword = func(string, string) error { attempts++; return errDenied }
	b.openTerminal = func(string, string, int, int) (pseudoTerminal, error) {
		t.Fatal("stale credential reached process creation")
		return nil, errDenied
	}
	for i := 0; i < 3; i++ {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "terminal-start", Session: session, Args: json.RawMessage(`{"width":80,"height":24}`)}, id, token)
		if status == 200 {
			t.Fatal("stale account was accepted")
		}
	}
	if attempts != 1 {
		t.Fatal("cached stale account attempted repeated Windows logins")
	}
	b.store.validatePassword = valid
	b.mu.Lock()
	b.sessions[session].close()
	delete(b.sessions, session)
	b.lease = 40 * time.Millisecond
	b.mu.Unlock()
	_ = openFixture(t, b, id, token, "terminal")
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		count := len(b.sessions)
		b.mu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("idle session did not expire autonomously")
}
func grantFixture(t *testing.T, b *controllerBroker, owner, name string, p permissions) (string, string) {
	status, reply := controllerCall(t, b, "/v2/manage", controllerRequest{Action: "grant", Name: name, Policy: p}, "", owner)
	if status != 200 {
		t.Fatal(reply)
	}
	result := reply["result"].(map[string]any)
	code := result["code"].(string)
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(code, "GMSSH-AUTH2."))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Controller struct {
			ID    string `json:"id"`
			Token string `json:"token"`
		} `json:"controller"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		t.Fatal("invalid independent code")
	}
	return payload.Controller.ID, payload.Controller.Token
}
func openFixture(t *testing.T, b *controllerBroker, id, token, kind string) string {
	status, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "open", Kind: kind}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	return reply["result"].(map[string]any)["session"].(string)
}

func TestIndependentControllerCodesDoNotRevealMasterCredentials(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Viewer", permissions{View: true})
	raw, err := b.store.read("controllers.dat")
	if err != nil {
		t.Fatal(err)
	}
	defer clear(raw)
	if bytes.Contains(raw, []byte(token)) || bytes.Contains(raw, []byte("synthetic-connection-password")) {
		t.Fatal("registry contains reusable plaintext credentials")
	}
	for _, bad := range []string{"", token[:42] + "?", owner} {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, id, bad)
		if status != 403 {
			t.Fatal("invalid credential accepted")
		}
	}
	status, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	wire, _ := json.Marshal(reply)
	if bytes.Contains(wire, []byte("synthetic-connection-password")) {
		t.Fatal("capability response leaks master password")
	}
}

func TestControllerIPv6LocalPrefixStillRequiresItsCredential(t *testing.T) {
	b, owner := brokerFixture(t)
	_, prefix, _ := net.ParseCIDR("2001:db8:10::/64")
	b.store.ipv6LocalNetworks = func() ([]*net.IPNet, error) { return []*net.IPNet{prefix}, nil }
	id, token := grantFixture(t, b, owner, "IPv6 viewer", permissions{View: true})
	for _, test := range []struct {
		peer, token, code string
		status            int
	}{
		{"2001:db8:10::2", token, "", 200},
		{"2001:db8:11::2", token, "SOURCE_DENIED", 403},
		{"2001:db8:10::2", "incorrect", "ACCESS_DENIED", 403},
	} {
		r := httptest.NewRequest("POST", "/v2/controller", strings.NewReader(`{"action":"capabilities"}`))
		r.RemoteAddr = net.JoinHostPort(test.peer, "5000")
		r.Header.Set("Authorization", "Bearer "+test.token)
		r.Header.Set("X-GMSSH-Controller", id)
		w := httptest.NewRecorder()
		b.serve(w, r)
		if w.Code != test.status || test.code != "" && !strings.Contains(w.Body.String(), test.code) {
			t.Fatal("incorrect IPv6 authentication boundary", w.Code)
		}
	}
}

func TestGrantCodeUsesLiveIPv6AddressesWithoutReplacingDeviceIdentity(t *testing.T) {
	b, owner := brokerFixture(t)
	addresses := []string{"192.168.250.2", "2001:db8::10", "2001:db8::20", "fd00::30"}
	status, reply := controllerCall(t, b, "/v2/manage", controllerRequest{Action: "grant", Name: "Dual stack", Policy: permissions{View: true}, Addresses: addresses}, "", owner)
	if status != 200 {
		t.Fatal(reply)
	}
	encoded := reply["result"].(map[string]any)["code"].(string)
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(encoded, "GMSSH-AUTH2."))
	if err != nil {
		t.Fatal(err)
	}
	var code struct {
		Connection struct {
			Addresses []string `json:"addresses"`
			Computer  string   `json:"computer"`
			PublicKey string   `json:"sshHostPublicKey"`
		} `json:"connection"`
	}
	if json.Unmarshal(raw, &code) != nil || strings.Join(code.Connection.Addresses, ",") != strings.Join(addresses, ",") || code.Connection.Computer != "LAB-PC" || !strings.HasPrefix(code.Connection.PublicKey, "ssh-ed25519 ") {
		t.Fatal("live addresses or original device identity were lost")
	}
	status, _ = controllerCall(t, b, "/v2/manage", controllerRequest{Action: "grant", Name: "Unusable", Policy: permissions{View: true}, Addresses: []string{"fe80::1", "::1"}}, "", owner)
	registry, err := b.registry()
	if status == 200 || err != nil || len(registry.Items) != 1 {
		t.Fatal("invalid export created an orphan grant")
	}
}

func TestPermissionBoundaryRejectsDirectRequestsAndCrossControllerSessions(t *testing.T) {
	b, owner := brokerFixture(t)
	viewer, viewerToken := grantFixture(t, b, owner, "Viewer", permissions{View: true})
	files, filesToken := grantFixture(t, b, owner, "Files", permissions{Files: true})
	calls := 0
	b.openDesktop = func() (net.Conn, error) { calls++; a, z := net.Pipe(); t.Cleanup(func() { z.Close() }); return a, nil }
	for _, kind := range []string{"files", "terminal", "power"} {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "open", Kind: kind}, viewer, viewerToken)
		if status != 403 {
			t.Fatal("viewer opened " + kind)
		}
	}
	status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "open", Kind: "desktop"}, files, filesToken)
	if status != 403 || calls != 0 {
		t.Fatal("file-only controller reached desktop engine")
	}
	session := openFixture(t, b, viewer, viewerToken, "desktop")
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "close", Session: session}, files, filesToken)
	if status != 403 {
		t.Fatal("another controller closed a session")
	}
	fileSession := openFixture(t, b, files, filesToken, "files")
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "execute", Session: fileSession, Args: json.RawMessage(`{"command":"unexpected","timeout":1}`)}, files, filesToken)
	if status != 403 {
		t.Fatal("file permission executed a command")
	}
}

func TestViewOnlyPacketPolicyCannotBeBypassedWithWireMessages(t *testing.T) {
	p := permissions{View: true}
	for _, number := range []int{10, 15, 16, 20, 28, 42} {
		if _, _, err := permittedPacket(bytesField(number, []byte{}), p, "secret", "salt", "challenge", "Viewer", true); err == nil {
			t.Fatalf("view-only accepts field %d", number)
		}
	}
	options := append(uintField(8, 1), uintField(12, 1)...)
	login := bytesField(7, append(bytesField(2, []byte("attacker supplied password")), bytesField(6, options)...))
	safe, isLogin, err := permittedPacket(login, p, "held-on-server", "salt", "challenge", "Viewer", false)
	if err != nil || !isLogin {
		t.Fatal(err)
	}
	outer, _ := fields(safe)
	inside, _ := fields(outer[0].body)
	var challenge []byte
	for _, field := range inside {
		if field.number == 2 {
			challenge = field.body
		}
		if field.number == 6 {
			opts, _ := fields(field.body)
			for _, option := range opts {
				if (option.number == 8 || option.number == 12) && option.value != 2 {
					t.Fatal("view-only flags could be enabled by client")
				}
			}
		}
	}
	a := sha256.Sum256([]byte("held-on-serversalt"))
	expected := sha256.Sum256(append(a[:], []byte("challenge")...))
	if !bytes.Equal(challenge, expected[:]) {
		t.Fatal("desktop password not injected exclusively on server")
	}
	if bytes.Contains(safe, []byte("held-on-server")) || bytes.Contains(safe, []byte("attacker supplied password")) {
		t.Fatal("plaintext password reached engine")
	}
	for _, packet := range [][]byte{append(login, login...), bytesField(19, bytesField(99, nil)), bytesField(19, append(bytesField(5, uintField(1, 0)), bytesField(7, options)...))} {
		if _, _, err := permittedPacket(packet, p, "secret", "salt", "challenge", "Viewer", true); err == nil {
			t.Fatal("ambiguous or unknown control accepted")
		}
	}
}

func TestRevocationClosesOnlySelectedControllersAndCancelsCommands(t *testing.T) {
	b, owner := brokerFixture(t)
	one, tokenOne := grantFixture(t, b, owner, "One", permissions{View: true, Terminal: true})
	two, tokenTwo := grantFixture(t, b, owner, "Two", permissions{View: true})
	b.openDesktop = func() (net.Conn, error) { a, z := net.Pipe(); t.Cleanup(func() { z.Close() }); return a, nil }
	first := openFixture(t, b, one, tokenOne, "desktop")
	second := openFixture(t, b, two, tokenTwo, "desktop")
	firstConnection := b.sessions[first].desktop
	secondConnection := b.sessions[second].desktop
	started := make(chan struct{})
	b.execute = func(ctx context.Context, _, _, _, _ string) ([]byte, int, error) {
		close(started)
		<-ctx.Done()
		return nil, 0, ctx.Err()
	}
	terminal := openFixture(t, b, one, tokenOne, "terminal")
	done := make(chan struct{})
	go func() {
		defer close(done)
		controllerCall(t, b, "/v2/controller", controllerRequest{Action: "execute", Session: terminal, Args: json.RawMessage(`{"command":"synthetic wait","timeout":60}`)}, one, tokenOne)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("command did not start")
	}
	status, reply := controllerCall(t, b, "/v2/manage", controllerRequest{Action: "revoke", ID: one}, "", owner)
	if status != 200 {
		t.Fatal(reply)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("revocation did not cancel active command")
	}
	select {
	case <-firstConnection.done:
	default:
		t.Fatal("selected desktop stayed connected")
	}
	select {
	case <-secondConnection.done:
		t.Fatal("unrelated desktop disconnected")
	default:
	}
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, one, tokenOne)
	if status != 403 {
		t.Fatal("revoked token is still valid")
	}
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, two, tokenTwo)
	if status != 200 {
		t.Fatal("unrelated token revoked")
	}
}

func TestControllerFilesUseBoundHandlesAndNeverReplaceAnExistingTarget(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Files", permissions{Files: true})
	root := t.TempDir()
	b.filePath = func(value string) (string, error) {
		if !strings.HasPrefix(value, "C:/") || strings.Contains(value, "..") {
			return "", errDenied
		}
		return filepath.Join(root, strings.TrimPrefix(value, "C:/")), nil
	}
	session := openFixture(t, b, id, token, "files")
	status, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "fs-open", Session: session, Args: json.RawMessage(`{"path":"C:/part","mode":"wx"}`)}, id, token)
	if status != 200 {
		t.Fatal(reply)
	}
	handle := reply["result"].(map[string]any)["handle"].(string)
	args, _ := json.Marshal(map[string]any{"handle": handle, "offset": 0, "data": []byte("synthetic")})
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "file-write", Session: session, Args: args}, id, token)
	if status != 200 {
		t.Fatal("file write failed")
	}
	if err := os.WriteFile(filepath.Join(root, "keep"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "fs-rename", Session: session, Args: json.RawMessage(`{"path":"C:/part","target":"C:/keep"}`)}, id, token)
	if status == 200 {
		t.Fatal("overwrite accepted")
	}
	body, _ := os.ReadFile(filepath.Join(root, "keep"))
	if string(body) != "keep" {
		t.Fatal("destination changed")
	}
	status, _ = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "file-read", Session: session, Args: json.RawMessage(`{"handle":"not-a-granted-handle","length":10}`)}, id, token)
	if status != 403 {
		t.Fatal("unknown handle read")
	}
}
