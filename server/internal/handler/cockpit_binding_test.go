package handler

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitInheritedBinding(t *testing.T) {
	projectID, moduleID := parseUUID(uuid.NewString()), parseUUID(uuid.NewString())
	root := db.CockpitNode{ID: parseUUID(uuid.NewString()), ProjectID: projectID, Code: "arbitrary-root"}
	group := db.CockpitNode{ID: parseUUID(uuid.NewString()), ParentID: root.ID, Code: "not-a-number"}
	module := db.CockpitNode{ID: parseUUID(uuid.NewString()), ParentID: group.ID, ProjectID: projectID, ModuleID: moduleID, Code: "another-title"}
	leaf := db.CockpitNode{ID: parseUUID(uuid.NewString()), ParentID: module.ID, Code: "L3"}
	byID := map[pgtype.UUID]db.CockpitNode{root.ID: root, group.ID: group, module.ID: module, leaf.ID: leaf}
	p, m, err := cockpitInheritedBinding(leaf, byID)
	if err != nil || p != projectID || m != moduleID {
		t.Fatalf("inherited binding = %v/%v, %v", p, m, err)
	}

	t.Run("conflicting project through grouping rows", func(t *testing.T) {
		changed := module
		changed.ProjectID = parseUUID(uuid.NewString())
		if _, _, err := cockpitInheritedBinding(changed, byID); err == nil {
			t.Fatal("accepted conflicting project")
		}
	})
	t.Run("nested module binding", func(t *testing.T) {
		changed := leaf
		changed.ProjectID, changed.ModuleID = projectID, parseUUID(uuid.NewString())
		if _, _, err := cockpitInheritedBinding(changed, byID); err == nil {
			t.Fatal("accepted nested module")
		}
	})
	t.Run("missing ancestor", func(t *testing.T) {
		changed := leaf
		changed.ParentID = parseUUID(uuid.NewString())
		if _, _, err := cockpitInheritedBinding(changed, byID); err == nil {
			t.Fatal("accepted missing ancestor")
		}
	})
	t.Run("cycle", func(t *testing.T) {
		changed := root
		changed.ParentID = leaf.ID
		if _, _, err := cockpitInheritedBinding(changed, byID); err == nil {
			t.Fatal("accepted cyclic ancestry")
		}
	})
}

func bindingPatch(t *testing.T, wsID, nodeID string, body map[string]any, status int) CockpitNodeResponse {
	t.Helper()
	resp := testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/"+nodeID, wsID, body), "id", nodeID)).Want(status)
	var node CockpitNodeResponse
	if status == http.StatusOK {
		resp.JSON(&node)
	}
	return node
}

func TestCockpitNodeBindingLifecycle(t *testing.T) {
	wsID := cockpitFixture(t, "Bindings")
	projectID := dbfx.Project(t, "Project", testutil.Cols{"workspace_id": wsID})
	moduleID := dbfx.Module(t, projectID, "Renamable module", testutil.Cols{"workspace_id": wsID})
	root := createNode(t, wsID, map[string]any{"code": "root", "project_id": projectID})
	group := createNode(t, wsID, map[string]any{"code": "group", "parent_id": root.ID})
	module := createNode(t, wsID, map[string]any{"code": "module", "parent_id": group.ID, "module_id": moduleID})
	leaf := createNode(t, wsID, map[string]any{"code": "leaf", "parent_id": module.ID})
	if module.ProjectID == nil || *module.ProjectID != projectID || module.ModuleID == nil || *module.ModuleID != moduleID {
		t.Fatalf("module binding = %+v", module)
	}
	if leaf.ProjectID != nil || leaf.ModuleID != nil {
		t.Fatalf("descendant persisted inherited binding: %+v", leaf)
	}

	updated := bindingPatch(t, wsID, module.ID, map[string]any{"name": "Renamed", "code": "changed-number"}, http.StatusOK)
	if updated.ID != module.ID || updated.ModuleID == nil || *updated.ModuleID != moduleID {
		t.Fatalf("rename changed binding identity: %+v", updated)
	}
	bindingPatch(t, wsID, module.ID, map[string]any{"project_id": nil}, http.StatusBadRequest)
	cleared := bindingPatch(t, wsID, module.ID, map[string]any{"project_id": nil, "module_id": nil}, http.StatusOK)
	if cleared.ID != module.ID || cleared.ProjectID != nil || cleared.ModuleID != nil {
		t.Fatalf("clear = %+v", cleared)
	}
}

func TestCockpitNodeBindingsRejectWrongWorkspaceAndDuplicates(t *testing.T) {
	wsID := cockpitFixture(t, "Binding validation")
	projectID := dbfx.Project(t, "Local", testutil.Cols{"workspace_id": wsID})
	moduleID := dbfx.Module(t, projectID, "Local module", testutil.Cols{"workspace_id": wsID})
	otherProject := dbfx.Project(t, "Another local", testutil.Cols{"workspace_id": wsID})
	foreignProject := dbfx.Project(t, "Foreign project")
	foreignModule := dbfx.Module(t, foreignProject, "Foreign module")
	cases := []map[string]any{
		{"project_id": "not-a-uuid"},
		{"project_id": foreignProject},
		{"module_id": foreignModule},
		{"module_id": moduleID, "project_id": otherProject},
		{"module_id": moduleID, "project_id": nil},
	}
	for _, body := range cases {
		body["code"] = uuid.NewString()
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID, body)).Want(http.StatusBadRequest)
	}
	root := createNode(t, wsID, map[string]any{"code": "p", "project_id": projectID})
	createNode(t, wsID, map[string]any{"code": "m", "parent_id": root.ID, "module_id": moduleID})
	for _, body := range []map[string]any{{"code": "p-again", "project_id": projectID}, {"code": "m-again", "module_id": moduleID}} {
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNode), cockpitRequest(http.MethodPost, "/api/cockpit/nodes", wsID, body)).Want(http.StatusConflict)
	}
}

