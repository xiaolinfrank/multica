package handler

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Round-two fixes for the S7 folder plumbing: a renumber that crosses levels,
// a fill pass that has to resolve parents as it goes, and the status rules that
// decide between "missing", "mismatch" and "unavailable".

func round2Plan(t *testing.T, name, collab string) (string, string) {
	t.Helper()
	ws := cockpitFixture(t, name)
	cols := testutil.Cols{"workspace_id": ws}
	if collab != "" {
		cols["collab_path"] = collab
	}
	project := dbfx.Project(t, "交付项目", cols)
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "交付计划"})
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, ws); err != nil {
		t.Fatal(err)
	}
	return ws, project
}

func round2Module(t *testing.T, ws, project, title string) ModuleResponse {
	t.Helper()
	var resp struct {
		Module ModuleResponse `json:"module"`
	}
	testutil.Call(t, cockpitHandler(testHandler.CreateModule), cockpitRequest(http.MethodPost, "/api/modules", ws, map[string]any{
		"project_id": project, "title": title,
	})).Want(http.StatusCreated).JSON(&resp)
	return resp.Module
}

func round2WorkItem(t *testing.T, ws, moduleID, name string) CockpitNodeResponse {
	t.Helper()
	var node CockpitNodeResponse
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitWorkItem), cockpitRequest(http.MethodPost, "/api/cockpit/work-items", ws, map[string]any{
		"module_id": moduleID, "name": name,
	})).Want(http.StatusCreated).JSON(&node)
	return node
}

func round2PatchModule(t *testing.T, ws, moduleID string, body map[string]any, want int) {
	t.Helper()
	testutil.Call(t, cockpitHandler(testHandler.UpdateModule), testutil.WithURLParams(
		cockpitRequest(http.MethodPatch, "/api/modules/"+moduleID, ws, body), "id", moduleID)).Want(want)
}

func round2Fill(t *testing.T, ws string, body map[string]any, out any) *testutil.Response {
	t.Helper()
	return testutil.Call(t, cockpitHandler(testHandler.FillCockpitPlanDirectories),
		cockpitRequest(http.MethodPost, "/api/cockpit/plan/directories/fill", ws, body)).Want(http.StatusOK).JSON(out)
}

func round2NodeDir(t *testing.T, ws, nodeID string) string {
	t.Helper()
	return mustNodeDir(t, ws, nodeID)
}

func round2ModuleL2(t *testing.T, ws, moduleID string) (string, string) {
	t.Helper()
	var id, dir string
	if err := testPool.QueryRow(context.Background(),
		`SELECT id::text, COALESCE(directory_name,'') FROM cockpit_node WHERE module_id=$1 AND workspace_id=$2`,
		moduleID, ws).Scan(&id, &dir); err != nil {
		t.Fatal(err)
	}
	return id, dir
}

