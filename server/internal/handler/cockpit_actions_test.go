package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func cockpitActionHTTPFixture(t *testing.T) (string, CockpitMeetingResponse, CockpitMinutesVersionResponse, CockpitNodeResponse) {
	t.Helper()
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	project := dbfx.Project(t, "Action project", testutil.Cols{"workspace_id": ws})
	module := dbfx.Module(t, project, "Action module", testutil.Cols{"workspace_id": ws})
	root := createNode(t, ws, map[string]any{"code": "project", "project_id": project})
	group := createNode(t, ws, map[string]any{"code": "module", "parent_id": root.ID, "module_id": module})
	node := createNode(t, ws, map[string]any{"code": "execution", "name": "Verify the boundary", "parent_id": group.ID})
	dbfx.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_action WHERE workspace_id=$1", ws)
	var work CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, meeting.ID, "", "", map[string]any{"reviewer_id": testUserID}).Want(200).JSON(&work)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, "PATCH", ws, meeting.ID, "", "", map[string]any{"expected_revision": work.Revision, "ended": true, "materials_ready": true}).Want(200).JSON(&work)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, "POST", ws, meeting.ID, "", "", map[string]any{"expected_revision": work.Revision}).Want(200).JSON(&work)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, "POST", ws, meeting.ID, "", "", map[string]any{"expected_revision": work.Revision, "submission_key": uuid.NewString(), "content": "# Fixed source\n\nValidate the delivery boundary before execution."}).Want(200).JSON(&work)
	version := work.Versions[0].ID
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, "POST", ws, meeting.ID, "", version, map[string]any{"expected_revision": work.Revision, "decision": "approved"}).Want(200).JSON(&work)
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, "POST", ws, meeting.ID, "", version, map[string]any{"expected_revision": work.Revision}).Want(200).JSON(&work)
	return ws, meeting, work.Versions[0], node
}

func callCockpitAction(t *testing.T, fn http.HandlerFunc, method, path, ws, meeting, version, action string, body any) *testutil.Response {
	t.Helper()
	request := testutil.WithURLParams(cockpitRequest(method, path, ws, body), "meetingId", meeting, "versionId", version, "actionId", action)
	return testutil.Call(t, cockpitHandler(fn), request)
}

func TestCockpitActionHTTPEmptyMeetingHasAUsablePage(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	var page service.CockpitActionPage
	callCockpitAction(t, testHandler.ListCockpitMeetingActions, "GET", "/actions", ws, meeting.ID, "", "", nil).Want(200).JSON(&page)
	if page.MeetingID != meeting.ID || page.Items == nil || len(page.Items) != 0 || page.CanAdd || page.Total != 0 || page.NextCursor != nil {
		t.Fatalf("an existing meeting without a work package must not look broken: %+v", page)
	}
}

