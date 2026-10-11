package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitInputRetainedIssueDeleteRejectsBeforeCancellingRun(t *testing.T) {
	ws := dbfx.Workspace(t, "Retained input deletion", "input-delete-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "member")
	issue := dbfx.Issue(t, "Retain this execution history", testutil.Cols{"workspace_id": ws, "creator_id": testUserID})
	manifest := dbfx.Insert(t, "cockpit_issue_input_manifest_version", testutil.Cols{"id": uuid.NewString(), "workspace_id": ws, "issue_id": issue, "version_number": 1, "command_key": uuid.NewString(), "request_hash": strings.Repeat("a", 64), "receipt": testutil.Raw("'{}'::jsonb"), "manifest_hash": strings.Repeat("b", 64), "item_total": 0, "required_total": 0, "created_by": testUserID})
	dbfx.InsertNoID(t, "cockpit_issue_input_manifest", testutil.Cols{"workspace_id": ws, "issue_id": issue, "revision": 1, "current_version_id": manifest, "updated_by": testUserID}, "workspace_id=$1 AND issue_id=$2", ws, issue)
	runtime := dbfx.Runtime(t, "Input delete runtime", testutil.Cols{"workspace_id": ws, "owner_id": testUserID})
	agent := dbfx.Agent(t, "Input delete agent", runtime, testutil.Cols{"workspace_id": ws, "owner_id": testUserID})
	task := dbfx.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "queued", "input_manifest_version_id": manifest, "input_preparation_state": "pending"})
	request := testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/issues/"+issue, ws, nil), "id", issue)
	testutil.Call(t, cockpitHandler(testHandler.DeleteIssue), request).Want(http.StatusConflict)
	var status string
	if err := dbfx.Pool.QueryRow(context.Background(), "SELECT status FROM agent_task_queue WHERE id=$1", task).Scan(&status); err != nil || status != "queued" {
		t.Fatalf("blocked deletion changed execution before rejecting: %s %v", status, err)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2", ws, issue) != 1 || dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_input_manifest WHERE workspace_id=$1 AND issue_id=$2", ws, issue) != 1 {
		t.Fatal("blocked deletion lost its task or fixed manifest")
	}
}

func TestCockpitInputUnusedManifestIsCleanedWithIssueDeletion(t *testing.T) {
	ws := dbfx.Workspace(t, "Unused input deletion", "input-unused-delete-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "member")
	issue := dbfx.Issue(t, "Unexecuted input selection", testutil.Cols{"workspace_id": ws, "creator_id": testUserID})
	manifest := dbfx.Insert(t, "cockpit_issue_input_manifest_version", testutil.Cols{"id": uuid.NewString(), "workspace_id": ws, "issue_id": issue, "version_number": 1, "command_key": uuid.NewString(), "request_hash": strings.Repeat("a", 64), "receipt": testutil.Raw("'{}'::jsonb"), "manifest_hash": strings.Repeat("b", 64), "item_total": 0, "required_total": 0, "created_by": testUserID})
	dbfx.InsertNoID(t, "cockpit_issue_input_manifest", testutil.Cols{"workspace_id": ws, "issue_id": issue, "revision": 1, "current_version_id": manifest, "updated_by": testUserID}, "workspace_id=$1 AND issue_id=$2", ws, issue)
	request := testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/issues/"+issue, ws, nil), "id", issue)
	testutil.Call(t, cockpitHandler(testHandler.DeleteIssue), request).Want(http.StatusNoContent)
	for _, table := range []string{"cockpit_issue_input_manifest", "cockpit_issue_input_manifest_version"} {
		if count := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1 AND issue_id=$2", ws, issue); count != 0 {
			t.Fatalf("unused %s facts retained after deletion: %d", table, count)
		}
	}
}
