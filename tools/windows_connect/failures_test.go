package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestHelperFailuresExposeOnlyFixedCodes(t *testing.T) {
	secret := "synthetic-password-and-private-path"
	for _, test := range []struct {
		err  error
		code string
	}{
		{errInstallBinding, "GMSSH_ERR_INSTALL_BINDING"},
		{errMachineBinding, "GMSSH_ERR_MACHINE_BINDING"},
		{errAccountBinding, "GMSSH_ERR_ACCOUNT_BINDING"},
		{errAdminBinding, "GMSSH_ERR_ADMIN_BINDING"},
		{errCredential, "GMSSH_ERR_CREDENTIAL"},
		{errDesktopCredential, "GMSSH_ERR_DESKTOP_CREDENTIAL"},
		{errDesktopUnavailable, "GMSSH_ERR_DESKTOP_UNAVAILABLE"},
	} {
		got := helperErrorCode(fmt.Errorf("%s: %w", secret, test.err))
		if got != test.code || strings.Contains(got, secret) {
			t.Fatalf("unsafe or incorrect failure code: %q", got)
		}
	}
	if got := helperErrorCode(errors.New(secret)); got != "GMSSH_ERR_UNAVAILABLE" {
		t.Fatalf("unknown native error was exposed: %q", got)
	}
}
