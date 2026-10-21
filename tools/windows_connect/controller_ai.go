package main

// AI uses the existing pinned controller endpoint and its current permissions.
// Jobs outlive a CLI/MCP process; an interrupted service never replays a command.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const aiOutputLimit = 256 * 1024

type aiJob struct {
	ID         string `json:"id"`
	Controller string `json:"controller"`
	Digest     string `json:"digest"`
	State      string `json:"state"`
	Code       string `json:"code"`
	Output     string `json:"output"`
	Exit       *int   `json:"exit"`
	Truncated  bool   `json:"truncated"`
	Started    int64  `json:"started"`
	Updated    int64  `json:"updated"`
	cancel     context.CancelFunc
}

type aiFailure string

func (e aiFailure) Error() string { return string(e) }

func (b *controllerBroker) saveAIJob(j *aiJob) error {
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	defer clear(raw)
	_, err = b.store.write("ai-job-"+j.ID+".dat", raw)
	return err
}

func (b *controllerBroker) loadAIJob(id string) (*aiJob, error) {
	if !validControllerID(id) {
		return nil, errDenied
	}
	if b.aiJobs == nil {
		b.aiJobs = map[string]*aiJob{}
	}
	if j := b.aiJobs[id]; j != nil {
		return j, nil
	}
	name, err := b.store.privatePath("ai-job-" + id + ".dat")
	if err != nil {
		return nil, err
	}
	if _, err = os.Lstat(name); err != nil {
		return nil, err
	}
	raw, err := readBounded(name, 2*1024*1024)
	if err != nil {
		return nil, err
	}
	defer clear(raw)
	plain, err := b.store.unprotect(raw)
	if err != nil {
		return nil, errUnavailable
	}
	defer clear(plain)
	var j aiJob
	if decodeJSON(plain, &j) != nil || j.ID != id || !validControllerID(j.Controller) || len(j.Output) > aiOutputLimit || len(j.Digest) != 64 {
		return nil, errUnavailable
	}
	if j.State == "running" || j.State == "cancelling" {
		j.State, j.Code, j.Updated = "interrupted", "OUTCOME_UNKNOWN", time.Now().UnixMilli()
		if err = b.saveAIJob(&j); err != nil {
			return nil, err
		}
	}
	b.aiJobs[id] = &j
	return &j, nil
}

func aiJobResult(j *aiJob, offset int) (any, error) {
	if offset < 0 || offset > len(j.Output) || offset < len(j.Output) && !utf8.RuneStart(j.Output[offset]) {
		return nil, errDenied
	}
	end := offset + 16384
	if end > len(j.Output) {
		end = len(j.Output)
	}
	for end < len(j.Output) && !utf8.RuneStart(j.Output[end]) {
		end--
	}
	return map[string]any{"taskId": j.ID, "state": j.State, "code": j.Code, "output": j.Output[offset:end], "exitCode": j.Exit,
		"offset": offset, "nextOffset": end, "more": end < len(j.Output), "truncated": j.Truncated, "combinedOutput": true,
		"startedAt": j.Started, "updatedAt": j.Updated}, nil
}

func (b *controllerBroker) cancelAIJobs(controllerID string) {
	for _, j := range b.aiJobs {
		if j.Controller == controllerID && j.cancel != nil {
			j.State = "cancelling"
			j.cancel()
		}
	}
}

