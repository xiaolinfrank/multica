package handler

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// P0-3: an explicit null clears the work item, so the issue's folder has to
// follow it — and running work in that folder refuses the move first.
func TestIssueFilingClearedByNullMovesFolderAndRefusesRunningWork(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 clear filing", collab)
	module := round2Module(t, ws, project, "确权线")
	item := round2WorkItem(t, ws, module.ID, "接口设计")
	issueID := dbfx.Issue(t, "注册路径设计", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID, "work_item_id": item.ID,
	})
	testutil.Call(t, cockpitHandler(testHandler.EnsureIssueDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/issues/x/directory/ensure", ws, nil), "id", issueID)).Want(http.StatusOK)
	issueDir := round2IssueDir(t, issueID)
	agent := dbfx.Agent(t, "Clear filing agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": issueID, "status": "running", "runtime_id": testRuntimeID})

	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/issues/x", ws, map[string]any{"work_item_id": nil}), "id", issueID)).
		Want(http.StatusConflict)
	if code, _ := collabfs.StatDir(collab, *module.DirectoryName, round2NodeDir(t, ws, item.ID), issueDir); code != collabfs.StatOK {
		t.Fatalf("a refused move touched the folder: %s", code)
	}

	if _, err := testPool.Exec(context.Background(), `UPDATE agent_task_queue SET status='completed' WHERE issue_id=$1`, issueID); err != nil {
		t.Fatal(err)
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/issues/x", ws, map[string]any{"work_item_id": nil}), "id", issueID)).
		Want(http.StatusOK)
	if code, _ := collabfs.StatDir(collab, *module.DirectoryName, issueDir); code != collabfs.StatOK {
		t.Fatalf("the issue folder did not move out of the work item: %s", code)
	}
	if _, err := os.Stat(filepath.Join(collab, *module.DirectoryName, round2NodeDir(t, ws, item.ID), issueDir)); !os.IsNotExist(err) {
		t.Fatalf("the issue folder stayed inside the work item: %v", err)
	}
}

// P0-3: a re-file carries the whole subtree, so a running task on a CHILD is
// enough to refuse it — checking only the parent missed this entirely.
func TestIssueFilingChecksRunningWorkInTheSubtree(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 subtree runs", collab)
	moduleA := round2Module(t, ws, project, "确权线")
	moduleB := round2Module(t, ws, project, "质量体系")
	parentID := dbfx.Issue(t, "父任务", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": moduleA.ID,
	})
	childID := dbfx.Issue(t, "子任务", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": moduleA.ID, "parent_issue_id": parentID,
	})
	for _, id := range []string{parentID, childID} {
		testutil.Call(t, cockpitHandler(testHandler.EnsureIssueDirectory), testutil.WithURLParams(
			cockpitRequest(http.MethodPost, "/api/issues/x/directory/ensure", ws, nil), "id", id)).Want(http.StatusOK)
	}
	agent := dbfx.Agent(t, "Subtree agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": childID, "status": "running", "runtime_id": testRuntimeID})

	var conflict struct {
		Code         string           `json:"code"`
		RunningTasks []RunningTaskRef `json:"running_tasks"`
	}
	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/issues/x", ws, map[string]any{"module_id": moduleB.ID}), "id", parentID)).
		Want(http.StatusConflict).JSON(&conflict)
	if conflict.Code != "running_agent_tasks" || len(conflict.RunningTasks) != 1 || conflict.RunningTasks[0].IssueID != childID {
		t.Fatalf("conflict = %+v", conflict)
	}
}

// P0-3: a new parent is a potential filing change even when the three filing
// fields echo their current values, so its running work is checked too.
func TestIssueParentChangeAloneChecksRunningWork(t *testing.T) {
	collab := t.TempDir()
	ws, project := round2Plan(t, "S7 round2 parent run", collab)
	module := round2Module(t, ws, project, "确权线")
	parentID := dbfx.Issue(t, "父任务", testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": module.ID})
	childID := dbfx.Issue(t, "子任务", testutil.Cols{
		"workspace_id": ws, "project_id": project, "module_id": module.ID,
	})
	testutil.Call(t, cockpitHandler(testHandler.EnsureIssueDirectory), testutil.WithURLParams(
		cockpitRequest(http.MethodPost, "/api/issues/x/directory/ensure", ws, nil), "id", childID)).Want(http.StatusOK)
	agent := dbfx.Agent(t, "Parent agent", "", testutil.Cols{"workspace_id": ws})
	dbfx.Insert(t, "agent_task_queue", testutil.Cols{"agent_id": agent, "issue_id": childID, "status": "running", "runtime_id": testRuntimeID})

	testutil.Call(t, cockpitHandler(testHandler.UpdateIssue), testutil.WithURLParams(
		cockpitRequest(http.MethodPut, "/api/issues/x", ws, map[string]any{"parent_issue_id": parentID}), "id", childID)).
		Want(http.StatusConflict)
}
