package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const codePrefix = "GMSSH-CONNECT1."
const connectPort = 22257

var errUnavailable = errors.New("一键接入尚未启用或需要重新配置")

type binding struct {
	Computer    string `json:"computer"`
	Username    string `json:"username"`
	Fingerprint string `json:"fingerprint"`
	ID          string `json:"id"`
	OwnerSID    string `json:"ownerSid"`
	ManagedSID  string `json:"managedSid"`
}

type metadata struct {
	Schema       int     `json:"schema"`
	Binding      binding `json:"binding"`
	Certificate  string  `json:"certificate"`
	Token        string  `json:"token"`
	PasswordHash string  `json:"passwordHash"`
	Enabled      bool    `json:"enabled"`
}

type credential struct {
	Schema      int    `json:"schema"`
	Username    string `json:"username"`
	Fingerprint string `json:"fingerprint"`
	Password    string `json:"password"`
}

type store struct {
	root             string
	protect          func([]byte) ([]byte, error)
	unprotect        func([]byte) ([]byte, error)
	validatePassword func(string, string) error
	validateBinding  func(binding) error
}

func decodeJSON(body []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid JSON")
	}
	return nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errUnavailable
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(path)) {
		return nil, errUnavailable
	}
	return os.ReadFile(path)
}

func (s store) privatePath(name string) (string, error) {
	folder := filepath.Join(s.root, "private")
	info, err := os.Lstat(folder)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errUnavailable
	}
	resolved, err := filepath.EvalSymlinks(folder)
	if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(folder)) {
		return "", errUnavailable
	}
	return filepath.Join(folder, name), nil
}

func (s store) read(name string) ([]byte, error) {
	path, err := s.privatePath(name)
	if err != nil {
		return nil, err
	}
	body, err := readBounded(path, 32768)
	if err != nil {
		return nil, errUnavailable
	}
	defer clear(body)
	plain, err := s.unprotect(body)
	if err != nil {
		return nil, errUnavailable
	}
	return plain, nil
}

func (s store) write(name string, plain []byte) (string, error) {
	path, err := s.privatePath(name)
	if err != nil {
		return "", err
	}
	body, err := s.protect(plain)
	if err != nil {
		return "", errUnavailable
	}
	defer clear(body)
	file, err := os.CreateTemp(filepath.Dir(path), ".connect-*")
	if err != nil {
		return "", errUnavailable
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err = file.Write(body); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary, path)
	}
	if err != nil {
		return "", errUnavailable
	}
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:]), nil
}

func (s store) managed() (binding, map[string]any, error) {
	var agent struct {
		Computer   string `json:"computer"`
		Username   string `json:"username"`
		ManagedSID string `json:"managedAccountSid"`
		OwnerSID   string `json:"trayUserSid"`
		Unified    bool   `json:"unifiedPassword"`
	}
	body, err := readBounded(filepath.Join(s.root, "agent.json"), 65536)
	if err != nil {
		return binding{}, nil, errUnavailable
	}
	if json.Unmarshal(bytes.TrimPrefix(body, []byte{239, 187, 191}), &agent) != nil || !agent.Unified || agent.Username != "gmssh" || !strings.HasPrefix(agent.ManagedSID, "S-1-") || !strings.HasPrefix(agent.OwnerSID, "S-1-") {
		return binding{}, nil, errUnavailable
	}
	body, err = readBounded(filepath.Join(s.root, "connection.json"), 65536)
	if err != nil {
		return binding{}, nil, errUnavailable
	}
	var public map[string]any
	if json.Unmarshal(bytes.TrimPrefix(body, []byte{239, 187, 191}), &public) != nil || public["computer"] != agent.Computer || public["username"] != agent.Username {
		return binding{}, nil, errUnavailable
	}
	b, err := publicBinding(public)
	if err != nil {
		return binding{}, nil, err
	}
	b.OwnerSID = agent.OwnerSID
	b.ManagedSID = agent.ManagedSID
	public["desktopAuth"] = "shared-ssh"
	return b, public, nil
}

func publicBinding(public map[string]any) (binding, error) {
	computer, cOK := public["computer"].(string)
	username, uOK := public["username"].(string)
	key, kOK := public["sshHostPublicKey"].(string)
	reported, rOK := public["sshHostFingerprint"].(string)
	port, pOK := public["sshPort"].(float64)
	fields := strings.Fields(key)
	if !cOK || !uOK || !kOK || !rOK || !pOK || port < 1 || port > 65535 || port != float64(int(port)) || len(fields) < 2 || fields[0] != "ssh-ed25519" {
		return binding{}, errUnavailable
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) != 51 || binary.BigEndian.Uint32(blob[:4]) != 11 || string(blob[4:15]) != "ssh-ed25519" || binary.BigEndian.Uint32(blob[15:19]) != 32 {
		return binding{}, errUnavailable
	}
	digest := sha256.Sum256(blob)
	fingerprint := "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
	found := false
	for _, field := range strings.Fields(reported) {
		if field == fingerprint {
			found = true
		}
	}
	if !found {
		return binding{}, errUnavailable
	}
	identifier := append(append(append([]byte{}, blob...), 0), []byte(strings.ToLower(username))...)
	identifier = binary.BigEndian.AppendUint16(identifier, uint16(port))
	id := sha256.Sum256(identifier)
	return binding{Computer: computer, Username: username, Fingerprint: fingerprint, ID: hex.EncodeToString(id[:16])}, nil
}

