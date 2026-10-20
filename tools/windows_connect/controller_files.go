package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func controllerFilePath(value string) (string, error) {
	if len(value) < 3 || len(value) > 1024 || !(value[0] >= 'A' && value[0] <= 'Z' || value[0] >= 'a' && value[0] <= 'z') || value[1:3] != ":/" || strings.ContainsAny(value, "\\\x00\r\n") {
		return "", errDenied
	}
	for _, part := range strings.Split(value[3:], "/") {
		if part == "." || part == ".." || strings.ContainsAny(part, "<>:\"|?*") {
			return "", errDenied
		}
	}
	name := filepath.FromSlash(value)
	current := filepath.VolumeName(name) + string(filepath.Separator)
	parts := strings.Split(value[3:], "/")
	for index, part := range parts {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) && index == len(parts)-1 {
			break
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(current) {
			return "", errDenied
		}
	}
	return name, nil
}

func fileMetadata(info os.FileInfo) (map[string]any, error) {
	mode := uint32(0100000)
	if info.IsDir() {
		mode = 0040000
	} else if !info.Mode().IsRegular() {
		return nil, errDenied
	}
	modified := info.ModTime().Unix()
	if modified < 0 {
		modified = 0
	}
	return map[string]any{"size": info.Size(), "modified": modified, "mode": mode}, nil
}

func (b *controllerBroker) fileRequest(s *controllerSession, r controllerRequest, policy permissions) (any, error) {
	var value struct {
		Path   string `json:"path,omitempty"`
		Target string `json:"target,omitempty"`
		Handle string `json:"handle,omitempty"`
		Mode   string `json:"mode,omitempty"`
		Offset int64  `json:"offset,omitempty"`
		Length int    `json:"length,omitempty"`
		Data   []byte `json:"data,omitempty"`
	}
	if decodeJSON(r.Args, &value) != nil || value.Offset < 0 || value.Offset > 1024*1024*1024*1024 || value.Length < 0 || value.Length > 65536 || len(value.Data) > 65536 {
		return nil, errDenied
	}
	if !policy.Files {
		if !policy.FilesRead {
			return nil, errDenied
		}
		switch r.Action {
		case "fs-stat", "fs-list", "file-read", "file-close":
		case "fs-open":
			if value.Mode != "rb" {
				return nil, errDenied
			}
		default:
			return nil, errDenied
		}
	}
	if strings.HasPrefix(r.Action, "file-") {
		file := s.files[value.Handle]
		if file == nil {
			return nil, errDenied
		}
		switch r.Action {
		case "file-close":
			file.Close()
			delete(s.files, value.Handle)
			return map[string]bool{"closed": true}, nil
		case "file-read":
			raw := make([]byte, value.Length)
			n, err := file.ReadAt(raw, value.Offset)
			if err != nil && !errors.Is(err, io.EOF) {
				return nil, err
			}
			return map[string]any{"data": raw[:n]}, nil
		case "file-write":
			if value.Offset+int64(len(value.Data)) > 1024*1024*1024*1024 {
				return nil, errDenied
			}
			n, err := file.WriteAt(value.Data, value.Offset)
			if err != nil {
				return nil, err
			}
			if err = file.Sync(); err != nil {
				return nil, err
			}
			return map[string]int{"written": n}, nil
		}
		return nil, errDenied
	}
	if r.Action == "fs-list" && value.Path == "/" {
		return map[string]any{"drives": controllerDrives()}, nil
	}
	name, err := b.filePath(value.Path)
	if err != nil {
		return nil, err
	}
	switch r.Action {
	case "fs-stat":
		info, err := os.Lstat(name)
		if os.IsNotExist(err) {
			return map[string]bool{"missing": true}, nil
		}
		if err != nil {
			return nil, err
		}
		return fileMetadata(info)
	case "fs-list":
		folder, err := os.Open(name)
		if err != nil {
			return nil, err
		}
		defer folder.Close()
		rows, err := folder.ReadDir(2001)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		result := []map[string]any{}
		truncated := len(rows) > 2000
		if truncated {
			rows = rows[:2000]
		}
		for _, row := range rows {
			info, err := row.Info()
			if err != nil {
				return nil, err
			}
			if info.Mode()&os.ModeSymlink != 0 || isReparsePoint(filepath.Join(name, row.Name())) {
				continue
			}
			meta, err := fileMetadata(info)
			if err != nil {
				continue
			}
			meta["name"] = row.Name()
			result = append(result, meta)
		}
		return map[string]any{"entries": result, "truncated": truncated}, nil
	case "fs-open":
		if len(s.files) >= 32 {
			return nil, errors.New("HANDLE_LIMIT")
		}
		flags := 0
		switch value.Mode {
		case "rb":
			flags = os.O_RDONLY
		case "wx":
			flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
		case "wb":
			flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
		case "r+b":
			flags = os.O_RDWR
		default:
			return nil, errDenied
		}
		file, err := os.OpenFile(name, flags, 0600)
		if err != nil {
			return nil, err
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			return nil, errDenied
		}
		id := randomID()
		s.files[id] = file
		return map[string]string{"handle": id}, nil
	case "fs-mkdir":
		if err = os.Mkdir(name, 0700); err != nil {
			return nil, err
		}
		return map[string]bool{"created": true}, nil
	case "fs-remove":
		info, err := os.Lstat(name)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errDenied
		}
		if err = os.Remove(name); err != nil {
			return nil, err
		}
		return map[string]bool{"removed": true}, nil
	case "fs-rename":
		target, err := b.filePath(value.Target)
		if err != nil {
			return nil, err
		}
		if err = renameControllerFile(name, target); err != nil {
			return nil, err
		}
		return map[string]bool{"renamed": true}, nil
	}
	return nil, errDenied
}