func TestCockpitActionHTTPCreateReuseAndIssueFacts(t *testing.T) {
	ws, meeting, version, node := cockpitActionHTTPFixture(t)
	var action service.CockpitActionView
	proposal := map[string]any{"proposal_key": uuid.NewString(), "title": "Validate boundary", "description": "Produce the acceptance report", "source_quote": "delivery boundary"}
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "", proposal).Want(200).JSON(&action)
	if action.Status != "draft" || action.VersionID != version.ID || action.SourceContentHash != version.ContentHash || !action.CanResolve {
		t.Fatalf("source or capabilities missing: %+v", action)
	}
	firstID := action.ID
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "", proposal).Want(200).JSON(&action)
	if action.ID != firstID || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_action WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("proposal replay duplicated action")
	}
	callCockpitAction(t, testHandler.GetCockpitMeetingAction, "GET", "/actions/one", ws, meeting.ID, "", action.ID, nil).Want(200).JSON(&action)
	decision := map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "create", "node_id": node.ID, "due_date": "2026-12-31", "priority": "high"}
	callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", action.ID, decision).Want(200).JSON(&action)
	if action.Status != "accepted" || action.Issue == nil || action.Issue.Status != "backlog" || action.Issue.PrimaryNodeID == nil || *action.Issue.PrimaryNodeID != node.ID || action.Issue.AssigneeID == nil || *action.Issue.AssigneeID != testUserID {
		t.Fatalf("acceptance did not produce owned backlog work: %+v", action)
	}
	issueID := action.Issue.ID
	callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", action.ID, decision).Want(200).JSON(&action)
	if action.Issue == nil || action.Issue.ID != issueID || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 3 {
		t.Fatal("decision replay duplicated its issue")
	}
	var reused service.CockpitActionView
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "",
		map[string]any{"proposal_key": uuid.NewString(), "title": "Follow up the same work"}).Want(200).JSON(&reused)
	callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", reused.ID,
		map[string]any{"expected_revision": reused.Revision, "decision_key": uuid.NewString(), "outcome": "reuse", "node_id": node.ID, "issue_id": action.Issue.Identifier}).Want(200).JSON(&reused)
	if reused.Issue == nil || reused.Issue.ID != issueID || reused.Issue.Title != "Validate boundary" || reused.Issue.Priority != "high" || reused.Issue.DueDate == nil || *reused.Issue.DueDate != "2026-12-31" {
		t.Fatalf("reuse changed original issue fields: %+v", reused)
	}
	var sources service.CockpitIssueActionSourcePage
	readSources := func(issueRef, path string, status int) {
		t.Helper()
		response := testutil.Call(t, cockpitHandler(testHandler.ListCockpitIssueActionSources), testutil.WithURLParams(cockpitRequest("GET", path, ws, nil), "issueId", issueRef)).Want(status)
		if status == http.StatusOK {
			response.JSON(&sources)
		}
	}
	readSources(action.Issue.Identifier, "/sources?page_size=1", http.StatusOK)
	if sources.Total != 2 || len(sources.Items) != 1 || sources.NextCursor == nil || sources.Items[0].MeetingID != meeting.ID || sources.Items[0].VersionID != version.ID {
		t.Fatalf("missing bounded reverse action source: %+v", sources)
	}
	firstSource, cursor := sources.Items[0].ID, *sources.NextCursor
	readSources(issueID, "/sources?page_size=1&cursor="+url.QueryEscape(cursor), http.StatusOK)
	if len(sources.Items) != 1 || sources.Items[0].ID == firstSource || sources.NextCursor != nil {
		t.Fatal("source pagination repeated or lost a reference")
	}
	otherIssue := dbfx.Issue(t, "No action source", testutil.Cols{"workspace_id": ws})
	readSources(otherIssue, "/sources?page_size=1&cursor="+url.QueryEscape(cursor), http.StatusBadRequest)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND issue_id=$2", ws, issueID) != 0 {
		t.Fatal("formal actions bloated the full board's mutable meeting links")
	}
	var graph graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph), graphRequest("GET", "/api/issues/graph?project_id="+*reused.Issue.ProjectID, ws)).Want(200).JSON(&graph)
	if !edgeKeys(graph)[fmt.Sprintf("mtg:%s>%s:meeting", meeting.ID, issueID)] {
		t.Fatal("graph omitted the accepted action's source meeting")
	}
	testutil.Call(t, testHandler.UpdateIssue, testutil.WithURLParams(cockpitRequest("PUT", "/issue", ws, map[string]any{"status": "done"}), "id", issueID)).Want(200)
	var page service.CockpitActionPage
	callCockpitAction(t, testHandler.ListCockpitMeetingActions, "GET", "/actions?status=accepted&page_size=1", ws, meeting.ID, "", "", nil).Want(200).JSON(&page)
	if len(page.Items) != 1 || page.Total != 2 || page.FilteredTotal != 2 || page.NextCursor == nil || page.Items[0].Issue == nil || page.Items[0].Issue.Status != "done" {
		t.Fatalf("action page duplicated execution state or lost its bound: %+v", page)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND node_id=$2", ws, node.ID); count != 1 {
		t.Fatalf("reused issue counted more than once: %d", count)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", ws); count != 0 {
		t.Fatal("confirming an action dispatched an agent")
	}
}

