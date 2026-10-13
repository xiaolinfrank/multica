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
	if h.WorkflowEnabled || h.Occurrence.State != "scheduled" || !h.CanEnd {
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
