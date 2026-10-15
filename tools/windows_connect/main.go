package main

import (
	"crypto/tls"
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
	if flags.Parse(os.Args[2:]) != nil || flags.NArg() != 0 || *root == "" {
		return errUnavailable
	}
	absolute, err := filepath.Abs(*root)
	if err != nil {
		return errUnavailable
	}
	s := store{root: absolute, protect: protectLocal, unprotect: unprotectLocal, validatePassword: validateLocalPassword, validateBinding: validatePlatformBinding}
	b, _, err := s.managed()
	if err != nil {
		return err
	}
	host, err := os.Hostname()
	if err != nil || !strings.EqualFold(host, b.Computer) {
		return errUnavailable
	}
	if err = validatePlatformBinding(b); err != nil {
		return errUnavailable
	}
	switch command {
	case "init":
		body, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
		if err != nil || len(body) > 4096 {
			return errUnavailable
		}
		defer clear(body)
		var request struct {
			Password string `json:"password"`
		}
		if decodeJSON(body, &request) != nil {
			return errUnavailable
		}
		if err = s.initialize(request.Password); err != nil {
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
		server := &http.Server{Handler: s.handler(), TLSConfig: configuration, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 8 * time.Second, WriteTimeout: 8 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
		return server.Serve(tls.NewListener(listener, configuration))
	default:
		return errUnavailable
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "GMSSH 一键接入操作未完成，请检查受管理安装、连接密码或本机授权。")
		os.Exit(1)
	}
}
