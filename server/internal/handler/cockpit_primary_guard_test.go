package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitPrimaryOldMutationPathsRespectOwnership(t *testing.T) {
	ws, _, _, node := cockpitActionHTTPFixture(t)
	key := uuid.NewString()
	create := map[string]any{"creation_key": key, "title": "Guarded L3 task"}
	var issue service.CockpitIssueSummary
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNodeTask), testutil.WithURLParams(cockpitRequest("POST", "/tasks", ws, create), "id", node.ID)).Want(200).JSON(&issue)
	if issue.ProjectID == nil || issue.ModuleID == nil || issue.PrimaryNodeID == nil {
		t.Fatal("fixture issue is not filed under the mapped execution leaf")
	}
	call := func(handler http.HandlerFunc, method, path string, body any, key, id string, status int) {
		t.Helper()
		req := cockpitRequest(method, path, ws, body)
		if key != "" {
			req = testutil.WithURLParams(req, key, id)
		}
		testutil.Call(t, cockpitHandler(handler), req).Want(status)
	}
	t.Run("ordinary scope edit", func(t *testing.T) {
		call(testHandler.UpdateIssue, "PUT", "/issues/"+issue.ID, map[string]any{"module_id": nil}, "id", issue.ID, 409)
	})
	t.Run("batch scope edit", func(t *testing.T) {
		call(testHandler.BatchUpdateIssues, "PUT", "/issues/batch", map[string]any{"issue_ids": []string{issue.ID}, "updates": map[string]any{"project_id": nil, "module_id": nil}}, "", "", 409)
	})
	t.Run("node reparent", func(t *testing.T) {
		call(testHandler.UpdateCockpitNode, "PATCH", "/nodes/"+node.ID, map[string]any{"parent_id": nil}, "id", node.ID, 409)
	})
	t.Run("leaf cannot become grouping", func(t *testing.T) {
		call(testHandler.CreateCockpitNode, "POST", "/nodes", map[string]any{"code": "blocked-child", "name": "Blocked child", "parent_id": node.ID}, "", "", 409)
	})
	t.Run("node delete", func(t *testing.T) {
		call(testHandler.DeleteCockpitNode, "DELETE", "/nodes/"+node.ID, nil, "id", node.ID, 409)
	})
	t.Run("project delete", func(t *testing.T) {
		call(testHandler.DeleteProject, "DELETE", "/projects/"+*issue.ProjectID, nil, "id", *issue.ProjectID, 409)
	})
	t.Run("module delete", func(t *testing.T) {
		call(testHandler.DeleteModule, "DELETE", "/modules/"+*issue.ModuleID, nil, "id", *issue.ModuleID, 409)
	})
	t.Run("ordinary progress remains editable", func(t *testing.T) {
		call(testHandler.UpdateCockpitNode, "PATCH", "/nodes/"+node.ID, map[string]any{"progress": 40}, "id", node.ID, 200)
	})
	var ownership service.CockpitPrimaryView
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitIssuePrimaryNode), testutil.WithURLParams(cockpitRequest("GET", "/primary", ws, nil), "issueId", issue.ID)).Want(200).JSON(&ownership)
	if ownership.NodeID == nil || *ownership.NodeID != node.ID || ownership.ModuleID == nil || *ownership.ModuleID != *issue.ModuleID {
		t.Fatal("a refused mutation changed ownership or issue scope")
	}
	call(testHandler.SetCockpitIssuePrimaryNode, "PUT", "/primary", map[string]any{"expected_revision": ownership.Revision, "node_id": nil}, "issueId", issue.ID, 200)
	call(testHandler.UpdateIssue, "PUT", "/issues/"+issue.ID, map[string]any{"module_id": nil}, "id", issue.ID, 200)
	call(testHandler.DeleteIssue, "DELETE", "/issues/"+issue.ID, nil, "id", issue.ID, 204)
	call(testHandler.CreateCockpitNodeTask, "POST", "/tasks", create, "id", node.ID, 409)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND creation_key=$2 AND issue_deleted_at IS NOT NULL", ws, key) != 1 {
		t.Fatal("HTTP deletion discarded the creation-key receipt")
	}
}
