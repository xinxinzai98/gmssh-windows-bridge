package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// A view-only controller can read bounded system metadata, never submit a script.
func infoScript(tool string, options map[string]json.RawMessage) (string, string, error) {
	fixed := map[string]string{"metrics-fast": "collector.ps1", "metrics-slow": "collector.ps1", "login": "login.ps1", "system": "system-info.ps1", "drives": ""}
	if file, ok := fixed[tool]; ok {
		if len(options) != 0 {
			return "", "", errDenied
		}
		prefix := ""
		if strings.HasPrefix(tool, "metrics-") {
			prefix = "$MetricMode='" + strings.TrimPrefix(tool, "metrics-") + "'\n"
		}
		if tool == "drives" {
			prefix = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);ConvertTo-Json -InputObject @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Select-Object -ExpandProperty DeviceID) -Compress"
		}
		return file, prefix, nil
	}
	expected := map[string][]string{"capabilities": {}, "processes": {"limit", "search", "sort"}, "services": {"limit", "search", "sort"}, "logs": {"source", "limit", "hours"}, "log-detail": {"source", "recordId"}}[tool]
	if expected == nil || len(options) != len(expected) {
		return "", "", errDenied
	}
	for _, key := range expected {
		raw, ok := options[key]
		if !ok {
			return "", "", errDenied
		}
		switch key {
		case "limit", "hours", "recordId":
			var n int64
			if json.Unmarshal(raw, &n) != nil {
				return "", "", errDenied
			}
			if key == "limit" && n != 50 && n != 100 && n != 200 || key == "hours" && n != 1 && n != 6 && n != 24 || key == "recordId" && (n < 1 || n > 1<<53-1) {
				return "", "", errDenied
			}
		case "search", "sort", "source":
			var value string
			if json.Unmarshal(raw, &value) != nil || !utf8.ValidString(value) {
				return "", "", errDenied
			}
			if key == "search" {
				if utf8.RuneCountInString(value) > 64 || strings.IndexFunc(value, unicode.IsControl) >= 0 {
					return "", "", errDenied
				}
			} else if key == "source" {
				if value != "system" && value != "application" {
					return "", "", errDenied
				}
			} else if tool == "processes" {
				if value != "name" && value != "cpu" && value != "memory" && value != "pid" {
					return "", "", errDenied
				}
			} else if value != "name" && value != "state" {
				return "", "", errDenied
			}
		default:
			return "", "", errDenied
		}
	}
	request := map[string]any{"tool": tool}
	for key, value := range options {
		request[key] = value
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return "", "", err
	}
	prefix := "$options=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + base64.StdEncoding.EncodeToString(raw) + "')) | ConvertFrom-Json\n"
	return "readonly-tools.ps1", prefix, nil
}
