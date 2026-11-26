package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
	projectID := dbfx.Project(t, fmt.Sprintf("%s project %s", label, uuid.NewString()))
	moduleID, workItemID := newWorkItemBranch(t, projectID, label)
	return workItemPlan{projectID: projectID, moduleID: moduleID, workItem: workItemID}
}

// newWorkItemBranch adds another module → work item branch to an existing
// project on the workspace board, so one project can hold several work items.
func newWorkItemBranch(t *testing.T, projectID, label string) (moduleID, workItemID string) {
	t.Helper()
	suffix := uuid.NewString()
	moduleID = dbfx.Module(t, projectID, fmt.Sprintf("%s module %s", label, suffix))
	cockpitID := ensureTestCockpit(t)
	branch := "T" + strings.ReplaceAll(suffix[:8], "-", "")
	// One project root per project (cockpit_node_project_binding_unique), so a
	// second branch in the same project reuses the existing L1 row.
	rootID := ""
	if err := testPool.QueryRow(context.Background(), `
		SELECT COALESCE((
			SELECT id::text FROM cockpit_node
			 WHERE cockpit_id = $1 AND project_id = $2 AND module_id IS NULL AND parent_id IS NULL
			 LIMIT 1
		), '')`, cockpitID, projectID).Scan(&rootID); err != nil {
		t.Fatalf("find project root: %v", err)
	}
	if rootID == "" {
		rootID = dbfx.Insert(t, "cockpit_node", testutil.Cols{
			"workspace_id": testWorkspaceID,
			"cockpit_id":   cockpitID,
			"code":         branch,
			"name":         "项目",
			"position":     0,
			"project_id":   projectID,
		})
	}
	l2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    rootID,
		"code":         branch + ".01",
		"name":         "模块",
		"position":     0,
		"project_id":   projectID,
		"module_id":    moduleID,
	})
	workItemID = dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    l2,
		"code":         branch + ".01.01",
		"name":         "工作项",
		"position":     0,
	})
	return moduleID, workItemID
}

