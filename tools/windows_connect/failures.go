package main

import "errors"

var (
	errInstallBinding     = errors.New("installation binding is unavailable")
	errMachineBinding     = errors.New("machine binding does not match")
	errAccountBinding     = errors.New("account SID does not match")
	errAdminBinding       = errors.New("administrator membership could not be confirmed")
	errCredential         = errors.New("existing connection password was rejected")
	errDesktopCredential  = errors.New("existing desktop password was rejected")
	errDesktopUnavailable = errors.New("existing desktop authentication could not be confirmed")
)

// Only fixed codes cross stderr. Native errors, paths and input never do.
func helperErrorCode(err error) string {
	for _, item := range []struct {
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
		if errors.Is(err, item.err) {
			return item.code
		}
	}
	return "GMSSH_ERR_UNAVAILABLE"
}
