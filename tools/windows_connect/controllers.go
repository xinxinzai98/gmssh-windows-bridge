package main

// Independent controllers never receive the shared Windows or desktop password.
// All privileged operations enter this authenticated, policy-checked boundary.
import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

var errDenied = errors.New("ACCESS_DENIED")

type permissions struct {
	View      bool `json:"view"`
	Input     bool `json:"input"`
	Clipboard bool `json:"clipboard"`
	Files     bool `json:"files"`
	FilesRead bool `json:"files_read,omitempty"`
	Terminal  bool `json:"terminal"`
	Power     bool `json:"power"`
}

type controller struct {
	ID      string      `json:"id"`
	Name    string      `json:"name"`
	Hash    string      `json:"tokenHash"`
	Policy  permissions `json:"permissions"`
	Created int64       `json:"created"`
}

type controllerRegistry struct {
	Schema  int          `json:"schema"`
	Binding string       `json:"binding"`
	Items   []controller `json:"items"`
}

type controllerSession struct {
	ID, ControllerID, Name, Kind, Address string
	Started, Updated                      time.Time
	mu                                    sync.Mutex
	files                                 map[string]*os.File
	desktop                               *desktopSession
	terminal                              *terminalSession
	cancel                                context.CancelFunc
	closed                                atomic.Bool
	closeOnce                             sync.Once
	finished                              chan struct{}
	onClosed                              func()
	expiry                                *time.Timer
}

func (s *controllerSession) close() {
	// Block new and queued requests before waiting for a possibly blocked I/O.
	s.closed.Store(true)
	s.closeOnce.Do(func() {
		go func() {
			s.mu.Lock()
			if s.expiry != nil {
				s.expiry.Stop()
			}
			if s.desktop != nil {
				s.desktop.close()
			}
			if s.terminal != nil {
				s.terminal.close()
			}
			if s.cancel != nil {
				s.cancel()
			}
			for _, file := range s.files {
				file.Close()
			}
			s.files = nil
			s.mu.Unlock()
			if s.onClosed != nil {
				s.onClosed()
			}
			close(s.finished)
		}()
	})
}

type controllerBroker struct {
	store             store
	mu                sync.Mutex
	sessions          map[string]*controllerSession
	openDesktop       func() (net.Conn, error)
	execute           func(context.Context, string, string, string, string) ([]byte, int, error)
	filePath          func(string) (string, error)
	readInfo          func(context.Context, string, string) ([]byte, error)
	openTerminal      func(string, string, int, int) (pseudoTerminal, error)
	infoSlots         chan struct{}
	accountMu         sync.Mutex
	blockedCredential string
	lease             time.Duration
	aiJobs            map[string]*aiJob
	aiDesktop         func(context.Context, string, json.RawMessage) (any, error)
}

func (b *controllerBroker) verifyAccount(m metadata, secret credential) error {
	b.accountMu.Lock()
	defer b.accountMu.Unlock()
	if b.blockedCredential == m.PasswordHash {
		return errUnavailable
	}
	if b.store.validatePassword == nil || b.store.validatePassword(secret.Username, secret.Password) != nil {
		b.blockedCredential = m.PasswordHash
		return errUnavailable
	}
	return nil
}
func (b *controllerBroker) accountFailure(m metadata, err error) {
	if errors.Is(err, errDenied) {
		b.accountMu.Lock()
		b.blockedCredential = m.PasswordHash
		b.accountMu.Unlock()
	}
}

func newControllerBroker(s store) *controllerBroker {
	return &controllerBroker{store: s, sessions: map[string]*controllerSession{},
		openDesktop: func() (net.Conn, error) { return net.DialTimeout("tcp", "127.0.0.1:21118", 3*time.Second) },
		execute:     runControllerCommand, filePath: controllerFilePath, readInfo: runControllerInfo, infoSlots: make(chan struct{}, 2), openTerminal: openControllerTerminal, lease: 30 * time.Minute, aiDesktop: runAIDesktop}
}

func (b *controllerBroker) expire(s *controllerSession) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sessions[s.ID] != s {
		return
	}
	remaining := b.lease - time.Since(s.Updated)
	if s.closed.Load() {
		return
	}
	if remaining > 0 {
		s.expiry.Reset(remaining)
		return
	}
	s.close()
}

func randomID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}
func tokenHash(token string) string {
	value := sha256.Sum256([]byte(token))
	return hex.EncodeToString(value[:])
}
func validControllerID(id string) bool {
	raw, err := hex.DecodeString(id)
	return err == nil && len(raw) == 16 && strings.ToLower(id) == id
}
func validPolicy(p permissions) bool { return p.View || !p.Input && !p.Clipboard }
func normalizedPolicy(p permissions) permissions {
	if p.Files {
		p.FilesRead = false
	} // Preserve the six-field legacy read/write policy.
	return p
}

