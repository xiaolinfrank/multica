package handler

// Auto-provisioning of the per-runtime "cluster generic agent" for shared
// compute nodes (BayClaw fork).
//
// Background: agents are strictly workspace-scoped, so a generic worker bound
// to a shared-runner node must exist in every workspace the shared daemon
// serves. These were originally hand-created in one workspace only; this file
// automates them so every existing and future workspace gets one generic agent
// per shared Claude runtime, following node add/remove automatically.
//
// Two triggers converge on the same idempotent unit:
//   - DaemonRegister: for each shared-runner built-in Claude runtime, a
//     goroutine runs ensureClusterGenericAgent.
//   - BackfillClusterGenericAgents: one-shot startup reconciliation across all
//     workspaces shared runners already serve.
//
// Idempotency key: agent_workspace_name_unique (UNIQUE(workspace_id, name),
// migration 046). A same-named agent — user-created or auto-created — is never
// modified except for healing a drifted runtime_id.

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/seed"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// clusterGenericAgentPrefix is the common display-name prefix of every
// auto-provisioned generic worker: "通用智能体（主）" on the API host,
// "通用智能体 N" on numbered fleet nodes.
const clusterGenericAgentPrefix = "通用智能体"

// legacyClusterGenericAgentPrefix is the pre-rename naming scheme
// ("集群通用智能体 @ <node>"). ensure renames agents still carrying it onto
// the new scheme instead of creating duplicates alongside them.
const legacyClusterGenericAgentPrefix = "集群通用智能体 @ "

// fleetNodeLabelPrefix prefixes the numbered fleet-node hostnames
// ("fosun_agent_1"…"fosun_agent_6"); their agents drop it for a plain number.
const fleetNodeLabelPrefix = "fosun_agent_"

// clusterGenericAgentTimeout bounds one detached ensure run.
const clusterGenericAgentTimeout = 15 * time.Second

// normalizeNodeLabel lowercases and strips a trailing ".local" so the API
// host and its co-located daemon compare equal despite mDNS hostname drift
// (the daemon may register "foo" or "foo.local" on different boots).
func normalizeNodeLabel(s string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(s)), ".local")
}

// isHostNodeLabel reports whether node labels the machine the API server
// itself runs on. In the BayClaw deployment the host daemon is co-located
// with the API, so its generic agent is the primary one ("通用智能体（主）").
func isHostNodeLabel(node string) bool {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return false
	}
	return normalizeNodeLabel(node) == normalizeNodeLabel(host)
}

// clusterAgentNameForNode maps a runtime node label to the generic agent's
// display name: the API server's own host is "通用智能体（主）", numbered
// fleet nodes "fosun_agent_N" become "通用智能体 N", anything else falls back
// to "通用智能体（<node>）".
func clusterAgentNameForNode(node string) string {
	node = strings.TrimSpace(node)
	if node == "" {
		return clusterGenericAgentPrefix + "（未知节点）"
	}
	if isHostNodeLabel(node) {
		return clusterGenericAgentPrefix + "（主）"
	}
	if n, ok := strings.CutPrefix(node, fleetNodeLabelPrefix); ok && n != "" {
		return clusterGenericAgentPrefix + " " + n
	}
	return clusterGenericAgentPrefix + "（" + node + "）"
}

// clusterNodeLabel extracts the stable node label for rt — DeviceInfo's
// pre-" · " segment (the daemon's DeviceName), then custom_name, then the
// parenthesised tail of Name, then the runtime id tail. Never empty.
func clusterNodeLabel(rt db.AgentRuntime) string {
	if node := nodeLabelFromDeviceInfo(rt.DeviceInfo); node != "" {
		return node
	}
	if rt.CustomName.Valid && strings.TrimSpace(rt.CustomName.String) != "" {
		return strings.TrimSpace(rt.CustomName.String)
	}
	if node := nodeLabelFromName(rt.Name); node != "" {
		return node
	}
	return uuidToString(rt.ID)[:8]
}

// clusterAgentName builds the display name for the cluster generic agent
// bound to rt from its node label.
func clusterAgentName(rt db.AgentRuntime) string {
	return clusterAgentNameForNode(clusterNodeLabel(rt))
}

// clusterAgentAvatarSlug maps a cluster generic agent's display name to its
// embedded avatar slug. The API host ("通用智能体（主）") maps to the gold
// primary avatar; numbered fleet nodes ("通用智能体 1"…"通用智能体 6") map to
// their matching numbered node avatar. Any other name (an unknown node label)
// falls back to the primary avatar so every generic worker always has a face.
// Slugs match embedded PNGs in seed/avatars, served at
// /uploads/agent-avatars/<slug>.png by seed.ServeAvatar.
func clusterAgentAvatarSlug(name string) string {
	switch {
	case name == clusterGenericAgentPrefix+"（主）":
		return "cluster-primary"
	case strings.HasPrefix(name, clusterGenericAgentPrefix+" "):
		return "cluster-node-" + strings.TrimPrefix(name, clusterGenericAgentPrefix+" ")
	default:
		return "cluster-primary"
	}
}

