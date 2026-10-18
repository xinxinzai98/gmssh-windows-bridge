package main

// Opt-in loopback fixture for cross-language integration. No Windows APIs,
// real accounts, real remote addresses, or user data are touched.
import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureFrame(conn net.Conn, raw []byte) error {
	width := 1
	for len(raw) > (1<<(8*width-2))-1 && width < 4 {
		width++
	}
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(raw)<<2|width-1))
	packet := append(header[:width], raw...)
	for len(packet) > 0 {
		n, err := conn.Write(packet)
		if err != nil {
			return err
		}
		packet = packet[n:]
	}
	return nil
}
func fixtureReadFrame(conn net.Conn) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header[:1]); err != nil {
		return nil, err
	}
	width := int(header[0]&3) + 1
	if _, err := io.ReadFull(conn, header[1:width]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header) >> 2
	if size > 16384 {
		return nil, errDenied
	}
	raw := make([]byte, size)
	_, err := io.ReadFull(conn, raw)
	return raw, err
}

func TestControllerLoopbackFixture(t *testing.T) {
	folder := os.Getenv("GMSSH_CONTROLLER_FIXTURE")
	if folder == "" {
		t.Skip("opt-in cross-language fixture")
	}
	if !filepath.IsAbs(folder) {
		t.Fatal("absolute fixture directory required")
	}
	b, owner := brokerFixture(t)
	remote := filepath.Join(folder, "remote")
	if err := os.MkdirAll(remote, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(remote, "source.txt"), []byte("Synthetic gateway download 中文"), 0600); err != nil {
		t.Fatal(err)
	}
	b.filePath = func(value string) (string, error) {
		if !strings.HasPrefix(value, "C:/") || strings.Contains(value, "..") || strings.Contains(value, "\\") {
			return "", errDenied
		}
		return filepath.Join(remote, strings.TrimPrefix(value, "C:/")), nil
	}
	b.readInfo = func(_ context.Context, file, prefix string) ([]byte, error) {
		switch file {
		case "collector.ps1":
			if strings.Contains(prefix, "fast") {
				return []byte("__GMB_CPU_TOTAL__=10000000\n__GMB_CPU_IDLE__=8000000\n__GMB_CPU_USAGE__=20\n__GMB_MEM_TOTAL_BYTES__=17179869184\n__GMB_MEM_USED_BYTES__=4294967296\n"), nil
			}
			return []byte("__GMB_OS_KERNEL__=Windows (synthetic)\n__GMB_OS_NAME__=Synthetic Windows\n__GMB_CPU_CORES__=4\n__GMB_UPTIME_SECONDS__=60\n__GMB_PROCESS_COUNT__=3\n__GMB_ACTIVE_PROCESS_COUNT__=1\n__GMB_CID__=\n__GMB_DISKS_BEGIN__\n/dev/windows/C\tNTFS\t107374182400\t1\t53687091200\tC:\\\n__GMB_DISKS_END__\n__GMB_NETWORK_BEGIN__\n__GMB_NETWORK_END__\n"), nil
		case "login.ps1":
			return []byte("__GMB_LOGIN_PROFILE__=1\n__GMB_LOGIN_USER__=gmssh\n__GMB_LOGIN_SUDO__=0\n__GMB_LOGIN_OS__=Windows\n"), nil
		case "system-info.ps1":
			return []byte(`{"computer":"LAB-PC","os":"Synthetic Windows","version":"test","cpu":"Synthetic CPU","cores":4,"memory":17179869184,"uptime":60,"processes":3,"disks":[],"network":[]}`), nil
		case "":
			return []byte(`["C:"]`), nil
		}
		return nil, errDenied
	}
	b.openTerminal = func(_, _ string, w, h int) (pseudoTerminal, error) {
		p := &echoTerminal{data: make(chan []byte), done: make(chan struct{})}
		p.Resize(w, h)
		return p, nil
	}
	b.execute = func(_ context.Context, _, _, kind, command string) ([]byte, int, error) {
		if kind == "power" {
			return []byte("synthetic power accepted"), 0, nil
		}
		return []byte("synthetic command accepted"), 0, nil
	}
	b.openDesktop = func() (net.Conn, error) {
		client, engine := net.Pipe()
		go func() {
			defer engine.Close()
			if fixtureFrame(engine, bytesField(9, append(bytesField(1, []byte("synthetic-salt")), bytesField(2, []byte("synthetic-challenge"))...))) != nil {
				return
			}
			if _, err := fixtureReadFrame(engine); err != nil {
				return
			}
			display := append(uintField(3, 800), uintField(4, 600)...)
			display = append(display, bytesField(5, []byte("Synthetic display"))...)
			display = append(display, uintField(6, 1)...)
			peer := append(bytesField(1, []byte("gmssh")), bytesField(2, []byte("LAB-PC"))...)
			peer = append(peer, bytesField(3, []byte("Windows"))...)
			peer = append(peer, bytesField(4, display)...)
			peer = append(peer, bytesField(7, []byte("1.5.0"))...)
			if fixtureFrame(engine, bytesField(8, bytesField(2, peer))) != nil {
				return
			}
			for {
				if _, err := fixtureReadFrame(engine); err != nil {
					return
				}
			}
		}()
		return client, nil
	}
	b.mu.Lock()
	full, err := b.manage(controllerRequest{Action: "grant", Name: "Synthetic full controller", Policy: permissions{View: true, Input: true, Clipboard: true, Files: true, Terminal: true, Power: true}})
	if err != nil {
		t.Fatal(err)
	}
	view, err := b.manage(controllerRequest{Action: "grant", Name: "Synthetic view-only", Policy: permissions{View: true}})
	b.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	configuration, err := b.store.tlsConfig()
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(b.serve)}
	value := map[string]any{"port": listener.Addr().(*net.TCPAddr).Port, "owner": owner, "full": full, "view": view, "remote": remote, "pid": os.Getpid()}
	raw, _ := json.Marshal(value)
	if err = os.WriteFile(filepath.Join(folder, "gateway.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err = server.Serve(tls.NewListener(listener, configuration)); err != nil {
		t.Fatal(err)
	}
}
