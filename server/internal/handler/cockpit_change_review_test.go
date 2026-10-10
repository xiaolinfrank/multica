package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func previewCockpitChange(t *testing.T, ws, id string) CockpitChangeReviewPreview {
	t.Helper()
	var out CockpitChangeReviewPreview
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitChangePreview), testutil.WithURLParams(cockpitRequest("GET", "/preview", ws, nil), "changeId", id)).Want(200).JSON(&out)
	return out
}
func applyReviewedChange(t *testing.T, ws string, preview CockpitChangeReviewPreview, status int) *testutil.Response {
	t.Helper()
	req := testutil.WithURLParams(cockpitRequest("POST", "/apply", ws, nil), "changeId", preview.Change.ID)
	req.Header.Set("If-Match", preview.ReviewToken)
	return testutil.Call(t, cockpitHandler(testHandler.ApplyCockpitChange), req).Want(status)
}
func TestCockpitChangeReviewPinsActualValueAndProposal(t *testing.T) {
	ws := cockpitFixture(t, "Reviewed changes")
	node := createNode(t, ws, map[string]any{"code": "L1-01", "name": "Reviewed item", "progress": 40})
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "progress", "new_value": "80"}})
	id := changeID(t, ws)
	original := previewCockpitChange(t, ws, id)
	if original.CurrentValue != "40" || original.Conflict || original.WorkspaceID != ws {
		t.Fatalf("original preview: %+v", original)
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(cockpitRequest("PATCH", "/node", ws, map[string]any{"progress": 50}), "id", node.ID)).Want(200)
	applyReviewedChange(t, ws, original, 409)
	current := previewCockpitChange(t, ws, id)
	if current.CurrentValue != "50" || !current.Conflict {
		t.Fatalf("concurrent edit not made explicit: %+v", current)
	}
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "progress", "new_value": "90"}})
	applyReviewedChange(t, ws, current, 409)
	changed := previewCockpitChange(t, ws, id)
	var accepted CockpitChangeApplyResponse
	applyReviewedChange(t, ws, changed, 200).JSON(&accepted)
	if accepted.Change.OldValue != "50" || accepted.Change.NewValue != "90" || accepted.Node.Progress != 90 {
		t.Fatalf("accepted a value that was not reviewed: %+v", accepted)
	}
	applyReviewedChange(t, ws, changed, 409)
}
func TestCockpitChangeReviewBatchDoesNotInvalidateUnrelatedFields(t *testing.T) {
	ws := cockpitFixture(t, "Reviewed batch")
	node := createNode(t, ws, map[string]any{"code": "L1-01", "progress": 40, "status": "未开始"})
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "progress", "new_value": "80"}, {"node": node.ID, "field": "status", "new_value": "进行中"}})
	previews := []CockpitChangeReviewPreview{}
	for _, change := range listChanges(t, ws) {
		previews = append(previews, previewCockpitChange(t, ws, change.ID))
	}
	if len(previews) != 2 {
		t.Fatal("expected two independent proposals")
	}
	for _, preview := range previews {
		applyReviewedChange(t, ws, preview, 200)
	}
}
func TestCockpitChangeDecisionsRequireHumanEvenWithoutReviewHeader(t *testing.T) {
	ws := cockpitFixture(t, "Human plan review")
	node := createNode(t, ws, map[string]any{"code": "L1-01"})
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "progress", "new_value": "80"}})
	id := changeID(t, ws)
	for _, source := range []string{"task_token", "cloud_pat"} {
		for _, handler := range []http.HandlerFunc{testHandler.ApplyCockpitChange, testHandler.RejectCockpitChange} {
			req := testutil.WithURLParams(cockpitRequest("POST", "/decision", ws, nil), "changeId", id)
			req.Header.Set("X-Actor-Source", source)
			testutil.Call(t, cockpitHandler(handler), req).Want(http.StatusForbidden)
		}
	}
	if got := listChanges(t, ws); len(got) != 1 || got[0].Status != "pending" {
		t.Fatal("machine decided a plan change")
	}
}

