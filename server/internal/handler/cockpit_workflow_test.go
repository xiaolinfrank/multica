package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func newCockpitWorkflowHTTPFixture(t *testing.T) (string, CockpitMeetingResponse) {
	t.Helper()
	ws := cockpitMeetingFixture(t, "Meeting workflow HTTP")
	dbfx.Cleanup(t, "DELETE FROM issue WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM issue_subscriber WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws)
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws)
	dbfx.Cleanup(t, "DELETE FROM activity_log WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_work_package WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_version WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_reviewer_handoff WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_minutes_export_attempt WHERE workspace_id=$1", ws)
	return ws, createMeeting(t, ws, map[string]any{"title": "Scope and delivery review", "meet_date": "2026-10-09"})
}

func callCockpitWorkflow(t *testing.T, fn http.HandlerFunc, method, ws, meeting, actor, version string, body any) *testutil.Response {
	t.Helper()
	req := cockpitRequest(method, "/api/cockpit/meetings/"+meeting+"/workflow", ws, body)
	if actor != "" {
		req.Header.Set("X-User-ID", actor)
	}
	req = testutil.WithURLParams(req, "meetingId", meeting, "versionId", version)
	return testutil.Call(t, cockpitHandler(fn), req)
}

func TestCockpitWorkflowHTTPReviewAndPublication(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	reviewer := dbfx.User(t, "Minutes reviewer", "review-"+uuid.NewString()+"@example.com")
	if getBoard(t, ws).HasMeetingWorkflows {
		t.Fatal("new board reported a meeting workflow")
	}
	dbfx.Member(t, ws, reviewer, "member")
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, ws, meeting.ID, "", "", nil).Want(http.StatusOK).JSON(&state)
	if state.Enabled || state.Revision != 0 || state.Versions == nil || !state.CanManage {
		t.Fatalf("unexpected unconfigured workflow: %+v", state)
	}
	init := map[string]any{"reviewer_id": reviewer}
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "", init).Want(http.StatusOK).JSON(&state)
	if !state.Enabled || state.MinutesIssue == nil || state.MinutesIssue.Status != "backlog" || state.MaterialsReady || state.EndedAt != nil {
		t.Fatalf("new work was not held: %+v", state)
	}
	minutesID := state.MinutesIssue.ID
	if !getBoard(t, ws).HasMeetingWorkflows {
		t.Fatal("board omitted its workflow restore protection")
	}
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "", init).Want(http.StatusOK).JSON(&state)
	if state.MinutesIssue.ID != minutesID || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("initialization retry duplicated work")
	}
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusConflict)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "ended": true}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusConflict)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "materials_ready": true}).Want(http.StatusOK).JSON(&state)
	releaseRevision := state.Revision
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": releaseRevision}).Want(http.StatusOK).JSON(&state)
	if state.ReleasedAt == nil || state.MinutesIssue.Status != "todo" || !state.CanSubmit {
		t.Fatalf("ready member task was not released: %+v", state)
	}
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": releaseRevision}).Want(http.StatusOK)
	// R1 (design-principles-2026-10-12): materials confirmation stays
	// two-way after release; the execution gate is a continuous projection.
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "materials_ready": false}).Want(http.StatusOK).JSON(&state)
	key := uuid.NewString()
	submit := map[string]any{"expected_revision": state.Revision, "submission_key": key, "content": "  First phase excludes historical backfill.  "}
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "", submit).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "", submit).Want(http.StatusOK).JSON(&state)
	if len(state.Versions) != 1 || state.Versions[0].ReviewIssue == nil || state.Versions[0].SubmissionKey != key || state.Versions[0].Content != "First phase excludes historical backfill." {
		t.Fatalf("version was not fixed or submission retry duplicated it: %+v", state)
	}
	version := state.Versions[0]
	if state.CanReview || state.CanPublish || version.ReviewerID != reviewer || version.ReviewIssue.AssigneeID == nil || *version.ReviewIssue.AssigneeID != reviewer {
		t.Fatalf("reviewer authority was not pinned: %+v", state)
	}
	// Ordinary task completion and reassignment grant no approval authority.
	testutil.Call(t, testHandler.UpdateIssue, testutil.WithURLParams(cockpitRequest(http.MethodPut, "/api/issues/"+version.ReviewIssue.ID, ws,
		map[string]any{"status": "done", "assignee_type": "member", "assignee_id": testUserID}), "id", version.ReviewIssue.ID)).Want(http.StatusOK)
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, ws, meeting.ID, "", "", nil).Want(http.StatusOK).JSON(&state)
	if state.Versions[0].Decision != "pending" || state.PublishedVersionID != nil || state.CanReview {
		t.Fatal("editing the review issue altered formal authority or decision")
	}
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version.ID,
		map[string]any{"expected_revision": state.Revision, "decision": "approved"}).Want(http.StatusForbidden)
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version.ID,
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusConflict)
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, reviewer, version.ID,
		map[string]any{"expected_revision": state.Revision, "decision": "approved"}).Want(http.StatusOK).JSON(&state)
	if state.Versions[0].Decision != "approved" || state.PublishedVersionID != nil || !state.CanPublish {
		t.Fatalf("approval was not separate from publication: %+v", state)
	}
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", version.ID,
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	if state.PublishedVersionID == nil || *state.PublishedVersionID != version.ID || state.Versions[0].PublishedAt == nil {
		t.Fatalf("approved version was not published: %+v", state)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws); count != 0 {
		t.Fatalf("member workflow unexpectedly created %d runs", count)
	}
	// Whole-workspace teardown is the explicit history removal boundary.
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/workspaces/"+ws, ws, nil), "id", ws)).Want(http.StatusNoContent)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND 'minutes'=ANY(roles)", ws) != 0 ||
		dbfx.Count(t, "SELECT count(*) FROM cockpit_minutes_version WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("workspace deletion left workflow history or an execution gate behind")
	}
}

