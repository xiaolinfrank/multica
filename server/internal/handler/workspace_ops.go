package handler

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Workspace file-op request store
// ---------------------------------------------------------------------------
//
// Browsing / reading / reclaiming a persistent agent workspace means touching
// the daemon's (NAS-backed) filesystem, which the server can neither reach
// inbound nor read directly (no Full Disk Access on network volumes). So these
// operations use the same pending-request pattern as model-list discovery
// (see runtime_models.go): a user POST creates a pending op, the daemon pops it
// on its next heartbeat (or a WS nudge), executes it sandboxed to the target
// envRoot, and reports the result back, which the UI polls for.
//
// One generic store serves all three op kinds; Result is the op-specific JSON
// payload (tree listing / file content / reclaim summary) the daemon produced.

// WorkspaceOpKind is the operation a request asks the daemon to perform.
type WorkspaceOpKind string

const (
	// WorkspaceOpTree lists the workspace's file tree (repo checkouts collapsed).
	WorkspaceOpTree WorkspaceOpKind = "tree"
	// WorkspaceOpRead returns one file's contents (size-capped).
	WorkspaceOpRead WorkspaceOpKind = "read"
	// WorkspaceOpReclaim frees space: mode=artifacts (repo checkouts /
	// node_modules) or mode=full (the whole workspace).
	WorkspaceOpReclaim WorkspaceOpKind = "reclaim"
)

// WorkspaceOpStatus mirrors the model-list lifecycle.
type WorkspaceOpStatus string

const (
	WorkspaceOpPending   WorkspaceOpStatus = "pending"
	WorkspaceOpRunning   WorkspaceOpStatus = "running"
	WorkspaceOpCompleted WorkspaceOpStatus = "completed"
	WorkspaceOpFailed    WorkspaceOpStatus = "failed"
	WorkspaceOpTimeout   WorkspaceOpStatus = "timeout"
)

// WorkspaceOpTarget identifies the on-disk envRoot the op runs against, plus the
// op-specific parameters. The daemon resolves envRoot =
// {WorkspacesRoot}/{WorkspaceID}/{TaskShort} and refuses anything that escapes
// it.
type WorkspaceOpTarget struct {
	WorkspaceID string `json:"workspace_id"`
	TaskShort   string `json:"task_short"`
	// Path is the file to read, relative to the workspace root (read op only).
	Path string `json:"path,omitempty"`
	// Mode is "artifacts" or "full" (reclaim op only).
	Mode string `json:"mode,omitempty"`
}

