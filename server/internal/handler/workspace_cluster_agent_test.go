package handler

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Tests for the auto-provisioned per-runtime cluster generic agent
// (workspace_cluster_agent.go): naming stability, idempotent ensure, runtime
// rebind healing, user-created same-name preservation, the startup backfill's
// coverage and predicate, and the DaemonRegister wiring.

const clusterProbePrefix = "cluster-probe"

// --- fixtures ---------------------------------------------------------------

func insertClusterProbeUser(t *testing.T, email string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id::text
	`, email, email).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, id)
	})
	return id
}

func insertClusterProbeWorkspace(t *testing.T, slug string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO workspace (name, slug, description, issue_prefix)
		VALUES ($1, $1, '', 'CLP') RETURNING id::text
	`, slug).Scan(&id); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM workspace WHERE id = $1`, id)
	})
	return id
}

func insertClusterProbeMember(t *testing.T, wsID, userID, role string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, $3)
	`, wsID, userID, role); err != nil {
		t.Fatalf("insert member: %v", err)
	}
}

// insertClusterProbeRuntime inserts a runtime row and returns its id. The row
// is cleaned up with the workspace (agent rows are removed by agent cleanup
// helpers first where needed).
func insertClusterProbeRuntime(t *testing.T, wsID, ownerID, provider, deviceInfo string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id)
		VALUES ($1, NULL, 'probe', 'local', $2, 'online', $3, '{}'::jsonb, now(), 'public', $4)
		RETURNING id::text
	`, wsID, provider, deviceInfo, ownerID).Scan(&id); err != nil {
		t.Fatalf("insert runtime: %v", err)
	}
	return id
}

func clusterProbeRuntime(t *testing.T, wsID, runtimeID, ownerID, provider, deviceInfo string) db.AgentRuntime {
	t.Helper()
	return db.AgentRuntime{
		ID:          parseUUID(runtimeID),
		WorkspaceID: parseUUID(wsID),
		OwnerID:     parseUUID(ownerID),
		Provider:    provider,
		RuntimeMode: "local",
		DeviceInfo:  deviceInfo,
	}
}

func deleteClusterProbeAgents(t *testing.T, wsID string) {
	t.Helper()
	_, _ = testPool.Exec(context.Background(), `
		DELETE FROM agent_invocation_target WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = $1)`, wsID)
	_, _ = testPool.Exec(context.Background(), `DELETE FROM agent WHERE workspace_id = $1`, wsID)
}

func countClusterGenericAgents(t *testing.T, wsID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*) FROM agent WHERE workspace_id = $1 AND name LIKE '集群通用智能体%'
	`, wsID).Scan(&n); err != nil {
		t.Fatalf("count cluster agents: %v", err)
	}
	return n
}

func waitForClusterGenericAgents(t *testing.T, wsID string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := countClusterGenericAgents(t, wsID); got == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("cluster generic agent count in ws %s did not reach %d (now %d)", wsID, want, countClusterGenericAgents(t, wsID))
}

func setClusterProbeConfig(t *testing.T, runnerEmail string) {
	t.Helper()
	prev := testHandler.cfg
	testHandler.cfg.EnsureClusterGenericAgent = true
	testHandler.cfg.SharedRunnerEmails = []string{runnerEmail}
	t.Cleanup(func() { testHandler.cfg = prev })
}

// --- naming -----------------------------------------------------------------