func TestCockpitWorkflowHTTPMachineGuardsAndConflicts(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": testUserID}).Want(http.StatusOK).JSON(&state)
	for _, source := range []string{"task_token", "cloud_pat"} {
		for _, endpoint := range []struct {
			h      http.HandlerFunc
			method string
		}{
			{testHandler.EnableCockpitMeetingWorkflow, http.MethodPost},
			{testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch},
			{testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost},
			{testHandler.ReviewCockpitMeetingMinutes, http.MethodPost},
			{testHandler.PublishCockpitMeetingMinutes, http.MethodPost},
			{testHandler.ChangeCockpitMeetingReviewer, http.MethodPost},
			{testHandler.ExportCockpitMeetingMinutes, http.MethodPost},
			{testHandler.RetryCockpitMinutesExport, http.MethodPost},
		} {
			req := testutil.WithURLParams(cockpitRequest(endpoint.method, "/workflow", ws, map[string]any{
				"reviewer_id": testUserID, "expected_revision": state.Revision, "ended": true, "decision": "approved",
			}), "meetingId", meeting.ID, "versionId", uuid.NewString())
			req.Header.Set("X-Actor-Source", source)
			testutil.Call(t, cockpitHandler(endpoint.h), req).Want(http.StatusForbidden)
		}
	}
	outsider := dbfx.User(t, "Other member", "other-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, ws, outsider, "member")
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, outsider, "",
		map[string]any{"expected_revision": state.Revision, "ended": true}).Want(http.StatusForbidden)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision + 99, "ended": true}).Want(http.StatusConflict)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "", map[string]any{"ended": true}).Want(http.StatusBadRequest)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "submission_key": uuid.NewString(), "content": "Too early"}).Want(http.StatusForbidden)
	foreign := cockpitMeetingFixture(t, "Other workspace")
	callCockpitWorkflow(t, testHandler.GetCockpitMeetingWorkflow, http.MethodGet, foreign, meeting.ID, "", "", nil).Want(http.StatusNotFound)
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": testUserID, "existing_issue_id": state.MinutesIssue.ID,
			"assignee_type": "member", "assignee_id": outsider}).Want(http.StatusBadRequest)
}