func sameBinding(a, b binding) bool {
	return a.Computer == b.Computer && a.Username == b.Username && a.Fingerprint == b.Fingerprint && a.ID == b.ID && a.OwnerSID == b.OwnerSID && a.ManagedSID == b.ManagedSID
}

func (s store) meta() (metadata, error) {
	body, err := s.read("connect-meta.dat")
	if err != nil {
		return metadata{}, err
	}
	defer clear(body)
	var m metadata
	if decodeJSON(body, &m) != nil || m.Schema != 1 || len(m.Token) != 43 || len(m.PasswordHash) != 64 {
		return metadata{}, errUnavailable
	}
	bound, _, err := s.managed()
	if err != nil || !sameBinding(bound, m.Binding) {
		return metadata{}, errUnavailable
	}
	if s.validateBinding != nil && s.validateBinding(bound) != nil {
		return metadata{}, errUnavailable
	}
	return m, nil
}

func certificateFor(b binding) (string, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", nil, err
	}
	name := "gmssh-" + b.ID + ".local"
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name}, DNSNames: []string{name}, NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().AddDate(30, 0, 0), BasicConstraintsValid: true, IsCA: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return "", nil, err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", nil, err
	}
	defer clear(private)
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}), nil
}

func randomToken() (string, error) {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return "", err
	}
	defer clear(token)
	return base64.RawURLEncoding.EncodeToString(token), nil
}

func (s store) initialize(password string) error {
	b, _, err := s.managed()
	if err != nil || password == "" || len(password) > 1024 {
		return errUnavailable
	}
	if err = s.validatePassword(b.Username, password); err != nil {
		return errors.New("连接密码未通过验证")
	}
	m, previous := s.meta()
	if previous != nil {
		// Explicit enabling with a verified password also repairs an interrupted
		// first initialization. A new certificate invalidates every previous code.
		cert, key, err := certificateFor(b)
		if err != nil {
			return errUnavailable
		}
		defer clear(key)
		if _, err = s.write("connect-identity.dat", key); err != nil {
			return err
		}
		m = metadata{Schema: 1, Binding: b, Certificate: cert}
	}
	// Revoke a previous code before replacing the underlying password blob.
	if previous == nil {
		m.Enabled = false
		body, _ := json.Marshal(m)
		if _, err = s.write("connect-meta.dat", body); err != nil {
			return err
		}
	}
	plain, err := json.Marshal(credential{Schema: 1, Username: b.Username, Fingerprint: b.Fingerprint, Password: password})
	if err != nil {
		return errUnavailable
	}
	defer clear(plain)
	digest, err := s.write("connect-password.dat", plain)
	if err != nil {
		return err
	}
	token, err := randomToken()
	if err != nil {
		return errUnavailable
	}
	m.Token = token
	m.PasswordHash = digest
	m.Enabled = true
	body, _ := json.Marshal(m)
	defer clear(body)
	_, err = s.write("connect-meta.dat", body)
	return err
}

func (s store) rotate(disable bool) error {
	m, err := s.meta()
	if err != nil {
		return err
	}
	m.Token, err = randomToken()
	if err != nil {
		return errUnavailable
	}
	m.Enabled = !disable
	body, _ := json.Marshal(m)
	defer clear(body)
	_, err = s.write("connect-meta.dat", body)
	return err
}

func (s store) code(public map[string]any) (string, error) {
	m, err := s.meta()
	if err != nil || !m.Enabled {
		return "", errUnavailable
	}
	b, _, err := s.managed()
	if err != nil {
		return "", err
	}
	if public == nil {
		_, public, err = s.managed()
		if err != nil {
			return "", err
		}
	}
	actual, err := publicBinding(public)
	if err != nil || actual.Username != b.Username || actual.Computer != b.Computer || actual.ID != b.ID || actual.Fingerprint != b.Fingerprint {
		return "", errUnavailable
	}
	addresses, ok := public["addresses"].([]any)
	if !ok {
		return "", errUnavailable
	}
	lan := []any{}
	seen := make(map[string]bool)
	for _, value := range addresses {
		text, ok := value.(string)
		if !ok {
			continue
		}
		ip := net.ParseIP(text)
		if ip != nil && !seen[ip.String()] && ip.IsGlobalUnicast() && !ip.IsLinkLocalUnicast() && (ip.To4() == nil || ip.IsPrivate()) {
			lan = append(lan, ip.String())
			seen[ip.String()] = true
		}
	}
	if len(lan) == 0 {
		return "", errors.New("未提供可用的局域网 IPv4 或 IPv6 地址")
	}
	filtered := map[string]any{}
	for _, name := range []string{"schema", "computer", "username", "sshPort", "sshHostPublicKey", "sshHostFingerprint", "wakeAdapters"} {
		if value, ok := public[name]; ok {
			filtered[name] = value
		}
	}
	filtered["addresses"] = lan
	filtered["desktopAuth"] = "shared-ssh"
	body, err := json.Marshal(map[string]any{"schema": 1, "connection": filtered, "port": connectPort, "certificate": m.Certificate, "token": m.Token})
	if err != nil {
		return "", errUnavailable
	}
	defer clear(body)
	return codePrefix + base64.RawURLEncoding.EncodeToString(body), nil
}