// ensureTestCockpit returns the workspace's single cockpit row, creating it on
// first use. One cockpit per workspace (idx_cockpit_workspace) is shared by
// every fixture in this package; each branch gets its own code prefix.
func ensureTestCockpit(t *testing.T) string {
	t.Helper()
	var cockpitID string
	if err := testPool.QueryRow(context.Background(), `
		INSERT INTO cockpit (workspace_id, title) VALUES ($1, 'plan')
		ON CONFLICT (workspace_id) DO UPDATE SET title = cockpit.title
		RETURNING id`, testWorkspaceID).Scan(&cockpitID); err != nil {
		t.Fatalf("ensure cockpit: %v", err)
	}
	return cockpitID
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

func putIssueRequest(t *testing.T, issueID string, body map[string]any) (*httptest.ResponseRecorder, IssueResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	testHandler.UpdateIssue(w, withURLParam(newRequest("PUT", "/api/issues/"+issueID, body), "id", issueID))
	var issue IssueResponse
	if w.Code == http.StatusOK {
		if err := json.NewDecoder(w.Body).Decode(&issue); err != nil {
			t.Fatalf("decode updated issue: %v", err)
		}
	}
	return w, issue
}

// Re-filing an issue that already has a module must work: the new work item
// names another module of the SAME project, and nothing in the request pins
// the old one. Regression for the conflict check reading the stored module
// off params and refusing every re-file of an already-filed issue.
func TestUpdateIssueWorkItemRefilesWithinProject(t *testing.T) {
	plan := newWorkItemPlan(t, "refile same project")
	otherModule, otherItem := newWorkItemBranch(t, plan.projectID, "refile same project other")

	_, issue := createIssueRequest(t, map[string]any{
		"title":        "refile same project " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w, updated := putIssueRequest(t, issue.ID, map[string]any{"work_item_id": otherItem})
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue re-file: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if updated.WorkItemID == nil || *updated.WorkItemID != otherItem {
		t.Fatalf("work_item_id = %v, want %s", updated.WorkItemID, otherItem)
	}
	if updated.ModuleID == nil || *updated.ModuleID != otherModule {
		t.Fatalf("module_id = %v, want %s (derived from the new work item)", updated.ModuleID, otherModule)
	}
	if updated.ProjectID == nil || *updated.ProjectID != plan.projectID {
		t.Fatalf("project_id = %v, want %s (unchanged)", updated.ProjectID, plan.projectID)
	}
}

// The same re-file across projects: the work item carries its own project, so
// the issue moves with it rather than being refused for "belonging" to the
// project it is about to leave.
func TestUpdateIssueWorkItemRefilesAcrossProjects(t *testing.T) {
	first := newWorkItemPlan(t, "refile cross a")
	second := newWorkItemPlan(t, "refile cross b")

	_, issue := createIssueRequest(t, map[string]any{
		"title":        "refile cross project " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": first.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w, updated := putIssueRequest(t, issue.ID, map[string]any{"work_item_id": second.workItem})
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue cross-project re-file: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if updated.WorkItemID == nil || *updated.WorkItemID != second.workItem {
		t.Fatalf("work_item_id = %v, want %s", updated.WorkItemID, second.workItem)
	}
	if updated.ProjectID == nil || *updated.ProjectID != second.projectID {
		t.Fatalf("project_id = %v, want %s (derived from the new work item)", updated.ProjectID, second.projectID)
	}
	if updated.ModuleID == nil || *updated.ModuleID != second.moduleID {
		t.Fatalf("module_id = %v, want %s (derived from the new work item)", updated.ModuleID, second.moduleID)
	}
}

// The flip side of the two tests above: a module the request actually names
// still has to agree with the work item.
func TestUpdateIssueRejectsNamedModuleOutsideWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "refile conflict")
	otherModule := dbfx.Module(t, plan.projectID, "refile conflict module "+uuid.NewString())

	_, issue := createIssueRequest(t, map[string]any{
		"title":    "refile conflict " + uuid.NewString(),
		"status":   "todo",
		"priority": "none",
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w, _ := putIssueRequest(t, issue.ID, map[string]any{
		"work_item_id": plan.workItem,
		"module_id":    otherModule,
	})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("UpdateIssue conflicting module: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// open_only is an unpaginated scan with its own static query. It must apply
// the same three-parameter work item predicate as the paginated path, or the
// project page's "this work item or its unfiled remainder" view disagrees with
// the list it replaces.
func TestListIssuesOpenOnlyHonoursWorkItemFilters(t *testing.T) {
	plan := newWorkItemPlan(t, "open only")
	other := newWorkItemPlan(t, "open only other")

	_, filed := createIssueRequest(t, map[string]any{
		"title":        "open only filed " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, filed.ID) })
	_, sibling := createIssueRequest(t, map[string]any{
		"title":        "open only sibling " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": other.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, sibling.ID) })
	_, unfiled := createIssueRequest(t, map[string]any{
		"title":    "open only unfiled " + uuid.NewString(),
		"status":   "todo",
		"priority": "none",
	})
	t.Cleanup(func() { deleteTestIssue(t, unfiled.ID) })

	listed := func(query string) map[string]bool {
		t.Helper()
		w := httptest.NewRecorder()
		testHandler.ListIssues(w, newRequest("GET", "/api/issues?workspace_id="+testWorkspaceID+"&open_only=true&"+query, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("ListIssues open_only %s: %d %s", query, w.Code, w.Body.String())
		}
		var resp struct {
			Issues []IssueResponse `json:"issues"`
		}
		if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
			t.Fatalf("decode open_only list: %v", err)
		}
		ids := make(map[string]bool, len(resp.Issues))
		for _, issue := range resp.Issues {
			ids[issue.ID] = true
		}
		return ids
	}

	both := listed("work_item_ids=" + plan.workItem + "," + other.workItem)
	if !both[filed.ID] || !both[sibling.ID] {
		t.Fatalf("work_item_ids must return both filed issues: %v", both)
	}
	if both[unfiled.ID] {
		t.Fatal("work_item_ids must not return an unfiled issue")
	}

	widened := listed("work_item_ids=" + plan.workItem + "&include_no_work_item=true")
	if !widened[filed.ID] || !widened[unfiled.ID] {
		t.Fatalf("ids + include_no_work_item must return the work item and unfiled work: %v", widened)
	}
	if widened[sibling.ID] {
		t.Fatal("include_no_work_item must not widen to a different work item")
	}
}

// Work item groups read in plan-tree order, which is the node's code, and the
// unfiled group comes last.
func TestIssueTableGroupsWorkItemsSortByCode(t *testing.T) {
	plan := newWorkItemPlan(t, "group order")
	secondModule, secondItem := newWorkItemBranch(t, plan.projectID, "group order second")

	for _, item := range []string{plan.workItem, secondItem} {
		_, issue := createIssueRequest(t, map[string]any{
			"title":        "group order " + uuid.NewString(),
			"status":       "todo",
			"priority":     "none",
			"work_item_id": item,
		})
		t.Cleanup(func() { deleteTestIssue(t, issue.ID) })
	}
	_, unfiled := createIssueRequest(t, map[string]any{
		"title":     "group order unfiled " + uuid.NewString(),
		"status":    "todo",
		"priority":  "none",
		"module_id": secondModule,
	})
	t.Cleanup(func() { deleteTestIssue(t, unfiled.ID) })

	var firstCode, secondCode string
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id = $1`, plan.workItem).Scan(&firstCode); err != nil {
		t.Fatalf("read first code: %v", err)
	}
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id = $1`, secondItem).Scan(&secondCode); err != nil {
		t.Fatalf("read second code: %v", err)
	}
	first, second := plan.workItem, secondItem
	if firstCode > secondCode {
		first, second = second, first
	}

	w := httptest.NewRecorder()
	testHandler.ListIssueTableGroups(w, newRequest(http.MethodPost, "/api/issues/table/groups", issueTableGroupsRequest{
		Query: issueTableQuerySpec{
			Scope:   issueTableScope{Kind: "project", ProjectID: plan.projectID},
			Filters: issueTableFiltersRequest{},
			Sort:    issueTableSortRequest{Field: "title", Direction: "asc"},
		},
		Group: issueTableGroupSpec{Kind: "work_item"},
		Page:  issueTablePageRequest{Limit: 100},
	}))
	if w.Code != http.StatusOK {
		t.Fatalf("group work items: %d %s", w.Code, w.Body.String())
	}
	var groups issueTableGroupsResponse
	if err := json.NewDecoder(w.Body).Decode(&groups); err != nil {
		t.Fatalf("decode groups: %v", err)
	}
	want := []string{"work_item:" + first, "work_item:" + second, "work_item:none"}
	if len(groups.Groups) != len(want) {
		t.Fatalf("groups = %+v, want %v", groups.Groups, want)
	}
	for i, key := range want {
		if groups.Groups[i].Key != key {
			t.Fatalf("group %d = %s, want %s (codes %s/%s)", i, groups.Groups[i].Key, key, firstCode, secondCode)
		}
	}
}

// The work item shape is the tree contract, not "has a parent": a fourth-level
// node, or a third-level node that carries its own module binding, is a
// container rather than a filing target.
func TestCreateIssueRejectsNonWorkItemNodes(t *testing.T) {
	plan := newWorkItemPlan(t, "shape")
	var moduleNodeID string
	if err := testPool.QueryRow(context.Background(), `SELECT parent_id::text FROM cockpit_node WHERE id = $1`, plan.workItem).Scan(&moduleNodeID); err != nil {
		t.Fatalf("read module node: %v", err)
	}
	cockpitID := ensureTestCockpit(t)
	deeper := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    plan.workItem,
		"code":         "T" + uuid.NewString()[:8] + ".01.01.01",
		"name":         "第四层",
		"position":     0,
	})
	// A node that carries its own module binding is a container, even at the
	// third level. It needs its own module: one node per module.
	containerModule := dbfx.Module(t, plan.projectID, "shape container module "+uuid.NewString())
	bound := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   cockpitID,
		"parent_id":    moduleNodeID,
		"code":         "T" + uuid.NewString()[:8] + ".01.02",
		"name":         "绑定节点的容器",
		"position":     1,
		"project_id":   plan.projectID,
		"module_id":    containerModule,
	})

	for name, workItem := range map[string]string{"fourth level": deeper, "bound container": bound} {
		w, _ := createIssueRequest(t, map[string]any{
			"title":        "shape " + name + " " + uuid.NewString(),
			"status":       "todo",
			"priority":     "none",
			"work_item_id": workItem,
		})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("CreateIssue with %s: expected 400, got %d: %s", name, w.Code, w.Body.String())
		}
	}
}

// Deleting a module detaches its issues; the work item goes with it, because a
// work item has no meaning outside its module.
func TestDeleteModuleClearsWorkItemFiling(t *testing.T) {
	plan := newWorkItemPlan(t, "module delete")

	_, issue := createIssueRequest(t, map[string]any{
		"title":        "module delete " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w := httptest.NewRecorder()
	testHandler.DeleteModule(w, withURLParam(newRequest(http.MethodDelete, "/api/modules/"+plan.moduleID, nil), "id", plan.moduleID))
	if w.Code != http.StatusNoContent {
		t.Fatalf("DeleteModule: expected 204, got %d: %s", w.Code, w.Body.String())
	}

	var moduleAfter, workItemAfter, projectAfter string
	if err := testPool.QueryRow(context.Background(),
		`SELECT COALESCE(module_id::text, ''), COALESCE(work_item_id::text, ''), project_id::text FROM issue WHERE id = $1`, issue.ID).
		Scan(&moduleAfter, &workItemAfter, &projectAfter); err != nil {
		t.Fatalf("read detached issue: %v", err)
	}
	if moduleAfter != "" || workItemAfter != "" {
		t.Fatalf("issue after module delete: module=%q work_item=%q, want both empty", moduleAfter, workItemAfter)
	}
	if projectAfter != plan.projectID {
		t.Fatalf("project = %s, want %s (issue stays in the project)", projectAfter, plan.projectID)
	}
}

// Project deletion runs its own detach query; it must clear the work item for
// the same reason module deletion does.
func TestDeleteProjectClearsWorkItemFiling(t *testing.T) {
	plan := newWorkItemPlan(t, "project delete")

	_, issue := createIssueRequest(t, map[string]any{
		"title":        "project delete " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, issue.ID) })

	w := httptest.NewRecorder()
	testHandler.DeleteProject(w, withURLParam(newRequest(http.MethodDelete, "/api/projects/"+plan.projectID, nil), "id", plan.projectID))
	if w.Code != http.StatusNoContent {
		t.Fatalf("DeleteProject: expected 204, got %d: %s", w.Code, w.Body.String())
	}

	var moduleAfter, workItemAfter string
	if err := testPool.QueryRow(context.Background(),
		`SELECT COALESCE(module_id::text, ''), COALESCE(work_item_id::text, '') FROM issue WHERE id = $1`, issue.ID).
		Scan(&moduleAfter, &workItemAfter); err != nil {
		t.Fatalf("read issue after project delete: %v", err)
	}
	if moduleAfter != "" || workItemAfter != "" {
		t.Fatalf("issue after project delete: module=%q work_item=%q, want both empty", moduleAfter, workItemAfter)
	}
}

// newSiblingWorkItem adds a second work item under the same module row: the
// closest place a sub-issue could try to jump to without leaving the module.
func newSiblingWorkItem(t *testing.T, plan workItemPlan) string {
	t.Helper()
	var moduleNodeID, moduleCode string
	if err := testPool.QueryRow(context.Background(),
		`SELECT parent_id::text FROM cockpit_node WHERE id = $1`, plan.workItem).Scan(&moduleNodeID); err != nil {
		t.Fatalf("read module node: %v", err)
	}
	if err := testPool.QueryRow(context.Background(),
		`SELECT code FROM cockpit_node WHERE id = $1`, moduleNodeID).Scan(&moduleCode); err != nil {
		t.Fatalf("read module code: %v", err)
	}
	return dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": testWorkspaceID,
		"cockpit_id":   ensureTestCockpit(t),
		"parent_id":    moduleNodeID,
		"code":         moduleCode + ".02",
		"name":         "兄弟工作项",
		"position":     1,
	})
}

// I4 has no same-module loophole: a sub-issue may not move to a sibling work
// item, and may not clear its work item while its parent keeps one. Both moves
// leave project and module untouched, which used to skip the parent check
// entirely.
func TestUpdateIssueChildCannotLeaveParentsWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "child guard")
	sibling := newSiblingWorkItem(t, plan)

	_, parent := createIssueRequest(t, map[string]any{
		"title":        "child guard parent " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, parent.ID) })
	_, child := createIssueRequest(t, map[string]any{
		"title":           "child guard child " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
	})
	t.Cleanup(func() { deleteTestIssue(t, child.ID) })

	for name, body := range map[string]map[string]any{
		"sibling work item": {"work_item_id": sibling},
		"clear work item":   {"work_item_id": nil},
	} {
		w, _ := putIssueRequest(t, child.ID, body)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: expected 400, got %d: %s", name, w.Code, w.Body.String())
		}
		if !containsJSONCode(w.Body.Bytes(), errCodeChildWorkItemMismatch) {
			t.Fatalf("%s: expected %s, got %s", name, errCodeChildWorkItemMismatch, w.Body.String())
		}
	}

	// The refusals must not leave a half-written filing behind.
	var storedWorkItem, storedModule string
	if err := testPool.QueryRow(context.Background(),
		`SELECT COALESCE(work_item_id::text, ''), COALESCE(module_id::text, '') FROM issue WHERE id = $1`, child.ID).
		Scan(&storedWorkItem, &storedModule); err != nil {
		t.Fatalf("read child filing: %v", err)
	}
	if storedWorkItem != plan.workItem || storedModule != plan.moduleID {
		t.Fatalf("child filing = %s/%s after refusals, want %s/%s", storedWorkItem, storedModule, plan.workItem, plan.moduleID)
	}
}

