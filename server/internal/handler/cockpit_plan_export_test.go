package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitPlanExportHTTPEmptyAndScope(t *testing.T) {
	ws := cockpitMeetingFixture(t, "export readonly")
	var out service.CockpitPlanExport
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitPlanExport), cockpitRequest(http.MethodGet, "/api/cockpit/plan/export-data", ws, nil)).Want(200).JSON(&out)
	if out.WorkspaceID != ws || out.Cockpit != nil || !out.Complete || out.IssueLinkTotal != 0 || out.IssueLinks == nil || out.GeneratedAt == "" {
		t.Fatalf("empty export is not a complete readonly snapshot: %+v", out)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("export initialized board")
	}
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitPlanExport), cockpitRequest(http.MethodGet, "/api/cockpit/plan/export-data?project_id=invalid", ws, nil)).Want(400)
	other := dbfx.Workspace(t, "Other export", "other-export-scope")
	project := dbfx.Project(t, "Other scope", testutil.Cols{"workspace_id": other})
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitPlanExport), cockpitRequest(http.MethodGet, "/api/cockpit/plan/export-data?project_id="+project, ws, nil)).Want(404)
}
