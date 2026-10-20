//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"os"
)

func controllerLogonState() (windowsLogonState, error) {
	return windowsLogonState{}, errDesktopUnavailable
}

func runAIDesktop(context.Context, string, json.RawMessage) (any, error) {
	return nil, aiFailure("DESKTOP_WORKER_UNAVAILABLE")
}

func runControllerCommand(context.Context, string, string, string, string) ([]byte, int, error) {
	return nil, 0, errUnavailable
}
func runControllerInfo(context.Context, string, string) ([]byte, error) { return nil, errUnavailable }
func openControllerTerminal(string, string, int, int) (pseudoTerminal, error) {
	return nil, errUnavailable
}
func controllerDrives() []string { return []string{} }
func isReparsePoint(name string) bool {
	info, err := os.Lstat(name)
	return err != nil || info.Mode()&os.ModeSymlink != 0
}
func renameControllerFile(old, new string) error {
	if err := os.Link(old, new); err != nil {
		return err
	}
	return os.Remove(old)
}
