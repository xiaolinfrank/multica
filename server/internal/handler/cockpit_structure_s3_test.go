package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// reconciledFixture builds a reconciled board: project row → module row (L2) →
// two work items, with a second module to move between.
func reconciledFixture(t *testing.T) (wsID, projectID, moduleA, moduleB, l2A, l2B, workItem string) {
	t.Helper()
	wsID = cockpitFixture(t, "S3 structure rules")
	projectID = dbfx.Insert(t, "project", testutil.Cols{"workspace_id": wsID, "title": "P", "status": "in_progress", "priority": "none"})
	moduleA = dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": projectID, "title": "01.01 模块甲"})
	moduleB = dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": projectID, "title": "01.02 模块乙"})
	root := createNode(t, wsID, map[string]any{"code": "01", "name": "P", "project_id": projectID})
	l2a := createNode(t, wsID, map[string]any{"code": "01.01", "name": "模块甲", "parent_id": root.ID, "module_id": moduleA})
	l2b := createNode(t, wsID, map[string]any{"code": "01.02", "name": "模块乙", "parent_id": root.ID, "module_id": moduleB})
	// Mark the plan reconciled: the S3 rules only apply from here.
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, wsID); err != nil {
		t.Fatal(err)
	}
	var work CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
		cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, map[string]any{"module_id": moduleA, "name": "工作项"})).Want(http.StatusCreated).JSON(&work)
	return wsID, projectID, moduleA, moduleB, l2a.ID, l2b.ID, work.ID
}

func patchNode(t *testing.T, wsID, nodeID string, body map[string]any, want int) {
	t.Helper()
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+nodeID, wsID, body), "id", nodeID)).Want(want)
}

// A work item may only move under a module row; project rows and module rows
// keep their parent (I1/I2).
func TestWorkItemMoveRefusesIllegalParents(t *testing.T) {
	wsID, _, _, _, l2A, _, work := reconciledFixture(t)
	// Under a project row (L1): the issue would lose its scope.
	patchNode(t, wsID, work, map[string]any{"parent_id": l2A}, http.StatusOK)
	var rootID string
	if err := testPool.QueryRow(context.Background(), `SELECT parent_id::text FROM cockpit_node WHERE id=$1`, l2A).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	patchNode(t, wsID, work, map[string]any{"parent_id": rootID}, http.StatusBadRequest)
	// To the top level.
	patchNode(t, wsID, work, map[string]any{"parent_id": nil}, http.StatusBadRequest)
	// Another work item (a fourth level).
	patchNode(t, wsID, work, map[string]any{"parent_id": work}, http.StatusBadRequest)
	// A module row may not change parent either.
	patchNode(t, wsID, l2A, map[string]any{"parent_id": l2A}, http.StatusBadRequest)
}

// Crossing modules gives the work item the destination's next number; the old
// one stays spent.
func TestWorkItemMoveAcrossModulesRenumbers(t *testing.T) {
	wsID, _, moduleA, moduleB, _, l2B, work := reconciledFixture(t)
	var before string
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id=$1`, work).Scan(&before); err != nil {
		t.Fatal(err)
	}
	patchNode(t, wsID, work, map[string]any{"parent_id": l2B}, http.StatusOK)
	var after string
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id=$1`, work).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before == after || after != "01.02.01" {
		t.Fatalf("code %q → %q, want the destination's next number 01.02.01", before, after)
	}
	// The old number is not handed out again.
	var created CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
		cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, map[string]any{"module_id": moduleA, "name": "新行"})).Want(http.StatusCreated).JSON(&created)
	if created.Code == before {
		t.Fatalf("old code %q was handed out again", before)
	}
	_ = moduleB
}

