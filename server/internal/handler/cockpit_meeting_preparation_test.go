package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func preparationHTTPHandler() *Handler {
	h := *testHandler
	s := *h.IssueService
	s.CockpitMeetingDispositionBackendReady = true
	h.IssueService = &s
	return &h
}
func preparationHTTPFixture(t *testing.T) (string, CockpitMeetingResponse) {
	t.Helper()
	ws, m := lifecycleHTTPFixture(t)
	for _, table := range []string{"search_index_change", "issue", "cockpit_meeting_preparation_operation", "cockpit_meeting_preparation_effect"} {
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
	}
	return ws, m
}
func preparationCall(t *testing.T, fn http.HandlerFunc, method, path, ws string, body any, params ...string) *testutil.Response {
	t.Helper()
	r := testutil.WithURLParams(cockpitRequest(method, path, ws, body), params...)
	return testutil.Call(t, cockpitHandler(fn), r)
}

func TestCockpitPreparationHTTPCancellationAndArchivePreserveFacts(t *testing.T) {
	ws, m := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	selection := service.CockpitCancellationPreviewInput{Reason: "The external session was cancelled.", Issues: []service.CockpitCancellationIssueChoice{}, RunIDs: []string{}}
	var preview service.CockpitCancellationPreview
	preparationCall(t, h.PreviewCockpitMeetingCancellation, "POST", "/preview", ws, selection, "meetingId", m.ID).Want(200).JSON(&preview)
	if !preview.CanConfirm || preview.AffectedIssueTotal != 0 || preview.ActiveRunTotal != 0 {
		t.Fatalf("empty cancellation preview: %+v", preview)
	}
	input := service.CockpitCancellationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: preview.LifecycleRevision}, CockpitCancellationPreviewInput: selection, ContextToken: preview.ContextToken}
	var cancelled service.CockpitPreparationCommandResult
	preparationCall(t, h.CancelCockpitMeeting, "POST", "/cancel", ws, input, "meetingId", m.ID).Want(200).JSON(&cancelled)
	if cancelled.Receipt.Occurrence == nil || cancelled.Receipt.Occurrence.State != "cancelled" || cancelled.Receipt.Occurrence.EndedAt != nil {
		t.Fatalf("cancellation falsified meeting occurrence: %+v", cancelled.Receipt)
	}
	var live service.CockpitMeetingLifecycleHeader
	callLifecycle(t, h.GetCockpitMeetingLifecycle, "GET", ws, m.ID, "", "", nil).Want(200).JSON(&live)
	for _, transition := range []string{"archive", "unarchive", "reinstate"} {
		var result service.CockpitLifecycleCommandResult
		in := service.CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: live.LifecycleRevision}, Transition: transition, Reason: "Explicit disposition by the meeting owner"}
		preparationCall(t, h.ChangeCockpitMeetingDisposition, "POST", "/disposition", ws, in, "meetingId", m.ID).Want(200).JSON(&result)
		live = result.Current
		if result.Action != transition || result.CommandKey != in.CommandKey {
			t.Fatal("disposition returned a different command")
		}
	}
	if live.Occurrence.State == "cancelled" || live.Occurrence.EndedAt != nil || live.Occurrence.ActualStartedAt != nil {
		t.Fatal("reinstatement started or ended the meeting")
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("meeting disposition created tasks")
	}
}

func TestCockpitPreparationHTTPRejectsMalformedAndMachineWrites(t *testing.T) {
	ws, m := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	request := testutil.WithURLParams(cockpitRequest("POST", "/cancellation", ws, map[string]any{}), "meetingId", m.ID)
	request.Header.Set("X-Actor-Source", "cloud_pat")
	testutil.Call(t, cockpitHandler(h.CancelCockpitMeeting), request).Want(403)
}

