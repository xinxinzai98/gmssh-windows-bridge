package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	qrcode "./qr"
)

func TestConnectionQRUsesLocalPNGAndRejectsUnrelatedOrOversizeText(t *testing.T) {
	s, password := fixture(t)
	if err := s.initialize(*password); err != nil {
		t.Fatal(err)
	}
	code, err := s.code(nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := connectionQR(code)
	if err != nil {
		t.Fatal(err)
	}
	image, err := png.Decode(bytes.NewReader(body))
	if err != nil || image.Bounds().Dx() > 1000 || image.Bounds().Dx() != image.Bounds().Dy() {
		t.Fatal("invalid local PNG", err)
	}
	for _, text := range []string{"", "https://example.invalid", strings.Repeat("x", 2954), `{"schema":1,"password":"must-not-share"}`} {
		if _, err := connectionQR(text); err == nil {
			t.Fatal("unexpected QR content accepted")
		}
	}
}

func TestPublicQRFixtureContainsOnlySyntheticPublicConnectionFields(t *testing.T) {
	blob := binary.BigEndian.AppendUint32(nil, 11)
	blob = append(blob, []byte("ssh-ed25519")...)
	blob = binary.BigEndian.AppendUint32(blob, 32)
	blob = append(blob, bytes.Repeat([]byte{7}, 32)...)
	digest := sha256.Sum256(blob)
	public := map[string]any{"schema": 1, "computer": "DEMO-PC", "username": "gmssh", "sshPort": 22, "addresses": []string{"192.0.2.42"}, "sshHostPublicKey": "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob), "sshHostFingerprint": "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])}
	text, _ := json.Marshal(public)
	body, err := connectionQR(string(text))
	if err != nil {
		t.Fatal(err)
	}
	if folder := os.Getenv("GMSSH_QR_FIXTURE_DIR"); folder != "" {
		if err = os.MkdirAll(folder, 0700); err != nil {
			t.Fatal(err)
		}
		code, err := qrcode.New(string(text), qrcode.Low)
		if err != nil {
			t.Fatal(err)
		}
		rows := []string{}
		for _, row := range code.Bitmap() {
			var line strings.Builder
			for _, black := range row {
				if black {
					line.WriteByte('1')
				} else {
					line.WriteByte('0')
				}
			}
			rows = append(rows, line.String())
		}
		fixture, _ := json.MarshalIndent(map[string]any{"synthetic": true, "text": string(text), "rows": rows}, "", "  ")
		if err = os.WriteFile(filepath.Join(folder, "synthetic-connection-qr.png"), body, 0600); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(folder, "synthetic-connection-qr.json"), fixture, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