// nodeLabelFromDeviceInfo returns the device/hostname segment the daemon
// writes as everything before the first " · " in DeviceInfo (e.g.
// "fosun_agent_1 · 2.1.220 (Claude Code)" -> "fosun_agent_1"). SplitN-style
// first-match keeps the label intact if a version string reintroduces " · ".
func nodeLabelFromDeviceInfo(deviceInfo string) string {
	s := strings.TrimSpace(deviceInfo)
	if s == "" {
		return ""
	}
	if i := strings.Index(s, " · "); i > 0 {
		return strings.TrimSpace(s[:i])
	}
	return s // bare hostname when no version suffix is present
}

// nodeLabelFromName extracts the parenthesised tail of a runtime display name,
// e.g. "Claude (fosun_agent_1)" -> "fosun_agent_1".
func nodeLabelFromName(name string) string {
	open := strings.LastIndex(name, "(")
	closeIdx := strings.LastIndex(name, ")")
	if open >= 0 && closeIdx > open+1 {
		return strings.TrimSpace(name[open+1 : closeIdx])
	}
	return ""
}

// clusterGenericAgentParams mirrors seedAgentParams but for the auto-provisioned
// per-runtime generic worker: workspace-visible, owned by the shared runner,
// bound to its own runtime, minimal payload (no instructions/mcp/custom env).
func clusterGenericAgentParams(rt db.AgentRuntime, name string) db.CreateAgentParams {
	return db.CreateAgentParams{
		WorkspaceID:        rt.WorkspaceID,
		Name:               name,
		AvatarUrl:          pgtype.Text{String: seed.AvatarURLFor(clusterAgentAvatarSlug(name)), Valid: true},
		Description:        "运行在 " + clusterNodeLabel(rt) + " 节点的通用智能体",
		Instructions:       "",
		RuntimeMode:        rt.RuntimeMode,
		RuntimeConfig:      []byte("{}"),
		RuntimeID:          rt.ID,
		Visibility:         "workspace", // derived legacy field; authorization is permission_mode + targets
		PermissionMode:     "public_to",
		MaxConcurrentTasks: 6,
		OwnerID:            rt.OwnerID,
		CustomEnv:          []byte("{}"),
		CustomArgs:         []byte("[]"),
		Model:              pgtype.Text{},
		ThinkingLevel:      pgtype.Text{},
	}
}

// ensureClusterGenericAgent guarantees that exactly one cluster generic agent
// exists in rt.WorkspaceID, bound to rt.ID, workspace-visible and owned by the
// shared runner. Best-effort: runs detached with its own timeout and never
// fails the daemon register/heartbeat path.
func (h *Handler) ensureClusterGenericAgent(rt db.AgentRuntime) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("cluster generic agent: panic recovered",
				"panic", rec, "runtime_id", uuidToString(rt.ID),
				"workspace_id", uuidToString(rt.WorkspaceID))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), clusterGenericAgentTimeout)
	defer cancel()

	if !rt.WorkspaceID.Valid || !rt.ID.Valid || !rt.OwnerID.Valid {
		return
	}
	wantName := clusterAgentName(rt)
	legacyName := legacyClusterGenericAgentPrefix + clusterNodeLabel(rt)

	existing, err := h.Queries.ListAgents(ctx, rt.WorkspaceID)
	if err != nil {
		slog.Warn("cluster generic agent: list agents failed",
			"error", err, "workspace_id", uuidToString(rt.WorkspaceID))
		return
	}
	for _, a := range existing {
		if a.Name != wantName && a.Name != legacyName {
			continue
		}
		if a.Name == legacyName && legacyName != wantName {
			// Pre-rename agent for this same node: migrate it onto the new
			// naming scheme instead of creating a duplicate alongside it.
			// UNIQUE(workspace_id, name) is safe — reaching here means no
			// agent in this workspace already carries wantName. On failure
			// stop here; the next register/backfill retries.
			if _, err := h.Queries.RenameClusterAgent(ctx, db.RenameClusterAgentParams{
				ID:   a.ID,
				Name: wantName,
			}); err != nil {
				slog.Warn("cluster generic agent: rename failed",
					"agent_id", uuidToString(a.ID), "from", a.Name, "to", wantName, "error", err)
				return
			}
			slog.Info("cluster generic agent: renamed",
				"agent_id", uuidToString(a.ID), "from", a.Name, "to", wantName,
				"workspace_id", uuidToString(rt.WorkspaceID))
		}
		// Present by name — ours from a previous run or user-created. Only heal
		// the runtime binding if it drifted (daemon_id migration or runtime GC +
		// re-register left it pointing at a dead row); never touch anything else.
		if a.RuntimeID != rt.ID {
			if _, err := h.Queries.RebindClusterAgentRuntime(ctx, db.RebindClusterAgentRuntimeParams{
				ID:        a.ID,
				RuntimeID: rt.ID,
			}); err != nil {
				slog.Warn("cluster generic agent: rebind failed",
					"agent_id", uuidToString(a.ID), "runtime_id", uuidToString(rt.ID), "error", err)
			}
		}
		return
	}

	created, err := h.Queries.CreateAgent(ctx, clusterGenericAgentParams(rt, wantName))
	if err != nil {
		// Race with a concurrent ensure (another replica, or register + backfill
		// overlap): the UNIQUE(workspace_id, name) constraint decides and the
		// loser stops here.
		if isUniqueViolation(err) {
			return
		}
		slog.Warn("cluster generic agent: create failed",
			"error", err, "workspace_id", uuidToString(rt.WorkspaceID), "name", wantName)
		return
	}
	// permission_mode='public_to' grants nothing until a matching target row
	// exists; the workspace target makes the agent visible/invocable by every
	// workspace member.
	if err := replaceInvocationTargetsWithQueries(ctx, h.Queries, created.ID, rt.OwnerID,
		[]targetSpec{{targetType: invocationTargetWorkspace, targetID: rt.WorkspaceID}}); err != nil {
		slog.Warn("cluster generic agent: grant workspace target failed",
			"agent_id", uuidToString(created.ID), "error", err)
	}
	slog.Info("cluster generic agent: created",
		"agent_id", uuidToString(created.ID), "workspace_id", uuidToString(rt.WorkspaceID),
		"runtime_id", uuidToString(rt.ID), "name", wantName)
}

