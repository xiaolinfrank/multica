package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// setWorkspaceSharedEnvForTest overwrites the shared workspace fixture's
// shared_env JSONB directly and resets it to '{}' on cleanup, so a value
// staged by one test can never leak into another (notably the
// value-omission assertions in agent_env_test.go). Tests that mutate it must
// not run in parallel — they share testWorkspaceID.
func setWorkspaceSharedEnvForTest(t *testing.T, env map[string]string) {
	t.Helper()
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal shared_env: %v", err)
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE workspace SET shared_env = $1 WHERE id = $2`, raw, testWorkspaceID); err != nil {
		t.Fatalf("set workspace shared_env: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(),
			`UPDATE workspace SET shared_env = '{}' WHERE id = $1`, testWorkspaceID)
	})
}

// TestGetWorkspaceSharedEnv_RevealsValuesForAdmin confirms the reveal
// endpoint returns plaintext values to an owner/admin (it is the audited
// reveal path, unlike the names-only overview).
func TestGetWorkspaceSharedEnv_RevealsValuesForAdmin(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	const shared = "tvly-shared-secret-123"
	setWorkspaceSharedEnvForTest(t, map[string]string{"TAVILY_API_KEY": shared, "SHARED_FLAG": "on"})

	w := httptest.NewRecorder()
	testHandler.GetWorkspaceSharedEnv(w, newRequest("GET", "/api/env/shared", nil))
	if w.Code != 200 {
		t.Fatalf("GetWorkspaceSharedEnv: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceSharedEnvResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp.SharedEnv["TAVILY_API_KEY"] != shared || resp.SharedEnv["SHARED_FLAG"] != "on" {
		t.Fatalf("reveal must return plaintext values, got %+v", resp.SharedEnv)
	}
}

// TestGetWorkspaceSharedEnv_ForbidsNonAdminMember confirms the owner/admin
// gate on the reveal endpoint.
func TestGetWorkspaceSharedEnv_ForbidsNonAdminMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	memberID := insertWorkspaceMemberForTest(t, "ws-env-plain-member@multica.test", "member")

	w := httptest.NewRecorder()
	testHandler.GetWorkspaceSharedEnv(w, newRequestAs(memberID, "GET", "/api/env/shared", nil))
	if w.Code != 403 {
		t.Fatalf("GetWorkspaceSharedEnv as plain member: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// TestGetWorkspaceSharedEnv_ForbidsAgentActor confirms an agent-token actor
// cannot reveal the workspace's shared secrets, even when its backing member
// is the owner. Mirrors the per-agent lateral-movement guard (MUL-2600).
func TestGetWorkspaceSharedEnv_ForbidsAgentActor(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "WS Env Actor Agent", nil)
	taskID := createHandlerTestTaskForAgent(t, agentID)

	req := newRequest("GET", "/api/env/shared", nil)
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)

	w := httptest.NewRecorder()
	testHandler.GetWorkspaceSharedEnv(w, req)
	if w.Code != 403 {
		t.Fatalf("GetWorkspaceSharedEnv as agent actor: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// TestUpdateWorkspaceSharedEnv_PersistsAndHonorsSentinel exercises the write
// path end-to-end: a new key is added, a changed key is written, and the ****
// sentinel preserves an existing value instead of clobbering it with the mask.
func TestUpdateWorkspaceSharedEnv_PersistsAndHonorsSentinel(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	const keep = "keep-this-secret"
	setWorkspaceSharedEnvForTest(t, map[string]string{"KEEP": keep, "CHANGE": "old"})

	w := httptest.NewRecorder()
	testHandler.UpdateWorkspaceSharedEnv(w, newRequest("PUT", "/api/env/shared", UpdateWorkspaceSharedEnvRequest{SharedEnv: map[string]string{
		"KEEP":   envSentinel, // preserve existing value
		"CHANGE": "new",       // overwrite
		"ADD":    "added",     // new key
	}}))
	if w.Code != 200 {
		t.Fatalf("UpdateWorkspaceSharedEnv: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceSharedEnvResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	want := map[string]string{"KEEP": keep, "CHANGE": "new", "ADD": "added"}
	if !reflect.DeepEqual(resp.SharedEnv, want) {
		t.Fatalf("merged shared_env: got %+v, want %+v", resp.SharedEnv, want)
	}

	// Re-read to confirm it persisted (and the sentinel didn't write "****").
	w2 := httptest.NewRecorder()
	testHandler.GetWorkspaceSharedEnv(w2, newRequest("GET", "/api/env/shared", nil))
	var reread WorkspaceSharedEnvResponse
	json.Unmarshal(w2.Body.Bytes(), &reread)
	if !reflect.DeepEqual(reread.SharedEnv, want) {
		t.Fatalf("persisted shared_env: got %+v, want %+v", reread.SharedEnv, want)
	}
}

// TestUpdateWorkspaceSharedEnv_ForbidsAgentActor confirms an agent-token
// actor cannot write the workspace shared env.
func TestUpdateWorkspaceSharedEnv_ForbidsAgentActor(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	agentID := createHandlerTestAgent(t, "WS Env Write Actor", nil)
	taskID := createHandlerTestTaskForAgent(t, agentID)

	req := newRequest("PUT", "/api/env/shared", UpdateWorkspaceSharedEnvRequest{SharedEnv: map[string]string{"X": "y"}})
	req.Header.Set("X-Agent-ID", agentID)
	req.Header.Set("X-Task-ID", taskID)

	w := httptest.NewRecorder()
	testHandler.UpdateWorkspaceSharedEnv(w, req)
	if w.Code != 403 {
		t.Fatalf("UpdateWorkspaceSharedEnv as agent actor: expected 403, got %d: %s", w.Code, w.Body.String())
	}
}

// TestListWorkspaceEnv_IncludesSharedEnvNames confirms the overview surfaces
// the workspace shared_env KEY NAMES (sorted) and never their values.
func TestListWorkspaceEnv_IncludesSharedEnvNames(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	const shared = "shared-plaintext-should-not-leak"
	setWorkspaceSharedEnvForTest(t, map[string]string{"Z_SHARED": shared, "A_SHARED": "v"})

	w := httptest.NewRecorder()
	testHandler.ListWorkspaceEnv(w, newRequest("GET", "/api/env", nil))
	if w.Code != 200 {
		t.Fatalf("ListWorkspaceEnv: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), shared) {
		t.Fatalf("overview leaked a shared_env plaintext value into the response body")
	}

	var resp WorkspaceEnvListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if want := []string{"A_SHARED", "Z_SHARED"}; !reflect.DeepEqual(resp.SharedEnv, want) {
		t.Fatalf("shared_env names: got %v, want %v (sorted, names only)", resp.SharedEnv, want)
	}
}
