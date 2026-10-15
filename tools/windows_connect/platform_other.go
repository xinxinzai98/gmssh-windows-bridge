//go:build !windows

package main

func protectLocal([]byte) ([]byte, error)        { return nil, errUnavailable }
func unprotectLocal([]byte) ([]byte, error)      { return nil, errUnavailable }
func validateLocalPassword(string, string) error { return errUnavailable }
func validatePlatformBinding(binding) error      { return errUnavailable }
