package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServerReadOnlyFilesRejectRawMutationRequests(t *testing.T) {
	b, owner := brokerFixture(t)
	root := t.TempDir()
	original := []byte("name=original\r\n")
	if err := os.WriteFile(filepath.Join(root, "source.txt"), original, 0600); err != nil {
		t.Fatal(err)
	}
	b.filePath = func(value string) (string, error) {
		if !strings.HasPrefix(value, "C:/") || strings.Contains(value, "..") {
			return "", errDenied
		}
		return filepath.Join(root, strings.TrimPrefix(value, "C:/")), nil
	}
	id, token := grantFixture(t, b, owner, "Read only", permissions{FilesRead: true})
	session := openFixture(t, b, id, token, "files")
	call := func(action string, args any) (int, map[string]any) {
		raw, _ := json.Marshal(args)
		return controllerCall(t, b, "/v2/controller", controllerRequest{Action: action, Session: session, Args: raw}, id, token)
	}
	for _, action := range []string{"fs-stat", "fs-list"} {
		path := "C:/source.txt"
		if action == "fs-list" {
			path = "C:/"
		}
		if status, body := call(action, map[string]any{"path": path}); status != 200 {
			t.Fatal(action, body)
		}
	}
	status, body := call("fs-open", map[string]any{"path": "C:/source.txt", "mode": "rb"})
	if status != 200 {
		t.Fatal(body)
	}
	handle := body["result"].(map[string]any)["handle"].(string)
	if status, body = call("file-read", map[string]any{"handle": handle, "length": 128}); status != 200 {
		t.Fatal(body)
	}
	for _, mode := range []string{"wx", "wb", "r+b", "a", "rb+"} {
		if status, _ := call("fs-open", map[string]any{"path": "C:/source.txt", "mode": mode}); status != 403 {
			t.Fatal("write mode accepted", mode, status)
		}
	}
	mutations := map[string]any{
		"file-write": map[string]any{"handle": handle, "data": []byte("must not write")},
		"fs-remove":  map[string]any{"path": "C:/source.txt"},
		"fs-mkdir":   map[string]any{"path": "C:/new-folder"},
		"fs-rename":  map[string]any{"path": "C:/source.txt", "target": "C:/moved.txt"},
		"execute":    map[string]any{"command": "must not execute", "timeout": 1},
	}
	for action, args := range mutations {
		if status, _ := call(action, args); status != 403 {
			t.Fatal("mutation accepted", action, status)
		}
	}
	if status, _ := call("file-close", map[string]any{"handle": handle}); status != 200 {
		t.Fatal("read handle could not close")
	}
	actual, _ := os.ReadFile(filepath.Join(root, "source.txt"))
	if string(actual) != string(original) {
		t.Fatal("read-only requests changed source")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatal("read-only request created content")
	}
	full, fullToken := grantFixture(t, b, owner, "Legacy full", permissions{Files: true, FilesRead: true})
	_, capabilities := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, full, fullToken)
	result := capabilities["result"].(map[string]any)
	if result["fileReadOnly"] != float64(1) {
		t.Fatal("missing file capability")
	}
	p := result["permissions"].(map[string]any)
	if p["files"] != true || len(p) != 6 {
		t.Fatal("legacy full policy changed shape", p)
	}
}

func TestPolicyDowngradeDoesNotWaitForBlockedFileIO(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Blocked file", permissions{Files: true})
	other, otherToken := grantFixture(t, b, owner, "Other", permissions{FilesRead: true})
	session := openFixture(t, b, id, token, "files")
	entered, release := make(chan struct{}), make(chan struct{})
	b.filePath = func(string) (string, error) { close(entered); <-release; return "", errDenied }
	requestDone := make(chan int, 1)
	go func() {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "fs-stat", Session: session, Args: json.RawMessage(`{"path":"C:/blocked"}`)}, id, token)
		requestDone <- status
	}()
	<-entered
	defer func() {
		close(release)
		select {
		case status := <-requestDone:
			if status == 200 {
				t.Error("closed in-flight session reported success")
			}
		case <-time.After(time.Second):
			t.Error("file request did not finish")
		}
	}()
	sessionObject := b.sessions[session]
	changed := make(chan int, 1)
	go func() {
		status, _ := controllerCall(t, b, "/v2/manage", controllerRequest{Action: "permissions", ID: id, Policy: permissions{FilesRead: true}}, "", owner)
		changed <- status
	}()
	select {
	case status := <-changed:
		if status != 200 {
			t.Fatal("downgrade failed", status)
		}
	case <-time.After(time.Second):
		t.Fatal("downgrade waited for file I/O")
	}
	if !sessionObject.closed.Load() {
		t.Fatal("old session not immediately blocked")
	}
	checked := make(chan int, 1)
	go func() {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, other, otherToken)
		checked <- status
	}()
	select {
	case status := <-checked:
		if status != 200 {
			t.Fatal("unrelated controller failed")
		}
	case <-time.After(time.Second):
		t.Fatal("registry lock held by closed file I/O")
	}
	if status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "file-write", Session: session, Args: json.RawMessage(`{"handle":"old","data":"eA=="}`)}, id, token); status == 200 {
		t.Fatal("old session reused after downgrade")
	}
}

func TestRevocationInterruptsOneShotWithoutReportingSuccess(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Command", permissions{Terminal: true})
	session := openFixture(t, b, id, token, "terminal")
	started := make(chan struct{})
	b.execute = func(ctx context.Context, _, _, _, _ string) ([]byte, int, error) {
		close(started)
		<-ctx.Done()
		return nil, 0, ctx.Err()
	}
	done := make(chan map[string]any, 1)
	go func() {
		_, reply := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "execute", Session: session, Args: json.RawMessage(`{"command":"synthetic","timeout":60}`)}, id, token)
		done <- reply
	}()
	<-started
	if status, _ := controllerCall(t, b, "/v2/manage", controllerRequest{Action: "revoke", ID: id}, "", owner); status != 200 {
		t.Fatal("revocation failed")
	}
	select {
	case reply := <-done:
		if reply["ok"] != false || reply["code"] != "OPERATION_INTERRUPTED" {
			t.Fatal("interrupted command claimed success", reply)
		}
	case <-time.After(time.Second):
		t.Fatal("command did not receive cancellation")
	}
}