func (b *controllerBroker) aiRequest(c controller, r controllerRequest) (any, error) {
	if r.Action == "ai-desktop" {
		if !c.Policy.View {
			return nil, errDenied
		}
		var v struct {
			Operation    string `json:"operation"`
			Window       string `json:"window,omitempty"`
			Name         string `json:"name,omitempty"`
			ControlType  string `json:"controlType,omitempty"`
			AutomationID string `json:"automationId,omitempty"`
			Snapshot     string `json:"snapshot,omitempty"`
			Target       string `json:"target,omitempty"`
			Text         string `json:"text,omitempty"`
			Key          string `json:"key,omitempty"`
		}
		if decodeJSON(r.Args, &v) != nil || len(r.Args) > 32768 {
			return nil, errDenied
		}
		switch v.Operation {
		case "context", "observe", "find", "screenshot":
		case "focus", "invoke", "set-value", "click", "type-text", "key":
			if !c.Policy.Input {
				return nil, errDenied
			}
		default:
			return nil, errDenied
		}
		b.mu.Unlock()
		defer b.mu.Lock()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		// Each request carries the authenticated owner, never an arbitrary caller name.
		// Canonicalize after validation so Go and PowerShell never interpret two
		// spellings/duplicate keys differently at the permission boundary.
		canonical, err := json.Marshal(v)
		if err != nil {
			return nil, errDenied
		}
		return b.aiDesktop(ctx, c.ID, canonical)
	}
	if !c.Policy.Terminal {
		return nil, errDenied
	}
	switch r.Action {
	case "ai-task-start":
		var v struct {
			Command string `json:"command"`
			Timeout int    `json:"timeout"`
			Key     string `json:"key"`
		}
		if decodeJSON(r.Args, &v) != nil || v.Command == "" || len(v.Command) > 32768 || !utf8.ValidString(v.Command) || v.Timeout < 1 || v.Timeout > 3600 || !validControllerID(v.Key) {
			return nil, errDenied
		}
		identity := sha256.Sum256([]byte(c.ID + ":" + v.Key))
		id := hex.EncodeToString(identity[:16])
		digest := sha256.Sum256([]byte(v.Command + "\x00" + strconv.Itoa(v.Timeout)))
		hash := hex.EncodeToString(digest[:])
		if existing, err := b.loadAIJob(id); err == nil {
			if existing.Digest != hash {
				return nil, aiFailure("IDEMPOTENCY_CONFLICT")
			}
			return aiJobResult(existing, 0)
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		folder, err := b.store.privatePath(".")
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		count, running := 0, 0
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "ai-job-") && strings.HasSuffix(entry.Name(), ".dat") {
				count++
			}
		}
		for _, j := range b.aiJobs {
			if j.cancel != nil {
				running++
			}
		}
		if count >= 128 || running >= 4 {
			return nil, aiFailure("TASK_LIMIT")
		}
		m, err := b.store.meta()
		if err != nil {
			return nil, err
		}
		secret, err := b.store.storedCredential(m)
		if err != nil {
			return nil, err
		}
		if err = b.verifyAccount(m, secret); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(v.Timeout)*time.Second)
		j := &aiJob{ID: id, Controller: c.ID, Digest: hash, State: "running", Code: "RUNNING", Started: time.Now().UnixMilli(), Updated: time.Now().UnixMilli(), cancel: cancel}
		if err = b.saveAIJob(j); err != nil {
			cancel()
			return nil, err
		}
		b.aiJobs[id] = j
		go func() {
			defer cancel()
			output, exit, runErr := b.execute(ctx, secret.Username, secret.Password, "terminal", v.Command)
			secret.Password = ""
			b.accountFailure(m, runErr)
			b.mu.Lock()
			defer b.mu.Unlock()
			j.cancel = nil
			j.Exit = &exit
			if runErr != nil && exit == 0 {
				j.Exit = nil
			}
			j.Updated = time.Now().UnixMilli()
			j.State, j.Code = "completed", "OK"
			if runErr != nil {
				j.State, j.Code = "failed", "EXECUTION_FAILED"
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					j.Code = "TIMEOUT"
				}
				if errors.Is(ctx.Err(), context.Canceled) {
					j.State, j.Code = "cancelled", "CANCELLED"
				}
				if runErr.Error() == "OUTPUT_LIMIT" {
					j.Code = "OUTPUT_LIMIT"
					j.Truncated = true
				}
			} else if exit != 0 {
				j.State, j.Code = "failed", "EXIT_NONZERO"
			}
			if len(output) > aiOutputLimit {
				output = output[:aiOutputLimit]
				j.Truncated = true
			}
			j.Output = strings.ToValidUTF8(string(output), "\ufffd")
			for len(j.Output) > aiOutputLimit {
				j.Output = j.Output[:len(j.Output)-1]
				j.Output = strings.TrimRightFunc(j.Output, func(r rune) bool { return r == '\ufffd' })
			}
			if err := b.saveAIJob(j); err != nil {
				j.State, j.Code = "failed", "JOURNAL_WRITE_FAILED"
			}
		}()
		return aiJobResult(j, 0)
	case "ai-task-get", "ai-task-cancel", "ai-task-forget":
		var v struct {
			ID     string `json:"taskId"`
			Offset int    `json:"offset"`
		}
		if decodeJSON(r.Args, &v) != nil || !validControllerID(v.ID) {
			return nil, errDenied
		}
		j, err := b.loadAIJob(v.ID)
		if err != nil {
			return nil, err
		}
		if j.Controller != c.ID {
			return nil, errDenied
		}
		if r.Action == "ai-task-cancel" && j.cancel != nil {
			j.State = "cancelling"
			j.cancel()
		}
		if r.Action == "ai-task-forget" {
			if j.cancel != nil {
				return nil, aiFailure("TASK_RUNNING")
			}
			name, err := b.store.privatePath("ai-job-" + j.ID + ".dat")
			if err != nil {
				return nil, err
			}
			if err = os.Remove(filepath.Clean(name)); err != nil {
				return nil, err
			}
			delete(b.aiJobs, j.ID)
			return map[string]bool{"forgotten": true}, nil
		}
		return aiJobResult(j, v.Offset)
	}
	return nil, errDenied
}
