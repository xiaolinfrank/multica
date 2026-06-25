package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/multica-ai/multica/server/internal/util"
)

// Workspace inventory is the push-reported, server-cached view of every agent
// workspace on disk across the fleet's daemons. Daemons cannot be reached
// inbound and the server has no Full Disk Access to read their (NAS-backed)
// filesystems directly, so each daemon periodically POSTs a per-workspace
// footprint snapshot and the server caches it here to power the workspace
// management UI without any on-demand round trip.

// inventoryTask mirrors the JSON the daemon emits per task directory
// (daemon.TaskDiskUsage). Kept as a local wire struct rather than importing the
// daemon package so the daemon->server boundary can drift field-by-field
// without coupling the handler to daemon internals.
type inventoryTask struct {
	WorkspaceID       string `json:"workspace_id"`
	TaskShort         string `json:"task_short"`
	Kind              string `json:"kind"`
	IssueID           string `json:"issue_id"`
	AgentID           string `json:"agent_id"`
	AgeSeconds        int64  `json:"age_seconds"`
	SizeBytes         int64  `json:"size_bytes"`
	ArtifactSizeBytes int64  `json:"artifact_size_bytes"`
	RepoCheckoutBytes int64  `json:"repo_checkout_bytes"`
	FileCount         int64  `json:"file_count"`
}

type inventorySnapshot struct {
	deviceName string
	runtimeID  string
	receivedAt time.Time
	tasks      []inventoryTask
}

// daemonTask is an inventoryTask annotated with the daemon that reported it, so
// the management UI can show which device holds each workspace. RuntimeID is the
// runtime the daemon reported under — a live runtime on the very daemon that
// holds these files, which is exactly where an on-demand file op must be routed.
type daemonTask struct {
	inventoryTask
	DaemonID   string
	DeviceName string
	RuntimeID  string
}

// workspaceInventoryStaleAfter drops snapshots from daemons that stopped
// reporting (offline / decommissioned) so the management page doesn't show
// phantom workspaces forever. Comfortably larger than the daemon's report
// interval so a single missed tick doesn't blink rows out.
const workspaceInventoryStaleAfter = 15 * time.Minute

// WorkspaceInventoryStore caches the latest per-(workspace, daemon) snapshot.
type WorkspaceInventoryStore interface {
	Put(workspaceID, daemonID, runtimeID, deviceName string, tasks []inventoryTask)
	TasksForWorkspace(workspaceID string) []daemonTask
}

// InMemoryWorkspaceInventoryStore is the single-node implementation. The cache
// is rebuilt from the next round of daemon reports after a server restart, so
// durability isn't required.
type InMemoryWorkspaceInventoryStore struct {
	mu sync.RWMutex
	// workspaceID -> daemonID -> snapshot
	byWorkspace map[string]map[string]inventorySnapshot
}

func NewInMemoryWorkspaceInventoryStore() *InMemoryWorkspaceInventoryStore {
	return &InMemoryWorkspaceInventoryStore{byWorkspace: map[string]map[string]inventorySnapshot{}}
}

func (s *InMemoryWorkspaceInventoryStore) Put(workspaceID, daemonID, runtimeID, deviceName string, tasks []inventoryTask) {
	s.mu.Lock()
	defer s.mu.Unlock()
	daemons := s.byWorkspace[workspaceID]
	if daemons == nil {
		daemons = map[string]inventorySnapshot{}
		s.byWorkspace[workspaceID] = daemons
	}
	daemons[daemonID] = inventorySnapshot{deviceName: deviceName, runtimeID: runtimeID, receivedAt: time.Now(), tasks: tasks}
}

func (s *InMemoryWorkspaceInventoryStore) TasksForWorkspace(workspaceID string) []daemonTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cutoff := time.Now().Add(-workspaceInventoryStaleAfter)
	var out []daemonTask
	for daemonID, snap := range s.byWorkspace[workspaceID] {
		if snap.receivedAt.Before(cutoff) {
			continue // daemon went quiet; treat its snapshot as gone
		}
		for _, t := range snap.tasks {
			out = append(out, daemonTask{inventoryTask: t, DaemonID: daemonID, DeviceName: snap.deviceName, RuntimeID: snap.runtimeID})
		}
	}
	return out
}

