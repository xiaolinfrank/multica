package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestIssueOperationBasisHTTPBoundedScopedRead(t *testing.T) {
	f := newArtifactHTTPFixture(t)
	a := f.create(t)
	v := f.submit(t, a)
	other := cockpitMeetingFixture(t, "Private other tenant")
	foreign := dbfx.Issue(t, "Never leak this title", testutil.Cols{"workspace_id": other})
	var page service.IssueOperationBasisPage
	f.call(t, f.h.ReadIssueOperationBasis, http.MethodPost, "/operation-basis", map[string]any{"issue_ids": []string{v.Version.Version.ReviewIssue.ID, foreign, uuid.NewString()}}).Want(200).JSON(&page)
	if page.WorkspaceID != f.ws || page.SchemaVersion != 1 || len(page.Items) != 3 || page.Items[0].Assignee.State != "blocked" {
		t.Fatalf("wrong read receipt: %+v", page)
	}
	for _, row := range page.Items[1:] {
		if row.Availability != "unavailable" || row.IssueRevision != nil || len(row.Targets) != 0 || row.Delete.State != "unknown" {
			t.Fatalf("cross-scope facts leaked or unlocked: %+v", row)
		}
	}
	for _, ids := range [][]string{{}, {f.source, f.source}, {"bad-uuid"}} {
		f.call(t, f.h.ReadIssueOperationBasis, http.MethodPost, "/operation-basis", map[string]any{"issue_ids": ids}).Want(400)
	}
	hundred := make([]string, 101)
	for i := range hundred {
		hundred[i] = uuid.NewString()
	}
	f.call(t, f.h.ReadIssueOperationBasis, http.MethodPost, "/operation-basis", map[string]any{"issue_ids": hundred}).Want(400)
	var node service.ContainerOperationBasis
	f.call(t, f.h.GetNodeOperationBasis, http.MethodGet, "/node/operation-basis", nil, "id", f.node).Want(200).JSON(&node)
	if node.Delete.State != "blocked" || node.StructuralEdit.State != "blocked" || node.AddChild.State != "blocked" {
		t.Fatalf("retained node UI remains unrestricted: %+v", node)
	}
}
func TestIssueOperationBasisReadNeverCreatesBoard(t *testing.T) {
	ws := dbfx.Workspace(t, "Operation basis empty workspace", "basis-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "member")
	h := testHandler
	req := func(fn http.HandlerFunc, path string, body any, params ...string) *testutil.Response {
		return testutil.Call(t, cockpitHandler(fn), testutil.WithURLParams(cockpitRequest("POST", path, ws, body), params...))
	}
	var out service.IssueOperationBasisPage
	req(h.ReadIssueOperationBasis, "/operation-basis", map[string]any{"issue_ids": []string{uuid.NewString()}}).Want(200).JSON(&out)
	if len(out.Items) != 1 || out.Items[0].Availability != "unavailable" {
		t.Fatal(out)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws); n != 0 {
		t.Fatal("read initialized a board")
	}
}