func (s store) allowedPeer(address net.IP) bool {
	if address == nil {
		return false
	}
	if address.IsPrivate() || address.IsLoopback() {
		return true
	}
	if address.To4() != nil || !address.IsGlobalUnicast() || address.IsLinkLocalUnicast() {
		return false
	}
	// Additional IPv6 sources are explicit administrator configuration, not
	// inferred from target addresses and not a change to Windows firewall rules.
	body, err := readBounded(filepath.Join(s.root, "agent.json"), 65536)
	if err != nil {
		return false
	}
	var policy struct {
		Sources []string `json:"connectIpv6Sources"`
	}
	if json.Unmarshal(bytes.TrimPrefix(body, []byte{239, 187, 191}), &policy) != nil || len(policy.Sources) > 32 {
		return false
	}
	allowed := false
	for _, source := range policy.Sources {
		ip, network, err := net.ParseCIDR(source)
		if err != nil {
			ip = net.ParseIP(source)
			if ip == nil {
				return false
			}
			network = &net.IPNet{IP: ip, Mask: net.CIDRMask(128, 128)}
		}
		if ip.To4() != nil || ip.To16() == nil {
			return false
		}
		if network.Contains(address) {
			allowed = true
		}
	}
	return allowed
}

func (s store) handler() http.Handler {
	slots := make(chan struct{}, 1)
	blockedToken := ""
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		fail := func(code int) { w.WriteHeader(code); io.WriteString(w, "{\"ok\":false}") }
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			fail(503)
			return
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		address := net.ParseIP(host)
		if err != nil || !s.allowedPeer(address) || r.Header.Get("Origin") != "" {
			fail(403)
			return
		}
		if r.Method != "POST" || r.URL.Path != "/v1/connect" || r.URL.RawQuery != "" || r.ContentLength < 0 || r.ContentLength > 1024 {
			fail(400)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1025))
		if err != nil || len(body) > 1024 {
			fail(400)
			return
		}
		defer clear(body)
		var request struct {
			Schema int `json:"schema"`
		}
		if decodeJSON(body, &request) != nil || request.Schema != 1 {
			fail(400)
			return
		}
		m, err := s.meta()
		if err != nil || !m.Enabled {
			fail(503)
			return
		}
		provided := r.Header.Get("Authorization")
		expected := "Bearer " + m.Token
		if len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			fail(403)
			return
		}
		if m.Token == blockedToken {
			fail(403)
			return
		}
		path, err := s.privatePath("connect-password.dat")
		if err != nil {
			fail(503)
			return
		}
		sealed, err := readBounded(path, 32768)
		if err != nil {
			fail(503)
			return
		}
		defer clear(sealed)
		digest := sha256.Sum256(sealed)
		if hex.EncodeToString(digest[:]) != m.PasswordHash {
			fail(503)
			return
		}
		plain, err := s.unprotect(sealed)
		if err != nil {
			fail(503)
			return
		}
		defer clear(plain)
		var secret credential
		if decodeJSON(plain, &secret) != nil || secret.Schema != 1 || secret.Username != m.Binding.Username || secret.Fingerprint != m.Binding.Fingerprint || secret.Password == "" || len(secret.Password) > 1024 {
			fail(503)
			return
		}
		if s.validatePassword(secret.Username, secret.Password) != nil {
			// External password changes must not turn repeated imports into lockouts.
			blockedToken = m.Token
			_ = s.rotate(true)
			fail(403)
			return
		}
		// Fixed response fields only; never echo caller input, code, or token.
		result, err := json.Marshal(secret)
		if err != nil {
			fail(503)
			return
		}
		defer clear(result)
		w.WriteHeader(200)
		w.Write(result)
	})
}

func (s store) tlsConfig() (*tls.Config, error) {
	m, err := s.meta()
	if err != nil {
		return nil, err
	}
	private, err := s.read("connect-identity.dat")
	if err != nil {
		return nil, err
	}
	defer clear(private)
	cert, err := tls.X509KeyPair([]byte(m.Certificate), private)
	if err != nil {
		return nil, errUnavailable
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
}