// P0-1: renumbering the project root renames the module folder and then the
// work items inside it. The second rename must read the module's new name; a
// stale source path used to look like "nothing to move" and leave the database
// naming a folder that does not exist.
func TestRenumberProjectRenamesNestedWorkItemFolders(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 renumber root", collab)
	moduleA := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, moduleA.ID, "接口设计")
	issueID := dbfx.Issue(t, "注册路径设计", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": moduleA.ID, "work_item_id": item.ID,
	})
	testutil.Call(t, cockpitHandler(testHandler.EnsureIssueDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/issues/x/directory/ensure", ws, nil), "id", issueID)).Want(http.StatusOK)

	moduleB := round2Module(t, ws, project, "质量体系")
	// Put the second module in front so the first module's code changes.
	l2B := mustModuleL2(t, ws, moduleB.ID)
	patchNode(t, ws, l2B, map[string]any{"position": -1.0}, http.StatusOK)

	oldModuleDir := mustNodeDir(t, ws, mustModuleL2(t, ws, moduleA.ID))
	oldItemDir := round2NodeDir(t, ws, item.ID)
	var rootID string
	if err := testPool.QueryRow(context.Background(), `SELECT id::text FROM cockpit_node WHERE parent_id IS NULL AND workspace_id=$1`, ws).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, cockpitHandler(testHandler.RenumberCockpitChildren), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/renumber", ws, map[string]any{}), "id", rootID)).Want(http.StatusOK)

	newModuleDir := mustNodeDir(t, ws, mustModuleL2(t, ws, moduleA.ID))
	newItemDir := round2NodeDir(t, ws, item.ID)
	if newModuleDir == oldModuleDir || newItemDir == oldItemDir {
		t.Fatalf("renumber did not change both names: module %q→%q item %q→%q", oldModuleDir, newModuleDir, oldItemDir, newItemDir)
	}
	if _, err := os.Stat(filepath.Join(collab, newModuleDir, newItemDir)); err != nil {
		t.Fatalf("the work item folder is not under the renumbered module: %v", err)
	}
	if _, err := os.Stat(filepath.Join(collab, newModuleDir, oldItemDir)); !os.IsNotExist(err) {
		t.Fatalf("the work item folder stayed at its old name inside the new module: %v", err)
	}
	if _, err := os.Stat(filepath.Join(collab, oldModuleDir)); !os.IsNotExist(err) {
		t.Fatalf("the old module folder is still on disk: %v", err)
	}
}

func mustModuleL2(t *testing.T, ws, moduleID string) string {
	t.Helper()
	id, _ := round2ModuleL2(t, ws, moduleID)
	return id
}

// P0-2 (a): one fill pass creates a module folder and the work item folder
// inside it when neither row has a name yet.
func TestFillCreatesModuleAndWorkItemInOnePass(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 fill two levels", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	l2, _ := round2ModuleL2(t, ws, module.ID)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE module SET directory_name=NULL WHERE id=$1`, module.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE cockpit_node SET directory_name=NULL WHERE id IN ($1,$2)`, l2, item.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(collab, *module.DirectoryName)); err != nil {
		t.Fatal(err)
	}

	var applied struct {
		Items  []DirectoryFillItem `json:"items"`
		Counts map[string]int      `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{"apply": true}, &applied)
	if applied.Counts["failed"] > 0 {
		t.Fatalf("fill failed: %+v", applied.Items)
	}
	moduleDir := mustNodeDir(t, ws, l2)
	itemDir := round2NodeDir(t, ws, item.ID)
	if moduleDir == "" || itemDir == "" {
		t.Fatalf("names after fill: module %q item %q", moduleDir, itemDir)
	}
	if code, _ := collabfs.StatDir(collab, moduleDir); code != collabfs.StatOK {
		t.Fatalf("module folder missing after fill: %s", code)
	}
	if code, _ := collabfs.StatDir(collab, moduleDir, itemDir); code != collabfs.StatOK {
		t.Fatalf("work item folder missing after fill: %s", code)
	}
}

// P0-2 edge: when a module has no folder name yet but its work item still
// carries a matching folder name, the preview must NOT stat the collaboration
// root with zero segments and mark the work item "ok".
func TestFillCreatesWorkItemWhoseModuleLostItsFolderName(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 fill module lost name", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	l2, _ := round2ModuleL2(t, ws, module.ID)
	if _, err := testPool.Exec(context.Background(), `UPDATE module SET directory_name=NULL WHERE id=$1`, module.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit_node SET directory_name=NULL WHERE id=$1`, l2); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(collab, *module.DirectoryName)); err != nil {
		t.Fatal(err)
	}

	var preview struct {
		Items  []DirectoryFillItem `json:"items"`
		Counts map[string]int      `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{}, &preview)
	var itemPreview *DirectoryFillItem
	for i := range preview.Items {
		if preview.Items[i].NodeID == item.ID {
			itemPreview = &preview.Items[i]
			break
		}
	}
	if itemPreview == nil || itemPreview.Action != "create" {
		t.Fatalf("work item preview = %+v, want action=create", itemPreview)
	}

	var applied struct {
		Items  []DirectoryFillItem `json:"items"`
		Counts map[string]int      `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{"apply": true}, &applied)
	if applied.Counts["failed"] > 0 {
		t.Fatalf("fill failed: %+v", applied.Items)
	}
	moduleDir := mustNodeDir(t, ws, l2)
	itemDir := round2NodeDir(t, ws, item.ID)
	if code, _ := collabfs.StatDir(collab, moduleDir, itemDir); code != collabfs.StatOK {
		t.Fatalf("work item folder missing after fill: %s", code)
	}
}