func TestClusterGenericAgentName_StableAcrossRuntimeShapes(t *testing.T) {
	cases := []struct {
		name string
		rt   db.AgentRuntime
		want string
	}{
		{
			name: "device info with version suffix",
			rt: db.AgentRuntime{
				DeviceInfo: "fosun_agent_1 · 2.1.220 (Claude Code)",
				Name:       "Claude (fosun_agent_1)",
			},
			want: "集群通用智能体 @ fosun_agent_1",
		},
		{
			name: "bare device info",
			rt:   db.AgentRuntime{DeviceInfo: "fosun_agent_2", Name: "Claude (fosun_agent_2)"},
			want: "集群通用智能体 @ fosun_agent_2",
		},
		{
			name: "custom name fallback",
			rt: db.AgentRuntime{
				DeviceInfo: "",
				CustomName: pgtype.Text{String: "node-x", Valid: true},
				Name:       "Claude (whatever)",
			},
			want: "集群通用智能体 @ node-x",
		},
		{
			name: "parenthesised name fallback",
			rt:   db.AgentRuntime{DeviceInfo: "", Name: "Claude (fosun_agent_6)"},
			want: "集群通用智能体 @ fosun_agent_6",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clusterAgentName(tc.rt); got != tc.want {
				t.Fatalf("clusterAgentName = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- ensure -----------------------------------------------------------------

func TestEnsureClusterGenericAgent_CreatesWorkspaceVisibleAgent(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runnerID := insertClusterProbeUser(t, clusterProbePrefix+"-create-runner@test.local")
	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-create")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })
	runtimeID := insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-node-a · 1.0.0 (Claude Code)")

	rt := clusterProbeRuntime(t, wsID, runtimeID, runnerID, "claude", "probe-node-a · 1.0.0 (Claude Code)")
	testHandler.ensureClusterGenericAgent(rt)

	const wantName = "集群通用智能体 @ probe-node-a"
	var permMode, vis, boundRuntime, owner string
	if err := testPool.QueryRow(ctx, `
		SELECT permission_mode, visibility, runtime_id::text, owner_id::text
		FROM agent WHERE workspace_id = $1 AND name = $2
	`, wsID, wantName).Scan(&permMode, &vis, &boundRuntime, &owner); err != nil {
		t.Fatalf("cluster agent not created: %v", err)
	}
	if permMode != "public_to" {
		t.Fatalf("permission_mode = %q, want public_to", permMode)
	}
	if vis != "workspace" {
		t.Fatalf("visibility = %q, want workspace", vis)
	}
	if boundRuntime != runtimeID {
		t.Fatalf("runtime_id = %q, want %q", boundRuntime, runtimeID)
	}
	if owner != runnerID {
		t.Fatalf("owner_id = %q, want runner %q", owner, runnerID)
	}

	var targets int
	if err := testPool.QueryRow(ctx, `
		SELECT count(*) FROM agent_invocation_target tgt
		JOIN agent a ON a.id = tgt.agent_id
		WHERE a.workspace_id = $1 AND a.name = $2 AND tgt.target_type = 'workspace' AND tgt.target_id = $1
	`, wsID, wantName).Scan(&targets); err != nil {
		t.Fatalf("count invocation targets: %v", err)
	}
	if targets != 1 {
		t.Fatalf("workspace invocation target rows = %d, want 1", targets)
	}
}

func TestEnsureClusterGenericAgent_IdempotentSkip(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runnerID := insertClusterProbeUser(t, clusterProbePrefix+"-idem-runner@test.local")
	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-idem")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })
	runtimeID := insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-node-b · 1.0.0 (Claude Code)")
	rt := clusterProbeRuntime(t, wsID, runtimeID, runnerID, "claude", "probe-node-b · 1.0.0 (Claude Code)")

	testHandler.ensureClusterGenericAgent(rt)
	testHandler.ensureClusterGenericAgent(rt)
	if got := countClusterGenericAgents(t, wsID); got != 1 {
		t.Fatalf("cluster agents after double ensure = %d, want 1", got)
	}
}

func TestEnsureClusterGenericAgent_RebindsStaleRuntimeID(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runnerID := insertClusterProbeUser(t, clusterProbePrefix+"-rebind-runner@test.local")
	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-rebind")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })
	oldRuntimeID := insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-node-c-old · 1.0.0 (Claude Code)")
	newRuntimeID := insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-node-c · 1.0.0 (Claude Code)")

	const wantName = "集群通用智能体 @ probe-node-c"
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
		VALUES ($1, $2, '', 'local', '{}'::jsonb, $3, 'workspace', 'public_to', 6, $4)
	`, wsID, wantName, oldRuntimeID, runnerID); err != nil {
		t.Fatalf("insert stale-bound agent: %v", err)
	}

	rt := clusterProbeRuntime(t, wsID, newRuntimeID, runnerID, "claude", "probe-node-c · 1.0.0 (Claude Code)")
	testHandler.ensureClusterGenericAgent(rt)

	if got := countClusterGenericAgents(t, wsID); got != 1 {
		t.Fatalf("cluster agents = %d, want 1 (no duplicate)", got)
	}
	var bound string
	if err := testPool.QueryRow(ctx, `
		SELECT runtime_id::text FROM agent WHERE workspace_id = $1 AND name = $2
	`, wsID, wantName).Scan(&bound); err != nil {
		t.Fatalf("read rebound runtime: %v", err)
	}
	if bound != newRuntimeID {
		t.Fatalf("runtime_id = %q, want healed to %q", bound, newRuntimeID)
	}
}

func TestEnsureClusterGenericAgent_LeavesUserCreatedSameName(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runnerID := insertClusterProbeUser(t, clusterProbePrefix+"-user-runner@test.local")
	userID := insertClusterProbeUser(t, clusterProbePrefix+"-user-owner@test.local")
	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-user")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })
	runtimeID := insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-node-d · 1.0.0 (Claude Code)")

	const wantName = "集群通用智能体 @ probe-node-d"
	const customDesc = "user-maintained custom worker, do not touch"
	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent (workspace_id, name, description, runtime_mode, runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
		VALUES ($1, $2, $3, 'local', '{}'::jsonb, $4, 'private', 'private', 1, $5)
	`, wsID, wantName, customDesc, runtimeID, userID); err != nil {
		t.Fatalf("insert user agent: %v", err)
	}

	rt := clusterProbeRuntime(t, wsID, runtimeID, runnerID, "claude", "probe-node-d · 1.0.0 (Claude Code)")
	testHandler.ensureClusterGenericAgent(rt)

	if got := countClusterGenericAgents(t, wsID); got != 1 {
		t.Fatalf("cluster agents = %d, want 1 (no duplicate)", got)
	}
	var desc, owner, perm string
	if err := testPool.QueryRow(ctx, `
		SELECT description, owner_id::text, permission_mode FROM agent WHERE workspace_id = $1 AND name = $2
	`, wsID, wantName).Scan(&desc, &owner, &perm); err != nil {
		t.Fatalf("read user agent: %v", err)
	}
	if desc != customDesc || owner != userID || perm != "private" {
		t.Fatalf("user-created agent was modified: desc=%q owner=%q permission_mode=%q", desc, owner, perm)
	}
}

// --- backfill ---------------------------------------------------------------

func TestBackfillClusterGenericAgents_CoversWorkspacesAndFiltersRuntimes(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runnerEmail := clusterProbePrefix + "-backfill-runner@test.local"
	runnerID := insertClusterProbeUser(t, runnerEmail)
	otherID := insertClusterProbeUser(t, clusterProbePrefix+"-backfill-other@test.local")
	setClusterProbeConfig(t, runnerEmail)

	ws1 := insertClusterProbeWorkspace(t, clusterProbePrefix+"-bf-1")
	ws2 := insertClusterProbeWorkspace(t, clusterProbePrefix+"-bf-2")
	for _, ws := range []string{ws1, ws2} {
		insertClusterProbeMember(t, ws, runnerID, "member")
		deleteClusterProbeAgents(t, ws)
		ws := ws
		t.Cleanup(func() { deleteClusterProbeAgents(t, ws) })
	}

	// ws1: runner claude builtin (ensure), runner openclaw (skip: provider),
	// other user's claude (skip: not runner-owned).
	insertClusterProbeRuntime(t, ws1, runnerID, "claude", "probe-bf-node1 · 1.0.0 (Claude Code)")
	insertClusterProbeRuntime(t, ws1, runnerID, "openclaw", "probe-bf-oc · 1.0.0 (Openclaw)")
	insertClusterProbeRuntime(t, ws1, otherID, "claude", "probe-bf-foreign · 1.0.0 (Claude Code)")
	// ws2: runner claude builtin (ensure).
	insertClusterProbeRuntime(t, ws2, runnerID, "claude", "probe-bf-node2 · 1.0.0 (Claude Code)")

	testHandler.BackfillClusterGenericAgents(context.Background())

	if got := countClusterGenericAgents(t, ws1); got != 1 {
		t.Fatalf("ws1 cluster agents = %d, want 1 (only runner claude builtin)", got)
	}
	if got := countClusterGenericAgents(t, ws2); got != 1 {
		t.Fatalf("ws2 cluster agents = %d, want 1", got)
	}

	// Second run must be a no-op.
	testHandler.BackfillClusterGenericAgents(context.Background())
	if got := countClusterGenericAgents(t, ws1); got != 1 {
		t.Fatalf("ws1 cluster agents after second backfill = %d, want 1", got)
	}
	if got := countClusterGenericAgents(t, ws2); got != 1 {
		t.Fatalf("ws2 cluster agents after second backfill = %d, want 1", got)
	}
}

func TestBackfillClusterGenericAgents_DisabledNoop(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	runnerEmail := clusterProbePrefix + "-off-runner@test.local"
	runnerID := insertClusterProbeUser(t, runnerEmail)
	prev := testHandler.cfg
	testHandler.cfg.EnsureClusterGenericAgent = false
	testHandler.cfg.SharedRunnerEmails = []string{runnerEmail}
	t.Cleanup(func() { testHandler.cfg = prev })

	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-off")
	insertClusterProbeMember(t, wsID, runnerID, "member")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })
	insertClusterProbeRuntime(t, wsID, runnerID, "claude", "probe-off-node · 1.0.0 (Claude Code)")

	testHandler.BackfillClusterGenericAgents(context.Background())
	if got := countClusterGenericAgents(t, wsID); got != 0 {
		t.Fatalf("cluster agents with feature disabled = %d, want 0", got)
	}
}

// --- DaemonRegister wiring ---------------------------------------------------

func TestDaemonRegister_TriggersClusterGenericAgentForSharedClaude(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	runnerEmail := clusterProbePrefix + "-http-runner@test.local"
	runnerID := insertClusterProbeUser(t, runnerEmail)
	setClusterProbeConfig(t, runnerEmail)

	wsID := insertClusterProbeWorkspace(t, clusterProbePrefix+"-http")
	deleteClusterProbeAgents(t, wsID)
	t.Cleanup(func() { deleteClusterProbeAgents(t, wsID) })

	// Pre-seed the runtime row with the runner as owner: a daemon-token register
	// carries no user, and the upsert's COALESCE preserves this owner, which is
	// what the shared-runner predicate keys on.
	var runtimeID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_runtime (workspace_id, daemon_id, name, runtime_mode, provider, status, device_info, metadata, last_seen_at, visibility, owner_id)
		VALUES ($1, 'cluster-probe-daemon', 'Claude (probe-http-node)', 'local', 'claude', 'offline', 'probe-http-node', '{}'::jsonb, now(), 'public', $2)
		RETURNING id::text
	`, wsID, runnerID).Scan(&runtimeID); err != nil {
		t.Fatalf("pre-seed runtime: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})

	w := httptest.NewRecorder()
	req := newDaemonTokenRequest("POST", "/api/daemon/register", map[string]any{
		"workspace_id": wsID,
		"daemon_id":    "cluster-probe-daemon",
		"device_name":  "probe-http-node",
		"runtimes": []map[string]any{
			{"name": "Claude (probe-http-node)", "type": "claude", "version": "1.0.0", "status": "online"},
		},
	}, wsID, "cluster-probe-daemon")
	testHandler.DaemonRegister(w, req)
	if w.Code != 200 {
		t.Fatalf("DaemonRegister: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	waitForClusterGenericAgents(t, wsID, 1)
}
