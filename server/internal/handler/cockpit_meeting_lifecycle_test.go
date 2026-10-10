package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func lifecycleHTTPFixture(t *testing.T) (string, CockpitMeetingResponse) {
	t.Helper()
	ws, m := newCockpitWorkflowHTTPFixture(t)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_agenda WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_agenda_reference WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", ws)
	return ws, m
}
func callLifecycle(t *testing.T, fn http.HandlerFunc, method, ws, meeting, agenda, reference string, body any) *testutil.Response {
	t.Helper()
	r := testutil.WithURLParams(cockpitRequest(method, "/lifecycle", ws, body), "meetingId", meeting, "agendaId", agenda, "referenceId", reference)
	return testutil.Call(t, cockpitHandler(fn), r)
}
func TestCockpitMeetingLifecycleHTTPPreservesLegacyWorkflowAndScope(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	var h service.CockpitMeetingLifecycleHeader
	callLifecycle(t, testHandler.GetCockpitMeetingLifecycle, "GET", ws, m.ID, "", "", nil).Want(200).JSON(&h)
	if h.WorkflowEnabled || h.Occurrence.State != "unconfirmed" || !h.CanEnd {
		t.Fatalf("unconfigured lifecycle: %+v", h)
	}
	var w CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, "POST", ws, m.ID, "", "", map[string]any{"reviewer_id": testUserID}).Want(200).JSON(&w)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, "PATCH", ws, m.ID, "", "", map[string]any{"expected_revision": w.Revision, "ended": true, "materials_ready": true}).Want(200).JSON(&w)
	callLifecycle(t, testHandler.GetCockpitMeetingLifecycle, "GET", ws, m.ID, "", "", nil).Want(200).JSON(&h)
	if w.EndedAt == nil || h.Occurrence.EndedAt == nil || *w.EndedAt != *h.Occurrence.EndedAt || h.Occurrence.ActualEndedAt != nil || !h.Materials.Ready {
		t.Fatalf("old/new authority diverged: %+v %+v", w, h)
	}
	var compact CockpitWorkflowSummaryResponse
	callCockpitWorkflow(t, testHandler.GetCockpitWorkflowSummary, "GET", ws, m.ID, "", "", nil).Want(200).JSON(&compact)
	if compact.EndedAt == nil || *compact.EndedAt != *w.EndedAt {
		t.Fatal("bounded workflow lost legacy end projection")
	}
	foreign := cockpitMeetingFixture(t, "other lifecycle")
	callLifecycle(t, testHandler.GetCockpitMeetingLifecycle, "GET", foreign, m.ID, "", "", nil).Want(404)
	r := testutil.WithURLParams(cockpitRequest("POST", "/occurrence", ws, map[string]any{"command_key": uuid.NewString(), "expected_revision": h.LifecycleRevision, "transition": "correct_times", "reason": "machine", "actual_ended_at": nil}), "meetingId", m.ID)
	r.Header.Set("X-Actor-Source", "cloud_pat")
	testutil.Call(t, cockpitHandler(testHandler.ChangeCockpitMeetingOccurrence), r).Want(403)
	callLifecycle(t, testHandler.ChangeCockpitMeetingOccurrence, "POST", ws, m.ID, "", "", map[string]any{"command_key": uuid.NewString(), "expected_revision": h.LifecycleRevision, "transition": "end", "run_id": uuid.NewString()}).Want(400)
}
func TestCockpitMeetingAgendaHTTPBacklogAndExactRemoval(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	create := map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "title": "  Data review  ", "notes": "  preserved notes\n"}
	var a service.CockpitLifecycleCommandResult
	callLifecycle(t, testHandler.SaveCockpitMeetingAgenda, "POST", ws, m.ID, "", "", create).Want(200).JSON(&a)
	if a.Receipt.Agenda.Title != "Data review" || a.Receipt.Agenda.Notes != "  preserved notes\n" || a.Current.AgendaTotal != 1 {
		t.Fatalf("agenda content receipt: %+v", a)
	}
	agenda := *a.Receipt.AgendaID
	prep := map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "primary_node_id": nil, "new_issue": map[string]any{"title": "Gather the records", "description": "Preserve primary evidence", "assignee_type": nil, "assignee_id": nil, "priority": "none", "project_id": nil, "module_id": nil, "due_date": nil}}
	var made service.CockpitLifecycleCommandResult
	callLifecycle(t, testHandler.CreateCockpitMeetingPreparationIssue, "POST", ws, m.ID, agenda, "", prep).Want(200).JSON(&made)
	if made.Receipt.Reference.Issue.Status != "backlog" || made.Receipt.Reference.Issue.AssigneeID != nil || made.Receipt.IssueID == nil {
		t.Fatalf("explicit prep task did not stay inert: %+v", made)
	}
	dbfx.Exec(t, "UPDATE issue SET title='Edited later',status='done' WHERE workspace_id=$1 AND id=$2", ws, *made.Receipt.IssueID)
	var replay service.CockpitLifecycleCommandResult
	callLifecycle(t, testHandler.CreateCockpitMeetingPreparationIssue, "POST", ws, m.ID, agenda, "", prep).Want(200).JSON(&replay)
	if !replay.Replayed || replay.Receipt.Reference.Issue.Status != "backlog" || replay.Receipt.Reference.Issue.Title != "Gather the records" {
		t.Fatal("replay used mutable task facts")
	}
	var refs service.CockpitIssueReferencePage[service.CockpitIssueMeetingReference]
	r := testutil.WithURLParams(cockpitRequest("GET", "/refs", ws, nil), "issueId", *made.Receipt.IssueID, "id", *made.Receipt.IssueID)
	testutil.Call(t, cockpitHandler(testHandler.ListCockpitIssueMeetingReferences), r).Want(200).JSON(&refs)
	if len(refs.Items) != 1 || refs.Items[0].HasDirectReference || !refs.Items[0].HasAgendaReference || refs.Items[0].CanUnlink {
		t.Fatalf("prep return path missing: %+v", refs)
	}
	remove := map[string]any{"command_key": uuid.NewString(), "expected_revision": made.Receipt.Revision}
	callLifecycle(t, testHandler.RemoveCockpitAgendaReference, "POST", ws, m.ID, agenda, *made.Receipt.ReferenceID, remove).Want(200)
	callLifecycle(t, testHandler.RemoveCockpitAgendaReference, "POST", ws, m.ID, agenda, *made.Receipt.ReferenceID, remove).Want(200).JSON(&replay)
	if !replay.Replayed || replay.Receipt.Reference.RemovedAt == nil {
		t.Fatal("successful remove lost terminal replay")
	}
	callLifecycle(t, testHandler.CreateCockpitMeetingPreparationIssue, "POST", ws, m.ID, agenda, "", prep).Want(410)
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 1 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", ws) != 0 {
		t.Fatal("preparation replay created extra work")
	}
	// A meeting without formal retained facts remains explicitly deletable.
	callLifecycle(t, testHandler.DeleteCockpitMeeting, "DELETE", ws, m.ID, "", "", nil).Want(204)
	callLifecycle(t, testHandler.SaveCockpitMeetingAgenda, "POST", ws, m.ID, "", "", create).Want(410)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_agenda WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_lifecycle_command WHERE workspace_id=$1", ws) != 3 {
		t.Fatal("meeting deletion lost command tombstones or left agenda rows")
	}
}