// The status a move maps to is refused exactly like the issue detail path, and
// the message names the issue.
func TestWorkItemMoveReportsStatusNotInWorkflow(t *testing.T) {
	wsID, _, moduleA, _, _, _, work := reconciledFixture(t)
	// A second project with a restricted workflow: only a project crossing runs
	// the status mapping.
	restricted := dbfx.Insert(t, "project", testutil.Cols{"workspace_id": wsID, "title": "受限项目", "status": "in_progress", "priority": "none"})
	workflow := dbfx.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": wsID, "name": "受限", "initial_status_key": "backlog",
		"steps": `[{"status_key":"backlog"},{"status_key":"done"}]`,
	})
	if _, err := testPool.Exec(context.Background(), `UPDATE project SET workflow_id=$2 WHERE id=$1`, restricted, workflow); err != nil {
		t.Fatal(err)
	}
	moduleC := dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": restricted, "title": "02.01 受限模块"})
	rootC := createNode(t, wsID, map[string]any{"code": "02", "name": "受限项目", "project_id": restricted})
	l2C := createNode(t, wsID, map[string]any{"code": "02.01", "name": "受限模块", "parent_id": rootC.ID, "module_id": moduleC})
	dbfx.Issue(t, "进行中", testutil.Cols{"workspace_id": wsID, "module_id": moduleA, "work_item_id": work, "status": "in_progress"})
	resp := testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+work, wsID, map[string]any{"parent_id": l2C.ID}), "id", work)).Want(http.StatusBadRequest)
	var body map[string]any
	resp.JSON(&body)
	if body["code"] != "status_not_in_workflow" || body["allowed_statuses"] == nil {
		t.Fatalf("body = %v, want the issue-detail refusal shape", body)
	}
}

// A machine credential may delete only a work item that files nothing.
func TestDeleteWorkItemMachineCredentialRules(t *testing.T) {
	wsID, _, _, _, _, _, work := reconciledFixture(t)
	parent := workItemParent(t, wsID, work)
	machine := func() *http.Request {
		r := cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+work, wsID, nil)
		r.Header.Set("X-Actor-Source", "task_token")
		return testutil.WithURLParams(r, "id", work)
	}
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode), machine()).Want(http.StatusNoContent)

	// With an issue filed, the same credential is refused.
	work2 := createNode(t, wsID, map[string]any{"code": "01.01.77", "name": "有归属", "parent_id": parent})
	dbfx.Issue(t, "归属 issue", testutil.Cols{"workspace_id": wsID, "work_item_id": work2.ID})
	r := cockpitRequest(http.MethodDelete, "/api/cockpit/nodes/"+work2.ID, wsID, nil)
	r.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitNode), testutil.WithURLParams(r, "id", work2.ID)).Want(http.StatusForbidden)
}

// workItemParent finds the module row a work item hung from before deletion.
func workItemParent(t *testing.T, wsID, after string) string {
	t.Helper()
	var board CockpitBoardResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpit), cockpitRequest(http.MethodGet, "/api/cockpit", wsID, nil)).Want(http.StatusOK).JSON(&board)
	for _, node := range board.Nodes {
		if node.ID == after {
			if node.ParentID == nil {
				t.Fatal("work item has no parent")
			}
			return *node.ParentID
		}
	}
	t.Fatal("work item not found")
	return ""
}

// Structure writes wait for the reconcile.
func TestStructureWritesRequireReconciledPlan(t *testing.T) {
	wsID := cockpitFixture(t, "pre reconcile")
	projectID := dbfx.Insert(t, "project", testutil.Cols{"workspace_id": wsID, "title": "P", "status": "in_progress", "priority": "none"})
	moduleID := dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": projectID, "title": "模块"})
	root := createNode(t, wsID, map[string]any{"code": "01", "name": "P", "project_id": projectID})
	createNode(t, wsID, map[string]any{"code": "01.01", "name": "模块", "parent_id": root.ID, "module_id": moduleID})
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
		cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, map[string]any{"module_id": moduleID, "name": "x"})).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/"+root.ID+"/renumber", wsID, nil), "id", root.ID)).Want(http.StatusConflict)
}