// defaultClusterAssignee returns the id of the workspace's cluster generic
// agent for the configured DefaultIssueAssigneeNode, for use as the fallback
// assignee when an issue is created without one. Returns an invalid UUID when
// the feature is off or no ready agent exists (not provisioned yet, or
// runtime-less) — the caller then leaves the issue unassigned. ListAgents
// already excludes archived agents; RuntimeID must be set or the assignment
// could never dispatch a run.
func (h *Handler) defaultClusterAssignee(ctx context.Context, workspaceID pgtype.UUID) pgtype.UUID {
	node := strings.TrimSpace(h.cfg.DefaultIssueAssigneeNode)
	if node == "" || !workspaceID.Valid {
		return pgtype.UUID{}
	}
	agents, err := h.Queries.ListAgents(ctx, workspaceID)
	if err != nil {
		slog.Warn("default cluster assignee: list agents failed",
			"error", err, "workspace_id", uuidToString(workspaceID))
		return pgtype.UUID{}
	}
	want := clusterAgentNameForNode(node)
	for _, a := range agents {
		if a.Name == want && a.RuntimeID.Valid {
			return a.ID
		}
	}
	return pgtype.UUID{}
}

// BackfillClusterGenericAgents is a one-shot startup reconciliation: for every
// workspace a shared runner serves, ensure the cluster generic agent exists for
// each of its built-in Claude runtimes. Covers existing workspaces on first
// deploy without waiting for daemon reconnect; the DaemonRegister hook plus the
// daemon's periodic workspace sync keep it converged afterwards. Idempotent and
// safe under multiple replicas (UNIQUE(workspace_id, name) is the final dedup).
func (h *Handler) BackfillClusterGenericAgents(ctx context.Context) {
	defer func() {
		if rec := recover(); rec != nil {
			slog.Error("cluster generic agent backfill: panic recovered", "panic", rec)
		}
	}()
	if !h.cfg.EnsureClusterGenericAgent || len(h.cfg.SharedRunnerEmails) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// Resolve shared-runner user ids once (vs. isSharedRunner's per-runtime
	// GetUser) since the backfill may iterate many runtimes.
	runnerIDs := make([]pgtype.UUID, 0, len(h.cfg.SharedRunnerEmails))
	for _, email := range h.cfg.SharedRunnerEmails {
		u, err := h.Queries.GetUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
		if err != nil {
			continue
		}
		runnerIDs = append(runnerIDs, u.ID)
	}

	for _, runnerID := range runnerIDs {
		wss, err := h.Queries.ListWorkspaces(ctx, runnerID)
		if err != nil {
			slog.Warn("cluster generic agent backfill: list workspaces failed", "error", err)
			continue
		}
		for _, ws := range wss {
			rts, err := h.Queries.ListAgentRuntimesByOwner(ctx, db.ListAgentRuntimesByOwnerParams{
				WorkspaceID: ws.ID,
				OwnerID:     runnerID,
			})
			if err != nil {
				slog.Warn("cluster generic agent backfill: list runtimes failed",
					"error", err, "workspace_id", uuidToString(ws.ID))
				continue
			}
			for _, rt := range rts {
				if rt.Provider == seedPreferredProvider && !rt.ProfileID.Valid {
					h.ensureClusterGenericAgent(rt)
				}
			}
		}
	}
}
