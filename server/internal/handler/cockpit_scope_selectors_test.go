package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitScopeSelectorHTTPBoundary(t *testing.T) {
	ws := cockpitFixture(t, "Selector HTTP")
	var members service.CockpitMemberChoicePage
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitScopeMembers), cockpitRequest(http.MethodGet, "/api/cockpit/scopes/members?ids="+testUserID, ws, nil)).Want(200).JSON(&members)
	if len(members.Items) != 1 || members.Items[0].ID != testUserID || members.WorkspaceID != ws || len(members.Scope.IDs) != 1 {
		t.Fatalf("selected member scope not acknowledged: %+v", members)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("readonly picker initialized the board")
	}
	project := dbfx.Project(t, "Selector project", testutil.Cols{"workspace_id": ws})
	module := dbfx.Module(t, project, "Selector module", testutil.Cols{"workspace_id": ws})
	root := createNode(t, ws, map[string]any{"code": "Module root", "module_id": module})
	leaf := createNode(t, ws, map[string]any{"code": "No inferred mapping", "name": "Explicit execution", "parent_id": root.ID})
	var nodes service.CockpitNodeChoicePage
	path := "/api/cockpit/scopes/nodes?project_id=" + project + "&module_id=" + module + "&eligible=true&page_size=1"
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitScopeNodes), cockpitRequest(http.MethodGet, path, ws, nil)).Want(200).JSON(&nodes)
	if len(nodes.Items) != 1 || nodes.Items[0].ID != leaf.ID || !nodes.Items[0].Eligible || nodes.Total != 1 || nodes.NextCursor != nil {
		t.Fatalf("handler lost explicit scope or leaf eligibility: %+v", nodes)
	}
	for _, invalid := range []string{"?eligible=maybe", "?page_size=101", "?project_id=bad-id", "?module_id=" + module} {
		testutil.Call(t, cockpitHandler(testHandler.ListCockpitScopeNodes), cockpitRequest(http.MethodGet, "/api/cockpit/scopes/nodes"+invalid, ws, nil)).Want(400)
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitScopeMembers), cockpitRequest(http.MethodGet, "/api/cockpit/scopes/members?ids="+testUserID+"&q=other", ws, nil)).Want(400)
	outsider := dbfx.User(t, "Outside selector scope", "selector-outsider-"+uuid.NewString()+"@example.com")
	req := cockpitRequest(http.MethodGet, "/api/cockpit/scopes/members", ws, nil)
	req.Header.Set("X-User-ID", outsider)
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitScopeMembers), req).Want(404)
}
