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

// setAgentJSONBForTest overwrites an agent's mcp_config / runtime_config
// JSONB column directly, so the overview tests can stage all three secret
// locations without going through their respective write handlers.
func setAgentJSONBForTest(t *testing.T, agentID, column, raw string) {
	t.Helper()
	// column is a fixed test-controlled literal (mcp_config / runtime_config),
	// never user input — safe to interpolate.
	if _, err := testPool.Exec(context.Background(),
		"UPDATE agent SET "+column+" = $1 WHERE id = $2", []byte(raw), agentID); err != nil {
		t.Fatalf("set agent %s: %v", column, err)
	}
}

// TestListWorkspaceEnv_ReturnsKeyNamesWithoutValues is the core contract:
// the overview lists configured secret NAMES per agent across all three
// locations (custom_env, mcp_config[*].env, runtime gateway token), and a
// plaintext value from ANY of them never appears on the wire.
func TestListWorkspaceEnv_ReturnsKeyNamesWithoutValues(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "Env Overview Agent", nil)
	const (
		customSecret = "sk-super-secret-value-xyz"
		mcpSecret    = "tvly-mcp-secret-value-abc"
		gwSecret     = "gateway-token-secret-def"
	)
	setAgentCustomEnvForTest(t, agentID, map[string]string{
		"OPENAI_API_KEY":    customSecret,
		"ANTHROPIC_API_KEY": "sk-anthropic-zzz",
	})
	setAgentJSONBForTest(t, agentID, "mcp_config",
		`{"mcpServers":{"tavily":{"command":"tavily-mcp","env":{"TAVILY_API_KEY":"`+mcpSecret+`"}}}}`)
	setAgentJSONBForTest(t, agentID, "runtime_config",
		`{"gateway":{"host":"gw.internal","token":"`+gwSecret+`"}}`)

	w := httptest.NewRecorder()
	testHandler.ListWorkspaceEnv(w, newRequest("GET", "/api/env", nil))
	if w.Code != 200 {
		t.Fatalf("ListWorkspaceEnv: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// No plaintext value from ANY secret location may reach the client.
	for _, secret := range []string{customSecret, mcpSecret, gwSecret} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("ListWorkspaceEnv leaked a plaintext value (%q) into the response body", secret)
		}
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
		if want := []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY"}; !reflect.DeepEqual(g.Keys, want) {
			t.Fatalf("custom_env keys: got %v, want %v (sorted, names only)", g.Keys, want)
		}
		if len(g.McpServers) != 1 || g.McpServers[0].Name != "tavily" ||
			!reflect.DeepEqual(g.McpServers[0].Keys, []string{"TAVILY_API_KEY"}) {
			t.Fatalf("mcp_servers: got %+v, want one 'tavily' server with [TAVILY_API_KEY]", g.McpServers)
		}
		if !g.GatewayToken {
			t.Fatalf("gateway_token: expected true when runtime_config.gateway.token is set")
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

// TestMcpServerEnvKeys covers both accepted mcp_config shapes, the
// value-omission invariant, and graceful handling of malformed/empty
// input. No DB.
func TestMcpServerEnvKeys(t *testing.T) {
	t.Parallel()

	t.Run("claude-style env block, names only, sorted", func(t *testing.T) {
		out := mcpServerEnvKeys([]byte(
			`{"mcpServers":{"tavily":{"command":"tavily-mcp","env":{"Z_KEY":"secret-z","A_KEY":"secret-a"}}}}`))
		if len(out) != 1 || out[0].Name != "tavily" {
			t.Fatalf("got %+v, want one 'tavily' server", out)
		}
		if want := []string{"A_KEY", "Z_KEY"}; !reflect.DeepEqual(out[0].Keys, want) {
			t.Fatalf("keys: got %v, want %v (sorted names)", out[0].Keys, want)
		}
	})

	t.Run("opencode-native environment block", func(t *testing.T) {
		out := mcpServerEnvKeys([]byte(
			`{"mcp":{"brave":{"type":"local","command":["brave-mcp"],"environment":{"BRAVE_API_KEY":"x"}}}}`))
		if len(out) != 1 || out[0].Name != "brave" ||
			!reflect.DeepEqual(out[0].Keys, []string{"BRAVE_API_KEY"}) {
			t.Fatalf("got %+v, want one 'brave' server with [BRAVE_API_KEY]", out)
		}
	})

	t.Run("servers without env are omitted; multiple sorted by name", func(t *testing.T) {
		out := mcpServerEnvKeys([]byte(
			`{"mcpServers":{"no-secrets":{"command":"x"},"zeta":{"command":"z","env":{"K":"1"}},"alpha":{"command":"a","env":{"K":"1"}}}}`))
		if len(out) != 2 || out[0].Name != "alpha" || out[1].Name != "zeta" {
			t.Fatalf("got %+v, want [alpha, zeta] (env-less server omitted, sorted)", out)
		}
	})

	t.Run("non-string env values still yield clean key names", func(t *testing.T) {
		out := mcpServerEnvKeys([]byte(`{"mcpServers":{"s":{"env":{"PORT":8080,"FLAG":true}}}}`))
		if len(out) != 1 || !reflect.DeepEqual(out[0].Keys, []string{"FLAG", "PORT"}) {
			t.Fatalf("got %+v, want one server with [FLAG, PORT]", out)
		}
	})

	t.Run("null and empty env blocks are omitted; only configured server appears", func(t *testing.T) {
		// `env: null` and `env: {}` both unmarshal to a zero-length map and
		// must be skipped, while a sibling server with real keys still shows.
		out := mcpServerEnvKeys([]byte(
			`{"mcpServers":{"nullenv":{"env":null},"emptyenv":{"env":{}},"real":{"env":{"K":"v"}}}}`))
		if len(out) != 1 || out[0].Name != "real" {
			t.Fatalf("got %+v, want only the 'real' server", out)
		}
		// Same for the OpenCode `environment: null` shape.
		if out := mcpServerEnvKeys([]byte(`{"mcp":{"s":{"type":"local","environment":null}}}`)); out != nil {
			t.Fatalf("environment:null: got %+v, want nil", out)
		}
	})

	t.Run("empty and malformed degrade to nil", func(t *testing.T) {
		if out := mcpServerEnvKeys(nil); out != nil {
			t.Fatalf("nil config: got %+v, want nil", out)
		}
		if out := mcpServerEnvKeys([]byte(`{}`)); out != nil {
			t.Fatalf("empty config: got %+v, want nil", out)
		}
		if out := mcpServerEnvKeys([]byte(`not json`)); out != nil {
			t.Fatalf("malformed config: got %+v, want nil", out)
		}
	})
}

// TestHasGatewayToken checks presence detection without ever reading the
// token value.
func TestHasGatewayToken(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"token set", `{"gateway":{"host":"h","token":"real-secret"}}`, true},
		{"empty token", `{"gateway":{"host":"h","token":""}}`, false},
		{"no token key", `{"gateway":{"host":"h"}}`, false},
		{"no gateway", `{"mode":"direct"}`, false},
		{"empty config", `{}`, false},
		{"malformed", `nope`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasGatewayToken([]byte(tc.raw)); got != tc.want {
				t.Fatalf("hasGatewayToken(%s): got %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
	if hasGatewayToken(nil) {
		t.Fatalf("hasGatewayToken(nil): got true, want false")
	}
}