func TestCockpitWorkflowHTTPProtectsHistoryAndRelations(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": testUserID}).Want(http.StatusOK).JSON(&state)
	issueID := state.MinutesIssue.ID
	// R1: deleting sweeps bare bindings; a submitted version is the formal
	// history that retains the meeting. Create one before asserting protection.
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "ended": true, "materials_ready": true}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "submission_key": uuid.NewString(), "content": "Protected history"}).Want(http.StatusOK).JSON(&state)
	testutil.Call(t, cockpitHandler(testHandler.ProvisionCockpitMeeting), testutil.WithURLParams(cockpitRequest(http.MethodPost, "/provision", ws,
		map[string]any{"create_task": true, "create_dir": false}), "meetingId", meeting.ID)).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.UpdateCockpitMeeting), testutil.WithURLParams(cockpitRequest(http.MethodPatch, "/meeting", ws,
		map[string]any{"minutes": "Overwrite history"}), "meetingId", meeting.ID)).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeeting), testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/meeting", ws, nil), "meetingId", meeting.ID)).Want(http.StatusConflict)
	testutil.Call(t, testHandler.DeleteIssue, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/issue", ws, nil), "id", issueID)).Want(http.StatusConflict)
	testutil.Call(t, testHandler.BatchDeleteIssues, cockpitRequest(http.MethodPost, "/issues/batch-delete", ws, map[string]any{"issue_ids": []string{issueID}})).Want(http.StatusConflict)
	setMeetingIssues(t, ws, meeting.ID, map[string]any{"issue_ids": []string{}, "replace": true}).Want(http.StatusConflict)
	setMeetingRoles(t, ws, meeting.ID, issueID, map[string]any{"roles": []string{"reference"}}).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeetingIssue), testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/unlink", ws, nil), "meetingId", meeting.ID, "issueId", issueID)).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit), cockpitRequest(http.MethodPut, "/import", ws, map[string]any{"nodes": []any{}})).Want(http.StatusConflict)
	if count := dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1", issueID); count != 1 {
		t.Fatal("a protected issue was removed")
	}
	if len(getBoard(t, ws).MeetingIssues) < 2 {
		t.Fatal("a protected workflow relationship was removed")
	}
}

func TestCockpitWorkflowHTTPTaskScopedSubmission(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": testUserID}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "ended": true, "materials_ready": true}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	// Simulate the identities stamped by task-token authentication. No daemon
	// or real agent executable participates in this handler regression.
	runtime := dbfx.Runtime(t, "Minutes fixture runtime", testutil.Cols{"workspace_id": ws})
	agent := dbfx.Agent(t, "Minutes assistant", runtime, testutil.Cols{"workspace_id": ws})
	wrongIssue := dbfx.Issue(t, "Other work", testutil.Cols{"workspace_id": ws, "number": 900000})
	wrongTask := dbfx.Task(t, agent, testutil.Cols{"issue_id": wrongIssue, "runtime_id": runtime, "status": "running"})
	sourceTask := dbfx.Task(t, agent, testutil.Cols{"issue_id": state.MinutesIssue.ID, "runtime_id": runtime, "status": "running"})
	key := uuid.NewString()
	for _, scenario := range []struct {
		name, source, task, agent string
		status                    int
	}{
		{"cloud runtime is not an issue author", "cloud_pat", sourceTask, agent, http.StatusForbidden},
		{"task belongs to another issue", "task_token", wrongTask, agent, http.StatusForbidden},
		{"task identity is missing", "task_token", "", agent, http.StatusForbidden},
		{"agent does not own task", "task_token", sourceTask, uuid.NewString(), http.StatusForbidden},
		{"issue-scoped agent submits", "task_token", sourceTask, agent, http.StatusOK},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			req := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/workflow/versions", ws,
				map[string]any{"expected_revision": state.Revision, "submission_key": key, "content": "Recorded by the assigned task."}), "meetingId", meeting.ID)
			req.Header.Set("X-Actor-Source", scenario.source)
			req.Header.Set("X-Agent-ID", scenario.agent)
			req.Header.Set("X-Task-ID", scenario.task)
			response := testutil.Call(t, cockpitHandler(testHandler.SubmitCockpitMeetingMinutes), req).Want(scenario.status)
			if scenario.status == http.StatusOK {
				response.JSON(&state)
			}
		})
	}
	if len(state.Versions) != 1 || state.Versions[0].SubmittedByType != "agent" || state.Versions[0].SubmittedByID != agent {
		t.Fatalf("task author provenance was lost: %+v", state.Versions)
	}
	if state.CanManage || state.CanReview || state.CanPublish {
		t.Fatal("machine submission granted human control capabilities")
	}
}