func TestCockpitMeetingAgendaGraphProjectsOnlyActiveScopedRelationships(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	var a, prep service.CockpitLifecycleCommandResult
	callLifecycle(t, testHandler.SaveCockpitMeetingAgenda, "POST", ws, m.ID, "", "", map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "title": "Prepare meeting inputs"}).Want(200).JSON(&a)
	callLifecycle(t, testHandler.CreateCockpitMeetingPreparationIssue, "POST", ws, m.ID, *a.Receipt.AgendaID, "", map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "new_issue": map[string]any{"title": "Collect primary inputs", "priority": "none"}}).Want(200).JSON(&prep)
	assertEdge := func(want int) {
		t.Helper()
		var g graphPayload
		testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph), graphRequest("GET", "/api/issues/graph", ws)).Want(200).JSON(&g)
		count := 0
		for _, e := range g.Edges {
			if e.Kind == "meeting" && e.Source == "mtg:"+m.ID && e.Target == *prep.Receipt.IssueID {
				count++
			}
		}
		if count != want {
			t.Fatalf("meeting source edges=%d want%d: %+v", count, want, g.Edges)
		}
	}
	assertEdge(1)
	dbfx.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": ws, "meeting_id": m.ID, "issue_id": *prep.Receipt.IssueID, "role": ""}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", ws, m.ID, *prep.Receipt.IssueID)
	assertEdge(1)
	dbfx.Exec(t, "DELETE FROM cockpit_meeting_issue WHERE workspace_id=$1 AND meeting_id=$2", ws, m.ID)
	dbfx.Exec(t, "UPDATE cockpit_meeting_agenda_reference SET removed_at=now() WHERE workspace_id=$1", ws)
	assertEdge(0)
	dbfx.Exec(t, "UPDATE cockpit_meeting_agenda_reference SET removed_at=NULL WHERE workspace_id=$1", ws)
	dbfx.Exec(t, "UPDATE cockpit_meeting_agenda SET removed_at=now() WHERE workspace_id=$1", ws)
	assertEdge(0)
	foreignWS, foreignMeeting := lifecycleHTTPFixture(t)
	dbfx.Exec(t, "UPDATE cockpit_meeting_agenda SET removed_at=NULL WHERE workspace_id=$1", ws)
	dbfx.Exec(t, "UPDATE cockpit_meeting_agenda_reference SET meeting_id=$2 WHERE workspace_id=$1", ws, foreignMeeting.ID)
	assertEdge(0)
	var other graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph), graphRequest("GET", "/api/issues/graph", foreignWS)).Want(200).JSON(&other)
	for _, edge := range other.Edges {
		if edge.Target == *prep.Receipt.IssueID {
			t.Fatal("agenda graph crossed workspace")
		}
	}
}

func TestCockpitMeetingLifecycleContextProtectsUnboundAgendaBoard(t *testing.T) {
	ws, m := lifecycleHTTPFixture(t)
	var header service.CockpitSurfaceContext
	contextRead := func() {
		t.Helper()
		testutil.Call(t, cockpitHandler(testHandler.GetCockpitSurfaceContext), cockpitRequest("GET", "/context", ws, nil)).Want(200).JSON(&header)
	}
	contextRead()
	if header.HasMeetingLifecycle || header.HasMeetingWorkflows || header.HasStableBindings {
		t.Fatal("empty meeting was treated as confirmed lifecycle history")
	}
	callLifecycle(t, testHandler.SaveCockpitMeetingAgenda, "POST", ws, m.ID, "", "", map[string]any{"command_key": uuid.NewString(), "expected_revision": 1, "title": "Project-level discussion without an L3"}).Want(200)
	contextRead()
	if !header.HasMeetingLifecycle || header.HasMeetingWorkflows || header.HasStableBindings {
		t.Fatalf("independent agenda guard missing or other flags falsified: %+v", header)
	}
	testutil.Call(t, cockpitHandler(testHandler.ImportCockpit), cockpitRequest("PUT", "/import", ws, map[string]any{"nodes": []any{}})).Want(409)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_agenda WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("rejected replacement lost agenda")
	}
}