// ReportWorkspaceInventory ingests a daemon's per-workspace footprint snapshot.
// POST /api/daemon/runtimes/{runtimeId}/workspace-inventory
func (h *Handler) ReportWorkspaceInventory(w http.ResponseWriter, r *http.Request) {
	runtimeID := chi.URLParam(r, "runtimeId")
	rt, ok := h.requireDaemonRuntimeAccess(w, r, runtimeID)
	if !ok {
		return
	}

	var body struct {
		WorkspaceID string          `json:"workspace_id"`
		GeneratedAt time.Time       `json:"generated_at"`
		Tasks       []inventoryTask `json:"tasks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid workspace inventory body")
		return
	}

	// Bind the snapshot to the runtime's own workspace and keep only tasks that
	// belong to it — a daemon may only report footprint for a workspace it owns
	// a runtime in, so a spoofed cross-workspace task is dropped rather than
	// surfaced to another tenant's management page.
	wsID := uuidToString(rt.WorkspaceID)
	tasks := make([]inventoryTask, 0, len(body.Tasks))
	for _, t := range body.Tasks {
		if t.WorkspaceID == wsID {
			tasks = append(tasks, t)
		}
	}

	daemonID := rt.DaemonID.String
	if daemonID == "" {
		daemonID = rt.LegacyDaemonID.String
	}
	h.WorkspaceInventoryStore.Put(wsID, daemonID, uuidToString(rt.ID), rt.Name, tasks)
	w.WriteHeader(http.StatusNoContent)
}

// AgentWorkspace is one persistent (agent, issue) workspace as shown in the
// management UI.
type AgentWorkspace struct {
	IssueID           string `json:"issue_id"`
	IssueIdentifier   string `json:"issue_identifier"`
	IssueTitle        string `json:"issue_title"`
	IssueStatus       string `json:"issue_status"`
	AgentID           string `json:"agent_id"`
	AgentName         string `json:"agent_name"`
	DeviceName        string `json:"device_name"`
	TaskShort         string `json:"task_short"`
	SizeBytes         int64  `json:"size_bytes"`
	RepoCheckoutBytes int64  `json:"repo_checkout_bytes"`
	FileCount         int64  `json:"file_count"`
	AgeSeconds        int64  `json:"age_seconds"`
}

// AgentWorkspacesResponse is the management page payload.
type AgentWorkspacesResponse struct {
	Workspaces             []AgentWorkspace `json:"workspaces"`
	TotalSizeBytes         int64            `json:"total_size_bytes"`
	TotalRepoCheckoutBytes int64            `json:"total_repo_checkout_bytes"`
}

// ListAgentWorkspaces returns every persistent agent workspace in a workspace,
// resolving issue/agent identities for display.
// GET /api/workspaces/{workspaceId}/agent-workspaces
func (h *Handler) ListAgentWorkspaces(w http.ResponseWriter, r *http.Request) {
	wsID := chi.URLParam(r, "workspaceId")
	if _, ok := h.requireWorkspaceMember(w, r, wsID, "workspace not found"); !ok {
		return
	}

	tasks := h.WorkspaceInventoryStore.TasksForWorkspace(wsID)

	// Resolve the issue prefix once for identifier rendering.
	issuePrefix := ""
	if wsUUID, err := util.ParseUUID(wsID); err == nil {
		if ws, err := h.Queries.GetWorkspace(r.Context(), wsUUID); err == nil {
			issuePrefix = ws.IssuePrefix
		}
	}

	// Per-request caches so repeated issue/agent ids cost one lookup each.
	type issueInfo struct {
		identifier string
		title      string
		status     string
	}
	issueCache := map[string]issueInfo{}
	agentCache := map[string]string{}

	resp := AgentWorkspacesResponse{Workspaces: make([]AgentWorkspace, 0, len(tasks))}
	for _, t := range tasks {
		// The management page lists (agent, issue) workspaces; chat/autopilot/
		// quick-create scratch is governed by its own lifecycle and excluded.
		if t.Kind != "issue" || t.IssueID == "" {
			continue
		}

		info, ok := issueCache[t.IssueID]
		if !ok {
			if iu, err := util.ParseUUID(t.IssueID); err == nil {
				if iss, err := h.Queries.GetIssue(r.Context(), iu); err == nil {
					info = issueInfo{
						identifier: issuePrefix + "-" + strconv.Itoa(int(iss.Number)),
						title:      iss.Title,
						status:     iss.Status,
					}
				}
			}
			issueCache[t.IssueID] = info
		}

		agentName, ok := agentCache[t.AgentID]
		if !ok {
			if t.AgentID != "" {
				if au, err := util.ParseUUID(t.AgentID); err == nil {
					if ag, err := h.Queries.GetAgent(r.Context(), au); err == nil {
						agentName = ag.Name
					}
				}
			}
			agentCache[t.AgentID] = agentName
		}

		resp.Workspaces = append(resp.Workspaces, AgentWorkspace{
			IssueID:           t.IssueID,
			IssueIdentifier:   info.identifier,
			IssueTitle:        info.title,
			IssueStatus:       info.status,
			AgentID:           t.AgentID,
			AgentName:         agentName,
			DeviceName:        t.DeviceName,
			TaskShort:         t.TaskShort,
			SizeBytes:         t.SizeBytes,
			RepoCheckoutBytes: t.RepoCheckoutBytes,
			FileCount:         t.FileCount,
			AgeSeconds:        t.AgeSeconds,
		})
		resp.TotalSizeBytes += t.SizeBytes
		resp.TotalRepoCheckoutBytes += t.RepoCheckoutBytes
	}

	// Biggest first — the management page's primary job is finding what to clean.
	sort.Slice(resp.Workspaces, func(i, j int) bool {
		return resp.Workspaces[i].SizeBytes > resp.Workspaces[j].SizeBytes
	})

	writeJSON(w, http.StatusOK, resp)
}
