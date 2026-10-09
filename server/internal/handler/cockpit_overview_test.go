package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitOverviewHTTPReadOnlyEmptyWorkspaceAndInput(t *testing.T) {
	ws := cockpitFixture(t, "Read-only overview")
	var out service.CockpitOverview
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitOverview), cockpitRequest("GET", "/overview?as_of=2026-10-10", ws, nil)).Want(200).JSON(&out)
	if out.WorkspaceID != ws || out.Actor.UserID != testUserID || !out.Actor.IsHuman || out.Board != nil || out.Summary.PrimaryIssues.Total != 0 || out.Attention.Items == nil || out.ExecutionNodes.Items == nil || out.RecentMeetings.Items == nil || out.RecentMeetings.RangeStart != "2026-09-11" {
		t.Fatalf("empty read model: %+v", out)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("overview GET created a board")
	}
	cases := []struct {
		handler http.HandlerFunc
		path    string
		status  int
	}{
		{testHandler.GetCockpitOverview, "/overview", 400},
		{testHandler.GetCockpitOverview, "/overview?as_of=2026-02-30", 400},
		{testHandler.GetCockpitOverview, "/overview?as_of=2026-10-10&project_id=not-uuid", 400},
		{testHandler.GetCockpitOverview, "/overview?as_of=2026-10-10&project_id=" + uuid.NewString(), 404},
		{testHandler.ListCockpitOverviewAttention, "/attention?as_of=2026-10-10&view=unknown", 400},
		{testHandler.ListCockpitOverviewAttention, "/attention?as_of=2026-10-10&kind=made_up", 400},
		{testHandler.ListCockpitOverviewExecution, "/execution?as_of=2026-10-10&page_size=101", 400},
		{testHandler.ListCockpitOverviewMeetings, "/meetings?as_of=2026-10-10&days=0", 400},
	}
	for _, c := range cases {
		testutil.Call(t, cockpitHandler(c.handler), cockpitRequest("GET", c.path, ws, nil)).Want(c.status)
	}
	foreign := dbfx.Workspace(t, "Other overview", "overview-"+uuid.NewString())
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitOverview), cockpitRequest("GET", "/overview?as_of=2026-10-10", foreign, nil)).Want(404)
	project := dbfx.Project(t, "Foreign project", testutil.Cols{"workspace_id": foreign})
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitOverview), cockpitRequest("GET", "/overview?as_of=2026-10-10&project_id="+project, ws, nil)).Want(404)
}
