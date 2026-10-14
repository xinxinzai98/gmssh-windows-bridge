package main

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func extractSetup(payload []byte, root string) error {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	if len(archive.File) > 10000 {
		return fmt.Errorf("too many installer files")
	}
	var total uint64
	seen := make(map[string]bool)
	for _, item := range archive.File {
		name := strings.ReplaceAll(item.Name, "\\", "/")
		if !filepath.IsLocal(name) || strings.Contains(name, ":") || item.Mode()&os.ModeSymlink != 0 || seen[strings.ToLower(name)] {
			return fmt.Errorf("unsafe installer file path")
		}
		seen[strings.ToLower(name)] = true
		if item.UncompressedSize64 > 512*1024*1024-total {
			return fmt.Errorf("installer size limit exceeded")
		}
		total += item.UncompressedSize64
		target := filepath.Join(root, filepath.FromSlash(name))
		if item.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		input, err := item.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			input.Close()
			return err
		}
		_, copyErr := io.Copy(output, input)
		input.Close()
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
