package handler

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// S7's folder plumbing, exercised end to end against a real filesystem. The
// same body runs twice: once on a temp directory in a normal test, once on the
// configured NAS root when MULTICA_TEST_NAS_ROOT is set.
func TestCockpitDirectoriesLifecycle(t *testing.T) {
	runCockpitDirectoryLifecycle(t, t.TempDir())
}

func TestCockpitDirectoriesLifecycleOnNAS(t *testing.T) {
	root := strings.TrimSpace(os.Getenv("MULTICA_TEST_NAS_ROOT"))
	if root == "" {
		t.Skip("MULTICA_TEST_NAS_ROOT is not set; the NAS lifecycle test runs only on request")
	}
	dir := filepath.Join(root, "s7-test-"+time.Now().Format("20060102-150405"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("create the NAS test directory: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Errorf("clean up %s: %v", dir, err)
			return
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("the NAS test directory %s was not removed", dir)
		}
	})
	runCockpitDirectoryLifecycle(t, dir)
}

func runCockpitDirectoryLifecycle(t *testing.T, collab string) {
	t.Helper()
	ws := cockpitFixture(t, "S7 directory lifecycle "+filepath.Base(collab))
	project := dbfx.Project(t, "交付项目", testutil.Cols{"workspace_id": ws, "collab_path": collab})
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}

	createModule := func(title string) ModuleResponse {
		t.Helper()
		var resp struct {
			Module ModuleResponse `json:"module"`
		}
		testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
			"project_id": project, "title": title,
		})).Want(http.StatusCreated).JSON(&resp)
		return resp.Module
	}

	// 1. A module's folder is its plan address plus its title, and the module
	// row and the plan row name the same folder.
	moduleA := createModule("确权线")
	if moduleA.DirectoryName == nil || !strings.HasPrefix(*moduleA.DirectoryName, "01.01") || strings.Contains(*moduleA.DirectoryName, "--") {
		t.Fatalf("module folder = %v, want the plan address plus the title and no random suffix", moduleA.DirectoryName)
	}
	var l2A, moduleRowDir string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text, COALESCE(directory_name,'') FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2`, moduleA.ID, ws).Scan(&l2A, &moduleRowDir); err != nil {
		t.Fatal(err)
	}
	if moduleRowDir != *moduleA.DirectoryName {
		t.Fatalf("module row %q and module %q disagree", moduleRowDir, *moduleA.DirectoryName)
	}
	if code, err := collabfs.StatDir(collab, *moduleA.DirectoryName); code != collabfs.StatOK {
		t.Fatalf("module folder not created: %s %v", code, err)
	}

	// 2. A second module gets its own address; a duplicate title is made unique.
	moduleB := createModule("质量体系")
	if moduleB.DirectoryName == nil || !strings.HasPrefix(*moduleB.DirectoryName, "01.02") {
		t.Fatalf("second module folder = %v", moduleB.DirectoryName)
	}

	createWorkItem := func(moduleID, name string) CockpitNodeResponse {
		t.Helper()
		var node CockpitNodeResponse
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
			"module_id": moduleID, "name": name,
		})).Want(http.StatusCreated).JSON(&node)
		return node
	}

	// 3. A work item's folder sits inside its module's.
	item := createWorkItem(moduleA.ID, "接口设计")
	if item.DirectoryName == nil || !strings.HasPrefix(*item.DirectoryName, item.Code) {
		t.Fatalf("work item folder = %v (code %s)", item.DirectoryName, item.Code)
	}
	if code, _ := collabfs.StatDir(collab, *moduleA.DirectoryName, *item.DirectoryName); code != collabfs.StatOK {
		t.Fatalf("work item folder not created: %s", code)
	}

	// 4. An issue delivers into the work item's folder. A file stands in for
	// the team's material that has to follow every rename and move.
	issueID := dbfx.Issue(t, "注册路径设计", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": moduleA.ID, "work_item_id": item.ID,
	})
	if got, want := ensureIssueFolder(t, ws, issueID).FullPath, filepath.Join(collab, *moduleA.DirectoryName, *item.DirectoryName); got == nil || *got != want {
		t.Fatalf("issue folder = %v, want %q", got, want)
	}
	const material = "material.md"
	if err := os.WriteFile(filepath.Join(collab, *moduleA.DirectoryName, *item.DirectoryName, material), []byte("team"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 5. Renaming a work item renames its folder with everything inside it.
	renamed := "接口设计（二版）"
	patchNode(t, ws, item.ID, map[string]any{"name": renamed}, http.StatusOK)
	var newItemDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&newItemDir); err != nil {
		t.Fatal(err)
	}
	if newItemDir == *item.DirectoryName || !strings.Contains(newItemDir, "接口设计（二版）") {
		t.Fatalf("work item folder after rename = %q", newItemDir)
	}
	if _, err := os.Stat(filepath.Join(collab, *moduleA.DirectoryName, newItemDir, material)); err != nil {
		t.Fatalf("material did not follow the renamed work item: %v", err)
	}

	// 6. Deferring leaves the folder alone and reports the mismatch; the sync
	// endpoint then does what the reader deferred.
	deferred := "接口设计（三版）"
	patchNode(t, ws, item.ID, map[string]any{"name": deferred, "directory_sync": "defer"}, http.StatusOK)
	var deferredDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&deferredDir); err != nil {
		t.Fatal(err)
	}
	if deferredDir != newItemDir {
		t.Fatalf("a deferred rename changed the folder name to %q", deferredDir)
	}
	var listing struct {
		Items []PlanDirectoryStatus `json:"items"`
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitPlanDirectories), cockpitRequest(http.MethodGet, "/api/cockpit/plan/directories?node_ids="+item.ID, ws, nil)).Want(http.StatusOK).JSON(&listing)
	nodeStatus := listing.Items[0]
	if nodeStatus.Status != "name_mismatch" {
		t.Fatalf("deferred rename status = %q, want name_mismatch", nodeStatus.Status)
	}
	testutil.Call(t, cockpitHandler(testHandler.SyncCockpitNodeDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/directory/sync", ws, map[string]any{}), "id", item.ID)).Want(http.StatusOK)
	var syncedDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&syncedDir); err != nil {
		t.Fatal(err)
	}
	if syncedDir == deferredDir || !strings.Contains(syncedDir, "（三版）") {
		t.Fatalf("synced folder = %q", syncedDir)
	}

	// 7. Moving a work item to another module moves its folder, and its
	// files, to the destination module.
	var l2B string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2`, moduleB.ID, ws).Scan(&l2B); err != nil {
		t.Fatal(err)
	}
	patchNode(t, ws, item.ID, map[string]any{"parent_id": l2B}, http.StatusOK)
	var movedDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&movedDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(collab, *moduleB.DirectoryName, movedDir, material)); err != nil {
		t.Fatalf("material did not move with its work item: %v", err)
	}
	if code, _ := collabfs.StatDir(collab, *moduleA.DirectoryName, syncedDir); code != collabfs.StatMissing {
		t.Fatalf("the old work-item folder is still there: %s", code)
	}

	// 8. A running agent blocks a rename (409) unless the caller forces it.
	agent := dbfx.Agent(t, "Folder agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})
	var conflict struct {
		Code         string           `json:"code"`
		RunningTasks []RunningTaskRef `json:"running_tasks"`
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitNode), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/cockpit/nodes/x", ws, map[string]any{"name": "被占用"}), "id", item.ID)).
		Want(http.StatusConflict).JSON(&conflict)
	if conflict.Code != "running_agent_tasks" || len(conflict.RunningTasks) != 1 || conflict.RunningTasks[0].Status != "running" {
		t.Fatalf("conflict body = %+v", conflict)
	}
	var blockedDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&blockedDir); err != nil {
		t.Fatal(err)
	}
	if blockedDir != movedDir {
		t.Fatalf("a refused rename changed the folder to %q", blockedDir)
	}
	patchNode(t, ws, item.ID, map[string]any{"name": "强制同步", "directory_sync": "force"}, http.StatusOK)
	// The task finishes; later steps must not see it.
	if _, err := testPool.Exec(context.Background(), `UPDATE agent_task_queue SET status='completed' WHERE issue_id=$1`, issueID); err != nil {
		t.Fatal(err)
	}

	// 9. Fill: a preview reports what it would do and writes nothing; apply
	// creates the missing folder. The folder is deleted behind the row's back to
	// simulate a share that was never mounted.
	if err := os.RemoveAll(filepath.Join(collab, *moduleA.DirectoryName)); err != nil {
		t.Fatal(err)
	}
	var preview struct {
		Applied bool                `json:"applied"`
		Items   []DirectoryFillItem `json:"items"`
		Counts  map[string]int      `json:"counts"`
	}
	testutil.Call(t, cockpitHandler(testHandler.FillCockpitPlanDirectories), cockpitRequest(http.MethodPost, "/api/cockpit/plan/directories/fill", ws, map[string]any{})).Want(http.StatusOK).JSON(&preview)
	if preview.Applied || preview.Counts["create"] == 0 {
		t.Fatalf("preview = %+v", preview)
	}
	if code, _ := collabfs.StatDir(collab, *moduleA.DirectoryName); code != collabfs.StatMissing {
		t.Fatalf("a preview wrote to the share: %s", code)
	}
	var applied struct {
		Applied bool                `json:"applied"`
		Items   []DirectoryFillItem `json:"items"`
		Counts  map[string]int      `json:"counts"`
	}
	testutil.Call(t, cockpitHandler(testHandler.FillCockpitPlanDirectories), cockpitRequest(http.MethodPost, "/api/cockpit/plan/directories/fill", ws, map[string]any{"apply": true})).Want(http.StatusOK).JSON(&applied)
	if !applied.Applied {
		t.Fatal("apply did not report itself")
	}
	if code, _ := collabfs.StatDir(collab, *moduleA.DirectoryName); code != collabfs.StatOK {
		t.Fatalf("apply did not recreate the module folder: %s", code)
	}

}

