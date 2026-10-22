package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConnectionHTTPAllowsDelayedTLSAndIdleRequest(t *testing.T) {
	seed := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	configuration := seed.TLS.Clone()
	roots := x509.NewCertPool()
	roots.AddCert(seed.Certificate())
	seed.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	finished := make(chan error, 1)
	go func() {
		finished <- serveConnections(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }), configuration)
	}()
	raw, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	raw.SetDeadline(time.Now().Add(25 * time.Second))
	// A delayed ClientHello must not be cut off by the former five-second budget.
	time.Sleep(6 * time.Second)
	connection := tls.Client(raw, &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12})
	if err := connection.Handshake(); err != nil {
		t.Fatalf("delayed TLS: %v", err)
	}
	defer connection.Close()
	reader := bufio.NewReader(connection)
	request := func() {
		t.Helper()
		if _, err := io.WriteString(connection, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n"); err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || string(body) != "ok" {
			t.Fatalf("response: status=%d body=%q error=%v", response.StatusCode, body, err)
		}
	}
	request()
	time.Sleep(6 * time.Second)
	request()
	connection.Close()
	listener.Close()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("test server did not stop")
	}
}
