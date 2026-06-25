package handler

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestWorkspaceOpStore_Lifecycle(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceOpStore()
	ctx := context.Background()

	req, err := s.Create(ctx, "rt-1", WorkspaceOpTree, WorkspaceOpTarget{WorkspaceID: "ws", TaskShort: "abc123"})
	if err != nil {
		t.Fatal(err)
	}
	if req.Status != WorkspaceOpPending || req.Op != WorkspaceOpTree {
		t.Fatalf("create: got status=%s op=%s", req.Status, req.Op)
	}

	if has, _ := s.HasPending(ctx, "rt-1"); !has {
		t.Fatal("expected pending op for rt-1")
	}
	if has, _ := s.HasPending(ctx, "rt-other"); has {
		t.Fatal("pending op leaked to a different runtime")
	}

	// PopPending claims it (pending -> running).
	popped, _ := s.PopPending(ctx, "rt-1")
	if popped == nil || popped.ID != req.ID || popped.Status != WorkspaceOpRunning {
		t.Fatalf("pop: %+v", popped)
	}
	if has, _ := s.HasPending(ctx, "rt-1"); has {
		t.Fatal("op should no longer be pending after pop")
	}

	// Daemon reports the result.
	result := json.RawMessage(`{"entries":[{"path":"demo.txt","size":12}]}`)
	if err := s.Complete(ctx, req.ID, result); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(ctx, req.ID)
	if got.Status != WorkspaceOpCompleted || string(got.Result) != string(result) {
		t.Fatalf("complete: status=%s result=%s", got.Status, got.Result)
	}
}

func TestWorkspaceOpStore_InFlightCap(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceOpStore()
	ctx := context.Background()

	// Fill the per-runtime in-flight quota with pending ops.
	for i := 0; i < workspaceOpMaxInFlightPerRuntime; i++ {
		if _, err := s.Create(ctx, "rt-1", WorkspaceOpDownload, WorkspaceOpTarget{Path: "f"}); err != nil {
			t.Fatalf("create %d failed: %v", i, err)
		}
	}
	// The next one for the same runtime is rejected with the backlog sentinel.
	if _, err := s.Create(ctx, "rt-1", WorkspaceOpDownload, WorkspaceOpTarget{Path: "f"}); err != errWorkspaceOpBacklog {
		t.Fatalf("expected errWorkspaceOpBacklog, got %v", err)
	}
	// A different runtime is unaffected (the cap is per-runtime).
	if _, err := s.Create(ctx, "rt-2", WorkspaceOpDownload, WorkspaceOpTarget{Path: "f"}); err != nil {
		t.Fatalf("other runtime should not be capped: %v", err)
	}
	// Draining one to a terminal state frees a slot for rt-1.
	popped, _ := s.PopPending(ctx, "rt-1")
	if popped == nil {
		t.Fatal("expected a pending op to pop")
	}
	if err := s.Complete(ctx, popped.ID, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(ctx, "rt-1", WorkspaceOpDownload, WorkspaceOpTarget{Path: "f"}); err != nil {
		t.Fatalf("slot should have freed after completion: %v", err)
	}
}

func TestWorkspaceOpStore_PopOldestFirst(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceOpStore()
	ctx := context.Background()

	first, _ := s.Create(ctx, "rt-1", WorkspaceOpRead, WorkspaceOpTarget{Path: "a"})
	// Force a clear ordering gap without sleeping.
	s.mu.Lock()
	s.requests[first.ID].CreatedAt = time.Now().Add(-2 * time.Second)
	s.mu.Unlock()
	second, _ := s.Create(ctx, "rt-1", WorkspaceOpRead, WorkspaceOpTarget{Path: "b"})

	popped, _ := s.PopPending(ctx, "rt-1")
	if popped.ID != first.ID {
		t.Fatalf("expected oldest (%s) popped first, got %s", first.ID, second.ID)
	}
}

func TestWorkspaceOpStore_PopPendingBatch(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceOpStore()
	ctx := context.Background()

	// Three pending ops for rt-1, plus one for another runtime that must not leak.
	a, _ := s.Create(ctx, "rt-1", WorkspaceOpRead, WorkspaceOpTarget{Path: "a"})
	b, _ := s.Create(ctx, "rt-1", WorkspaceOpRead, WorkspaceOpTarget{Path: "b"})
	c, _ := s.Create(ctx, "rt-1", WorkspaceOpDownload, WorkspaceOpTarget{Path: "c"})
	_, _ = s.Create(ctx, "rt-2", WorkspaceOpRead, WorkspaceOpTarget{Path: "z"})

	// Stagger CreatedAt so the batch is returned oldest-first deterministically.
	s.mu.Lock()
	s.requests[a.ID].CreatedAt = time.Now().Add(-3 * time.Second)
	s.requests[b.ID].CreatedAt = time.Now().Add(-2 * time.Second)
	s.requests[c.ID].CreatedAt = time.Now().Add(-1 * time.Second)
	s.mu.Unlock()

	batch, err := s.PopPendingBatch(ctx, "rt-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(batch) != 3 {
		t.Fatalf("expected 3 ops drained, got %d", len(batch))
	}
	gotOrder := []string{batch[0].Target.Path, batch[1].Target.Path, batch[2].Target.Path}
	if gotOrder[0] != "a" || gotOrder[1] != "b" || gotOrder[2] != "c" {
		t.Fatalf("expected oldest-first [a b c], got %v", gotOrder)
	}
	for _, op := range batch {
		if op.Status != WorkspaceOpRunning || op.RunStartedAt == nil {
			t.Fatalf("op %s not claimed: status=%s started=%v", op.Target.Path, op.Status, op.RunStartedAt)
		}
	}

	// All of rt-1's ops are now running, so nothing is left pending.
	if has, _ := s.HasPending(ctx, "rt-1"); has {
		t.Fatal("rt-1 should have no pending ops after a batch drain")
	}
	if again, _ := s.PopPendingBatch(ctx, "rt-1"); len(again) != 0 {
		t.Fatalf("second drain should be empty, got %d", len(again))
	}
	// rt-2's op was untouched by the rt-1 drain.
	if has, _ := s.HasPending(ctx, "rt-2"); !has {
		t.Fatal("rt-2's pending op must survive an rt-1 batch drain")
	}
}

func TestWorkspaceOpStore_PendingTimeout(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceOpStore()
	ctx := context.Background()

	req, _ := s.Create(ctx, "rt-1", WorkspaceOpReclaim, WorkspaceOpTarget{Mode: "artifacts"})
	// Age it past the pending budget so the next read transitions it to timeout.
	s.mu.Lock()
	s.requests[req.ID].CreatedAt = time.Now().Add(-workspaceOpPendingTimeout - time.Second)
	s.mu.Unlock()

	got, _ := s.Get(ctx, req.ID)
	if got.Status != WorkspaceOpTimeout {
		t.Fatalf("expected timeout for un-popped pending op, got %s", got.Status)
	}
	if has, _ := s.HasPending(ctx, "rt-1"); has {
		t.Fatal("timed-out op must not count as pending")
	}
}