func (b *controllerBroker) registry() (controllerRegistry, error) {
	m, err := b.store.meta()
	if err != nil || !m.Enabled {
		return controllerRegistry{}, errUnavailable
	}
	file, err := b.store.privatePath("controllers.dat")
	if err != nil {
		return controllerRegistry{}, err
	}
	if _, err = os.Lstat(file); os.IsNotExist(err) {
		return controllerRegistry{Schema: 1, Binding: m.Binding.ID, Items: []controller{}}, nil
	}
	raw, err := b.store.read("controllers.dat")
	if err != nil {
		return controllerRegistry{}, err
	}
	defer clear(raw)
	var registry controllerRegistry
	if decodeJSON(raw, &registry) != nil || registry.Schema != 1 || registry.Binding != m.Binding.ID || len(registry.Items) > 32 {
		return registry, errUnavailable
	}
	seen := map[string]bool{}
	for index, c := range registry.Items {
		if !validControllerID(c.ID) || seen[c.ID] || len(c.Hash) != 64 || len(c.Name) < 1 || len(c.Name) > 240 || !utf8.ValidString(c.Name) || !validPolicy(c.Policy) {
			return registry, errUnavailable
		}
		seen[c.ID] = true
		registry.Items[index].Policy = normalizedPolicy(c.Policy)
	}
	return registry, nil
}

func (b *controllerBroker) save(registry controllerRegistry) error {
	raw, err := json.Marshal(registry)
	if err != nil {
		return err
	}
	defer clear(raw)
	_, err = b.store.write("controllers.dat", raw)
	return err
}

func (b *controllerBroker) authenticate(r *http.Request) (controller, error) {
	id := r.Header.Get("X-GMSSH-Controller")
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !validControllerID(id) || len(token) != 43 {
		return controller{}, errDenied
	}
	registry, err := b.registry()
	if err != nil {
		return controller{}, errUnavailable
	}
	hash := tokenHash(token)
	for _, c := range registry.Items {
		if c.ID == id && subtle.ConstantTimeCompare([]byte(c.Hash), []byte(hash)) == 1 {
			return c, nil
		}
	}
	return controller{}, errDenied
}

