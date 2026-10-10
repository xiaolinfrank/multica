package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitAssigneeSelectorHTTPBoundary(t *testing.T) {
	ws := cockpitFixture(t, "assignee selector HTTP")
	var out service.CockpitAssigneeChoicePage
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitAssigneeChoices), cockpitRequest(http.MethodGet, "/api/cockpit/scopes/assignees?selected_type=member&selected_id="+testUserID, ws, nil)).Want(200).JSON(&out)
	if out.WorkspaceID != ws || len(out.Items) != 1 || out.Items[0].ID != testUserID || !out.Items[0].CanAssign || out.Items[0].RuntimeBound != nil || out.SelectedType == nil || *out.SelectedType != "member" {
		t.Fatalf("selected actor not acknowledged: %+v", out)
	}
	for _, query := range []string{"?kind=unknown", "?selected_type=member", "?selected_id=bad-uuid", "?page_size=101", "?selected_type=member&selected_id=" + testUserID + "&kind=agent"} {
		testutil.Call(t, cockpitHandler(testHandler.ListCockpitAssigneeChoices), cockpitRequest(http.MethodGet, "/api/cockpit/scopes/assignees"+query, ws, nil)).Want(400)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("assignee selector initialized a board")
	}
}
