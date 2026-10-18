package main

import (
	"encoding/json"
	"strings"

	qrcode "./qr"
)

// Connection text is encoded locally; no QR generation service receives it.
func connectionQR(text string) ([]byte, error) {
	if len(text) == 0 || len(text) > 2953 {
		return nil, errUnavailable
	}
	if !strings.HasPrefix(text, "GMSSH-CONNECT1.") && !strings.HasPrefix(text, "GMSSH-AUTH2.") {
		var public map[string]any
		if json.Unmarshal([]byte(text), &public) != nil || public["schema"] != float64(1) {
			return nil, errUnavailable
		}
		for _, name := range []string{"password", "authValue", "keyPass", "token", "accessToken"} {
			if _, exists := public[name]; exists {
				return nil, errUnavailable
			}
		}
		if _, err := publicBinding(public); err != nil {
			return nil, errUnavailable
		}
	}
	return qrcode.Encode(text, qrcode.Low, -5)
}