type controllerRequest struct {
	Action    string          `json:"action"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Policy    permissions     `json:"permissions,omitempty"`
	Kind      string          `json:"kind,omitempty"`
	Session   string          `json:"session,omitempty"`
	Args      json.RawMessage `json:"args,omitempty"`
	Addresses []string        `json:"addresses,omitempty"`
}

func (b *controllerBroker) manage(r controllerRequest) (any, error) {
	r.Policy = normalizedPolicy(r.Policy)
	registry, err := b.registry()
	if err != nil {
		return nil, err
	}
	if r.Action == "list" {
		items := []map[string]any{}
		for _, c := range registry.Items {
			items = append(items, map[string]any{"id": c.ID, "name": c.Name, "permissions": c.Policy, "created": c.Created})
		}
		sessions := []map[string]any{}
		for _, s := range b.sessions {
			if time.Since(s.Updated) > 30*time.Minute || s.desktop != nil && s.desktop.snapshot() == "disconnected" {
				s.close()
			}
			state := "ready"
			if s.closed.Load() {
				state = "closing"
			} else if s.desktop != nil {
				state = s.desktop.snapshot()
			}
			sessions = append(sessions, map[string]any{"id": s.ID, "controllerId": s.ControllerID, "name": s.Name, "kind": s.Kind, "state": state, "address": s.Address, "started": s.Started.UTC().Format(time.RFC3339), "updated": s.Updated.UTC().Format(time.RFC3339)})
		}
		return map[string]any{"controllers": items, "sessions": sessions, "scope": "independent-controller-sessions"}, nil
	}
	if r.Action == "disconnect" {
		s := b.sessions[r.ID]
		if s == nil {
			return nil, errUnavailable
		}
		s.close()
		return map[string]bool{"disconnected": true}, nil
	}
	if r.Action == "grant" {
		if len(registry.Items) >= 32 || len(strings.TrimSpace(r.Name)) < 1 || len(r.Name) > 240 || !utf8.ValidString(r.Name) || strings.ContainsAny(r.Name, "\r\n\x00") || !validPolicy(r.Policy) {
			return nil, errUnavailable
		}
		_, public, err := b.store.managed()
		if err != nil {
			return nil, err
		}
		if r.Addresses != nil {
			if len(r.Addresses) < 1 || len(r.Addresses) > 32 {
				return nil, errUnavailable
			}
			addresses := make([]any, 0, len(r.Addresses))
			for _, address := range r.Addresses {
				addresses = append(addresses, address)
			}
			public["addresses"] = addresses
		}
		filtered, err := publicConnection(public)
		if err != nil {
			return nil, err
		}
		raw := make([]byte, 32)
		if _, err = rand.Read(raw); err != nil {
			return nil, err
		}
		token := base64.RawURLEncoding.EncodeToString(raw)
		clear(raw)
		c := controller{ID: randomID(), Name: strings.TrimSpace(r.Name), Hash: tokenHash(token), Policy: r.Policy, Created: time.Now().UnixMilli()}
		registry.Items = append(registry.Items, c)
		if err = b.save(registry); err != nil {
			return nil, err
		}
		m, err := b.store.meta()
		if err != nil {
			return nil, err
		}
		body, err := json.Marshal(map[string]any{"schema": 2, "connection": filtered, "port": connectPort, "certificate": m.Certificate, "controller": map[string]any{"id": c.ID, "name": c.Name, "token": token, "permissions": c.Policy}})
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": c.ID, "code": "GMSSH-AUTH2." + base64.RawURLEncoding.EncodeToString(body), "permissions": c.Policy}, nil
	}
	if (r.Action != "revoke" && r.Action != "permissions") || !validControllerID(r.ID) || !validPolicy(r.Policy) {
		return nil, errUnavailable
	}
	found := false
	next := []controller{}
	for _, c := range registry.Items {
		if c.ID == r.ID {
			found = true
			if r.Action == "revoke" {
				continue
			}
			c.Policy = r.Policy
		}
		next = append(next, c)
	}
	if !found {
		return nil, errUnavailable
	}
	registry.Items = next
	if err = b.save(registry); err != nil {
		return nil, err
	}
	b.cancelAIJobs(r.ID)
	// Changes close this controller's sessions. Other controllers and legacy SSH stay intact.
	for _, s := range b.sessions {
		if s.ControllerID == r.ID {
			s.close()
		}
	}
	return map[string]bool{"updated": true}, nil
}

func permissionFor(p permissions, kind string) bool {
	switch kind {
	case "desktop":
		return p.View
	case "files":
		return p.Files || p.FilesRead
	case "terminal":
		return p.Terminal
	case "power":
		return p.Power
	}
	return false
}

func (b *controllerBroker) request(c controller, r controllerRequest, address string) (any, error) {
	if strings.HasPrefix(r.Action, "ai-") {
		return b.aiRequest(c, r)
	}
	if r.Action == "info" {
		var value struct {
			Tool    string                     `json:"tool"`
			Options map[string]json.RawMessage `json:"options"`
		}
		if decodeJSON(r.Args, &value) != nil {
			return nil, errDenied
		}
		file, prefix, err := infoScript(value.Tool, value.Options)
		if err != nil {
			return nil, err
		}
		select {
		case b.infoSlots <- struct{}{}:
		default:
			return nil, errUnavailable
		}
		defer func() { <-b.infoSlots }()
		b.mu.Unlock()
		defer b.mu.Lock()
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		body, err := b.readInfo(ctx, file, prefix)
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, aiFailure("OPERATION_TIMEOUT")
			}
			return nil, err
		}
		return map[string]any{"data": body}, nil
	}
	if r.Action == "capabilities" {
		return map[string]any{"protocol": 2, "aiProtocol": 1, "fileReadOnly": 1, "windowsUnlock": 1, "permissions": c.Policy, "name": c.Name, "controllerId": c.ID}, nil
	}
	if r.Action == "open" {
		if !permissionFor(c.Policy, r.Kind) {
			return nil, errDenied
		}
		count, desktops := 0, 0
		for _, s := range b.sessions {
			if time.Since(s.Updated) > 30*time.Minute || s.desktop != nil && s.desktop.snapshot() == "disconnected" {
				s.close()
			}
			if s.closed.Load() {
				continue
			}
			if s.Kind == "desktop" {
				desktops++
			}
			if s.ControllerID == c.ID {
				count++
			}
		}
		if count >= 8 || len(b.sessions) >= 64 || r.Kind == "desktop" && desktops >= 8 {
			return nil, errors.New("SESSION_LIMIT")
		}
		now := time.Now()
		s := &controllerSession{ID: randomID(), ControllerID: c.ID, Name: c.Name, Kind: r.Kind, Address: address, Started: now, Updated: now, files: map[string]*os.File{}, finished: make(chan struct{})}
		s.onClosed = func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			if b.sessions[s.ID] == s {
				delete(b.sessions, s.ID)
			}
		}
		if r.Kind == "desktop" {
			conn, err := b.openDesktop()
			if err != nil {
				return nil, errUnavailable
			}
			s.desktop = newDesktopSession(conn)
		}
		b.sessions[s.ID] = s
		s.expiry = time.AfterFunc(b.lease, func() { b.expire(s) })
		return map[string]any{"session": s.ID, "permissions": c.Policy}, nil
	}
	s := b.sessions[r.Session]
	if s == nil || s.ControllerID != c.ID {
		return nil, errDenied
	}
	if s.closed.Load() {
		return nil, aiFailure("SESSION_CLOSED")
	}
	if !permissionFor(c.Policy, s.Kind) {
		s.close()
		return nil, errDenied
	}
	s.Updated = time.Now()
	if s.expiry != nil {
		s.expiry.Reset(b.lease)
	}
	if r.Action == "close" {
		s.close()
		return map[string]bool{"closed": true}, nil
	}
	// Potentially blocking I/O runs outside the registry lock. Revocation can close it immediately.
	b.mu.Unlock()
	defer b.mu.Lock()
	s.mu.Lock()
	if s.closed.Load() {
		s.mu.Unlock()
		return nil, errDenied
	}
	if s.Kind == "desktop" {
		s.mu.Unlock()
		if r.Action == "desktop-read" {
			return s.desktop.read(c.Policy)
		}
		if r.Action == "desktop-write" {
			var value struct {
				Data []byte `json:"data"`
			}
			if decodeJSON(r.Args, &value) != nil || len(value.Data) > 16384 {
				return nil, errUnavailable
			}
			m, err := b.store.meta()
			if err != nil {
				return nil, err
			}
			secret, err := b.store.storedCredential(m)
			if err != nil {
				return nil, err
			}
			defer func() { secret.Password = ""; secret.DesktopPassword = "" }()
			desktopPassword := secret.DesktopPassword
			if desktopPassword == "" {
				desktopPassword = secret.Password
			}
			return s.desktop.write(value.Data, c.Policy, desktopPassword, c.Name)
		}
		return nil, errDenied
	}
	if s.Kind == "terminal" && strings.HasPrefix(r.Action, "terminal-") {
		var value struct {
			Data   []byte `json:"data,omitempty"`
			Width  int    `json:"width,omitempty"`
			Height int    `json:"height,omitempty"`
		}
		if decodeJSON(r.Args, &value) != nil || len(value.Data) > 8192 {
			s.mu.Unlock()
			return nil, errDenied
		}
		if r.Action == "terminal-start" {
			if value.Width < 1 || value.Width > 512 || value.Height < 1 || value.Height > 512 {
				s.mu.Unlock()
				return nil, errDenied
			}
			if s.terminal != nil {
				s.mu.Unlock()
				return nil, errUnavailable
			}
			m, err := b.store.meta()
			if err != nil {
				s.mu.Unlock()
				return nil, err
			}
			secret, err := b.store.storedCredential(m)
			if err != nil {
				s.mu.Unlock()
				return nil, err
			}
			if err = b.verifyAccount(m, secret); err != nil {
				s.mu.Unlock()
				return nil, err
			}
			pty, err := b.openTerminal(secret.Username, secret.Password, value.Width, value.Height)
			b.accountFailure(m, err)
			secret.Password = ""
			if err != nil {
				s.mu.Unlock()
				return nil, err
			}
			s.terminal = newTerminalSession(pty)
			s.mu.Unlock()
			return map[string]bool{"started": true}, nil
		}
		terminal := s.terminal
		s.mu.Unlock()
		if terminal == nil {
			return nil, errUnavailable
		}
		switch r.Action {
		case "terminal-read":
			return terminal.read()
		case "terminal-write":
			return terminal.write(value.Data)
		case "terminal-resize":
			if value.Width < 1 || value.Width > 512 || value.Height < 1 || value.Height > 512 {
				return nil, errDenied
			}
			if err := terminal.pty.Resize(value.Width, value.Height); err != nil {
				return nil, err
			}
			return map[string]bool{"resized": true}, nil
		}
		return nil, errDenied
	}
	defer s.mu.Unlock()
	if s.Kind == "files" {
		result, err := b.fileRequest(s, r, c.Policy)
		if s.closed.Load() {
			return nil, aiFailure("SESSION_CLOSED")
		}
		return result, err
	}
	var value struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if decodeJSON(r.Args, &value) != nil || value.Timeout < 1 || value.Timeout > 60 || len(value.Command) > 32768 {
		return nil, errUnavailable
	}
	if s.Kind == "terminal" && r.Action != "execute" || s.Kind == "power" && r.Action != "power" {
		return nil, errDenied
	}
	if s.Kind == "power" && value.Command != "restart" && value.Command != "shutdown" && value.Command != "cancel" {
		return nil, errDenied
	}
	m, err := b.store.meta()
	if err != nil {
		return nil, err
	}
	secret, err := b.store.storedCredential(m)
	if err != nil {
		return nil, err
	}
	defer func() { secret.Password = "" }()
	if err = b.verifyAccount(m, secret); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(value.Timeout)*time.Second)
	defer cancel()
	if s.cancel != nil {
		return nil, errUnavailable
	}
	s.cancel = cancel
	s.mu.Unlock()
	output, exit, err := b.execute(ctx, secret.Username, secret.Password, s.Kind, value.Command)
	b.accountFailure(m, err)
	s.mu.Lock()
	s.cancel = nil
	if s.closed.Load() {
		return nil, aiFailure("OPERATION_INTERRUPTED")
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, aiFailure("OPERATION_TIMEOUT")
		}
		return nil, err
	}
	return map[string]any{"output": string(output), "exit": exit}, nil
}

func (b *controllerBroker) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	fail := func(status int, code string) {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]any{"ok": false, "code": code})
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	address := net.ParseIP(host)
	if err != nil || !b.store.allowedPeer(address) {
		fail(403, "SOURCE_DENIED")
		return
	}
	if r.Header.Get("Origin") != "" || r.Method != "POST" || r.URL.RawQuery != "" || r.ContentLength < 0 || r.ContentLength > 128*1024 {
		fail(403, "ACCESS_DENIED")
		return
	}
	if r.URL.Path != "/v2/controller" && r.URL.Path != "/v2/manage" {
		fail(404, "UNSUPPORTED")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 128*1024+1))
	if err != nil || len(body) > 128*1024 {
		fail(400, "INVALID_REQUEST")
		return
	}
	defer clear(body)
	var request controllerRequest
	if decodeJSON(body, &request) != nil {
		fail(400, "INVALID_REQUEST")
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	var result any
	var policy *permissions
	if r.URL.Path == "/v2/manage" {
		m, e := b.store.meta()
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if e != nil || !address.IsLoopback() || len(provided) != len(m.Token) || subtle.ConstantTimeCompare([]byte(provided), []byte(m.Token)) != 1 {
			fail(403, "ACCESS_DENIED")
			return
		}
		result, err = b.manage(request)
	} else {
		c, e := b.authenticate(r)
		if e != nil {
			fail(403, "ACCESS_DENIED")
			return
		}
		policy = &c.Policy
		if request.Action == "execute" && c.Policy.Terminal {
			// One-shot commands allow up to 60s; desktop/terminal streams keep short polls.
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(65 * time.Second))
		}
		result, err = b.request(c, request, host)
	}
	if err != nil {
		code := "OPERATION_FAILED"
		status := 409
		if os.IsExist(err) {
			code = "CONFLICT"
		}
		if os.IsNotExist(err) {
			code = "NOT_FOUND"
		}
		if os.IsPermission(err) {
			code = "ACCESS_DENIED"
			status = 403
		}
		if errors.Is(err, errDenied) {
			code = "ACCESS_DENIED"
			status = 403
		}
		var aiErr aiFailure
		if errors.As(err, &aiErr) {
			code = string(aiErr)
		}
		fail(status, code)
		return
	}
	reply := map[string]any{"ok": true, "result": result}
	if policy != nil {
		reply["permissions"] = policy
	}
	json.NewEncoder(w).Encode(reply)
}

func (s store) manageControllers(request []byte) (json.RawMessage, error) {
	if len(request) > 16384 {
		return nil, errUnavailable
	}
	var decoded controllerRequest
	if decodeJSON(request, &decoded) != nil {
		return nil, errUnavailable
	}
	m, err := s.meta()
	if err != nil {
		return nil, err
	}
	client, err := s.healthClient()
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	client.Timeout = 8 * time.Second
	req, err := http.NewRequest("POST", fmt.Sprintf("https://127.0.0.1:%d/v2/manage", connectPort), strings.NewReader(string(request)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+m.Token)
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 || response.StatusCode != 200 {
		return nil, errUnavailable
	}
	return raw, nil
}