// Two inserts after the same row get distinct positions.
func TestWorkItemAfterIDKeepsPositionsDistinct(t *testing.T) {
	wsID, _, moduleA, _, _, _, first := reconciledFixture(t)
	create := func(name string) CockpitNodeResponse {
		t.Helper()
		var node CockpitNodeResponse
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
			cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, map[string]any{"module_id": moduleA, "name": name, "after_id": first})).Want(http.StatusCreated).JSON(&node)
		return node
	}
	a, b := create("X"), create("Y")
	var pa, pb float64
	_ = testPool.QueryRow(context.Background(), `SELECT position FROM cockpit_node WHERE id=$1`, a.ID).Scan(&pa)
	_ = testPool.QueryRow(context.Background(), `SELECT position FROM cockpit_node WHERE id=$1`, b.ID).Scan(&pb)
	if pa == pb {
		t.Fatalf("two inserts after the same row share position %v", pa)
	}
	_ = uuid.NewString()
}

// Deleting a module removes its L2 row and every work item under it, cleans the
// node's dependents, and leaves the issues in the project with no filing.
func TestDeleteModuleRemovesPlanSubtree(t *testing.T) {
	wsID, _, moduleA, _, l2A, _, work := reconciledFixture(t)
	ctx := context.Background()
	dbfx.Exec(t, `INSERT INTO cockpit_payment (workspace_id, node_id, label, amount, position, created_at, updated_at) VALUES ($1,$2,'p',100,0,now(),now())`, wsID, work)
	issue := dbfx.Issue(t, "模块下的 issue", testutil.Cols{"workspace_id": wsID, "module_id": moduleA, "work_item_id": work})
	testutil.Call(t, cockpitHandler(testHandler.DeleteModule), testutil.WithURLParams(
		cockpitRequest(http.MethodDelete, "/api/modules/"+moduleA, wsID, nil), "id", moduleA)).Want(http.StatusNoContent)

	for _, id := range []string{l2A, work} {
		var count int
		if err := testPool.QueryRow(ctx, `SELECT count(*) FROM cockpit_node WHERE id=$1`, id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("plan row %s survived the module delete", id)
		}
	}
	var payments, workItem int
	var moduleID *string
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM cockpit_payment WHERE node_id=$1`, work).Scan(&payments); err != nil {
		t.Fatal(err)
	}
	if payments != 0 {
		t.Fatalf("payments left behind: %d", payments)
	}
	if err := testPool.QueryRow(ctx, `SELECT COALESCE(work_item_id::text,''), module_id::text FROM issue WHERE id=$1`, issue).Scan(new(string), &moduleID); err != nil {
		t.Fatal(err)
	}
	if moduleID != nil {
		t.Fatalf("issue kept module %v", *moduleID)
	}
	_ = workItem
}

// Renumbering a parent rewrites the children's codes and their descendants'
// prefixes with them.
func TestRenumberRewritesDescendantPrefixes(t *testing.T) {
	wsID, _, moduleA, _, l2A, _, work := reconciledFixture(t)
	// A second module row before the first in display order, so module A's row
	// moves from 01.01 to 01.02 and its work item must follow.
	var rootID string
	if err := testPool.QueryRow(context.Background(), `SELECT parent_id::text FROM cockpit_node WHERE id=$1`, l2A).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	moduleZ := dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": dbfx.Project(t, "占位"), "title": "Z"})
	_ = moduleZ
	_ = moduleA
	front := createNode(t, wsID, map[string]any{"code": "01.03", "name": "前置模块", "parent_id": rootID})
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+front.ID, wsID, map[string]any{"position": float64(-1)}), "id", front.ID)).Want(http.StatusOK)
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/"+rootID+"/renumber", wsID, nil), "id", rootID)).Want(http.StatusOK)

	var moduleCode, workCode string
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id=$1`, l2A).Scan(&moduleCode); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id=$1`, work).Scan(&workCode); err != nil {
		t.Fatal(err)
	}
	if moduleCode != "01.02" {
		t.Fatalf("module row code = %q, want 01.02", moduleCode)
	}
	if workCode != moduleCode+".01" {
		t.Fatalf("work item code = %q, want its module's new prefix %s.01", workCode, moduleCode)
	}
}