// The batch path calls the same guard; a batch move of a child to a sibling
// work item rejects the whole request.
func TestBatchUpdateChildCannotLeaveParentsWorkItem(t *testing.T) {
	plan := newWorkItemPlan(t, "batch child guard")
	sibling := newSiblingWorkItem(t, plan)

	_, parent := createIssueRequest(t, map[string]any{
		"title":        "batch child guard parent " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, parent.ID) })
	_, child := createIssueRequest(t, map[string]any{
		"title":           "batch child guard child " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
	})
	t.Cleanup(func() { deleteTestIssue(t, child.ID) })

	w := httptest.NewRecorder()
	testHandler.BatchUpdateIssues(w, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{child.ID},
		"updates":   map[string]any{"work_item_id": sibling},
	}))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("batch move: expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !containsJSONCode(w.Body.Bytes(), errCodeChildWorkItemMismatch) {
		t.Fatalf("batch move: expected %s, got %s", errCodeChildWorkItemMismatch, w.Body.String())
	}
}

func TestBatchUpdateChildMismatchStopsBeforeMutatingStandalone(t *testing.T) {
	plan := newWorkItemPlan(t, "batch atomic preflight")
	sibling := newSiblingWorkItem(t, plan)

	_, standalone := createIssueRequest(t, map[string]any{
		"title":        "standalone " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, standalone.ID) })
	_, parent := createIssueRequest(t, map[string]any{
		"title":        "parent " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, parent.ID) })
	_, child := createIssueRequest(t, map[string]any{
		"title":           "child " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
	})
	t.Cleanup(func() { deleteTestIssue(t, child.ID) })

	w := httptest.NewRecorder()
	testHandler.BatchUpdateIssues(w, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{standalone.ID, child.ID},
		"updates":   map[string]any{"work_item_id": sibling},
	}))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("batch move: expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if !containsJSONCode(w.Body.Bytes(), errCodeChildWorkItemMismatch) {
		t.Fatalf("batch move: expected %s, got %s", errCodeChildWorkItemMismatch, w.Body.String())
	}
	var standaloneWorkItem string
	dbfx.QueryRow(t, `SELECT COALESCE(work_item_id::text, '') FROM issue WHERE id = $1`, standalone.ID).Scan(&standaloneWorkItem)
	if standaloneWorkItem != plan.workItem {
		t.Fatalf("standalone issue was mutated before parent conflict stop: got %s, want %s", standaloneWorkItem, plan.workItem)
	}
}

