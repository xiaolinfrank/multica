package handler

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/util"
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
	// WorkspaceOpDownload returns one file's full bytes (base64) for download
	// or inline image preview. Larger cap than read; binary-capable.
	WorkspaceOpDownload WorkspaceOpKind = "download"
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
	// workspaceOpMaxInFlightPerRuntime caps concurrent non-terminal ops per
	// runtime so the in-memory store's memory is explicitly bounded, not just by
	// the retention sweep. A completed download holds its full base64 payload
	// (~13 MiB for a 10 MiB file) until the sweep, so an authenticated member
	// can't balloon server memory by spamming download ops; legitimate browsing
	// never has more than a couple in flight at once.
	workspaceOpMaxInFlightPerRuntime = 16
)

// errWorkspaceOpBacklog is returned by Create when a runtime already has the
// maximum number of in-flight ops; the handler maps it to 429.
var errWorkspaceOpBacklog = errors.New("too many in-flight workspace ops for this runtime")

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
	// PopPendingBatch claims every pending op for the runtime in one shot so a
	// burst of file clicks drains in a single heartbeat, not one op per beat.
	PopPendingBatch(ctx context.Context, runtimeID string) ([]*WorkspaceOpRequest, error)
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
	now := time.Now()
	inFlight := 0
	for id, req := range s.requests {
		if time.Since(req.CreatedAt) > workspaceOpStoreRetention {
			delete(s.requests, id)
			continue
		}
		applyWorkspaceOpTimeout(req, now)
		if req.RuntimeID == runtimeID && !workspaceOpTerminal(req.Status) {
			inFlight++
		}
	}
	// Bound concurrent ops per runtime so a download backlog can't balloon memory.
	if inFlight >= workspaceOpMaxInFlightPerRuntime {
		return nil, errWorkspaceOpBacklog
	}
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