func TestCockpitActionHTTPRejectsUnintendedFieldsAndKeepsDismissalDistinct(t *testing.T) {
	ws, meeting, version, node := cockpitActionHTTPFixture(t)
	var action service.CockpitActionView
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "",
		map[string]any{"proposal_key": uuid.NewString(), "title": "Unfounded quote", "source_quote": "This is absent from the source."}).Want(400)
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "",
		map[string]any{"proposal_key": uuid.NewString(), "title": "Needs a decision", "description": "Retain this description"}).Want(200).JSON(&action)
	callCockpitAction(t, testHandler.UpdateCockpitMeetingAction, "PATCH", "/actions", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "title": "Missing other text fields"}).Want(400)
	callCockpitAction(t, testHandler.UpdateCockpitMeetingAction, "PATCH", "/actions", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "title": "Revised decision", "description": "Retain this description", "source_quote": ""}).Want(200).JSON(&action)
	for _, fields := range []map[string]any{
		{"outcome": "dismiss", "reason": "Handled", "node_id": node.ID},
		{"outcome": "dismiss", "reason": "Handled", "priority": nil},
		{"outcome": "reuse", "node_id": node.ID, "issue_id": uuid.NewString(), "due_date": "2026-12-31"},
		{"outcome": "create", "node_id": "invalid"},
		{"outcome": "create", "node_id": node.ID, "due_date": "2026-02-30"},
	} {
		fields["expected_revision"], fields["decision_key"] = action.Revision, uuid.NewString()
		callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", action.ID, fields).Want(400)
	}
	callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "dismiss", "reason": "Handled elsewhere"}).Want(200).JSON(&action)
	if action.Status != "dismissed" || action.Issue != nil || action.Reason != "Handled elsewhere" || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 2 {
		t.Fatalf("dismissal created work or lost the reason: %+v", action)
	}
}

