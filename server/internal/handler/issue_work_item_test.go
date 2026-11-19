package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// workItemPlanFixture builds the platform side (project + module) and the
// cockpit side (L1 → L2 → L3) of one plan branch, all bound together the way
// the reconciler leaves them: the module row carries project_id and module_id,
// the work item is a third-level node under it.
type workItemPlan struct {
	projectID string
	moduleID  string
	workItem  string
}

func newWorkItemPlan(t *testing.T, label string) workItemPlan {
	t.Helper()
	suffix := uuid.NewString()
	projectID := dbfx.Project(t, fmt.Sprintf("%s project %s", label, suffix))
	moduleID := dbfx.Module(t, projectID, fmt.Sprintf("%s module %s", label, suffix))
	// One cockpit per workspace (idx_cockpit_workspace), shared by every
	// fixture in this package: reuse it and give each branch its own codes.
	cockpitID := ""
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO cockpit (workspace_id, title) VALUES ($1, 'plan')
		ON CONFLICT (workspace_id) DO UPDATE SET title = cockpit.title
		RETURNING id`, testWorkspaceID).Scan(&cockpitID); err != nil {
		t.Fatalf("ensure cockpit: %v", err)
	}
	branch := "T" + suffix[:8]
	l1 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"code":         branch,
		"name":         "项目",
		"position":     0,
		"project_id":   projectID,
	})
	l2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    l1,
		"code":         branch + ".01",
		"name":         "模块",
		"position":     0,
		"project_id":   projectID,
		"module_id":    moduleID,
	})
	l3 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    l2,
		"code":         branch + ".01.01",
		"name":         "工作项",
		"position":     0,
	})
	return workItemPlan{projectID: projectID, moduleID: moduleID, workItem: l3}
}

func createIssueRequest(t *testing.T, body map[string]any) (*httptest.ResponseRecorder, IssueResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.CreateIssue(w, newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body))
	var issue IssueResponse
	if w.Code == http.StatusCreated {
		if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
			t.Fatalf("decode created issue: %v", err)
		}
	}
	return w, issue
}

// A work item is the third level of the plan tree and the single filing
// authority for an issue: naming it must file the issue into the node's module
// and project without the caller repeating them.
func TestCreateIssueFilesUnderWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "create")

	w, issue := createIssueRequest(t, map[string]any{
		"title":        "work item create " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	if issue.WorkItemID == nil || *issue.WorkItemID != plan.workItem {
		t.Fatalf("work_item_id = %v, want %s", issue.WorkItemID, plan.workItem)
	}
	if issue.ModuleID == nil || *issue.ModuleID != plan.moduleID {
		t.Fatalf("module_id = %v, want %s (derived from the work item)", issue.ModuleID, plan.moduleID)
	}
	if issue.ProjectID == nil || *issue.ProjectID != plan.projectID {
		t.Fatalf("project_id = %v, want %s (derived from the work item)", issue.ProjectID, plan.projectID)
	}

	var storedWorkItem, storedModule string
	if err := testPool.QueryRow(context.Background(),
		`SELECT work_item_id::text, module_id::text FROM issue WHERE id = $1`, issue.ID).
		Scan(&storedWorkItem, &storedModule); err != nil {
		t.Fatalf("read stored issue: %v", err)
	}
	if storedWorkItem != plan.workItem || storedModule != plan.moduleID {
		t.Fatalf("stored work_item/module = %s/%s, want %s/%s", storedWorkItem, storedModule, plan.workItem, plan.moduleID)
	}
}

// A work item names its own module. Pinning a different module in the same
// request is contradictory, and silently picking one side would leave the
// issue filed somewhere the caller did not ask for.
func TestCreateIssueRejectsWorkItemOutsideItsScope(t *testing.T) {
	plan := newWorkItemPlan(t, "scope")
	otherModule := dbfx.Module(t, plan.projectID, "other module "+uuid.NewString())

	w, _ := createIssueRequest(t, map[string]any{
		"title":        "work item scope " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
		"module_id":    otherModule,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("CreateIssue: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// A sub-issue stays where its parent is, one level below the module: it
// inherits the parent's work item, and asking for a different one is refused.
func TestCreateIssueChildInheritsParentWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "child")

	_, parent := createIssueRequest(t, map[string]any{
		"title":        "parent " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, parent.ID) })

	w, child := createIssueRequest(t, map[string]any{
		"title":           "child " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue child: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	t.Cleanup(func() { deleteTestIssue(t, child.ID) })
	if child.WorkItemID == nil || *child.WorkItemID != plan.workItem {
		t.Fatalf("child work_item_id = %v, want %s (inherited)", child.WorkItemID, plan.workItem)
	}

	// A second, unrelated branch: the child may not jump into it.
	other := newWorkItemPlan(t, "other branch")
	w, _ = createIssueRequest(t, map[string]any{
		"title":           "child mismatch " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
		"work_item_id":    other.workItem,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("CreateIssue child mismatch: expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !containsJSONCode(w.Body.Bytes(), errCodeChildWorkItemMismatch) {
		t.Fatalf("expected %s code, got %s", errCodeChildWorkItemMismatch, w.Body.String())
	}
}

// Update follows the module rule: naming a work item re-files the issue into
// it, and moving the issue to another module drops a work item that no longer
// matches instead of leaving an inconsistent filing behind.
func TestUpdateIssueWorkItemRefilesAndClears(t *testing.T) {
	plan := newWorkItemPlan(t, "update")
	otherModule := dbfx.Module(t, plan.projectID, "update other module "+uuid.NewString())

	_, issue := createIssueRequest(t, map[string]any{
		"title":    "update work item " + uuid.NewString(),
		"status":   "todo",
		"priority": "none",
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issue.ID, map[string]any{"work_item_id": plan.workItem})
	req = withURLParam(req, "id", issue.ID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue work item: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var updated IssueResponse
	if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if updated.WorkItemID == nil || *updated.WorkItemID != plan.workItem {
		t.Fatalf("work_item_id = %v, want %s", updated.WorkItemID, plan.workItem)
	}
	if updated.ModuleID == nil || *updated.ModuleID != plan.moduleID {
		t.Fatalf("module_id = %v, want %s (refiled by the work item)", updated.ModuleID, plan.moduleID)
	}

	// Moving the issue into another module must clear the work item: it cannot
	// survive outside its own module.
	w = httptest.NewRecorder()
	req = newRequest("PUT", "/api/issues/"+issue.ID, map[string]any{"module_id": otherModule})
	req = withURLParam(req, "id", issue.ID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue module move: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if err := json.NewDecoder(w.Body).Decode(&updated); err != nil {
		t.Fatalf("decode second update: %v", err)
	}
	if updated.WorkItemID != nil {
		t.Fatalf("work_item_id = %v after moving the issue out of its module, want null", *updated.WorkItemID)
	}
}

// The issue list can be narrowed to one work item, which is what the plan
// tree's drill-in view asks for.
func TestListIssuesFiltersByWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "list")

	_, filed := createIssueRequest(t, map[string]any{
		"title":        "filed " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, filed.ID) })

	_, unfiled := createIssueRequest(t, map[string]any{
		"title":    "unfiled " + uuid.NewString(),
		"status":   "todo",
		"priority": "none",
	})
	t.Cleanup(func() { deleteTestIssue(t, unfiled.ID) })

	w := httptest.NewRecorder()
	testHandler.ListIssues(w, newRequest("GET", "/api/issues?workspace_id="+testWorkspaceID+"&work_item_id="+plan.workItem, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("ListIssues: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Issues []IssueResponse `json:"issues"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(resp.Issues) != 1 {
		t.Fatalf("expected exactly the filed issue, got %d", len(resp.Issues))
	}
	if resp.Issues[0].ID != filed.ID {
		t.Fatalf("listed issue = %s, want %s", resp.Issues[0].ID, filed.ID)
	}
}

func containsJSONCode(body []byte, code string) bool {
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return payload.Code == code
}
