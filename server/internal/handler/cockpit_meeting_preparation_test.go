package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func preparationHTTPHandler() *Handler {
	h := *testHandler
	s := *h.IssueService
	s.CockpitMeetingTemplatesBackendReady = true
	s.CockpitMeetingDispositionBackendReady = true
	h.IssueService = &s
	return &h
}
func preparationHTTPFixture(t *testing.T) (string, CockpitMeetingResponse) {
	t.Helper()
	ws, m := lifecycleHTTPFixture(t)
	for _, table := range []string{"search_index_change", "issue", "cockpit_meeting_template", "cockpit_meeting_template_version", "cockpit_meeting_preparation_operation", "cockpit_meeting_preparation_effect"} {
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
	}
	return ws, m
}
func preparationCall(t *testing.T, fn http.HandlerFunc, method, path, ws string, body any, params ...string) *testutil.Response {
	t.Helper()
	r := testutil.WithURLParams(cockpitRequest(method, path, ws, body), params...)
	return testutil.Call(t, cockpitHandler(fn), r)
}
func preparationTemplateBody() service.CockpitMeetingTemplateSaveInput {
	agenda := uuid.NewString()
	return service.CockpitMeetingTemplateSaveInput{CommandKey: uuid.NewString(), Title: "  Evidence meeting  ", Description: "  Original description\n", Active: true,
		Config: service.CockpitMeetingTemplateConfig{SchemaVersion: 1, Slots: []service.CockpitMeetingTemplateSlot{
			{SlotID: agenda, Kind: "agenda", Label: "  Discuss evidence  ", Agenda: &service.CockpitTemplateAgendaDefaults{Title: "  Evidence discussion  ", Purposes: []string{"planning"}, DesiredOutcome: "  Decide the next step\n", Notes: "  Exact notes\n\n"}},
			{SlotID: uuid.NewString(), Kind: "preparation_issue", Label: "Collect evidence", AgendaSlotID: &agenda, NewIssue: &service.CockpitTemplateIssueDefaults{Title: "  Collect the primary evidence  ", Description: "  Keep the source record\n", Priority: "none"}},
		}}}
}
func createPreparationTemplate(t *testing.T, h *Handler, ws string) (service.CockpitMeetingTemplateSaveInput, service.CockpitMeetingTemplateSaveResult) {
	t.Helper()
	body := preparationTemplateBody()
	var out service.CockpitMeetingTemplateSaveResult
	preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/meeting-templates", ws, body).Want(200).JSON(&out)
	return body, out
}

func TestCockpitPreparationHTTPReadyAndReadDoesNotCreateBoard(t *testing.T) {
	ws := dbfx.Workspace(t, "Template reader", "template-reader-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	h := preparationHTTPHandler()
	var page service.CockpitMeetingTemplatePage
	preparationCall(t, h.ListCockpitMeetingTemplates, "GET", "/meeting-templates", ws, nil).Want(200).JSON(&page)
	if page.WorkspaceID != ws || page.Total != 0 || len(page.Items) != 0 || page.PageSize != 25 {
		t.Fatalf("empty metadata page: %+v", page)
	}
	if dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("template read initialized a board")
	}
	h.IssueService.CockpitMeetingTemplatesBackendReady = false
	preparationCall(t, h.ListCockpitMeetingTemplates, "GET", "/meeting-templates", ws, nil).Want(503)
	preparationCall(t, h.GetCockpitPreparationOperation, "GET", "/preparation", ws, nil, "meetingId", uuid.NewString(), "operationId", uuid.NewString()).Want(503)
	h.IssueService.CockpitMeetingTemplatesBackendReady = true
	h.IssueService.CockpitMeetingDispositionBackendReady = false
	preparationCall(t, h.GetCockpitPreparationOperation, "GET", "/preparation", ws, nil, "meetingId", uuid.NewString(), "operationId", uuid.NewString()).Want(503)
	preparationCall(t, h.GetCockpitMeetingOperationBasis, "GET", "/basis", ws, nil, "meetingId", uuid.NewString()).Want(503)
}