func TestBatchUpdateParentAndChildMoveTogetherRegardlessOfOrder(t *testing.T) {
	plan := newWorkItemPlan(t, "batch parent child together")
	sibling := newSiblingWorkItem(t, plan)

	_, parent := createIssueRequest(t, map[string]any{
		"title":        "parent " + uuid.NewString(),
		"status":       "todo",
		"priority":     "none",
		"work_item_id": plan.workItem,
	})
	t.Cleanup(func() { deleteTestIssue(t, parent.ID) })
	_, child := createIssueRequest(t, map[string]any{
		"title":           "child " + uuid.NewString(),
		"status":          "todo",
		"priority":        "none",
		"parent_issue_id": parent.ID,
	})
	t.Cleanup(func() { deleteTestIssue(t, child.ID) })

	var parentRev, childRev int64
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id = $1`, parent.ID).Scan(&parentRev)
	dbfx.QueryRow(t, `SELECT revision FROM issue WHERE id = $1`, child.ID).Scan(&childRev)

	// Child listed BEFORE parent, with expected_revisions on both.
	testutil.Call(t, testHandler.BatchUpdateIssues, newRequest(http.MethodPost, "/api/issues/batch-update", map[string]any{
		"issue_ids":          []string{child.ID, parent.ID},
		"expected_revisions": map[string]int64{parent.ID: parentRev, child.ID: childRev},
		"updates":            map[string]any{"project_id": plan.projectID, "module_id": plan.moduleID, "work_item_id": sibling},
	})).Want(http.StatusOK)

	for name, id := range map[string]string{"parent": parent.ID, "child": child.ID} {
		var got string
		dbfx.QueryRow(t, `SELECT COALESCE(work_item_id::text, '') FROM issue WHERE id = $1`, id).Scan(&got)
		if got != sibling {
			t.Fatalf("%s work_item_id = %q, want %s", name, got, sibling)
		}
	}
}