func TestCockpitActionHTTPRevisesWrittenResolutions(t *testing.T) {
	ws, meeting, version, node := cockpitActionHTTPFixture(t)
	var action service.CockpitActionView
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "",
		map[string]any{"proposal_key": uuid.NewString(), "title": "Confirm then reconsider"}).Want(200).JSON(&action)
	callCockpitAction(t, testHandler.ResolveCockpitMeetingAction, "POST", "/resolve", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "create", "node_id": node.ID}).Want(200).JSON(&action)
	createdIssue := action.Issue.ID
	// A revision without a reason never reaches the service layer.
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "dismiss"}).Want(400)
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "dismiss", "reason": "Tracked by the delivery stream", "issue_id": createdIssue}).Want(400)
	revise := map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "dismiss", "reason": "Tracked by the delivery stream"}
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", action.ID, revise).Want(200).JSON(&action)
	if action.Status != "dismissed" || action.Reason != "Tracked by the delivery stream" || action.Issue != nil || action.Resolution == nil || *action.Resolution != "dismiss" {
		t.Fatalf("revision did not rewrite the decision: %+v", action)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2", ws, createdIssue) != 1 {
		t.Fatal("revision deleted the issue the outgoing decision created")
	}
	trail := func() []map[string]any {
		var raw string
		dbfx.QueryRow(t, "SELECT previous_resolutions::text FROM cockpit_meeting_action WHERE id=$1", action.ID).Scan(&raw)
		var entries []map[string]any
		if err := json.Unmarshal([]byte(raw), &entries); err != nil {
			t.Fatalf("previous_resolutions is not a JSON trail: %v (%s)", err, raw)
		}
		return entries
	}
	if entries := trail(); len(entries) != 1 || entries[0]["resolution"] != "create" || entries[0]["issue_id"] != createdIssue {
		t.Fatalf("outgoing decision missing from the trail: %+v", entries)
	}
	// Replaying the same revision command is idempotent over HTTP.
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", action.ID, revise).Want(200).JSON(&action)
	if action.Status != "dismissed" || len(trail()) != 1 {
		t.Fatalf("revision replay appended history: %+v", action)
	}
	// dismissed -> create: the revision builds ordinary backlog work again.
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", action.ID,
		map[string]any{"expected_revision": action.Revision, "decision_key": uuid.NewString(), "outcome": "create", "node_id": node.ID, "priority": "high", "reason": "Scope returned to this meeting"}).Want(200).JSON(&action)
	if action.Status != "accepted" || action.Issue == nil || action.Issue.ID == createdIssue || action.Issue.Priority != "high" {
		t.Fatalf("recreate revision = %+v", action)
	}
	if entries := trail(); len(entries) != 2 || entries[1]["resolution"] != "dismiss" || entries[1]["reason"] != "Tracked by the delivery stream" {
		t.Fatalf("dismissal missing from the trail: %+v", entries)
	}
	// A pending suggestion is confirmed, never revised.
	var pending service.CockpitActionView
	callCockpitAction(t, testHandler.CreateCockpitMeetingAction, "POST", "/actions", ws, meeting.ID, version.ID, "",
		map[string]any{"proposal_key": uuid.NewString(), "title": "Still pending"}).Want(200).JSON(&pending)
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", pending.ID,
		map[string]any{"expected_revision": pending.Revision, "decision_key": uuid.NewString(), "outcome": "dismiss", "reason": "No decision exists"}).Want(409)
	callCockpitAction(t, testHandler.ReviseCockpitMeetingActionResolution, "POST", "/revise", ws, meeting.ID, "", pending.ID,
		map[string]any{"expected_revision": pending.Revision, "decision_key": uuid.NewString(), "outcome": "create", "node_id": node.ID, "reason": "No decision exists"}).Want(409)
	if action.Issue.Status != "backlog" {
		t.Fatalf("recreated issue lost its backlog state: %+v", action.Issue)
	}
}

func TestCockpitActionHTTPHumanAndWorkspaceBoundaries(t *testing.T) {
	ws, meeting, version, node := cockpitActionHTTPFixture(t)
	for _, source := range []string{"task_token", "cloud_pat"} {
		for _, endpoint := range []struct {
			handler http.HandlerFunc
			method  string
		}{
			{testHandler.CreateCockpitMeetingAction, "POST"}, {testHandler.UpdateCockpitMeetingAction, "PATCH"},
			{testHandler.ResolveCockpitMeetingAction, "POST"}, {testHandler.ReviseCockpitMeetingActionResolution, "POST"}, {testHandler.CreateCockpitNodeTask, "POST"}, {testHandler.SetCockpitIssuePrimaryNode, "PUT"},
		} {
			req := testutil.WithURLParams(cockpitRequest(endpoint.method, "/actions", ws, map[string]any{}), "meetingId", meeting.ID, "versionId", version.ID, "actionId", uuid.NewString(), "id", node.ID)
			req.Header.Set("X-Actor-Source", source)
			testutil.Call(t, cockpitHandler(endpoint.handler), req).Want(403)
		}
	}
	foreign := cockpitFixture(t, "Action foreign workspace")
	callCockpitAction(t, testHandler.ListCockpitMeetingActions, "GET", "/actions", foreign, meeting.ID, "", "", nil).Want(404)
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitNodeTasks), testutil.WithURLParams(cockpitRequest("GET", "/tasks", foreign, nil), "id", node.ID)).Want(404)
	for _, query := range []string{"page_size=0", "page_size=101", "page_size=bad", "version_id=bad"} {
		callCockpitAction(t, testHandler.ListCockpitMeetingActions, "GET", "/actions?"+query, ws, meeting.ID, "", "", nil).Want(400)
	}
	other := dbfx.User(t, "Ordinary member", "action-member-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, ws, other, "member")
	req := testutil.WithURLParams(cockpitRequest("POST", "/actions", ws, map[string]any{"proposal_key": uuid.NewString(), "title": "No management authority"}), "meetingId", meeting.ID, "versionId", version.ID)
	req.Header.Set("X-User-ID", other)
	testutil.Call(t, cockpitHandler(testHandler.CreateCockpitMeetingAction), req).Want(403)
}

