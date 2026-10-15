//go:build windows

package main

import (
	"bytes"
	"os"
	"syscall"
	"testing"
)

func TestWindowsAccountBinding(t *testing.T) {
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	user := os.Getenv("USERNAME")
	sid, _, _, err := syscall.LookupSID("", host+"\\"+user)
	if err != nil {
		t.Fatal(err)
	}
	text, err := sid.String()
	if err != nil {
		t.Fatal(err)
	}
	if validatePlatformBinding(binding{Username: user, ManagedSID: text}) != nil {
		t.Fatal("current account SID did not match")
	}
	if validatePlatformBinding(binding{Username: user, ManagedSID: "S-1-5-21-0-0-0-9999"}) == nil {
		t.Fatal("changed account SID accepted")
	}
}

func TestWindowsDPAPIRoundtrip(t *testing.T) {
	plain := []byte("synthetic-dpapi-fixture")
	sealed, err := protectLocal(plain)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(sealed)
	if bytes.Contains(sealed, plain) {
		t.Fatal("plaintext persisted")
	}
	restored, err := unprotectLocal(sealed)
	if err != nil || !bytes.Equal(restored, plain) {
		t.Fatal("DPAPI roundtrip failed")
	}
	clear(restored)
	sealed[len(sealed)-1] ^= 1
	if _, err = unprotectLocal(sealed); err == nil {
		t.Fatal("damaged DPAPI blob accepted")
	}
}
