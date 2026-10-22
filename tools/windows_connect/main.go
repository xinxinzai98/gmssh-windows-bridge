package main

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func run() error {
	if len(os.Args) < 2 {
		return errUnavailable
	}
	command := os.Args[1]
	flags := flag.NewFlagSet("gmssh-connect", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	root := flags.String("state", "", "")
	publicInput := flags.Bool("connection-stdin", false, "")
	if flags.Parse(os.Args[2:]) != nil || flags.NArg() != 0 || (*root == "" && command != "qr") {
		return errUnavailable
	}
	if command == "qr" {
		body, err := io.ReadAll(io.LimitReader(os.Stdin, 8193))
		if err != nil || len(body) > 8192 {
			return errUnavailable
		}
		defer clear(body)
		var request struct {
			Text string `json:"text"`
		}
		if decodeJSON(body, &request) != nil {
			return errUnavailable
		}
		image, err := connectionQR(request.Text)
		if err != nil {
			return err
		}
		fmt.Println(base64.StdEncoding.EncodeToString(image))
		return nil
	}
	absolute, err := filepath.Abs(*root)
	if err != nil {
		return errUnavailable
	}
	s := store{root: absolute, protect: protectLocal, unprotect: unprotectLocal, validatePassword: validateLocalPassword, validateDesktop: validateLocalDesktopPassword, validateBinding: validatePlatformBinding}
	b, _, err := s.managed()
	if err != nil {
		return errInstallBinding
	}
	host, err := os.Hostname()
	if err != nil || !strings.EqualFold(host, b.Computer) {
		return errMachineBinding
	}
	if err = validatePlatformBinding(b); err != nil {
		return err
	}
	switch command {
	case "diagnose":
		// Check public installation metadata and the live account binding only.
		// Do not read credentials, authenticate, create state or open a listener.
		fmt.Println("ready-for-credentials")
	case "logon-status":
		state, err := controllerLogonState()
		if err != nil {
			return err
		}
		body, _ := json.Marshal(map[string]any{"session": state.session, "locked": state.locked})
		fmt.Println(string(body))
	case "manage":
		body, err := io.ReadAll(io.LimitReader(os.Stdin, 16385))
		if err != nil || len(body) > 16384 {
			return errUnavailable
		}
		defer clear(body)
		result, err := s.manageControllers(body)
		if err != nil {
			return err
		}
		fmt.Println(string(result))
	case "status":
		if err = s.status(); err != nil {
			return err
		}
		fmt.Println("ready")
	case "init":
		body, err := io.ReadAll(io.LimitReader(os.Stdin, 8193))
		if err != nil || len(body) > 8192 {
			return errUnavailable
		}
		defer clear(body)
		var request struct {
			Password        string `json:"password"`
			DesktopPassword string `json:"desktopPassword"`
		}
		if decodeJSON(body, &request) != nil {
			return errUnavailable
		}
		if err = s.initializeCredentials(request.Password, request.DesktopPassword); err != nil {
			return err
		}
		fmt.Println("ok")
	case "reset", "revoke":
		if err = s.rotate(command == "revoke"); err != nil {
			return err
		}
		fmt.Println("ok")
	case "code":
		var public map[string]any
		if *publicInput {
			body, err := io.ReadAll(io.LimitReader(os.Stdin, 65537))
			if err != nil || len(body) > 65536 || json.Unmarshal(body, &public) != nil {
				return errUnavailable
			}
		}
		code, err := s.code(public)
		if err != nil {
			return err
		}
		fmt.Println(code)
	case "serve":
		// An upgraded installation may still need the owner's existing password.
		// Wait without opening a port until its encrypted state has been enabled.
		var configuration *tls.Config
		for {
			configuration, err = s.tlsConfig()
			if err == nil {
				break
			}
			time.Sleep(2 * time.Second)
		}
		listener, err := net.Listen("tcp", fmt.Sprintf(":%d", connectPort))
		if err != nil {
			return errUnavailable
		}
		defer listener.Close()
		return serveConnections(listener, s.handler(), configuration)
	default:
		return errUnavailable
	}
	return nil
}

func serveConnections(listener net.Listener, handler http.Handler, configuration *tls.Config) error {
	// net/http also uses the smallest header/read/write budget for TLS handshakes.
	// Five seconds cut off real LAN handshakes and requests during short stalls.
	server := &http.Server{Handler: handler, TLSConfig: configuration, ReadHeaderTimeout: 15 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
	return server.Serve(tls.NewListener(listener, configuration))
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, helperErrorCode(err))
		os.Exit(1)
	}
}