func TestCockpitPrimaryHTTPCreationReplayAndExplicitOwnership(t *testing.T) {
	ws, _, _, node := cockpitActionHTTPFixture(t)
	var task service.CockpitIssueSummary
	key := uuid.NewString()
	body := map[string]any{"creation_key": key, "title": "Direct L3 work"}
	create := func() {
		t.Helper()
		testutil.Call(t, cockpitHandler(testHandler.CreateCockpitNodeTask), testutil.WithURLParams(cockpitRequest("POST", "/tasks", ws, body), "id", node.Code)).Want(200).JSON(&task)
	}
	create()
	firstID := task.ID
	if task.CreationKey == nil || *task.CreationKey != key || task.PrimaryNodeID == nil || *task.PrimaryNodeID != node.ID {
		t.Fatalf("creation receipt missing: %+v", task)
	}
	create()
	if task.ID != firstID {
		t.Fatal("direct creation replay duplicated its task")
	}
	var primary service.CockpitPrimaryView
	getPrimary := testutil.WithURLParams(cockpitRequest("GET", "/primary", ws, nil), "issueId", task.Identifier)
	testutil.Call(t, cockpitHandler(testHandler.GetCockpitIssuePrimaryNode), getPrimary).Want(200).JSON(&primary)
	if primary.NodeID == nil || *primary.NodeID != node.ID {
		t.Fatalf("identifier did not resolve primary: %+v", primary)
	}
	second := createNode(t, ws, map[string]any{"code": "second-execution", "parent_id": *node.ParentID})
	move := testutil.WithURLParams(cockpitRequest("PUT", "/primary", ws, map[string]any{"expected_revision": primary.Revision, "node_id": second.ID}), "issueId", task.Identifier)
	testutil.Call(t, cockpitHandler(testHandler.SetCockpitIssuePrimaryNode), move).Want(200).JSON(&primary)
	create()
	if task.ID != firstID || task.PrimaryNodeID == nil || *task.PrimaryNodeID != second.ID || task.CreationKey == nil || *task.CreationKey != key {
		t.Fatalf("replay moved ownership back or lost its receipt: %+v", task)
	}
	var page service.CockpitNodeTaskPage
	for _, relation := range []string{"primary", "reference"} {
		testutil.Call(t, cockpitHandler(testHandler.ListCockpitNodeTasks), testutil.WithURLParams(cockpitRequest("GET", "/tasks?relation="+relation, ws, nil), "id", node.ID)).Want(200).JSON(&page)
		want := int64(0)
		if relation == "reference" {
			want = 1
		}
		if page.Total != want || page.Summary.Total != want {
			t.Fatalf("relation=%s wrong scope counts: %+v", relation, page)
		}
	}
	clear := testutil.WithURLParams(cockpitRequest("PUT", "/primary", ws, map[string]any{"expected_revision": primary.Revision, "node_id": nil}), "issueId", task.ID)
	testutil.Call(t, cockpitHandler(testHandler.SetCockpitIssuePrimaryNode), clear).Want(200).JSON(&primary)
	if primary.NodeID != nil {
		t.Fatal("explicit clear retained primary")
	}
	create()
	if task.ID != firstID || task.PrimaryNodeID != nil {
		t.Fatal("creation replay resurrected cleared ownership")
	}
}
