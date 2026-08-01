package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Tests for the BayClaw-fork default issue assignee: an issue created without
// an explicit assignee falls back to the workspace's cluster generic agent on
// the configured DefaultIssueAssigneeNode (issue.go CreateIssue). The standard
// trigger rules then apply untouched — "todo" enqueues a run immediately,
// "backlog" parks it.

const defaultAssigneeProbeNode = "probe-default-node"

// defaultAssigneeProbeAgentName is the new-scheme name for the probe node
// ("通用智能体（probe-default-node）" — neither the API host nor a numbered
// fleet node, so the generic fallback shape applies).
var defaultAssigneeProbeAgentName = clusterAgentNameForNode(defaultAssigneeProbeNode)

const defaultAssigneeProbeDeviceInfo = defaultAssigneeProbeNode + " · 1.0.0 (Claude Code)"

func setDefaultIssueAssigneeNode(t *testing.T, node string) {
	t.Helper()
	prev := testHandler.cfg.DefaultIssueAssigneeNode
	testHandler.cfg.DefaultIssueAssigneeNode = node
	t.Cleanup(func() { testHandler.cfg.DefaultIssueAssigneeNode = prev })
}

// provisionDefaultAssigneeAgent builds the cluster generic agent for the probe
// node inside testWorkspaceID through the production ensure path, so the
// fixture has the real shape (public_to + workspace invocation target).
// Returns the agent id; agent, invocation targets, and runtime are removed on
// cleanup.
func provisionDefaultAssigneeAgent(t *testing.T) string {
	t.Helper()
	ownerID := insertClusterProbeUser(t, clusterProbePrefix+"-defassign-runner@test.local")
	runtimeID := insertClusterProbeRuntime(t, testWorkspaceID, ownerID, "claude", defaultAssigneeProbeDeviceInfo)
	rt := clusterProbeRuntime(t, testWorkspaceID, runtimeID, ownerID, "claude", defaultAssigneeProbeDeviceInfo)
	testHandler.ensureClusterGenericAgent(rt)

	var agentID string
	if err := testPool.QueryRow(context.Background(), `
		SELECT id::text FROM agent WHERE workspace_id = $1 AND name = $2
	`, testWorkspaceID, defaultAssigneeProbeAgentName).Scan(&agentID); err != nil {
		t.Fatalf("provision default assignee agent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE agent_id = $1`, agentID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent_invocation_target WHERE agent_id = $1`, agentID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent WHERE id = $1`, agentID)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM agent_runtime WHERE id = $1`, runtimeID)
	})
	return agentID
}

func createIssueViaHandler(t *testing.T, body map[string]any) IssueResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode created issue: %v", err)
	}
	t.Cleanup(func() {
		cleanupReq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", created.ID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})
	return created
}

func countQueuedTasksForIssue(t *testing.T, issueID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `
		SELECT count(*) FROM agent_task_queue WHERE issue_id = $1
	`, issueID).Scan(&n); err != nil {
		t.Fatalf("count queued tasks: %v", err)
	}
	return n
}

func TestCreateIssueDefaultAssigneeAppliedWhenUnassigned(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	setDefaultIssueAssigneeNode(t, defaultAssigneeProbeNode)
	agentID := provisionDefaultAssigneeAgent(t)

	created := createIssueViaHandler(t, map[string]any{"title": "unassigned issue falls back to cluster agent"})
	if created.AssigneeType == nil || *created.AssigneeType != "agent" {
		t.Fatalf("assignee_type = %v, want agent", created.AssigneeType)
	}
	if created.AssigneeID == nil || *created.AssigneeID != agentID {
		t.Fatalf("assignee_id = %v, want %s", created.AssigneeID, agentID)
	}
	// Default status is "todo", so the assignment must have enqueued a run.
	if n := countQueuedTasksForIssue(t, created.ID); n != 1 {
		t.Fatalf("queued tasks for issue = %d, want 1 (immediate dispatch)", n)
	}
}

func TestCreateIssueDefaultAssigneeRespectsExplicitAssignee(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	setDefaultIssueAssigneeNode(t, defaultAssigneeProbeNode)
	provisionDefaultAssigneeAgent(t)

	created := createIssueViaHandler(t, map[string]any{
		"title":         "explicit assignee wins",
		"assignee_type": "member",
		"assignee_id":   testUserID,
	})
	if created.AssigneeType == nil || *created.AssigneeType != "member" {
		t.Fatalf("assignee_type = %v, want member (explicit assignee must win)", created.AssigneeType)
	}
	if created.AssigneeID == nil || *created.AssigneeID != testUserID {
		t.Fatalf("assignee_id = %v, want %s", created.AssigneeID, testUserID)
	}
}

func TestCreateIssueDefaultAssigneeDisabledWhenNodeEmpty(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	setDefaultIssueAssigneeNode(t, "")

	created := createIssueViaHandler(t, map[string]any{"title": "feature off stays unassigned"})
	if created.AssigneeType != nil || created.AssigneeID != nil {
		t.Fatalf("assignee = (%v, %v), want unassigned when feature is off", created.AssigneeType, created.AssigneeID)
	}
}

func TestCreateIssueDefaultAssigneeSkipsWhenAgentMissing(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	// Node configured but no such agent in this workspace: the fallback must
	// silently leave the issue unassigned rather than fail the create.
	setDefaultIssueAssigneeNode(t, "probe-node-not-provisioned")

	created := createIssueViaHandler(t, map[string]any{"title": "no cluster agent here"})
	if created.AssigneeType != nil || created.AssigneeID != nil {
		t.Fatalf("assignee = (%v, %v), want unassigned when agent is absent", created.AssigneeType, created.AssigneeID)
	}
}

func TestCreateIssueDefaultAssigneeBacklogParksRun(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	setDefaultIssueAssigneeNode(t, defaultAssigneeProbeNode)
	agentID := provisionDefaultAssigneeAgent(t)

	created := createIssueViaHandler(t, map[string]any{
		"title":  "backlog issue is assigned but not dispatched",
		"status": "backlog",
	})
	if created.AssigneeID == nil || *created.AssigneeID != agentID {
		t.Fatalf("assignee_id = %v, want %s", created.AssigneeID, agentID)
	}
	if n := countQueuedTasksForIssue(t, created.ID); n != 0 {
		t.Fatalf("queued tasks for backlog issue = %d, want 0 (backlog parks the run)", n)
	}
}