func mustNodeDir(t *testing.T, ws, nodeID string) string {
	t.Helper()
	var name string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1 AND workspace_id=$2`, nodeID, ws).Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}

// A module rename renames its folder and keeps the module record and its plan
// row on the same name.
func TestCockpitModuleRenameSyncsFolder(t *testing.T) {
	ws := cockpitFixture(t, "S7 module rename")
	collab := t.TempDir()
	project := dbfx.Project(t, "交付项目", testutil.Cols{"workspace_id": ws, "collab_path": collab})
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	var created struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
		"project_id": project, "title": "确权线",
	})).Want(http.StatusCreated).JSON(&created)
	before := *created.Module.DirectoryName

	var updated struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateModule), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/modules/x", ws, map[string]any{"title": "确权边界"}), "id", created.Module.ID)).
		Want(http.StatusOK).JSON(&updated)
	after := *updated.Module.DirectoryName
	if after == before || !strings.Contains(after, "确权边界") {
		t.Fatalf("module folder after rename = %q (was %q)", after, before)
	}
	if code, _ := collabfs.StatDir(collab, after); code != collabfs.StatOK {
		t.Fatalf("renamed module folder missing: %s", code)
	}
	if code, _ := collabfs.StatDir(collab, before); code != collabfs.StatMissing {
		t.Fatalf("old module folder still present: %s", code)
	}
	var rowName, moduleName string
	if err := testPool.QueryRow(context.Background(),
		`SELECT COALESCE(n.directory_name,''), COALESCE(m.directory_name,'') FROM cockpit_node n JOIN module m ON m.id = n.module_id WHERE n.workspace_id=$1 AND n.module_id=$2`,
		ws, created.Module.ID).Scan(&rowName, &moduleName); err != nil {
		t.Fatal(err)
	}
	if rowName != after || moduleName != after {
		t.Fatalf("module row %q / module %q disagree with %q", rowName, moduleName, after)
	}

	// Deferring leaves the folder and the reported name alone.
	var deferred struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateModule), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/modules/x", ws, map[string]any{"title": "确权边界二版", "directory_sync": "defer"}), "id", created.Module.ID)).
		Want(http.StatusOK).JSON(&deferred)
	if deferred.Module.DirectoryName == nil || *deferred.Module.DirectoryName != after {
		t.Fatalf("a deferred rename changed the folder to %v", deferred.Module.DirectoryName)
	}
	if code, _ := collabfs.StatDir(collab, after); code != collabfs.StatOK {
		t.Fatalf("a deferred rename moved the folder: %s", code)
	}
}

// Renumbering rewrites the codes and the folders together, one row at a time.
func TestCockpitRenumberSyncsFolders(t *testing.T) {
	ws := cockpitFixture(t, "S7 renumber")
	collab := t.TempDir()
	project := dbfx.Project(t, "交付项目", testutil.Cols{"workspace_id": ws, "collab_path": collab})
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	var mod struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
		"project_id": project, "title": "确权线",
	})).Want(http.StatusCreated).JSON(&mod)
	var second CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
		"module_id": mod.Module.ID, "name": "接口设计",
	})).Want(http.StatusCreated).JSON(&second)
	var first CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
		"module_id": mod.Module.ID, "name": "注册路径", "after_id": second.ID,
	})).Want(http.StatusCreated).JSON(&first)

	var l2 string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2`, mod.Module.ID, ws).Scan(&l2); err != nil {
		t.Fatal(err)
	}
	// Put the later-created row in front: its code and its folder both have to
	// move to the front too.
	patchNode(t, ws, first.ID, map[string]any{"position": -1.0}, http.StatusOK)
	var result struct {
		Changed int `json:"changed"`
		Results []struct {
			NodeID   string `json:"node_id"`
			Status   string `json:"status"`
			ToFolder string `json:"to_directory"`
		} `json:"directory_results"`
	}
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/renumber", ws, map[string]any{}), "id", l2)).Want(http.StatusOK).JSON(&result)
	if result.Changed != 2 || len(result.Results) != 2 {
		t.Fatalf("renumber = %+v", result)
	}
	for _, item := range result.Results {
		if item.Status != "renamed" && item.Status != "ok" {
			t.Fatalf("renumber result %+v", item)
		}
		if code, _ := collabfs.StatDir(collab, *mod.Module.DirectoryName, item.ToFolder); code != collabfs.StatOK {
			t.Fatalf("renumbered folder %q missing: %s", item.ToFolder, code)
		}
	}
}