func TestCockpitPreparationHTTPClosedMeetingAllowsReferenceEditsWithoutExecutingWork(t *testing.T) {
	for _, disposition := range []string{"cancelled", "archived", "ended"} {
		t.Run(disposition, func(t *testing.T) {
			ws, meeting := preparationHTTPFixture(t)
			h := preparationHTTPHandler()
			existing := dbfx.Issue(t, "Existing reference", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			prepared := dbfx.Issue(t, "Existing preparation", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			newIssue := dbfx.Issue(t, "Direct reference", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			bulkIssue := dbfx.Issue(t, "Bulk reference", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			replacementIssue := dbfx.Issue(t, "Replacement reference", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			existingNode := createNode(t, ws, map[string]any{"code": "closed-existing", "name": "Existing reference item"})
			newNode := createNode(t, ws, map[string]any{"code": "closed-new", "name": "Direct reference item"})
			bulkNode := createNode(t, ws, map[string]any{"code": "closed-bulk", "name": "Bulk reference item"})
			replacementNode := createNode(t, ws, map[string]any{"code": "closed-replace", "name": "Replacement reference item"})
			for _, issue := range []string{existing, prepared} {
				preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": issue}, "meetingId", meeting.ID).Want(200)
			}
			preparationCall(t, h.AppendCockpitMeetingNode, "POST", "/nodes", ws, map[string]any{"node_id": existingNode.ID}, "meetingId", meeting.ID).Want(200)
			setMeetingRoles(t, ws, meeting.ID, prepared, map[string]any{"roles": []string{"preparation"}}).Want(200)
			var lifecycle service.CockpitMeetingLifecycleHeader
			callLifecycle(t, h.GetCockpitMeetingLifecycle, "GET", ws, meeting.ID, "", "", nil).Want(200).JSON(&lifecycle)
			if disposition == "archived" {
				preparationCall(t, h.ChangeCockpitMeetingDisposition, "POST", "/disposition", ws, service.CockpitMeetingDispositionInput{
					CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: lifecycle.LifecycleRevision}, Transition: "archive", Reason: "Retain this historical meeting.",
				}, "meetingId", meeting.ID).Want(200)
			} else if disposition == "ended" {
				preparationCall(t, h.ChangeCockpitMeetingOccurrence, "POST", "/occurrence", ws, service.CockpitOccurrenceInput{
					CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: lifecycle.LifecycleRevision}, Transition: "end",
				}, "meetingId", meeting.ID).Want(200)
			} else {
				selection := service.CockpitCancellationPreviewInput{Reason: "The meeting will not occur; retain every existing task.", Issues: []service.CockpitCancellationIssueChoice{}, RunIDs: []string{}}
				var preview service.CockpitCancellationPreview
				preparationCall(t, h.PreviewCockpitMeetingCancellation, "POST", "/preview", ws, selection, "meetingId", meeting.ID).Want(200).JSON(&preview)
				if !preview.CanConfirm || preview.SelectedTotal != 0 {
					t.Fatal("retaining all preparation was not an explicit valid cancellation")
				}
				preparationCall(t, h.CancelCockpitMeeting, "POST", "/cancel", ws, service.CockpitCancellationInput{
					CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: preview.LifecycleRevision}, CockpitCancellationPreviewInput: selection, ContextToken: preview.ContextToken,
				}, "meetingId", meeting.ID).Want(200)
			}
			// Associations classify existing work; they do not resume the meeting or execute a task.
			preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": newIssue}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.AppendCockpitMeetingNode, "POST", "/nodes", ws, map[string]any{"node_id": newNode.ID}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.SetCockpitMeetingIssues, "PUT", "/issues", ws, map[string]any{"issue_ids": []string{bulkIssue}, "replace": false}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.SetCockpitMeetingNodes, "PUT", "/nodes", ws, map[string]any{"node_ids": []string{bulkNode.ID}, "replace": false}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.SetCockpitMeetingIssues, "PUT", "/issues", ws, map[string]any{"issue_ids": []string{existing, prepared, newIssue, bulkIssue, replacementIssue}, "replace": true}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.SetCockpitMeetingNodes, "PUT", "/nodes", ws, map[string]any{"node_ids": []string{existingNode.ID, newNode.ID, bulkNode.ID, replacementNode.ID}, "replace": true}, "meetingId", meeting.ID).Want(200)
			setMeetingRoles(t, ws, meeting.ID, existing, map[string]any{"roles": []string{"preparation"}}).Want(200)
			setMeetingRoles(t, ws, meeting.ID, existing, map[string]any{"roles": []string{}}).Want(200)
			preparationCall(t, h.DeleteCockpitMeetingIssue, "DELETE", "/issues", ws, nil, "meetingId", meeting.ID, "issueId", newIssue).Want(http.StatusNoContent)
			preparationCall(t, h.DeleteCockpitMeetingNode, "DELETE", "/nodes", ws, nil, "meetingId", meeting.ID, "nodeId", newNode.ID).Want(http.StatusNoContent)
			if disposition != "ended" {
				preparationCall(t, h.ProvisionCockpitMeeting, "POST", "/provision", ws, map[string]any{"create_task": true, "create_dir": false, "remember": false}, "meetingId", meeting.ID).Want(409)
			}
			// Existing relations are idempotent; notes and existing purposes remain editable.
			preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": existing}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.AppendCockpitMeetingNode, "POST", "/nodes", ws, map[string]any{"node_id": existingNode.ID}, "meetingId", meeting.ID).Want(200)
			setMeetingRoles(t, ws, meeting.ID, existing, map[string]any{"roles": []string{"support"}}).Want(200)
			setMeetingRoles(t, ws, meeting.ID, prepared, map[string]any{"roles": []string{"preparation", "support"}}).Want(200)
			updated := patchMeeting(t, ws, meeting.ID, map[string]any{"note": "  Preserve this later historical explanation\n"})
			if updated.Note != "  Preserve this later historical explanation\n" {
				t.Fatal("historical notes were lost or trimmed")
			}
			if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND meeting_id=$2", ws, meeting.ID) != 4 || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_node WHERE workspace_id=$1 AND meeting_id=$2", ws, meeting.ID) != 3 || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 5 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1", ws) != 0 {
				t.Fatal("reference edits lost relations or created/executed work")
			}
			var after service.CockpitMeetingLifecycleHeader
			callLifecycle(t, h.GetCockpitMeetingLifecycle, "GET", ws, meeting.ID, "", "", nil).Want(200).JSON(&after)
			if (disposition == "archived" && after.Archive.ArchivedAt == nil) || (disposition != "archived" && after.Occurrence.State != disposition) {
				t.Fatal("reference edits changed the meeting's disposition")
			}
		})
	}
}