func TestCockpitPreparationHTTPTemplateVersionsAndOriginalRecovery(t *testing.T) {
	ws, _ := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	body, made := createPreparationTemplate(t, h, ws)
	if made.Receipt.Title != "Evidence meeting" || made.Receipt.Description != body.Description || made.Receipt.Config.Slots[0].Agenda.Notes != body.Config.Slots[0].Agenda.Notes {
		t.Fatalf("fixed content changed: %+v", made.Receipt)
	}
	update := body
	update.CommandKey = uuid.NewString()
	update.ExpectedRevision = made.Current.Revision
	update.Title = "Updated template"
	update.Active = false
	var newer service.CockpitMeetingTemplateSaveResult
	preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/versions", ws, update, "templateId", made.TemplateID).Want(200).JSON(&newer)
	if newer.Receipt.Number != 2 || newer.Current.Active {
		t.Fatal("saving inactive config did not create fixed version2")
	}
	var old service.CockpitMeetingTemplateSaveResult
	preparationCall(t, h.GetCockpitMeetingTemplateCommand, "GET", "/commands", ws, nil, "commandKey", body.CommandKey).Want(200).JSON(&old)
	if old.Receipt.ID != made.Receipt.ID || old.Receipt.Config.Slots[0].Agenda.Notes != body.Config.Slots[0].Agenda.Notes || old.Current.CurrentVersion.ID != newer.Receipt.ID {
		t.Fatal("command recovery confused original receipt and current template")
	}
	preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/meeting-templates", ws, body).Want(200).JSON(&old)
	if !old.Replayed || old.Receipt.ID != made.Receipt.ID {
		t.Fatal("original create replay did not retain exact version")
	}
	var versions service.CockpitMeetingTemplateVersionPage
	preparationCall(t, h.ListCockpitMeetingTemplateVersions, "GET", "/versions?page_size=1", ws, nil, "templateId", made.TemplateID).Want(200).JSON(&versions)
	if versions.Total != 2 || len(versions.Items) != 1 || versions.Items[0].ID != newer.Receipt.ID || versions.NextCursor == nil {
		t.Fatalf("version page lost bounds/order: %+v", versions)
	}
	var fixed service.CockpitMeetingTemplateVersionDetail
	preparationCall(t, h.GetCockpitMeetingTemplateVersion, "GET", "/version", ws, nil, "templateId", made.TemplateID, "versionId", made.Receipt.ID).Want(200).JSON(&fixed)
	if fixed.Config.Slots[0].Agenda.Notes != body.Config.Slots[0].Agenda.Notes {
		t.Fatal("historical config read changed whitespace")
	}
	foreign, _ := preparationHTTPFixture(t)
	preparationCall(t, h.GetCockpitMeetingTemplate, "GET", "/template", foreign, nil, "templateId", made.TemplateID).Want(404)
	preparationCall(t, h.GetCockpitMeetingTemplateVersion, "GET", "/version", foreign, nil, "templateId", made.TemplateID, "versionId", made.Receipt.ID).Want(404)
	preparationCall(t, h.GetCockpitMeetingTemplateCommand, "GET", "/commands", foreign, nil, "commandKey", body.CommandKey).Want(404)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_template WHERE workspace_id=$1", ws) != 1 || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_template_version WHERE workspace_id=$1", ws) != 2 {
		t.Fatal("recovery created a new template/version")
	}
}