// P0-2 (b): a module rename and a work item rename in the same pass must not
// rebuild the old module folder or leave the item behind in it.
func TestFillFollowsRenamedModuleBeforeItsWorkItems(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 fill renamed parent", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	oldModuleDir := *module.DirectoryName
	oldItemDir := round2NodeDir(t, ws, item.ID)

	round2PatchModule(t, ws, module.ID, map[string]any{"title": "确权边界", "directory_sync": "defer"}, http.StatusOK)
	patchNode(t, ws, item.ID, map[string]any{"name": "接口设计二版", "directory_sync": "defer"}, http.StatusOK)

	var applied struct {
		Items  []DirectoryFillItem `json:"items"`
		Counts map[string]int      `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{"apply": true}, &applied)
	if applied.Counts["failed"] > 0 {
		t.Fatalf("fill failed: %+v", applied.Items)
	}
	newModuleDir := mustNodeDir(t, ws, mustModuleL2(t, ws, module.ID))
	newItemDir := round2NodeDir(t, ws, item.ID)
	if newModuleDir == oldModuleDir || newItemDir == oldItemDir {
		t.Fatalf("fill did not rename both: module %q→%q item %q→%q", oldModuleDir, newModuleDir, oldItemDir, newItemDir)
	}
	if code, _ := collabfs.StatDir(collab, newModuleDir, newItemDir); code != collabfs.StatOK {
		t.Fatalf("renamed work item folder missing: %s", code)
	}
	if code, _ := collabfs.StatDir(collab, newModuleDir, oldItemDir); code != collabfs.StatMissing {
		t.Fatalf("the old work item folder was left inside the renamed module: %s", code)
	}
	if code, _ := collabfs.StatDir(collab, oldModuleDir); code != collabfs.StatMissing {
		t.Fatalf("the old module folder was rebuilt on disk: %s", code)
	}
}

// P1-1: a deferred rename whose folder is gone is "missing", not a name
// mismatch; an unreachable root is "root_unavailable".
func TestPlanDirectoryStatusStatsBeforeComparingNames(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 status order", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	patchNode(t, ws, item.ID, map[string]any{"name": "接口设计二版", "directory_sync": "defer"}, http.StatusOK)
	if err := os.RemoveAll(filepath.Join(collab, *module.DirectoryName, round2NodeDir(t, ws, item.ID))); err != nil {
		t.Fatal(err)
	}
	if got := round2PlanStatus(t, ws, item.ID); got != "missing" {
		t.Fatalf("deleted folder with a drifted name: %q, want missing", got)
	}

	if _, err := testPool.Exec(context.Background(),
		`UPDATE project SET collab_path=$2 WHERE id=$1 AND workspace_id=$3`, project, filepath.Join(collab, "not-mounted"), ws); err != nil {
		t.Fatal(err)
	}
	if got := round2PlanStatus(t, ws, item.ID); got != "root_unavailable" {
		t.Fatalf("unreachable root: %q, want root_unavailable", got)
	}
}

func round2PlanStatus(t *testing.T, ws, nodeID string) string {
	t.Helper()
	var listing struct {
		Items []PlanDirectoryStatus `json:"items"`
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitPlanDirectories),
		cockpitRequest(http.MethodGet, "/api/cockpit/plan/directories?node_ids="+nodeID, ws, nil)).Want(http.StatusOK).JSON(&listing)
	if len(listing.Items) != 1 {
		t.Fatalf("status items = %d", len(listing.Items))
	}
	return listing.Items[0].Status
}

// P1-1: a folder adopted from the disk ("01.01 确权线") stays "ok", and a
// second fill preview has nothing left to do.
func TestFillAdoptsToleratedNameAndStaysIdempotent(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 adopt", collab)
	module := round2Module(t, ws, project, "确权线")
	l2, _ := round2ModuleL2(t, ws, module.ID)
	var code string
	if err := testPool.QueryRow(context.Background(), `SELECT code FROM cockpit_node WHERE id=$1`, l2).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE module SET directory_name=NULL WHERE id=$1`, module.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE cockpit_node SET directory_name=NULL WHERE id=$1`, l2); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(collab, *module.DirectoryName)); err != nil {
		t.Fatal(err)
	}
	adopted := code + " 确权线"
	if err := os.MkdirAll(filepath.Join(collab, adopted), 0o755); err != nil {
		t.Fatal(err)
	}
	var applied struct {
		Counts map[string]int `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{"apply": true}, &applied)
	if got := round2PlanStatus(t, ws, l2); got != "ok" {
		t.Fatalf("adopted folder status = %q, want ok", got)
	}
	var preview struct {
		Items  []DirectoryFillItem `json:"items"`
		Counts map[string]int      `json:"counts"`
	}
	round2Fill(t, ws, map[string]any{}, &preview)
	if preview.Counts["create"] != 0 || preview.Counts["sync"] != 0 {
		t.Fatalf("second preview still has work: %+v", preview.Counts)
	}
}