func TestCockpitMeetingRetiredAgendaHistoryRequiresArchiveInsteadOfDeletion(t *testing.T) {
	ws, meeting := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	agenda := dbfx.Insert(t, "cockpit_meeting_agenda", testutil.Cols{
		"id": uuid.NewString(), "workspace_id": ws, "meeting_id": meeting.ID, "title": "Retained historical discussion", "sort_order": 0,
		"created_by": dbfx.UserID, "updated_by": dbfx.UserID,
	})
	preparationCall(t, h.DeleteCockpitMeeting, "DELETE", "/meeting", ws, nil, "meetingId", meeting.ID).Want(http.StatusConflict)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_agenda WHERE workspace_id=$1 AND id=$2", ws, agenda) != 1 {
		t.Fatal("retiring the editor discarded its historical discussion")
	}
	var basis service.CockpitMeetingOperationBasis
	preparationCall(t, h.GetCockpitMeetingOperationBasis, "GET", "/basis", ws, nil, "meetingId", meeting.ID).Want(http.StatusOK).JSON(&basis)
	if basis.Delete.State != "blocked" {
		t.Fatal("meeting deletion affordance ignored retained historical discussion")
	}
}

func TestCockpitPreparationHTTPCancellationOperationGuards(t *testing.T) {
	ws, meeting := preparationHTTPFixture(t)
	foreign := cockpitMeetingFixture(t, "Foreign cancellation scope")
	h := preparationHTTPHandler()
	disabled := preparationHTTPHandler()
	disabled.IssueService.CockpitMeetingDispositionBackendReady = false
	operation, effect := uuid.NewString(), uuid.NewString()
	apply := service.CockpitPreparationEffectApplyInput{CommandKey: uuid.NewString(), AuthorizationKey: uuid.NewString(), AuthorizationRevision: 1}
	control := service.CockpitPreparationControlInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: 1}, Transition: "pause"}
	reauthorize := service.CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: 1}, ContextToken: "explicit-context", Reason: "Confirm the fixed intent."}
	for _, endpoint := range []struct {
		name, method    string
		fn, unavailable http.HandlerFunc
		body            any
	}{
		{"list", "GET", h.ListCockpitPreparationOperations, disabled.ListCockpitPreparationOperations, nil},
		{"show", "GET", h.GetCockpitPreparationOperation, disabled.GetCockpitPreparationOperation, nil},
		{"effects", "GET", h.ListCockpitPreparationEffects, disabled.ListCockpitPreparationEffects, nil},
		{"effect", "GET", h.GetCockpitPreparationEffect, disabled.GetCockpitPreparationEffect, nil},
		{"authorization", "GET", h.PreviewCockpitPreparationReauthorization, disabled.PreviewCockpitPreparationReauthorization, nil},
		{"apply", "POST", h.ApplyCockpitPreparationEffect, disabled.ApplyCockpitPreparationEffect, apply},
		{"control", "POST", h.ControlCockpitPreparationOperation, disabled.ControlCockpitPreparationOperation, control},
		{"reauthorize", "POST", h.ReauthorizeCockpitPreparationEffect, disabled.ReauthorizeCockpitPreparationEffect, reauthorize},
	} {
		t.Run(endpoint.name, func(t *testing.T) {
			params := []string{"meetingId", meeting.ID, "operationId", operation, "effectId", effect}
			preparationCall(t, endpoint.unavailable, endpoint.method, "/operation", ws, endpoint.body, params...).Want(http.StatusServiceUnavailable)
			preparationCall(t, endpoint.fn, endpoint.method, "/operation?unknown=true", ws, endpoint.body, params...).Want(http.StatusBadRequest)
			preparationCall(t, endpoint.fn, endpoint.method, "/operation", foreign, endpoint.body, params...).Want(http.StatusNotFound)
			if endpoint.name == "list" {
				preparationCall(t, endpoint.fn, endpoint.method, "/operation?page_size=0", ws, nil, "meetingId", meeting.ID).Want(http.StatusBadRequest)
			} else {
				preparationCall(t, endpoint.fn, endpoint.method, "/operation", ws, endpoint.body, "meetingId", meeting.ID, "operationId", "invalid", "effectId", effect).Want(http.StatusBadRequest)
			}
			if endpoint.method == "POST" {
				request := testutil.WithURLParams(cockpitRequest(endpoint.method, "/operation", ws, endpoint.body), params...)
				request.Header.Set("X-Actor-Source", "cloud_pat")
				testutil.Call(t, cockpitHandler(endpoint.fn), request).Want(http.StatusForbidden)
			}
		})
	}
	preparationCall(t, h.ApplyCockpitPreparationEffect, "POST", "/apply", ws, map[string]any{"command_key": operation, "authorization_key": effect, "authorization_revision": 0}, "meetingId", meeting.ID, "operationId", operation, "effectId", effect).Want(http.StatusBadRequest)
	preparationCall(t, h.ApplyCockpitPreparationEffect, "POST", "/apply", ws, map[string]any{"command_key": operation, "authorization_key": "invalid", "authorization_revision": 1}, "meetingId", meeting.ID, "operationId", operation, "effectId", effect).Want(http.StatusBadRequest)
}