func TestCockpitPreparationHTTPExplicitApplicationAndExactEffectReplay(t *testing.T) {
	ws, m := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	body, saved := createPreparationTemplate(t, h, ws)
	input := service.CockpitTemplateApplicationPreviewInput{TemplateVersionID: saved.Receipt.ID}
	for _, slot := range body.Config.Slots {
		input.Bindings = append(input.Bindings, service.CockpitMeetingTemplateBinding{SlotID: slot.SlotID, Selected: true})
	}
	var preview service.CockpitTemplateApplicationPreview
	preparationCall(t, h.PreviewCockpitTemplateApplication, "POST", "/preview", ws, input, "meetingId", m.ID).Want(200).JSON(&preview)
	if !preview.CanConfirm || preview.SelectedTotal != 2 || preview.ContextToken == "" {
		t.Fatalf("invalid preview: %+v", preview)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 0 || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_agenda WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("preview performed preparation writes")
	}
	confirm := service.CockpitTemplateApplicationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: preview.LifecycleRevision}, CockpitTemplateApplicationPreviewInput: input, ContextToken: preview.ContextToken}
	var operation service.CockpitPreparationCommandResult
	preparationCall(t, h.CreateCockpitTemplateApplication, "POST", "/application", ws, confirm, "meetingId", m.ID).Want(200).JSON(&operation)
	if operation.Receipt.OperationID != operation.Current.ID || len(operation.Receipt.EffectIDs) != 2 {
		t.Fatal("application acknowledgement lost fixed effects")
	}
	duplicate := confirm
	duplicate.CommandKey = uuid.NewString()
	var conflict map[string]any
	preparationCall(t, h.CreateCockpitTemplateApplication, "POST", "/application", ws, duplicate, "meetingId", m.ID).Want(409).JSON(&conflict)
	for key, want := range map[string]string{"code": "application_exists", "workspace_id": ws, "meeting_id": m.ID, "template_version_id": saved.Receipt.ID, "operation_id": operation.Current.ID, "command_key": duplicate.CommandKey} {
		if conflict[key] != want {
			t.Fatalf("conflict %s=%v want%s", key, conflict[key], want)
		}
	}
	var effects service.CockpitPreparationEffectPage
	preparationCall(t, h.ListCockpitPreparationEffects, "GET", "/effects", ws, nil, "meetingId", m.ID, "operationId", operation.Current.ID).Want(200).JSON(&effects)
	if len(effects.Items) != 2 || effects.Total != 2 {
		t.Fatal("bounded effects omitted authorized work")
	}
	var last service.CockpitPreparationEffectResult
	for _, effect := range effects.Items {
		apply := service.CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}
		preparationCall(t, h.ApplyCockpitPreparationEffect, "POST", "/apply", ws, apply, "meetingId", m.ID, "operationId", operation.Current.ID, "effectId", effect.ID).Want(200).JSON(&last)
	}
	if last.Receipt.Issue == nil || last.Receipt.Issue.Status != "backlog" || last.Receipt.Issue.AssigneeID != nil || last.Receipt.IssueID == nil {
		t.Fatalf("preparation did not create inert exact issue: %+v", last.Receipt)
	}
	oldTitle := last.Receipt.Issue.Title
	dbfx.Exec(t, "UPDATE issue SET title='Changed later',status='done' WHERE workspace_id=$1 AND id=$2", ws, *last.Receipt.IssueID)
	effect := effects.Items[1]
	apply := service.CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}
	preparationCall(t, h.ApplyCockpitPreparationEffect, "POST", "/apply", ws, apply, "meetingId", m.ID, "operationId", operation.Current.ID, "effectId", effect.ID).Want(200).JSON(&last)
	if !last.Replayed || last.Receipt.Issue.Title != oldTitle || last.Receipt.Issue.Status != "backlog" {
		t.Fatal("effect replay read mutable issue as original receipt")
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 1 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", ws) != 0 {
		t.Fatal("application replay created extra work or an Agent run")
	}
	foreign, other := preparationHTTPFixture(t)
	preparationCall(t, h.GetCockpitPreparationEffect, "GET", "/effect", foreign, nil, "meetingId", other.ID, "operationId", operation.Current.ID, "effectId", effect.ID).Want(404)
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

func TestCockpitPreparationHTTPRejectsUnscopedMalformedAndMachineWrites(t *testing.T) {
	ws, m := preparationHTTPFixture(t)
	h := preparationHTTPHandler()
	for _, query := range []string{"?page_size=0", "?page_size=101", "?page_size=no", "?q=" + strings.Repeat("x", 513), "?cursor=" + strings.Repeat("x", 4097), "?project=" + uuid.NewString(), "?include_inactive=wrong", "?page_size=1&page_size=25"} {
		preparationCall(t, h.ListCockpitMeetingTemplates, "GET", "/templates"+query, ws, nil).Want(400)
	}
	preparationCall(t, h.GetCockpitMeetingTemplate, "GET", "/template", ws, nil, "templateId", "not-a-uuid").Want(400)
	preparationCall(t, h.GetCockpitPreparationEffect, "GET", "/effect", ws, nil, "meetingId", m.ID, "operationId", uuid.NewString(), "effectId", "not-a-uuid").Want(400)
	bad := preparationTemplateBody()
	bad.Config.Slots[0].SlotID = "not-a-uuid"
	preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/templates", ws, bad).Want(400)
	validBody, err := json.Marshal(preparationTemplateBody())
	if err != nil {
		t.Fatal(err)
	}
	for _, missing := range []string{"active", "description", "expected_revision", "config"} {
		var incomplete map[string]any
		if err := json.Unmarshal(validBody, &incomplete); err != nil {
			t.Fatal(err)
		}
		delete(incomplete, missing)
		preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/templates", ws, incomplete).Want(400)
	}
	raw := map[string]any{"command_key": uuid.NewString(), "expected_revision": 0, "title": "Strict command", "active": true, "config": preparationTemplateBody().Config, "run_now": true}
	preparationCall(t, h.SaveCockpitMeetingTemplate, "POST", "/templates", ws, raw).Want(400)
	request := cockpitRequest("POST", "/templates", ws, preparationTemplateBody())
	request.Header.Set("X-Actor-Source", "cloud_pat")
	testutil.Call(t, cockpitHandler(h.SaveCockpitMeetingTemplate), request).Want(403)
	request = testutil.WithURLParams(cockpitRequest("POST", "/apply", ws, service.CockpitPreparationEffectApplyInput{CommandKey: uuid.NewString()}), "meetingId", m.ID, "operationId", uuid.NewString(), "effectId", uuid.NewString())
	testutil.Call(t, cockpitHandler(h.ApplyCockpitPreparationEffect), request).Want(400)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_template WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("rejected command changed templates")
	}
}

