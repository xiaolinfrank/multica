package handler

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// workItemFixture builds a reconciled-shape board: project row (L1) → module
// row (L2, bound to a module) and returns the ids the endpoints need.
func workItemFixture(t *testing.T) (wsID, moduleID, l2ID string) {
	t.Helper()
	wsID = cockpitFixture(t, "Work item writes")
	projectID := dbfx.Insert(t, "project", testutil.Cols{"workspace_id": wsID, "title": "出海注册项目", "status": "in_progress", "priority": "none"})
	moduleID = dbfx.Insert(t, "module", testutil.Cols{"workspace_id": wsID, "project_id": projectID, "title": "01.01 申报资料"})
	root := createNode(t, wsID, map[string]any{"code": "01", "name": "出海注册项目", "project_id": projectID})
	l2 := createNode(t, wsID, map[string]any{"code": "01.01", "name": "申报资料", "parent_id": root.ID, "module_id": moduleID})
	// Structure writes are open from the reconcile on (S3 §11.2).
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, wsID); err != nil {
		t.Fatal(err)
	}
	return wsID, moduleID, l2.ID
}

// A work item is created by naming its module: the server decides the parent,
// the next code and the directory name.
func TestCreateCockpitWorkItem(t *testing.T) {
	wsID, moduleID, l2ID := workItemFixture(t)
	create := func(body map[string]any, want int) CockpitNodeResponse {
		t.Helper()
		var node CockpitNodeResponse
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
			cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, body)).Want(want).JSON(&node)
		return node
	}
	first := create(map[string]any{"module_id": moduleID, "name": "注册路径设计"}, http.StatusCreated)
	if first.ParentID == nil || *first.ParentID != l2ID {
		t.Fatalf("work item parent = %v, want the module row %s", first.ParentID, l2ID)
	}
	if first.Code != "01.01.01" {
		t.Fatalf("code = %q, want 01.01.01", first.Code)
	}
	var directory string
	if err := testPool.QueryRow(context.Background(), "SELECT directory_name FROM cockpit_node WHERE id=$1", first.ID).Scan(&directory); err != nil {
		t.Fatal(err)
	}
	if directory != "01.01.01注册路径设计" {
		t.Fatalf("directory name = %q", directory)
	}
	// after_id places the next row between two siblings, and the code keeps
	// advancing (codes are spent once handed out).
	second := create(map[string]any{"module_id": moduleID, "name": "资料清单", "after_id": first.ID}, http.StatusCreated)
	if second.Code != "01.01.02" {
		t.Fatalf("second code = %q, want 01.01.02", second.Code)
	}
	var firstPos, secondPos float64
	if err := testPool.QueryRow(context.Background(), "SELECT position FROM cockpit_node WHERE id=$1", first.ID).Scan(&firstPos); err != nil {
		t.Fatal(err)
	}
	if err := testPool.QueryRow(context.Background(), "SELECT position FROM cockpit_node WHERE id=$1", second.ID).Scan(&secondPos); err != nil {
		t.Fatal(err)
	}
	if secondPos <= firstPos {
		t.Fatalf("after_id did not place the row after its sibling: %v <= %v", secondPos, firstPos)
	}
	// Unknown module and bad after_id are refused.
	create(map[string]any{"module_id": uuid.NewString(), "name": "x"}, http.StatusBadRequest)
	create(map[string]any{"module_id": moduleID, "name": "x", "after_id": uuid.NewString()}, http.StatusBadRequest)
}

// Renumbering rewrites the children to the shown order, including a swap that
// no row-by-row update could survive, and keeps a leading ".00" row's code.
func TestRenumberCockpitChildren(t *testing.T) {
	wsID, _, l2ID := workItemFixture(t)
	create := func(body map[string]any) CockpitNodeResponse {
		t.Helper()
		var node CockpitNodeResponse
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem),
			cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, body)).Want(http.StatusCreated).JSON(&node)
		return node
	}
	moduleID := ""
	// Reuse the fixture's module id through a created row's parent chain is
	// not exposed; read it from the board instead.
	var board CockpitBoardResponse
	testutil.Call(t, cockpitHandler(testHandler.GetCockpit), cockpitRequest(http.MethodGet, "/api/cockpit", wsID, nil)).Want(http.StatusOK).JSON(&board)
	for _, node := range board.Nodes {
		if node.ID == l2ID && node.ModuleID != nil {
			moduleID = *node.ModuleID
		}
	}
	a := create(map[string]any{"module_id": moduleID, "name": "A"})
	b := create(map[string]any{"module_id": moduleID, "name": "B"})
	c := create(map[string]any{"module_id": moduleID, "name": "C"})
	// Put C first, then B, then A: the codes must follow the new order.
	for i, id := range []string{c.ID, b.ID, a.ID} {
		testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
			cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+id, wsID, map[string]any{"position": float64(i)}), "id", id)).Want(http.StatusOK)
	}
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/"+l2ID+"/renumber", wsID, nil), "id", l2ID)).Want(http.StatusOK)
	for id, want := range map[string]string{c.ID: "01.01.01", b.ID: "01.01.02", a.ID: "01.01.03"} {
		var code string
		if err := testPool.QueryRow(context.Background(), "SELECT code FROM cockpit_node WHERE id=$1", id).Scan(&code); err != nil {
			t.Fatal(err)
		}
		if code != want {
			t.Fatalf("row %s code = %q, want %q", id, code, want)
		}
	}
}

// A work item created with creation_key: the intent table only allows
// resource_kind node/meeting, so the endpoint must use "node" — otherwise every
// keyed create fails with 500 and the skill's advice is unusable. A retry with
// the same key replays the first row instead of creating a second.
func TestCreateCockpitWorkItemWithCreationKey(t *testing.T) {
	wsID, moduleID, _ := workItemFixture(t)
	key := uuid.NewString()
	create := func(credential, key string) (CockpitNodeCreateResponse, int) {
		t.Helper()
		r := cockpitRequest(http.MethodPost, "/api/cockpit/work-items", wsID, map[string]any{
			"module_id": moduleID, "name": "带 key 的工作项", "creation_key": key,
		})
		if credential != "" {
			r.Header.Set("X-Actor-Source", credential)
		}
		var out CockpitNodeCreateResponse
		resp := testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), r)
		if resp.Code != http.StatusCreated && resp.Code != http.StatusOK {
			t.Fatalf("status %d: %s", resp.Code, resp.Body.String())
		}
		resp.JSON(&out)
		return out, resp.Code
	}
	first, status := create("", key)
	if status != http.StatusCreated {
		t.Fatalf("first create status = %d", status)
	}
	second, status := create("", key)
	if status != http.StatusOK {
		t.Fatalf("replay status = %d, want 200", status)
	}
	if second.ID != first.ID {
		t.Fatalf("replay id = %s, want %s", second.ID, first.ID)
	}
	// A machine credential may create work items too (§0 item 20); it uses its
	// own key, because a replay is keyed on the key alone.
	machine, status := create("task_token", uuid.NewString())
	if status != http.StatusCreated {
		t.Fatalf("machine create status = %d", status)
	}
	if machine.ID == "" {
		t.Fatal("machine create returned no row")
	}
	var rows int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND name='带 key 的工作项'`, wsID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 { // the keyed row (replayed once) + the machine's own row
		t.Fatalf("rows = %d, want 2", rows)
	}
}