func TestCockpitPreparationHTTPLinksMeetingWithoutRetiredAgenda(t *testing.T) {
	ws, meeting := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	target := createMeeting(t, ws, map[string]any{"title": "Next meeting", "meet_date": "2026-10-15"})
	issue := dbfx.Issue(t, "Retained preparation", testutil.Cols{"workspace_id": ws, "status": "backlog"})
	preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": issue}, "meetingId", meeting.ID).Want(http.StatusOK)
	setMeetingRoles(t, ws, meeting.ID, issue, map[string]any{"roles": []string{"preparation"}}).Want(http.StatusOK)
	var impact service.CockpitCancellationImpactPage
	preparationCall(t, h.ListCockpitCancellationImpact, "GET", "/impact", ws, nil, "meetingId", meeting.ID).Want(http.StatusOK).JSON(&impact)
	if len(impact.Items) != 1 {
		t.Fatalf("preparation is not discoverable: %+v", impact)
	}
	selection := map[string]any{"reason": "Retain the Issue and link it to the next meeting.", "issues": []map[string]any{{"issue_id": issue, "expected_revision": impact.Items[0].IssueRevision, "action": "link_meeting", "target_meeting_id": target.ID}}, "run_ids": []string{}}
	var preview service.CockpitCancellationPreview
	preparationCall(t, h.PreviewCockpitMeetingCancellation, "POST", "/preview", ws, selection, "meetingId", meeting.ID).Want(http.StatusOK).JSON(&preview)
	if !preview.CanConfirm {
		t.Fatalf("agenda-free direct association is not confirmable: %+v", preview)
	}
	selection["command_key"], selection["expected_revision"], selection["context_token"] = uuid.NewString(), preview.LifecycleRevision, preview.ContextToken
	var operation service.CockpitPreparationCommandResult
	preparationCall(t, h.CancelCockpitMeeting, "POST", "/cancel", ws, selection, "meetingId", meeting.ID).Want(http.StatusOK).JSON(&operation)
	var effects service.CockpitPreparationEffectPage
	preparationCall(t, h.ListCockpitPreparationEffects, "GET", "/effects", ws, nil, "meetingId", meeting.ID, "operationId", operation.Current.ID).Want(http.StatusOK).JSON(&effects)
	if len(effects.Items) != 1 || effects.Items[0].Kind != "link_meeting" {
		t.Fatalf("direct association has no fixed effect: %+v", effects)
	}
	effect := effects.Items[0]
	preparationCall(t, h.ApplyCockpitPreparationEffect, "POST", "/apply", ws, service.CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}, "meetingId", meeting.ID, "operationId", operation.Current.ID, "effectId", effect.ID).Want(http.StatusOK)
	preparationCall(t, h.ListCockpitCancellationImpact, "GET", "/impact", ws, nil, "meetingId", target.ID).Want(http.StatusOK).JSON(&impact)
	if len(impact.Items) != 1 || impact.Items[0].Issue.ID != issue {
		t.Fatalf("linked preparation purpose was lost at the HTTP boundary: %+v", impact)
	}
}
