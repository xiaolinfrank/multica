package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// setAgentCustomEnvForTest overwrites an agent's custom_env JSONB column
// directly. We bypass the PUT handler so the env-overview tests stay
// focused on the read/aggregate path and never depend on the audited
// write flow.
func setAgentCustomEnvForTest(t *testing.T, agentID string, env map[string]string) {
	t.Helper()
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal custom_env: %v", err)
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE agent SET custom_env = $1 WHERE id = $2`, raw, agentID); err != nil {
		t.Fatalf("set agent custom_env: %v", err)
	}
}

// insertWorkspaceMemberForTest seeds a fresh user + workspace member with
// the given role and returns the user id. Used to exercise the
// owner/admin gate from a non-privileged seat without mutating the shared
// owner fixture.
func insertWorkspaceMemberForTest(t *testing.T, email, role string) string {
	t.Helper()
	ctx := context.Background()
	var userID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ('Env Test Member', $1) RETURNING id
	`, email).Scan(&userID); err != nil {
		t.Fatalf("create member user: %v", err)
	}
	if _, err := testPool.Exec(ctx, `
		INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, $3)
	`, testWorkspaceID, userID, role); err != nil {
		t.Fatalf("add member: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM "user" WHERE email = $1`, email)
	})
	return userID
}

// TestListWorkspaceEnv_ReturnsKeyNamesWithoutValues is the core contract:
// the overview lists configured env var NAMES per agent, sorted, and the
// plaintext value never appears on the wire.
func TestListWorkspaceEnv_ReturnsKeyNamesWithoutValues(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "Env Overview Agent", nil)
	const secret = "sk-super-secret-value-xyz"
	setAgentCustomEnvForTest(t, agentID, map[string]string{
		"OPENAI_API_KEY":    secret,
		"ANTHROPIC_API_KEY": "sk-anthropic-zzz",
	})

	w := httptest.NewRecorder()
	testHandler.ListWorkspaceEnv(w, newRequest("GET", "/api/env", nil))
	if w.Code != 200 {
		t.Fatalf("ListWorkspaceEnv: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// No plaintext value may ever reach the client through this endpoint.
	if strings.Contains(w.Body.String(), secret) {
		t.Fatalf("ListWorkspaceEnv leaked a plaintext value into the response body")
	}

	var resp WorkspaceEnvListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	var found bool
	for _, g := range resp.Agents {
		if g.AgentID != agentID {
			continue
		}
		found = true
		want := []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY"}
		if !reflect.DeepEqual(g.Keys, want) {
			t.Fatalf("keys: got %v, want %v (sorted, names only)", g.Keys, want)
		}
	}
	if !found {
		t.Fatalf("agent %s not present in env overview", agentID)
	}
}

// TestListWorkspaceEnv_ForbidsNonAdminMember confirms the owner/admin
// gate: a plain workspace member is rejected even though the response
// carries no secret values.
func TestListWorkspaceEnv_ForbidsNonAdminMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	memberID := insertWorkspaceMemberForTest(t, "env-plain-member@multica.test", "member")

	w := httptest.NewRecorder()
	testHandler.ListWorkspaceEnv(w, newRequestAs(memberID, "GET", "/api/env", nil))
	if w.Code != 403 {
		t.Fatalf("ListWorkspaceEnv as plain member: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// TestListWorkspaceEnv_ForbidsAgentActor confirms an agent-token actor
// cannot enumerate the workspace's configured secret keys, even when its
// backing member is the workspace owner. Mirrors authorizeAgentEnv's
// lateral-movement guard (MUL-2600).
func TestListWorkspaceEnv_ForbidsAgentActor(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "Env Actor Agent", nil)
	taskID := createHandlerTestTaskForAgent(t, agentID)

	req := newRequest("GET", "/api/env", nil)
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)

	w := httptest.NewRecorder()
	testHandler.ListWorkspaceEnv(w, req)
	if w.Code != 403 {
		t.Fatalf("ListWorkspaceEnv as agent actor: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// TestBuildWorkspaceEnvGroups_SkipsArchivedAndSortsKeys exercises the
// pure projection without a DB: archived agents drop out, key names sort,
// and an agent with no env yields a non-nil empty slice (never a value).
func TestBuildWorkspaceEnvGroups_SkipsArchivedAndSortsKeys(t *testing.T) {
	t.Parallel()

	agents := []db.Agent{
		{Name: "active", CustomEnv: []byte(`{"B_KEY":"v2","A_KEY":"v1","C_KEY":"v3"}`)},
		{Name: "archived", ArchivedAt: pgtype.Timestamptz{Valid: true}, CustomEnv: []byte(`{"SECRET":"v"}`)},
		{Name: "empty", CustomEnv: []byte(`{}`)},
	}

	groups := buildWorkspaceEnvGroups(agents)

	if len(groups) != 2 {
		t.Fatalf("expected 2 groups (archived skipped), got %d: %+v", len(groups), groups)
	}
	if got, want := groups[0].Keys, []string{"A_KEY", "B_KEY", "C_KEY"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("active keys: got %v, want %v", got, want)
	}
	if groups[1].Keys == nil || len(groups[1].Keys) != 0 {
		t.Fatalf("empty agent must yield a non-nil empty key slice, got %#v", groups[1].Keys)
	}
}