// Deleting a module removes the rows and leaves every file where it is: a
// folder on a share is not the database's to delete.
func TestCockpitDeleteKeepsFolders(t *testing.T) {
	ws := cockpitFixture(t, "S7 delete keeps folders")
	collab := t.TempDir()
	project := dbfx.Project(t, "交付项目", testutil.Cols{"workspace_id": ws, "collab_path": collab})
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	var mod struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
		"project_id": project, "title": "确权线",
	})).Want(http.StatusCreated).JSON(&mod)
	if err := os.WriteFile(filepath.Join(collab, *mod.Module.DirectoryName, "notes.md"), []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, cockpitHandler(testHandler.DeleteModule), testutil.WithURLParams(
		cockpitRequest(http.MethodDelete, "/api/modules/x", ws, nil), "id", mod.Module.ID)).Want(http.StatusNoContent)
	if content, err := os.ReadFile(filepath.Join(collab, *mod.Module.DirectoryName, "notes.md")); err != nil || string(content) != "keep me" {
		t.Fatalf("deleting a module touched its folder: %q %v", content, err)
	}
}

// Renumbering is refused while an agent is working in one of the folders it
// would rename, like any other structural rename.
func TestCockpitRenumberRefusesWhileAnAgentWorks(t *testing.T) {
	ws := cockpitFixture(t, "S7 renumber conflict")
	collab := t.TempDir()
	project := dbfx.Project(t, "交付项目", testutil.Cols{"workspace_id": ws, "collab_path": collab})
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	var mod struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
		"project_id": project, "title": "确权线",
	})).Want(http.StatusCreated).JSON(&mod)
	var first CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
		"module_id": mod.Module.ID, "name": "接口设计",
	})).Want(http.StatusCreated).JSON(&first)
	// A second item, then put it in front: the codes have to move, which is
	// the pass the running task refuses.
	var second CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
		"module_id": mod.Module.ID, "name": "注册路径",
	})).Want(http.StatusCreated).JSON(&second)
	patchNode(t, ws, second.ID, map[string]any{"position": -1.0}, http.StatusOK)
	l2 := dbfx.Count(t, "SELECT count(*) FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2", mod.Module.ID, ws)
	if l2 != 1 {
		t.Fatalf("module rows = %d", l2)
	}
	var l2ID string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2`, mod.Module.ID, ws).Scan(&l2ID); err != nil {
		t.Fatal(err)
	}
	issueID := dbfx.Issue(t, "已排入的任务", testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": mod.Module.ID, "work_item_id": first.ID})
	agent := dbfx.Agent(t, "Renumber agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})

	var conflict struct {
		Code         string           `json:"code"`
		RunningTasks []RunningTaskRef `json:"running_tasks"`
	}
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/renumber", ws, map[string]any{}), "id", l2ID)).
		Want(http.StatusConflict).JSON(&conflict)
	if conflict.Code != "running_agent_tasks" || len(conflict.RunningTasks) != 1 {
		t.Fatalf("conflict = %+v", conflict)
	}
	// Forcing goes through and the folders follow.
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/renumber", ws, map[string]any{"directory_sync": "force"}), "id", l2ID)).
		Want(http.StatusOK)
}
