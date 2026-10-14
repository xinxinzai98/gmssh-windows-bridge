package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func sampleArchive(names ...string) []byte {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, name := range names {
		file, _ := writer.Create(name)
		file.Write([]byte("synthetic installer content"))
	}
	writer.Close()
	return buffer.Bytes()
}

func TestSetupExtraction(t *testing.T) {
	root := t.TempDir()
	if err := extractSetup(sampleArchive("setup-windows.ps1", "installers/ssh.msi"), root); err != nil {
		t.Fatal(err)
	}
	if body, err := os.ReadFile(filepath.Join(root, "installers", "ssh.msi")); err != nil || string(body) != "synthetic installer content" {
		t.Fatal("content missing")
	}
	if err := extractSetup(sampleArchive("setup-windows.ps1"), root); err == nil {
		t.Fatal("existing file overwritten")
	}
	for _, name := range []string{"../escape", "/absolute", "C:/system", "..\\escape", "folder/file:stream"} {
		if err := extractSetup(sampleArchive(name), t.TempDir()); err == nil {
			t.Fatalf("accepted unsafe path %q", name)
		}
	}
	if err := extractSetup(sampleArchive("setup.ps1", "SETUP.PS1"), t.TempDir()); err == nil {
		t.Fatal("duplicate Windows path accepted")
	}
}
