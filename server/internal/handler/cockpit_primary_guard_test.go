package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// The compat primary endpoint now reads and writes issue.work_item_id. Editing
// the module away clears the filing (I3) instead of being refused, and naming
// the work item again restores the derived scope. The creation receipt still
// outlives the issue so a replayed creation key stays idempotent.
func TestCockpitPrimaryFilingFollowsWorkItem(t *testing.T) {
	ws, _, _, node := cockpitActionHTTPFixture(t)
	key := uuid.NewString()
	create := map[string]any{"creation_key": key, "title": "Filed L3 task"}
	var issue service.CockpitIssueSummary
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNodeTask), testutil.WithURLParams(cockpitRequest("POST", "/tasks", ws, create), "id", node.ID)).Want(http.StatusOK).JSON(&issue)
	if issue.ProjectID == nil || issue.ModuleID == nil || issue.PrimaryNodeID == nil || *issue.PrimaryNodeID != node.ID {
		t.Fatalf("fixture issue is not filed under the work item: %+v", issue)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2 AND node_id IS NULL", ws, issue.ID) != 1 {
		t.Fatal("creation receipt still names a node instead of leaving the filing on issue.work_item_id")
	}

	// A module move without a work item clears the filing rather than 409ing.
	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/issues/"+issue.ID, ws, map[string]any{"module_id": nil}), "id", issue.ID,
	)).Want(http.StatusOK)
	var cleared service.CockpitPrimaryView
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitIssuePrimaryNode), testutil.WithURLParams(
		cockpitRequest(http.MethodGet, "/primary", ws, nil), "issueId", issue.ID,
	)).Want(http.StatusOK).JSON(&cleared)
	if cleared.NodeID != nil {
		t.Fatalf("module move kept the work item: %+v", cleared)
	}

	// Naming the work item re-files it and derives module/project again.
	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/issues/"+issue.ID, ws, map[string]any{"work_item_id": node.ID}), "id", issue.ID,
	)).Want(http.StatusOK)
	var refiled service.CockpitPrimaryView
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitIssuePrimaryNode), testutil.WithURLParams(
		cockpitRequest(http.MethodGet, "/primary", ws, nil), "issueId", issue.ID,
	)).Want(http.StatusOK).JSON(&refiled)
	if refiled.NodeID == nil || *refiled.NodeID != node.ID || refiled.ModuleID == nil || *refiled.ModuleID != *issue.ModuleID {
		t.Fatalf("re-file did not restore the derived scope: %+v", refiled)
	}

	// Deleting the issue keeps the receipt; replaying the key stays refused.
	testutil.Call(t, cockpitHandler(testHandler.DeleteIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodDelete, "/issues/"+issue.ID, ws, nil), "id", issue.ID,
	)).Want(http.StatusNoContent)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNodeTask), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/tasks", ws, create), "id", node.ID,
	)).Want(http.StatusConflict)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND creation_key=$2 AND issue_deleted_at IS NOT NULL", ws, key) != 1 {
		t.Fatal("HTTP deletion discarded the creation-key receipt")
	}
}