func TestCockpitBindingReparentValidatesDescendants(t *testing.T) {
	wsID := cockpitFixture(t, "Binding reparent")
	p1 := dbfx.Project(t, "P1", testutil.Cols{"workspace_id": wsID})
	p2 := dbfx.Project(t, "P2", testutil.Cols{"workspace_id": wsID})
	m1 := dbfx.Module(t, p1, "M1", testutil.Cols{"workspace_id": wsID})
	a := createNode(t, wsID, map[string]any{"code": "A", "project_id": p1})
	b := createNode(t, wsID, map[string]any{"code": "B", "project_id": p2})
	group := createNode(t, wsID, map[string]any{"code": "group", "parent_id": a.ID})
	module := createNode(t, wsID, map[string]any{"code": "M", "parent_id": group.ID, "module_id": m1})
	bindingPatch(t, wsID, group.ID, map[string]any{"parent_id": b.ID}, http.StatusBadRequest)
	bindingPatch(t, wsID, a.ID, map[string]any{"parent_id": module.ID}, http.StatusBadRequest)
	for _, node := range getBoard(t, wsID).Nodes {
		if node.ID == group.ID && (node.ParentID == nil || *node.ParentID != a.ID) {
			t.Fatalf("failed reparent was persisted: %+v", node)
		}
	}
}

func TestCockpitBoundBoardRejectsImportAndRestore(t *testing.T) {
	wsID := cockpitFixture(t, "Stable bound identity")
	projectID := dbfx.Project(t, "P", testutil.Cols{"workspace_id": wsID})
	root := createNode(t, wsID, map[string]any{"code": "P", "project_id": projectID})
	var snap CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot), cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, map[string]any{"label": "Bound baseline"})).Want(http.StatusCreated).JSON(&snap)
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit), cockpitRequest(http.MethodPut, "/api/cockpit/import", wsID, map[string]any{"nodes": []any{}})).Want(http.StatusConflict)
	restoreSnapshot(t, wsID, snap.ID).Want(http.StatusConflict)
	board := getBoard(t, wsID)
	if len(board.Nodes) != 1 || board.Nodes[0].ID != root.ID {
		t.Fatalf("replacement changed bound node identity: %+v", board.Nodes)
	}
}

func TestCockpitImportResolvesAndPreservesBindings(t *testing.T) {
	wsID := cockpitFixture(t, "Binding import")
	projectID := dbfx.Project(t, "P", testutil.Cols{"workspace_id": wsID})
	moduleID := dbfx.Module(t, projectID, "M", testutil.Cols{"workspace_id": wsID})
	importBoard(t, wsID, map[string]any{"nodes": []map[string]any{
		{"code": "P", "project_id": projectID},
		{"code": "M", "parent_code": "P", "module_id": moduleID},
	}})
	board := getBoard(t, wsID)
	for _, n := range board.Nodes {
		if n.ProjectID == nil || *n.ProjectID != projectID {
			t.Fatalf("import lost binding: %+v", n)
		}
	}
	// Snapshot schema exports bindings, not inferred names or display codes.
	var snap CockpitSnapshotResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitSnapshot), cockpitRequest(http.MethodPost, "/api/cockpit/snapshots", wsID, nil)).Want(http.StatusCreated).JSON(&snap)
	var payload string
	if err := testPool.QueryRow(t.Context(), "SELECT payload::text FROM cockpit_snapshot WHERE id = $1 AND workspace_id = $2", snap.ID, wsID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var doc CockpitImportRequest
	if err := json.Unmarshal([]byte(payload), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Nodes) != 2 || doc.Nodes[0].ProjectID == nil || *doc.Nodes[0].ProjectID != projectID {
		t.Fatalf("snapshot lost bindings: %s", payload)
	}
}

func TestCockpitResourceDeleteClearsBindingsWithoutDeletingNodes(t *testing.T) {
	wsID := cockpitFixture(t, "Binding resource deletion")
	projectID := dbfx.Project(t, "P", testutil.Cols{"workspace_id": wsID})
	moduleID := dbfx.Module(t, projectID, "M", testutil.Cols{"workspace_id": wsID})
	root := createNode(t, wsID, map[string]any{"code": "P", "project_id": projectID})
	module := createNode(t, wsID, map[string]any{"code": "M", "parent_id": root.ID, "module_id": moduleID})
	testutil.Call(t, testHandler.DeleteModule, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/modules/"+moduleID, wsID, nil), "id", moduleID)).Want(http.StatusNoContent)
	board := getBoard(t, wsID)
	if len(board.Nodes) != 2 {
		t.Fatalf("module delete removed plan nodes: %+v", board.Nodes)
	}
	for _, n := range board.Nodes {
		if n.ID == module.ID && (n.ProjectID != nil || n.ModuleID != nil) {
			t.Fatalf("module delete left binding: %+v", n)
		}
		if n.ID == root.ID && n.ProjectID == nil {
			t.Fatal("module deletion cleared project binding")
		}
	}
	testutil.Call(t, testHandler.DeleteProject, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/projects/"+projectID, wsID, nil), "id", projectID)).Want(http.StatusNoContent)
	for _, n := range getBoard(t, wsID).Nodes {
		if n.ProjectID != nil || n.ModuleID != nil {
			t.Fatalf("project delete left binding: %+v", n)
		}
	}
}