// P1-2: an explicit module directory_name reaches the L2 row, so the module
// record and its plan row keep naming the same folder.
func TestModuleExplicitDirectoryNameUpdatesTheRow(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 explicit module name", collab)
	module := round2Module(t, ws, project, "确权线")
	round2PatchModule(t, ws, module.ID, map[string]any{"directory_name": "历史目录"}, http.StatusOK)
	_, rowDir := round2ModuleL2(t, ws, module.ID)
	if rowDir != "历史目录" {
		t.Fatalf("L2 row folder = %q, want 历史目录", rowDir)
	}
}

// P1-2: without a collaboration space there is no folder to disturb, so a
// running task is not a reason to refuse a module or work item rename.
func TestPlanRenameWithoutCollabPathIgnoresRunningTasks(t *testing.T) {
	ws, project := round2Plan(t, "S7 round2 no collab", "")
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	issueID := dbfx.Issue(t, "无盘任务", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID, "work_item_id": item.ID,
	})
	agent := dbfx.Agent(t, "No-share agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})

	round2PatchModule(t, ws, module.ID, map[string]any{"title": "确权边界"}, http.StatusOK)
	patchNode(t, ws, item.ID, map[string]any{"name": "接口设计二版"}, http.StatusOK)
	var moduleDir string
	if err := testPool.QueryRow(context.Background(), `SELECT COALESCE(directory_name,'') FROM module WHERE id=$1`, module.ID).Scan(&moduleDir); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(moduleDir, "确权边界") {
		t.Fatalf("module folder after a no-share rename = %q", moduleDir)
	}
	if dir := round2NodeDir(t, ws, item.ID); !strings.Contains(dir, "二版") {
		t.Fatalf("work item folder after a no-share rename = %q", dir)
	}
}