func TestCockpitReviewedClearActuallyRemovesText(t *testing.T) {
	ws := cockpitFixture(t, "Clear reviewed text")
	node := createNode(t, ws, map[string]any{"code": "L1-01", "owner": "Previous owner"})
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "owner", "new_value": ""}})
	preview := previewCockpitChange(t, ws, changeID(t, ws))
	var accepted CockpitChangeApplyResponse
	applyReviewedChange(t, ws, preview, 200).JSON(&accepted)
	if accepted.Node.Owner != "" || accepted.Change.OldValue != "Previous owner" || accepted.Change.NewValue != "" {
		t.Fatalf("cleared in audit but not in plan: %+v", accepted)
	}
	board := getBoard(t, ws)
	if len(board.Nodes) != 1 || board.Nodes[0].Owner != "" {
		t.Fatal("clear was not persisted")
	}
}

func TestCockpitChangeReviewRejectsMovedAncestorContext(t *testing.T) {
	ws := cockpitFixture(t, "Reviewed inherited context")
	projectA := dbfx.Project(t, "Project A", testutil.Cols{"workspace_id": ws})
	projectB := dbfx.Project(t, "Project B", testutil.Cols{"workspace_id": ws})
	rootA := createNode(t, ws, map[string]any{"code": "PA", "project_id": projectA})
	rootB := createNode(t, ws, map[string]any{"code": "PB", "project_id": projectB})
	group := createNode(t, ws, map[string]any{"code": "Group", "parent_id": rootA.ID})
	leaf := createNode(t, ws, map[string]any{"code": "Leaf", "parent_id": group.ID, "progress": 40})
	ingestChanges(t, ws, []map[string]any{{"node": leaf.ID, "field": "progress", "new_value": "80"}})
	original := previewCockpitChange(t, ws, changeID(t, ws))
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(cockpitRequest("PATCH", "/node", ws, map[string]any{"parent_id": rootB.ID}), "id", group.ID)).Want(200)
	applyReviewedChange(t, ws, original, 409)
	refreshed := previewCockpitChange(t, ws, original.Change.ID)
	if refreshed.Context.ProjectID == nil || *refreshed.Context.ProjectID != projectB || original.Context.ProjectID == nil || *original.Context.ProjectID != projectA {
		t.Fatal("preview did not disclose actual inherited project")
	}
	if refreshed.ReviewToken == original.ReviewToken {
		t.Fatal("moving an ancestor left the review's inherited project unchanged")
	}
	var applied CockpitChangeApplyResponse
	applyReviewedChange(t, ws, refreshed, 200).JSON(&applied)
	if applied.Node.Progress != 80 || applied.Node.ParentID == nil || *applied.Node.ParentID != group.ID {
		t.Fatal("reviewed identity was not preserved")
	}
}

func TestCockpitReviewDoesNotSilentlyRoundBudget(t *testing.T) {
	ws := cockpitFixture(t, "Reviewed numeric precision")
	node := createNode(t, ws, map[string]any{"code": "L1-01", "budget_amount": 1})
	for _, value := range []string{"0.00001", "1e10"} {
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitChange), cockpitRequest("POST", "/changes", ws, map[string]any{"node": node.ID, "field": "budget_amount", "new_value": value})).Want(400)
	}
	ingestChanges(t, ws, []map[string]any{{"node": node.ID, "field": "budget_amount", "new_value": "1.2345"}})
	var applied CockpitChangeApplyResponse
	applyReviewedChange(t, ws, previewCockpitChange(t, ws, changeID(t, ws)), 200).JSON(&applied)
	if applied.Node.BudgetAmount == nil || *applied.Node.BudgetAmount != 1.2345 || applied.Change.NewValue != "1.2345" {
		t.Fatalf("persisted an unreviewed budget amount: %+v", applied)
	}
}
