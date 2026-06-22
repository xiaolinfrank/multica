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
