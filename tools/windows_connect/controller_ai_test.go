package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func aiFixtureCall(t *testing.T, b *controllerBroker, id, token, action string, args any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(args)
	return controllerCall(t, b, "/v2/controller", controllerRequest{Action: action, Args: raw}, id, token)
}
func awaitAI(t *testing.T, b *controllerBroker, id, token, task string) map[string]any {
	t.Helper()
	for i := 0; i < 200; i++ {
		status, body := aiFixtureCall(t, b, id, token, "ai-task-get", map[string]any{"taskId": task, "offset": 0})
		if status != 200 {
			t.Fatal(body)
		}
		result := body["result"].(map[string]any)
		if result["state"] != "running" && result["state"] != "cancelling" {
			return result
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("task did not settle")
	return nil
}

func TestAIJobsPreserveExitAndDeduplicateAcrossClientReconnect(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "AI", permissions{Terminal: true})
	var executions atomic.Int32
	b.execute = func(context.Context, string, string, string, string) ([]byte, int, error) {
		executions.Add(1)
		return []byte("中文 diagnostic failure"), 7, nil
	}
	args := map[string]any{"command": "exit 7", "timeout": 60, "key": strings.Repeat("a", 32)}
	status, body := aiFixtureCall(t, b, id, token, "ai-task-start", args)
	if status != 200 {
		t.Fatal(body)
	}
	task := body["result"].(map[string]any)["taskId"].(string)
	result := awaitAI(t, b, id, token, task)
	if result["exitCode"] != float64(7) || result["state"] != "failed" || result["code"] != "EXIT_NONZERO" || !strings.Contains(result["output"].(string), "中文") {
		t.Fatal(result)
	}
	status, replayed := aiFixtureCall(t, b, id, token, "ai-task-start", args)
	if status != 200 || replayed["result"].(map[string]any)["taskId"] != task || executions.Load() != 1 {
		t.Fatal(replayed, executions.Load())
	}
	args["command"] = "different"
	status, body = aiFixtureCall(t, b, id, token, "ai-task-start", args)
	if status == 200 || body["code"] != "IDEMPOTENCY_CONFLICT" {
		t.Fatal(body)
	}
	// A new broker reads the persisted result without running the script again.
	restarted := newControllerBroker(b.store)
	status, body = aiFixtureCall(t, restarted, id, token, "ai-task-get", map[string]any{"taskId": task, "offset": 0})
	if status != 200 || body["result"].(map[string]any)["exitCode"] != float64(7) || executions.Load() != 1 {
		t.Fatal(body)
	}
	other, otherToken := grantFixture(t, b, owner, "Other AI", permissions{Terminal: true})
	status, _ = aiFixtureCall(t, b, other, otherToken, "ai-task-get", map[string]any{"taskId": task, "offset": 0})
	if status != 403 {
		t.Fatal("cross-controller result disclosure", status)
	}
}

func TestAITaskCancellationRevocationAndUnknownRestartOutcome(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "AI", permissions{Terminal: true})
	b.execute = func(ctx context.Context, _ string, _ string, _ string, _ string) ([]byte, int, error) {
		<-ctx.Done()
		return []byte("partial output"), -1, ctx.Err()
	}
	start := func(key string) string {
		status, body := aiFixtureCall(t, b, id, token, "ai-task-start", map[string]any{"command": "wait", "timeout": 60, "key": key})
		if status != 200 {
			t.Fatal(body)
		}
		return body["result"].(map[string]any)["taskId"].(string)
	}
	task := start(strings.Repeat("a", 32))
	status, body := aiFixtureCall(t, b, id, token, "ai-task-cancel", map[string]any{"taskId": task, "offset": 0})
	if status != 200 {
		t.Fatal(body)
	}
	if result := awaitAI(t, b, id, token, task); result["state"] != "cancelled" || result["output"] != "partial output" {
		t.Fatal(result)
	}
	task = start(strings.Repeat("b", 32))
	status, body = controllerCall(t, b, "/v2/manage", controllerRequest{Action: "revoke", ID: id}, "", owner)
	if status != 200 {
		t.Fatal(body)
	}
	for i := 0; i < 200; i++ {
		b.mu.Lock()
		active := b.aiJobs[task].cancel != nil
		b.mu.Unlock()
		if !active {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	b.mu.Lock()
	state := b.aiJobs[task].State
	b.mu.Unlock()
	if state != "cancelled" {
		t.Fatal("revocation did not cancel job", state)
	}
	// Persist a running entry to simulate an abrupt service interruption.
	j := &aiJob{ID: strings.Repeat("c", 32), Controller: id, Digest: strings.Repeat("d", 64), State: "running"}
	if err := b.saveAIJob(j); err != nil {
		t.Fatal(err)
	}
	restarted := newControllerBroker(b.store)
	loaded, err := restarted.loadAIJob(j.ID)
	if err != nil || loaded.State != "interrupted" || loaded.Code != "OUTCOME_UNKNOWN" {
		t.Fatal(loaded, err)
	}
}

func TestAIDesktopPolicyBoundaryAndExplicitCapabilities(t *testing.T) {
	b, owner := brokerFixture(t)
	view, viewToken := grantFixture(t, b, owner, "View AI", permissions{View: true})
	input, inputToken := grantFixture(t, b, owner, "Control AI", permissions{View: true, Input: true})
	called := 0
	b.aiDesktop = func(_ context.Context, id string, args json.RawMessage) (any, error) {
		called++
		return map[string]any{"owner": id, "observed": true}, nil
	}
	status, body := aiFixtureCall(t, b, view, viewToken, "ai-desktop", map[string]any{"operation": "observe"})
	if status != 200 || body["result"].(map[string]any)["owner"] != view {
		t.Fatal(body)
	}
	status, _ = aiFixtureCall(t, b, view, viewToken, "ai-desktop", map[string]any{"operation": "invoke"})
	if status != 403 || called != 1 {
		t.Fatal("view grant reached input worker")
	}
	status, _ = aiFixtureCall(t, b, view, viewToken, "ai-desktop", map[string]any{"operation": "focus"})
	if status != 403 || called != 1 {
		t.Fatal("view grant activated a window")
	}
	status, _ = aiFixtureCall(t, b, input, inputToken, "ai-desktop", map[string]any{"operation": "invoke", "script": "untrusted"})
	if status != 403 || called != 1 {
		t.Fatal("unknown field reached worker")
	}
	status, _ = aiFixtureCall(t, b, input, inputToken, "ai-desktop", map[string]any{"operation": "set-value", "text": "中文"})
	if status != 200 || called != 2 {
		t.Fatal(status, called)
	}
	status, _ = aiFixtureCall(t, b, input, inputToken, "ai-desktop", map[string]any{"operation": "focus"})
	if status != 200 || called != 3 {
		t.Fatal("window focus did not retain the authenticated input policy", status, called)
	}
	b.aiDesktop = func(context.Context, string, json.RawMessage) (any, error) { return nil, aiFailure("STALE_TARGET") }
	status, body = aiFixtureCall(t, b, input, inputToken, "ai-desktop", map[string]any{"operation": "invoke"})
	if status == 200 || body["code"] != "STALE_TARGET" {
		t.Fatal(body)
	}
	status, body = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, input, inputToken)
	if status != 200 || body["result"].(map[string]any)["aiProtocol"] != float64(1) {
		t.Fatal(body)
	}
}

func TestAITaskOutputPaginationAndForget(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "AI", permissions{Terminal: true})
	b.execute = func(context.Context, string, string, string, string) ([]byte, int, error) {
		return []byte(strings.Repeat("中文", 50000)), 1, errors.New("OUTPUT_LIMIT")
	}
	status, body := aiFixtureCall(t, b, id, token, "ai-task-start", map[string]any{"command": "lots", "timeout": 60, "key": strings.Repeat("e", 32)})
	if status != 200 {
		t.Fatal(body)
	}
	task := body["result"].(map[string]any)["taskId"].(string)
	result := awaitAI(t, b, id, token, task)
	if result["truncated"] != true || result["more"] != true || result["code"] != "OUTPUT_LIMIT" {
		t.Fatal(result)
	}
	if strings.ContainsRune(result["output"].(string), '\ufffd') {
		t.Fatal("UTF-8 page split")
	}
	status, body = aiFixtureCall(t, b, id, token, "ai-task-get", map[string]any{"taskId": task, "offset": 1})
	if status != 403 {
		t.Fatal("accepted non-rune output offset", body)
	}
	status, body = aiFixtureCall(t, b, id, token, "ai-task-forget", map[string]any{"taskId": task, "offset": 0})
	if status != 200 {
		t.Fatal(body)
	}
	status, body = aiFixtureCall(t, b, id, token, "ai-task-get", map[string]any{"taskId": task, "offset": 0})
	if status == 200 || body["code"] != "NOT_FOUND" {
		t.Fatal("forgotten task survived", status, body)
	}
}

func TestAIDesktopCanonicalizesBeforeCrossLanguageDispatch(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "View AI", permissions{View: true})
	calls := 0
	b.aiDesktop = func(_ context.Context, _ string, raw json.RawMessage) (any, error) {
		calls++
		var request map[string]any
		if json.Unmarshal(raw, &request) != nil || request["operation"] != "observe" || request["Operation"] != nil {
			t.Fatal("noncanonical worker request", string(raw))
		}
		return map[string]bool{"observed": true}, nil
	}
	status, body := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "ai-desktop", Args: json.RawMessage(`{"operation":"invoke","Operation":"observe"}`)}, id, token)
	if status != 200 || calls != 1 {
		t.Fatal(body, calls)
	}
	status, body = controllerCall(t, b, "/v2/controller", controllerRequest{Action: "ai-desktop", Args: json.RawMessage(`{"operation":"observe","Operation":"invoke"}`)}, id, token)
	if status != 403 || calls != 1 {
		t.Fatal("view-only input bypass", body, calls)
	}
}
