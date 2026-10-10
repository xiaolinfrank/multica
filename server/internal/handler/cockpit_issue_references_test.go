package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitIssueReferencesHTTPReadDoesNotInitializeBoard(t *testing.T) {
	ws := cockpitFixture(t, "Reverse links HTTP")
	issue := dbfx.Issue(t, "No cockpit needed", testutil.Cols{"workspace_id": ws})
	var out service.CockpitIssueReferencePage[service.CockpitIssueNodeReference]
	call := func(fn http.HandlerFunc, issueID, path string) *testutil.Response {
		return testutil.Call(t, cockpitHandler(fn), testutil.WithURLParams(cockpitRequest(http.MethodGet, path, ws, nil), "issueId", issueID))
	}
	call(testHandler.ListCockpitIssueNodeReferences, issue, "/api/cockpit/issues/"+issue+"/nodes").Want(200).JSON(&out)
	if out.WorkspaceID != ws || out.IssueID != issue || out.Items == nil || out.Total != 0 {
		t.Fatalf("invalid empty receipt: %+v", out)
	}
	call(testHandler.GetCockpitIssuePrimaryNode, issue, "/primary-node").Want(200)
	call(testHandler.ListCockpitIssueActionSources, issue, "/actions").Want(200)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("reverse read initialized cockpit")
	}

	target := uuid.NewString()
	dbfx.InsertNoID(t, "cockpit_node_issue", testutil.Cols{"workspace_id": ws, "issue_id": issue, "node_id": target}, "workspace_id=$1 AND issue_id=$2 AND node_id=$3", ws, issue, target)
	var receipt service.CockpitIssueReferenceRemoval
	removal := testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/nodes/"+target, ws, nil), "issueId", issue, "nodeId", target)
	testutil.Call(t, cockpitHandler(testHandler.RemoveCockpitIssueNodeReference), removal).Want(200).JSON(&receipt)
	if !receipt.Removed || receipt.IssueID != issue || receipt.WorkspaceID != ws || receipt.TargetID != target || receipt.Kind != "node" {
		t.Fatalf("cleanup receipt: %+v", receipt)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("orphan cleanup initialized cockpit")
	}
	testutil.Call(t, cockpitHandler(testHandler.RemoveCockpitIssueNodeReference), removal).Want(404)
	bad := testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/nodes/invalid", ws, nil), "issueId", issue, "nodeId", "invalid")
	testutil.Call(t, cockpitHandler(testHandler.RemoveCockpitIssueNodeReference), bad).Want(400)
	call(testHandler.ListCockpitIssueNodeReferences, issue, "/nodes?page_size=101").Want(400)
	call(testHandler.ListCockpitIssueMeetingReferences, issue, "/meetings?cursor=invalid").Want(400)
	other := cockpitFixture(t, "Other reverse tenant")
	foreign := dbfx.Issue(t, "Foreign issue", testutil.Cols{"workspace_id": other})
	call(testHandler.ListCockpitIssueNodeReferences, foreign, "/nodes").Want(404)
	outsider := dbfx.User(t, "Outside reverse links", "reverse-"+uuid.NewString()+"@example.test")
	req := testutil.WithURLParams(cockpitRequest(http.MethodGet, "/nodes", ws, nil), "issueId", issue)
	req.Header.Set("X-User-ID", outsider)
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitIssueNodeReferences), req).Want(404)
}
