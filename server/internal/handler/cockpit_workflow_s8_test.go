package handler

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Explicitly naming the work item when enabling the work package must file the
// minutes task at it without repeating the row as a related link, and a retry
// with the same explicit node must be accepted. A fourth level is refused.
func TestCockpitMeetingWorkPackageExplicitWorkItemNode(t *testing.T) {
	f := newMeetingArchiveFixture(t, "Meeting work package explicit node", true)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_work_package WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_version WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_reviewer_handoff WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export WHERE workspace_id=$1", f.wsID)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export_attempt WHERE workspace_id=$1", f.wsID)
	reviewer := dbfx.User(t, "纪要审核人", "review-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, f.wsID, reviewer, "member")
	patchCockpit(t, f.wsID, map[string]any{
		"meeting_project_id": f.project, "meeting_module_id": f.module, "meeting_node_id": f.node,
	}).Want(http.StatusOK)

	meeting := createMeeting(t, f.wsID, map[string]any{"meet_date": "2026-09-21", "title": "周例会"})
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, meeting.ID, "", "",
		map[string]any{"reviewer_id": reviewer, "node_id": f.node}).Want(http.StatusOK).JSON(&state)
	if state.MinutesIssue == nil {
		t.Fatal("enabling the work package opened no minutes task")
	}
	minutesID := state.MinutesIssue.ID
	var projectID, moduleID, workItemID *string
	dbfx.QueryRow(t, "SELECT project_id::text, module_id::text, work_item_id::text FROM issue WHERE id=$1", minutesID).
		Scan(&projectID, &moduleID, &workItemID)
	if projectID == nil || *projectID != f.project || moduleID == nil || *moduleID != f.module || workItemID == nil || *workItemID != f.node {
		t.Errorf("minutes task filing = %v/%v/%v, want %s/%s/%s", projectID, moduleID, workItemID, f.project, f.module, f.node)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE issue_id=$1", minutesID); n != 0 {
		t.Errorf("the work item is repeated as a related link (%d rows)", n)
	}

	// The same explicit destination is a retry, not a conflict.
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, meeting.ID, "", "",
		map[string]any{"reviewer_id": reviewer, "node_id": f.node}).Want(http.StatusOK).JSON(&state)
	if state.MinutesIssue.ID != minutesID {
		t.Errorf("retry opened a second minutes task: %s vs %s", state.MinutesIssue.ID, minutesID)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.wsID); n != 1 {
		t.Errorf("retry left %d issues, want one", n)
	}

	cockpitID := dbfx.QueryRow(t, "SELECT id::text FROM cockpit WHERE workspace_id=$1", f.wsID)
	var boardID string
	cockpitID.Scan(&boardID)
	moduleRowID := dbfx.QueryRow(t,
		"SELECT id::text FROM cockpit_node WHERE workspace_id=$1 AND module_id=$2 LIMIT 1", f.wsID, f.module)
	var moduleRow string
	moduleRowID.Scan(&moduleRow)

	// Another work item is another filing: that is a conflict, not a retry.
	otherWorkItem := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": moduleRow,
		"code": "06.06.04", "name": "另一工作项", "position": 1,
	})
	conflict := callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, meeting.ID, "", "",
		map[string]any{"reviewer_id": reviewer, "node_id": otherWorkItem}).Want(http.StatusConflict)
	// The refusal names the work item, not some later step that happened to
	// fail: the retry check is what decides whether a second filing is a retry.
	if body := conflict.Text(); !strings.Contains(body, "different work item") {
		t.Errorf("a different explicit work item answered %s", body)
	}

	// A fourth level is not a meeting destination.
	fourth := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.wsID, "cockpit_id": boardID, "parent_id": f.node,
		"code": "06.06.03.01", "name": "第四层", "position": 0,
	})
	other := createMeeting(t, f.wsID, map[string]any{"meet_date": "2026-09-22", "title": "另一场例会"})
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, f.wsID, other.ID, "", "",
		map[string]any{"reviewer_id": reviewer, "node_id": fourth}).Want(http.StatusBadRequest)
}