// P1-3: creating a folder is not a rename, so running work does not refuse it.
func TestDirectorySyncCreatesMissingFolderWhileAnAgentWorks(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 sync create", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	issueID := dbfx.Issue(t, "在跑任务", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID, "work_item_id": item.ID,
	})
	agent := dbfx.Agent(t, "Sync agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})
	dir := round2NodeDir(t, ws, item.ID)
	if err := os.RemoveAll(filepath.Join(collab, *module.DirectoryName, dir)); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, cockpitHandler(testHandler.SyncCockpitNodeDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/directory/sync", ws, map[string]any{}), "id", item.ID)).Want(http.StatusOK)
	if code, _ := collabfs.StatDir(collab, *module.DirectoryName, dir); code != collabfs.StatOK {
		t.Fatalf("sync did not create the missing folder: %s", code)
	}
}

// P1-3: a failed rename keeps the disk's own classification and explains
// itself, instead of being flattened to "invalid".
func TestDirectorySyncFailureKeepsNameMismatchAndTheOldFolder(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 sync collision", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	oldDir := round2NodeDir(t, ws, item.ID)
	patchNode(t, ws, item.ID, map[string]any{"name": "接口设计二版", "directory_sync": "defer"}, http.StatusOK)
	if err := testPool.QueryRow(context.Background(),
		`SELECT COALESCE(directory_name,'') FROM cockpit_node WHERE id=$1`, item.ID).Scan(&oldDir); err != nil {
		t.Fatal(err)
	}
	// Put a folder where the new name would go; the rename must not overwrite it.
	blocker := collabfs.SanitizeFolderName(strings.TrimSuffix(oldDir, "接口设计")+"接口设计二版", 0)
	if err := os.MkdirAll(filepath.Join(collab, *module.DirectoryName, blocker), 0o755); err != nil {
		t.Fatal(err)
	}
	var resp struct {
		DirectorySync NodeDirectorySync   `json:"directory_sync"`
		Directory     PlanDirectoryStatus `json:"directory"`
	}
	testutil.Call(t, cockpitHandler(testHandler.SyncCockpitNodeDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/directory/sync", ws, map[string]any{}), "id", item.ID)).
		Want(http.StatusOK).JSON(&resp)
	if resp.DirectorySync.Status != "failed" || resp.DirectorySync.Reason != "target_exists" {
		t.Fatalf("sync result = %+v", resp.DirectorySync)
	}
	if resp.Directory.Status != "name_mismatch" || resp.Directory.Error == "" {
		t.Fatalf("status after a failed rename = %+v", resp.Directory)
	}
	if got := round2NodeDir(t, ws, item.ID); got != oldDir {
		t.Fatalf("a failed rename changed the row to %q (was %q)", got, oldDir)
	}
	if code, _ := collabfs.StatDir(collab, *module.DirectoryName, oldDir); code != collabfs.StatOK {
		t.Fatalf("a failed rename moved the old folder: %s", code)
	}
}

// P1-3: a preview reports the running tasks in the folders it would touch.
func TestFillPreviewReportsRunningTasks(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 preview tasks", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	issueID := dbfx.Issue(t, "预演在跑", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID, "work_item_id": item.ID,
	})
	agent := dbfx.Agent(t, "Preview agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})
	patchNode(t, ws, item.ID, map[string]any{"name": "接口设计二版", "directory_sync": "defer"}, http.StatusOK)

	var preview struct {
		RunningTasks []RunningTaskRef `json:"running_tasks"`
	}
	round2Fill(t, ws, map[string]any{}, &preview)
	if len(preview.RunningTasks) != 1 || preview.RunningTasks[0].Status != "running" {
		t.Fatalf("preview running tasks = %+v", preview.RunningTasks)
	}
}

// P1-3: empty Go slices are JSON arrays, not null, so a client can iterate them.
func TestPlanDirectoryEmptyListsSerializeAsArrays(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 empty arrays", collab)
	module := round2Module(t, ws, project, "确权线")
	body := testutil.Call(t, cockpitHandler(testHandler.ListCockpitPlanDirectories),
		cockpitRequest(http.MethodGet, "/api/cockpit/plan/directories?node_ids="+mustModuleL2(t, ws, module.ID), ws, nil)).
		Want(http.StatusOK).Text()
	if !strings.Contains(body, `"running_tasks":[]`) || !strings.Contains(body, `"shared_collab_projects":[]`) {
		t.Fatalf("empty lists serialized as null: %s", body)
	}
}

// P2-4: machine credentials cannot call the human-only folder endpoints.
func TestMachineCredentialCannotTouchDirectories(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 machine gate", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")

	for _, tc := range []struct {
		name string
		h    http.HandlerFunc
		req  *http.Request
	}{
		{"sync", humanOnly(testHandler.SyncCockpitNodeDirectory), testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/cockpit/nodes/x/directory/sync", ws, map[string]any{}), "id", item.ID)},
		{"fill", humanOnly(testHandler.FillCockpitPlanDirectories), cockpitRequest(http.MethodPost, "/api/cockpit/plan/directories/fill", ws, map[string]any{})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.req.Header.Set("X-Actor-Source", "task_token")
			testutil.Call(t, tc.h, tc.req).Want(http.StatusForbidden)
		})
	}
}

// P2-4: the status read stays bounded and a preview refuses an unreconciled
// board.
func TestPlanDirectoryReadLimitsAndUnreconciledFill(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 limits", collab)
	module := round2Module(t, ws, project, "确权线")
	ids := make([]string, 0, 101)
	ids = append(ids, mustModuleL2(t, ws, module.ID))
	for len(ids) < 101 {
		ids = append(ids, uuid.NewString())
	}
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitPlanDirectories),
		cockpitRequest(http.MethodGet, "/api/cockpit/plan/directories?node_ids="+strings.Join(ids, ","), ws, nil)).
		Want(http.StatusBadRequest)

	plainWS := cockpitFixture(t, "S7 round2 unreconciled")
	dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": plainWS, "title": "未对账计划"})
	testutil.Call(t, cockpitHandler(testHandler.FillCockpitPlanDirectories),
		cockpitRequest(http.MethodPost, "/api/cockpit/plan/directories/fill", plainWS, map[string]any{})).
		Want(http.StatusConflict)
}

// humanOnly is the router's RequireHumanActor gate in the test's handler shape.
func humanOnly(h http.HandlerFunc) http.HandlerFunc {
	return RequireHumanActor(h).ServeHTTP
}
