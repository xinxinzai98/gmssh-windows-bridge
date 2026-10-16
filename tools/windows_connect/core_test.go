package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (store, *string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "private"), 0700); err != nil {
		t.Fatal(err)
	}
	blob := binary.BigEndian.AppendUint32(nil, 11)
	blob = append(blob, []byte("ssh-ed25519")...)
	blob = binary.BigEndian.AppendUint32(blob, 32)
	blob = append(blob, bytes.Repeat([]byte{7}, 32)...)
	digest := sha256.Sum256(blob)
	public := map[string]any{"schema": 1, "computer": "LAB-PC", "username": "gmssh", "sshPort": 22, "sshHostPublicKey": "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob), "sshHostFingerprint": "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:]), "addresses": []string{"192.168.250.2", "100.64.0.7"}}
	agent := map[string]any{"computer": "LAB-PC", "username": "gmssh", "managedAccountSid": "S-1-5-21-1000", "trayUserSid": "S-1-5-21-1001", "unifiedPassword": true}
	for name, value := range map[string]any{"connection.json": public, "agent.json": agent} {
		body, _ := json.Marshal(value)
		if err := os.WriteFile(filepath.Join(root, name), body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	key := make([]byte, 32)
	rand.Read(key)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	password := "synthetic-connection-password"
	s := store{root: root, protect: func(body []byte) ([]byte, error) {
		nonce := make([]byte, gcm.NonceSize())
		rand.Read(nonce)
		return gcm.Seal(nonce, nonce, body, nil), nil
	}, unprotect: func(body []byte) ([]byte, error) {
		if len(body) < gcm.NonceSize() {
			return nil, errors.New("invalid ciphertext")
		}
		return gcm.Open(nil, body[:gcm.NonceSize()], body[gcm.NonceSize():], nil)
	}, validatePassword: func(user, secret string) error {
		if user != "gmssh" || secret != password {
			return errors.New("invalid credential")
		}
		return nil
	}}
	return s, &password
}

func TestLoopbackHealthChecksTheStoreWithoutLoginOrCredentialDisclosure(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	m, _ := s.meta()
	logins := 0
	s.validatePassword = func(string, string) error { logins++; return errors.New("health must not log in") }
	server, _ := testServer(t, s)
	client, err := s.healthClient()
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	response, err := client.Get(server.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(body) != "{\"schema\":1,\"ready\":true}" || logins != 0 || bytes.Contains(body, []byte(*password)) || bytes.Contains(body, []byte(m.Token)) {
		t.Fatalf("unexpected health response: status=%d, logins=%d", response.StatusCode, logins)
	}
	request := httptest.NewRequest("GET", "https://local/v1/health", nil)
	request.RemoteAddr = "192.168.250.2:1234"
	recorder := httptest.NewRecorder()
	s.handler().ServeHTTP(recorder, request)
	if recorder.Code != 403 {
		t.Fatal("LAN peers must not access local health")
	}
	path, _ := s.privatePath("connect-password.dat")
	if err := os.WriteFile(path, []byte("damaged fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	response, err = client.Get(server.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 503 || logins != 0 {
		t.Fatal("corrupt credentials were reported healthy or caused a login")
	}
	other, otherPassword := fixture(t)
	if err := other.initialize(*otherPassword); err != nil {
		t.Fatal(err)
	}
	otherServer, _ := testServer(t, other)
	if response, err = client.Get(otherServer.URL + "/v1/health"); err == nil {
		response.Body.Close()
		t.Fatal("health client accepted another device certificate")
	}
}

func testServer(t *testing.T, s store) (*httptest.Server, *http.Client) {
	t.Helper()
	configuration, err := s.tlsConfig()
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(s.handler())
	server.TLS = configuration
	server.StartTLS()
	t.Cleanup(server.Close)
	m, _ := s.meta()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM([]byte(m.Certificate)) {
		t.Fatal("certificate missing")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "gmssh-" + m.Binding.ID + ".local", MinVersion: tls.VersionTLS12}}
	t.Cleanup(transport.CloseIdleConnections)
	return server, &http.Client{Transport: transport}
}

func request(t *testing.T, client *http.Client, url, token string) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/v1/connect", strings.NewReader(`{"schema":1}`))
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, body
}

func TestLongLivedCodeIsReusableAndContainsNoConnectionPassword(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	code, err := s.code(nil)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := s.code(nil)
	if code != again {
		t.Fatal("copying a code rotated it")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(code, codePrefix))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	json.Unmarshal(raw, &document)
	if len(document) != 5 || document["expiresAt"] != nil || bytes.Contains(raw, []byte(*password)) {
		t.Fatal("code contains a password or unexpected expiration")
	}
	connection := document["connection"].(map[string]any)
	if len(connection["addresses"].([]any)) != 1 {
		t.Fatal("non-LAN address exported")
	}
	for _, name := range []string{"connect-password.dat", "connect-meta.dat", "connect-identity.dat"} {
		body, _ := os.ReadFile(filepath.Join(s.root, "private", name))
		if bytes.Contains(body, []byte(*password)) || bytes.Contains(body, []byte(document["token"].(string))) || bytes.Contains(body, []byte("PRIVATE KEY")) {
			t.Fatal("unencrypted private state")
		}
	}
	server, client := testServer(t, s)
	m, _ := s.meta()
	for i := 0; i < 2; i++ {
		status, body := request(t, client, server.URL, m.Token)
		if status != 200 {
			t.Fatalf("request %d: %d", i, status)
		}
		var result credential
		if json.Unmarshal(body, &result) != nil || result.Password != *password || result.Username != "gmssh" {
			t.Fatal("credential exchange failed")
		}
	}
}

func TestResetAndPasswordChangeRevokeOldCodesWithoutChangingDeviceIdentity(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	before, _ := s.meta()
	server, client := testServer(t, s)
	if err := s.rotate(false); err != nil {
		t.Fatal(err)
	}
	reset, _ := s.meta()
	if reset.Certificate != before.Certificate || reset.Binding != before.Binding {
		t.Fatal("reset changed device identity")
	}
	if status, _ := request(t, client, server.URL, before.Token); status != 403 {
		t.Fatal("old code remains valid")
	}
	if status, _ := request(t, client, server.URL, reset.Token); status != 200 {
		t.Fatal("replacement code failed")
	}
	if err := s.rotate(true); err != nil {
		t.Fatal(err)
	}
	if status, _ := request(t, client, server.URL, reset.Token); status != 503 {
		t.Fatal("revoked state served a password")
	}
	*password = "synthetic-rotated-password"
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	after, _ := s.meta()
	if after.Certificate != before.Certificate || after.Token == reset.Token {
		t.Fatal("password change did not retain certificate and rotate code")
	}
	if status, _ := request(t, client, server.URL, reset.Token); status != 403 {
		t.Fatal("old code survived password change")
	}
	status, body := request(t, client, server.URL, after.Token)
	var result credential
	json.Unmarshal(body, &result)
	if status != 200 || result.Password != *password {
		t.Fatal("new credential failed")
	}
}

func TestInvalidPasswordCannotCreateOrReplacePrivateState(t *testing.T) {
	s, password := fixture(t)
	if s.initialize("incorrect") == nil {
		t.Fatal("invalid password accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(s.root, "private"))
	if len(entries) != 0 {
		t.Fatal("invalid password wrote state")
	}
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	before, _ := s.code(nil)
	if s.initialize("incorrect") == nil {
		t.Fatal("invalid replacement accepted")
	}
	after, _ := s.code(nil)
	if before != after {
		t.Fatal("invalid password changed a working code")
	}
}

func TestIdentityChangesAndDamagedPasswordStateFailClosed(t *testing.T) {
	s, password := fixture(t)
	s.initialize(*password)
	server, client := testServer(t, s)
	m, _ := s.meta()
	if err := os.WriteFile(filepath.Join(s.root, "private", "connect-password.dat"), []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}
	if status, body := request(t, client, server.URL, m.Token); status != 503 || bytes.Contains(body, []byte(*password)) {
		t.Fatal("damaged state disclosed data")
	}
	public, _ := os.ReadFile(filepath.Join(s.root, "connection.json"))
	var data map[string]any
	json.Unmarshal(public, &data)
	data["computer"] = "DIFFERENT-PC"
	public, _ = json.Marshal(data)
	os.WriteFile(filepath.Join(s.root, "connection.json"), public, 0600)
	if _, err := s.code(nil); err == nil {
		t.Fatal("changed identity exported a code")
	}
	if status, _ := request(t, client, server.URL, m.Token); status != 503 {
		t.Fatal("changed identity served data")
	}
}

func TestOnlyTheBoundedAuthenticatedEndpointCanReturnCredentials(t *testing.T) {
	s, password := fixture(t)
	s.initialize(*password)
	server, client := testServer(t, s)
	m, _ := s.meta()
	for _, test := range []struct {
		method, path, body, token string
		status                    int
	}{{"GET", "/v1/connect", "", m.Token, 400}, {"POST", "/v1/connect?token=ignored", `{"schema":1}`, m.Token, 400}, {"POST", "/other", `{"schema":1}`, m.Token, 400}, {"POST", "/v1/connect", strings.Repeat("x", 1025), m.Token, 400}, {"POST", "/v1/connect", `{"schema":1}`, "incorrect", 403}} {
		req, _ := http.NewRequest(test.method, server.URL+test.path, strings.NewReader(test.body))
		req.Header.Set("Authorization", "Bearer "+test.token)
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != test.status || bytes.Contains(body, []byte(*password)) || bytes.Contains(body, []byte(m.Token)) {
			t.Fatalf("invalid request accepted: %s %s", test.method, test.path)
		}
	}
}

func TestPrivateStateSymlinksAreRejected(t *testing.T) {
	s, password := fixture(t)
	s.initialize(*password)
	outside := t.TempDir()
	original := filepath.Join(s.root, "private")
	os.Rename(original, filepath.Join(outside, "saved"))
	if err := os.Symlink(filepath.Join(outside, "saved"), original); err != nil {
		t.Skip("symlinks unavailable")
	}
	if _, err := s.code(nil); err == nil {
		t.Fatal("private directory link accepted")
	}
}

func TestExternalPasswordChangeStopsCredentialExchangeWithoutRepeatedLogons(t *testing.T) {
	s, password := fixture(t)
	s.initialize(*password)
	server, client := testServer(t, s)
	m, _ := s.meta()
	*password = "synthetic-external-change"
	status, body := request(t, client, server.URL, m.Token)
	if status != 403 || bytes.Contains(body, []byte(*password)) {
		t.Fatal("stale password was returned")
	}
	after, _ := s.meta()
	if after.Enabled || after.Token == m.Token {
		t.Fatal("stale code was not revoked")
	}
	if _, err := s.code(nil); err == nil {
		t.Fatal("disabled code exported")
	}
	if err := s.initialize(*password); err != nil {
		t.Fatal("could not enable the new verified password")
	}
	if status, _ := request(t, client, server.URL, m.Token); status != 403 {
		t.Fatal("old code survived re-enabling")
	}
}

func TestVerifiedEnablingRepairsInterruptedInitialization(t *testing.T) {
	s, password := fixture(t)
	os.WriteFile(filepath.Join(s.root, "private", "connect-identity.dat"), []byte("interrupted-fixture"), 0600)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	if _, err := s.tlsConfig(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.code(nil); err != nil {
		t.Fatal(err)
	}
}

func TestSuppliedIPv6CodeKeepsTheSameIdentityAndCertificate(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	before, _ := s.meta()
	body, _ := os.ReadFile(filepath.Join(s.root, "connection.json"))
	var public map[string]any
	json.Unmarshal(body, &public)
	public["addresses"] = []any{"2001:0DB8:0:0::42", "192.168.250.2", "2001:db8::42", "fe80::1", "::1"}
	code, err := s.code(public)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(code, codePrefix))
	var document struct {
		Certificate string `json:"certificate"`
		Connection  struct {
			Addresses []string `json:"addresses"`
		} `json:"connection"`
	}
	if json.Unmarshal(raw, &document) != nil {
		t.Fatal("invalid export")
	}
	if strings.Join(document.Connection.Addresses, ",") != "2001:db8::42,192.168.250.2" {
		t.Fatalf("unexpected addresses: %v", document.Connection.Addresses)
	}
	if document.Certificate != before.Certificate || bytes.Contains(raw, []byte(*password)) {
		t.Fatal("identity changed or password exported")
	}
	after, _ := s.meta()
	if after.Binding != before.Binding || after.Token != before.Token {
		t.Fatal("address export rotated the code")
	}
}

func TestIPv6CredentialEndpointRequiresAnExplicitAllowedSource(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	m, _ := s.meta()
	call := func(peer string) int {
		req := httptest.NewRequest("POST", "https://gmssh.local/v1/connect", strings.NewReader(`{"schema":1}`))
		req.RemoteAddr = net.JoinHostPort(peer, "40000")
		req.Header.Set("Authorization", "Bearer "+m.Token)
		response := httptest.NewRecorder()
		s.handler().ServeHTTP(response, req)
		return response.Code
	}
	if call("2001:db8:10::4") != 403 {
		t.Fatal("public IPv6 source accepted by default")
	}
	agentPath := filepath.Join(s.root, "agent.json")
	body, _ := os.ReadFile(agentPath)
	var agent map[string]any
	json.Unmarshal(body, &agent)
	agent["connectIpv6Sources"] = []string{"2001:db8:10::/64", "2001:db8:20::5"}
	body, _ = json.Marshal(agent)
	os.WriteFile(agentPath, body, 0600)
	if call("2001:db8:10::4") != 200 || call("2001:db8:20::5") != 200 {
		t.Fatal("explicit IPv6 source rejected")
	}
	for _, peer := range []string{"2001:db8:11::4", "2001:db8:20::6", "192.0.2.4", "fe80::1"} {
		if call(peer) != 403 {
			t.Fatalf("unexpected allowed source: %s", peer)
		}
	}
	agent["connectIpv6Sources"] = []string{"2001:db8:10::/64", "invalid"}
	body, _ = json.Marshal(agent)
	os.WriteFile(agentPath, body, 0600)
	if call("2001:db8:10::4") != 403 {
		t.Fatal("malformed policy did not fail closed")
	}
}

func TestPinnedTLSExchangeAcceptsBothLoopbackAddressFamilies(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	configuration, err := s.tlsConfig()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(s.handler())
	server.Listener = listener
	server.TLS = configuration
	server.StartTLS()
	defer server.Close()
	m, _ := s.meta()
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM([]byte(m.Certificate))
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "gmssh-" + m.Binding.ID + ".local", MinVersion: tls.VersionTLS12}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	port := listener.Addr().(*net.TCPAddr).Port
	for _, host := range []string{"127.0.0.1", "::1"} {
		url := "https://" + net.JoinHostPort(host, fmt.Sprint(port))
		if status, body := request(t, client, url, m.Token); status != 200 || !bytes.Contains(body, []byte(*password)) {
			t.Fatalf("exchange failed via %s: %d", host, status)
		}
	}
}