// WorkspaceOpRequest is a pending or completed file op. Result holds the
// op-specific payload the daemon returned (raw JSON so the store stays generic).
type WorkspaceOpRequest struct {
	ID           string            `json:"id"`
	RuntimeID    string            `json:"runtime_id"`
	Op           WorkspaceOpKind   `json:"op"`
	Target       WorkspaceOpTarget `json:"target"`
	Status       WorkspaceOpStatus `json:"status"`
	Result       json.RawMessage   `json:"result,omitempty"`
	Error        string            `json:"error,omitempty"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
	RunStartedAt *time.Time        `json:"-"`
}

const (
	// File ops can involve a slow NAS walk / large read, so the running window
	// is more generous than model-list's 60s. Pending stays tight: if the
	// daemon doesn't pick it up fast the runtime is likely offline.
	workspaceOpPendingTimeout = 30 * time.Second
	workspaceOpRunningTimeout = 90 * time.Second
	workspaceOpStoreRetention = 3 * time.Minute
)

// applyWorkspaceOpTimeout transitions a request to Timeout when it has overstayed
// its pending/running budget. Mirrors applyModelListTimeout.
func applyWorkspaceOpTimeout(req *WorkspaceOpRequest, now time.Time) bool {
	switch req.Status {
	case WorkspaceOpPending:
		if now.Sub(req.CreatedAt) > workspaceOpPendingTimeout {
			req.Status = WorkspaceOpTimeout
			req.UpdatedAt = now
			return true
		}
	case WorkspaceOpRunning:
		if req.RunStartedAt != nil && now.Sub(*req.RunStartedAt) > workspaceOpRunningTimeout {
			req.Status = WorkspaceOpTimeout
			req.UpdatedAt = now
			return true
		}
	}
	return false
}

func workspaceOpTerminal(status WorkspaceOpStatus) bool {
	return status == WorkspaceOpCompleted || status == WorkspaceOpFailed || status == WorkspaceOpTimeout
}

// WorkspaceOpStore is the contract for the pending-op lifecycle. Single-node
// in-memory is fine for self-hosted; a multi-node deploy would need a shared
// backend (same caveat as ModelListStore).
type WorkspaceOpStore interface {
	Create(ctx context.Context, runtimeID string, op WorkspaceOpKind, target WorkspaceOpTarget) (*WorkspaceOpRequest, error)
	Get(ctx context.Context, id string) (*WorkspaceOpRequest, error)
	HasPending(ctx context.Context, runtimeID string) (bool, error)
	PopPending(ctx context.Context, runtimeID string) (*WorkspaceOpRequest, error)
	Complete(ctx context.Context, id string, result json.RawMessage) error
	Fail(ctx context.Context, id string, errMsg string) error
}

// InMemoryWorkspaceOpStore is the single-node implementation.
type InMemoryWorkspaceOpStore struct {
	mu       sync.Mutex
	requests map[string]*WorkspaceOpRequest
}

func NewInMemoryWorkspaceOpStore() *InMemoryWorkspaceOpStore {
	return &InMemoryWorkspaceOpStore{requests: make(map[string]*WorkspaceOpRequest)}
}

func (s *InMemoryWorkspaceOpStore) Create(_ context.Context, runtimeID string, op WorkspaceOpKind, target WorkspaceOpTarget) (*WorkspaceOpRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Opportunistic retention sweep so the map can't grow without bound.
	for id, req := range s.requests {
		if time.Since(req.CreatedAt) > workspaceOpStoreRetention {
			delete(s.requests, id)
		}
	}
	now := time.Now()
	req := &WorkspaceOpRequest{
		ID:        randomID(),
		RuntimeID: runtimeID,
		Op:        op,
		Target:    target,
		Status:    WorkspaceOpPending,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.requests[req.ID] = req
	cp := *req
	return &cp, nil
}

func (s *InMemoryWorkspaceOpStore) Get(_ context.Context, id string) (*WorkspaceOpRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.requests[id]
	if !ok {
		return nil, nil
	}
	applyWorkspaceOpTimeout(req, time.Now())
	cp := *req
	return &cp, nil
}

func (s *InMemoryWorkspaceOpStore) HasPending(_ context.Context, runtimeID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for _, req := range s.requests {
		applyWorkspaceOpTimeout(req, now)
		if req.RuntimeID == runtimeID && req.Status == WorkspaceOpPending {
			return true, nil
		}
	}
	return false, nil
}

func (s *InMemoryWorkspaceOpStore) PopPending(_ context.Context, runtimeID string) (*WorkspaceOpRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	// Oldest pending first so a backlog drains in order.
	var oldest *WorkspaceOpRequest
	for _, req := range s.requests {
		applyWorkspaceOpTimeout(req, now)
		if req.RuntimeID == runtimeID && req.Status == WorkspaceOpPending {
			if oldest == nil || req.CreatedAt.Before(oldest.CreatedAt) {
				oldest = req
			}
		}
	}
	if oldest == nil {
		return nil, nil
	}
	oldest.Status = WorkspaceOpRunning
	oldest.RunStartedAt = &now
	oldest.UpdatedAt = now
	cp := *oldest
	return &cp, nil
}

func (s *InMemoryWorkspaceOpStore) Complete(_ context.Context, id string, result json.RawMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.requests[id]
	if !ok {
		return nil
	}
	req.Status = WorkspaceOpCompleted
	req.Result = result
	req.UpdatedAt = time.Now()
	return nil
}

func (s *InMemoryWorkspaceOpStore) Fail(_ context.Context, id string, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	req, ok := s.requests[id]
	if !ok {
		return nil
	}
	req.Status = WorkspaceOpFailed
	req.Error = errMsg
	req.UpdatedAt = time.Now()
	return nil
}