func TestCockpitPreparationHTTPConflictCarriesOnlyTheSubmittedScope(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/application", nil)
	value := &service.CockpitPreparationExistsError{WorkspaceID: uuid.NewString(), MeetingID: uuid.NewString(), TemplateVersionID: uuid.NewString(), OperationID: uuid.NewString(), CommandKey: uuid.NewString()}
	if !writeCockpitPreparationError(w, r, value) || w.Code != 409 {
		t.Fatal("application conflict not mapped")
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"code": "application_exists", "workspace_id": value.WorkspaceID, "meeting_id": value.MeetingID, "template_version_id": value.TemplateVersionID, "operation_id": value.OperationID, "command_key": value.CommandKey} {
		if body[key] != want {
			t.Fatalf("wrong conflict %s", key)
		}
	}
}

func TestCockpitPreparationHTTPClosedMeetingKeepsMaintenanceButRejectsLegacyAdditions(t *testing.T) {
	for _, disposition := range []string{"cancelled", "archived"} {
		t.Run(disposition, func(t *testing.T) {
			ws, meeting := preparationHTTPFixture(t)
			h := preparationHTTPHandler()
			existing := dbfx.Issue(t, "Existing reference", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			prepared := dbfx.Issue(t, "Existing preparation", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			newIssue := dbfx.Issue(t, "Unconfirmed addition", testutil.Cols{"workspace_id": ws, "status": "backlog"})
			existingNode := createNode(t, ws, map[string]any{"code": "closed-existing", "name": "Existing reference item"})
			newNode := createNode(t, ws, map[string]any{"code": "closed-new", "name": "Unconfirmed reference item"})
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
			preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": newIssue}, "meetingId", meeting.ID).Want(409)
			preparationCall(t, h.AppendCockpitMeetingNode, "POST", "/nodes", ws, map[string]any{"node_id": newNode.ID}, "meetingId", meeting.ID).Want(409)
			preparationCall(t, h.SetCockpitMeetingIssues, "PUT", "/issues", ws, map[string]any{"issue_ids": []string{existing, prepared, newIssue}, "replace": false}, "meetingId", meeting.ID).Want(409)
			preparationCall(t, h.SetCockpitMeetingNodes, "PUT", "/nodes", ws, map[string]any{"node_ids": []string{existingNode.ID, newNode.ID}, "replace": false}, "meetingId", meeting.ID).Want(409)
			setMeetingRoles(t, ws, meeting.ID, existing, map[string]any{"roles": []string{"preparation"}}).Want(409)
			preparationCall(t, h.ProvisionCockpitMeeting, "POST", "/provision", ws, map[string]any{"create_task": true, "create_dir": false, "remember": false}, "meetingId", meeting.ID).Want(409)
			// Existing relations are idempotent; notes and existing purposes remain editable.
			preparationCall(t, h.AppendCockpitMeetingIssue, "POST", "/issues", ws, map[string]any{"issue_id": existing}, "meetingId", meeting.ID).Want(200)
			preparationCall(t, h.AppendCockpitMeetingNode, "POST", "/nodes", ws, map[string]any{"node_id": existingNode.ID}, "meetingId", meeting.ID).Want(200)
			setMeetingRoles(t, ws, meeting.ID, existing, map[string]any{"roles": []string{"support"}}).Want(200)
			setMeetingRoles(t, ws, meeting.ID, prepared, map[string]any{"roles": []string{"preparation", "support"}}).Want(200)
			updated := patchMeeting(t, ws, meeting.ID, map[string]any{"note": "  Preserve this later historical explanation\n"})
			if updated.Note != "  Preserve this later historical explanation\n" {
				t.Fatal("historical notes were lost or trimmed")
			}
			if dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND meeting_id=$2", ws, meeting.ID) != 2 || dbfx.Count(t, "SELECT count(*) FROM cockpit_meeting_node WHERE workspace_id=$1 AND meeting_id=$2", ws, meeting.ID) != 1 || dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 3 {
				t.Fatal("blocked legacy entry added a relation or created a task")
			}
		})
	}
}