// PopPendingBatch atomically claims every pending op for runtimeID (oldest
// first) and transitions them to running. Returning the whole backlog in one
// heartbeat lets the daemon dispatch them concurrently instead of draining one
// op per beat — the difference between a snappy browse and a 15s-per-click wait.
func (s *InMemoryWorkspaceOpStore) PopPendingBatch(_ context.Context, runtimeID string) ([]*WorkspaceOpRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	var pending []*WorkspaceOpRequest
	for _, req := range s.requests {
		applyWorkspaceOpTimeout(req, now)
		if req.RuntimeID == runtimeID && req.Status == WorkspaceOpPending {
			pending = append(pending, req)
		}
	}
	if len(pending) == 0 {
		return nil, nil
	}
	sort.Slice(pending, func(i, j int) bool {
		return pending[i].CreatedAt.Before(pending[j].CreatedAt)
	})
	out := make([]*WorkspaceOpRequest, 0, len(pending))
	for _, req := range pending {
		req.Status = WorkspaceOpRunning
		started := now
		req.RunStartedAt = &started
		req.UpdatedAt = now
		cp := *req
		out = append(out, &cp)
	}
	return out, nil
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

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

// resolveWorkspaceOpRuntime finds a live runtime ID to route an op for
// (wsID, taskShort) to. The inventory snapshot records the runtime a daemon
// reported its footprint under — that runtime is, by construction, on the exact
// daemon that holds these files, so an op enqueued under it reaches the right
// disk. Returns ("", false) when no daemon currently reports this workspace.
func (h *Handler) resolveWorkspaceOpRuntime(wsID, taskShort string) (string, bool) {
	for _, t := range h.WorkspaceInventoryStore.TasksForWorkspace(wsID) {
		if t.TaskShort == taskShort && t.RuntimeID != "" {
			return t.RuntimeID, true
		}
	}
	return "", false
}

// InitiateWorkspaceOp enqueues a tree/read/reclaim op against one persistent
// agent workspace and returns the request the client polls.
// POST /api/workspaces/{workspaceId}/agent-workspaces/{taskShort}/ops/{op}
func (h *Handler) InitiateWorkspaceOp(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "workspaceId")
	if _, ok := h.requireWorkspaceMember(w, r, wsID, "workspace not found"); !ok {
		return
	}
	taskShort := chi.URLParam(r, "taskShort")
	op := WorkspaceOpKind(chi.URLParam(r, "op"))
	switch op {
	case WorkspaceOpTree, WorkspaceOpRead, WorkspaceOpDownload, WorkspaceOpReclaim:
	default:
		writeError(w, http.StatusBadRequest, "unknown workspace op")
		return
	}

	// Body is optional (tree takes none); decode leniently.
	var body struct {
		Path string `json:"path"`
		Mode string `json:"mode"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if (op == WorkspaceOpRead || op == WorkspaceOpDownload) && strings.TrimSpace(body.Path) == "" {
		writeError(w, http.StatusBadRequest, "path is required for a "+string(op)+" op")
		return
	}

	runtimeID, ok := h.resolveWorkspaceOpRuntime(wsID, taskShort)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found on any reporting daemon")
		return
	}
	// The routed runtime must be online or the daemon never picks up the op and
	// the client just waits out the timeout. Fail fast instead.
	if ru, err := util.ParseUUID(runtimeID); err == nil {
		if rt, err := h.Queries.GetAgentRuntime(r.Context(), ru); err == nil && rt.Status != "online" {
			writeError(w, http.StatusServiceUnavailable, "the daemon holding this workspace is offline")
			return
		}
	}

	req, err := h.WorkspaceOpStore.Create(r.Context(), runtimeID, op, WorkspaceOpTarget{
		WorkspaceID: wsID,
		TaskShort:   taskShort,
		Path:        body.Path,
		Mode:        body.Mode,
	})
	if err != nil {
		if errors.Is(err, errWorkspaceOpBacklog) {
			writeError(w, http.StatusTooManyRequests, "too many in-flight workspace ops; retry shortly")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to enqueue workspace op: "+err.Error())
		return
	}
	// Best-effort nudge: wake the daemon now so it pulls this op on an immediate
	// forced heartbeat instead of waiting up to one heartbeat interval (~15s).
	// The heartbeat pull stays the reliable backstop if the hint is dropped.
	if h.DaemonHub != nil {
		h.DaemonHub.NotifyWorkspaceOpAvailable(runtimeID)
	}
	writeJSON(w, http.StatusOK, req)
}

// GetWorkspaceOpRequest returns the current state of a workspace op so the
// client can poll for the daemon's result.
// GET /api/workspaces/{workspaceId}/workspace-ops/{requestId}
func (h *Handler) GetWorkspaceOpRequest(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "workspaceId")
	if _, ok := h.requireWorkspaceMember(w, r, wsID, "workspace not found"); !ok {
		return
	}
	requestID := chi.URLParam(r, "requestId")
	req, err := h.WorkspaceOpStore.Get(r.Context(), requestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load request: "+err.Error())
		return
	}
	// Bind to the caller's workspace so a request_id can't be polled cross-tenant.
	if req == nil || req.Target.WorkspaceID != wsID {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	writeJSON(w, http.StatusOK, req)
}

// ReportWorkspaceOpResult ingests the daemon's result for a workspace op.
// POST /api/daemon/runtimes/{runtimeId}/workspace-ops/{requestId}/result
func (h *Handler) ReportWorkspaceOpResult(w http.ResponseWriter, r *http.Request) {
	runtimeID := chi.URLParam(r, "runtimeId")
	if _, ok := h.requireDaemonRuntimeAccess(w, r, runtimeID); !ok {
		return
	}
	requestID := chi.URLParam(r, "requestId")

	// Fetch first so a retried report for an already-terminal request is a
	// harmless no-op rather than clobbering the stored result.
	existing, err := h.WorkspaceOpStore.Get(r.Context(), requestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load request: "+err.Error())
		return
	}
	if existing == nil || existing.RuntimeID != runtimeID {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}
	if workspaceOpTerminal(existing.Status) {
		slog.Debug("ignoring stale workspace op report", "runtime_id", runtimeID, "request_id", requestID, "status", existing.Status)
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	var body struct {
		Status  string          `json:"status"` // "completed" or "failed"
		Error   string          `json:"error"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.Status == "completed" {
		if err := h.WorkspaceOpStore.Complete(r.Context(), requestID, body.Payload); err != nil {
			slog.Error("WorkspaceOpStore Complete failed", "error", err, "request_id", requestID)
			writeError(w, http.StatusInternalServerError, "failed to persist completion")
			return
		}
	} else {
		if err := h.WorkspaceOpStore.Fail(r.Context(), requestID, body.Error); err != nil {
			slog.Error("WorkspaceOpStore Fail failed", "error", err, "request_id", requestID)
			writeError(w, http.StatusInternalServerError, "failed to persist failure")
			return
		}
	}
	slog.Debug("workspace op report", "runtime_id", runtimeID, "request_id", requestID, "status", body.Status)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
