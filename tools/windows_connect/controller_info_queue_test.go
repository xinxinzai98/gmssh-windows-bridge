package main

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

func TestInfoQueriesWaitForCapacityWithoutBlockingOtherRequests(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Info queue", permissions{View: true})
	entered, release := make(chan struct{}, 3), make(chan struct{})
	var active, peak, calls atomic.Int32
	b.readInfo = func(ctx context.Context, file, prefix string) ([]byte, error) {
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		calls.Add(1)
		entered <- struct{}{}
		select {
		case <-release:
			return []byte(`{"fixture":true}`), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	result := make(chan int, 3)
	query := func() {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "info", Args: json.RawMessage(`{"tool":"system","options":{}}`)}, id, token)
		result <- status
	}
	go query()
	go query()
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("information provider did not start")
		}
	}
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	go query()
	select {
	case status := <-result:
		t.Fatalf("third read-only sample rejected while two slots are briefly busy: %d", status)
	case <-time.After(50 * time.Millisecond):
	}
	ready := make(chan int, 1)
	go func() {
		status, _ := controllerCall(t, b, "/v2/controller", controllerRequest{Action: "capabilities"}, id, token)
		ready <- status
	}()
	select {
	case status := <-ready:
		if status != 200 {
			t.Fatal("unrelated request failed", status)
		}
	case <-time.After(time.Second):
		t.Fatal("queued information held the controller registry lock")
	}
	close(release)
	for i := 0; i < 3; i++ {
		select {
		case status := <-result:
			if status != 200 {
				t.Fatal("queued information request failed", status)
			}
		case <-time.After(time.Second):
			t.Fatal("queued information did not complete")
		}
	}
	if peak.Load() > 2 || calls.Load() != 3 {
		t.Fatal("concurrency bound or single execution changed", peak.Load(), calls.Load())
	}
}

func TestInfoQueueRetainsOneSixSecondDeadline(t *testing.T) {
	b, owner := brokerFixture(t)
	id, token := grantFixture(t, b, owner, "Info deadline", permissions{View: true})
	entered := make(chan struct{}, 3)
	b.readInfo = func(ctx context.Context, file, prefix string) ([]byte, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	query := func() (int, map[string]any) {
		return controllerCall(t, b, "/v2/controller", controllerRequest{Action: "info", Args: json.RawMessage(`{"tool":"system","options":{}}`)}, id, token)
	}
	for i := 0; i < 2; i++ {
		go func() { query() }()
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("information provider did not start")
		}
	}
	started := time.Now()
	status, body := query()
	if elapsed := time.Since(started); status != 409 || body["code"] != "OPERATION_TIMEOUT" || elapsed < 5*time.Second || elapsed > 7500*time.Millisecond {
		t.Fatal("queue reset or discarded its bounded deadline", status, body, elapsed)
	}
}
