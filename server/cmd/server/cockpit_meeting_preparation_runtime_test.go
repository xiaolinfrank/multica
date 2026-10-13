package main

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitMeetingPreparationRuntimeRequiresCanonicalTransactions(t *testing.T) {
	for _, h := range []*handler.Handler{nil, {}, {IssueService: &service.IssueService{CockpitMeetingDispositionBackendReady: true}}, {IssueService: service.NewIssueService(db.New(nil), artifactRuntimeNoIOTx{}, nil, nil, &service.TaskService{})}} {
		if enableCockpitMeetingPreparationRuntime(h) {
			t.Fatal("incomplete canonical transaction dependencies advertised preparation")
		}
		if h != nil && h.IssueService != nil && h.IssueService.CockpitMeetingDispositionBackendReady {
			t.Fatal("stale availability survived partial initialization")
		}
	}
	q := db.New(nil)
	tasks := service.NewTaskService(q, artifactRuntimeNoIOTx{}, nil, nil)
	svc := service.NewIssueService(q, artifactRuntimeNoIOTx{}, nil, nil, tasks)
	if !enableCockpitMeetingPreparationRuntime(&handler.Handler{IssueService: svc}) || !svc.CockpitMeetingDispositionBackendReady {
		t.Fatal("fully wired preparation/disposition remained unavailable")
	}
	if svc.CockpitArtifactBackendReady || svc.CockpitArtifactCapturer != nil {
		t.Fatal("preparation availability fabricated storage or artifact readiness")
	}
}

func TestCockpitCancellationEffectsThroughServerRouter(t *testing.T) {
	fx := testutil.New(testPool, testWorkspaceID, testUserID)
	ws := fx.Workspace(t, "Cancellation endpoints", "cancellation-"+uuid.NewString(), testutil.Cols{"issue_prefix": "CAN"})
	fx.Member(t, ws, testUserID, "owner")
	board := fx.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "Cancellation endpoints"})
	meeting := fx.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": ws, "cockpit_id": board, "title": "Cancelled meeting"})
	issue := fx.Issue(t, "Retained preparation", testutil.Cols{"workspace_id": ws, "status": "backlog"})
	fx.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": ws, "meeting_id": meeting, "issue_id": issue, "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", ws, meeting, issue)
	for _, table := range []string{"search_index_change", "activity_log", "cockpit_meeting_lifecycle_command", "cockpit_meeting_preparation_effect", "cockpit_meeting_preparation_operation"} {
		fx.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
	}
	router, h := NewRouterWithOptions(testPool, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil, RouterOptions{})
	if !enableCockpitMeetingPreparationRuntime(h) {
		t.Fatal("canonical cancellation maintenance runtime was not ready")
	}
	base := "/api/cockpit/meetings/" + meeting
	call := func(method, path string, body any) *testutil.Response {
		t.Helper()
		req := testutil.WithHeaders(testutil.JSONRequest(method, base+path, body), "Authorization", "Bearer "+testToken, "X-Workspace-ID", ws)
		return testutil.Call(t, router.ServeHTTP, req)
	}
	var listed service.CockpitPreparationOperationPage
	call(http.MethodGet, "/preparation-operations", nil).Want(http.StatusOK).JSON(&listed)
	if listed.Total != 0 || len(listed.Items) != 0 {
		t.Fatalf("new meeting has unexpected operations: %+v", listed)
	}
	var revision int64
	if err := testPool.QueryRow(context.Background(), "SELECT revision FROM issue WHERE workspace_id=$1 AND id=$2", ws, issue).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	due := "2026-12-18"
	selection := service.CockpitCancellationPreviewInput{Reason: "Cancel the meeting and explicitly retain its preparation.", Issues: []service.CockpitCancellationIssueChoice{{IssueID: issue, ExpectedRevision: revision, Action: "change_due_date", DueDate: &due}}, RunIDs: []string{}}
	var preview service.CockpitCancellationPreview
	call(http.MethodPost, "/cancellation/preview", selection).Want(http.StatusOK).JSON(&preview)
	if !preview.CanConfirm {
		t.Fatalf("cancellation cannot be confirmed: %+v", preview)
	}
	var cancelled service.CockpitPreparationCommandResult
	call(http.MethodPost, "/cancellation", service.CockpitCancellationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: preview.LifecycleRevision}, CockpitCancellationPreviewInput: selection, ContextToken: preview.ContextToken}).Want(http.StatusOK).JSON(&cancelled)
	if cancelled.Current.Kind != "cancel_preparation" || cancelled.Current.Counts.Pending != 1 {
		t.Fatalf("cancellation lost its pending effect: %+v", cancelled)
	}
	opPath := "/preparation-operations/" + cancelled.Current.ID
	var operation service.CockpitPreparationOperationHeader
	call(http.MethodGet, opPath, nil).Want(http.StatusOK).JSON(&operation)
	call(http.MethodGet, "/preparation-operations", nil).Want(http.StatusOK).JSON(&listed)
	if listed.Total != 1 || len(listed.Items) != 1 || listed.Items[0].ID != operation.ID {
		t.Fatalf("cancellation operation cannot be read: %+v", listed)
	}
	var effects service.CockpitPreparationEffectPage
	call(http.MethodGet, opPath+"/effects", nil).Want(http.StatusOK).JSON(&effects)
	if effects.Total != 1 || len(effects.Items) != 1 || effects.Items[0].Kind != "change_due_date" || !effects.Items[0].CanApply {
		t.Fatalf("pending cancellation effect cannot be read: %+v", effects)
	}
	effectPath := opPath + "/effects/" + effects.Items[0].ID
	var detail service.CockpitPreparationEffectDetail
	call(http.MethodGet, effectPath, nil).Want(http.StatusOK).JSON(&detail)
	control := func(transition string) {
		t.Helper()
		var result service.CockpitPreparationCommandResult
		call(http.MethodPost, opPath+"/control", service.CockpitPreparationControlInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: operation.Revision}, Transition: transition, Reason: "Explicit cancellation maintenance."}).Want(http.StatusOK).JSON(&result)
		operation = result.Current
	}
	control("pause")
	if operation.State != "paused" {
		t.Fatal("cancellation maintenance was not paused")
	}
	control("resume")
	original := service.CockpitPreparationEffectApplyInput{CommandKey: detail.Effect.CommandKey, AuthorizationKey: detail.Effect.AuthorizationKey, AuthorizationRevision: detail.Effect.AuthorizationRevision}
	fx.Exec(t, "UPDATE issue SET priority='high',revision=revision+1 WHERE workspace_id=$1 AND id=$2", ws, issue)
	call(http.MethodPost, effectPath+"/apply", original).Want(http.StatusConflict)
	var review service.CockpitPreparationReauthorizationPreview
	call(http.MethodGet, effectPath+"/authorization-preview", nil).Want(http.StatusOK).JSON(&review)
	if !review.CanConfirm || review.CurrentImpact == nil || review.PreviousAuthorization.Impact == nil || review.CurrentImpact.IssueRevision == review.PreviousAuthorization.Impact.IssueRevision {
		t.Fatalf("changed preparation has no explicit recovery: %+v", review)
	}
	var grant service.CockpitPreparationCommandResult
	call(http.MethodPost, effectPath+"/reauthorize", service.CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: review.EffectRevision}, ContextToken: review.ContextToken, Reason: "Confirm the same delivery date for the updated preparation."}).Want(http.StatusOK).JSON(&grant)
	call(http.MethodPost, effectPath+"/apply", original).Want(http.StatusConflict)
	call(http.MethodGet, effectPath, nil).Want(http.StatusOK).JSON(&detail)
	if detail.Effect.State != "pending" || detail.Effect.AuthorizationKey != grant.CommandKey || detail.Effect.AuthorizationRevision != 2 {
		t.Fatalf("old request poisoned the new authorization: %+v", detail)
	}
	apply := service.CockpitPreparationEffectApplyInput{CommandKey: detail.Effect.CommandKey, AuthorizationKey: detail.Effect.AuthorizationKey, AuthorizationRevision: detail.Effect.AuthorizationRevision}
	var applied service.CockpitPreparationEffectResult
	call(http.MethodPost, effectPath+"/apply", apply).Want(http.StatusOK).JSON(&applied)
	if applied.Current.State != "completed" || applied.Receipt.Issue == nil || applied.Receipt.Issue.DueDate == nil || *applied.Receipt.Issue.DueDate != due {
		t.Fatalf("confirmed cancellation effect did not execute: %+v", applied)
	}
	var replay service.CockpitPreparationEffectResult
	call(http.MethodPost, effectPath+"/apply", apply).Want(http.StatusOK).JSON(&replay)
	if !replay.Replayed || replay.Receipt.FactsHash != applied.Receipt.FactsHash {
		t.Fatal("effect retry did not return its fixed receipt")
	}
	if fx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 0 || fx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("cancellation maintenance manufactured work or dispatched it")
	}
	// Historic template operations remain invisible and cannot be resumed or executed.
	retired := fx.Insert(t, "cockpit_meeting_preparation_operation", testutil.Cols{"id": uuid.NewString(), "workspace_id": ws, "meeting_id": meeting, "kind": "apply_template", "command_key": uuid.NewString(), "request_hash": strings.Repeat("a", 64), "context_token": "retired", "template_id": uuid.NewString(), "template_version_id": uuid.NewString(), "input": "{}", "authorized_lifecycle_revision": 1, "authorized_agenda_revision": 1, "created_by": testUserID, "responsible_user_id": testUserID})
	retiredEffect := fx.Insert(t, "cockpit_meeting_preparation_effect", testutil.Cols{"id": uuid.NewString(), "workspace_id": ws, "meeting_id": meeting, "operation_id": retired, "slot_id": uuid.NewString(), "position": 0, "kind": "issue_reference", "label": "Retired template effect", "command_key": uuid.NewString(), "request_hash": strings.Repeat("b", 64), "input": "{}", "authorization_key": uuid.NewString(), "authorization_hash": strings.Repeat("c", 64), "authorization_snapshot": "{}"})
	retiredPath := "/preparation-operations/" + retired
	for _, suffix := range []string{"", "/effects", "/effects/" + retiredEffect, "/effects/" + retiredEffect + "/authorization-preview"} {
		call(http.MethodGet, retiredPath+suffix, nil).Want(http.StatusNotFound)
	}
	call(http.MethodPost, retiredPath+"/control", service.CockpitPreparationControlInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: 1}, Transition: "resume"}).Want(http.StatusNotFound)
	call(http.MethodPost, retiredPath+"/effects/"+retiredEffect+"/apply", service.CockpitPreparationEffectApplyInput{CommandKey: uuid.NewString(), AuthorizationKey: uuid.NewString(), AuthorizationRevision: 1}).Want(http.StatusNotFound)
	call(http.MethodPost, retiredPath+"/effects/"+retiredEffect+"/reauthorize", service.CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: service.CockpitLifecycleCommandInput{CommandKey: uuid.NewString(), ExpectedRevision: 1}, ContextToken: "retired", Reason: "Must remain retired."}).Want(http.StatusNotFound)
	call(http.MethodGet, "/preparation-operations", nil).Want(http.StatusOK).JSON(&listed)
	if listed.Total != 1 || len(listed.Items) != 1 || listed.Items[0].Kind != "cancel_preparation" {
		t.Fatalf("retired template leaked into cancellation operations: %+v", listed)
	}
	call(http.MethodPost, "/template-applications", map[string]any{}).Want(http.StatusNotFound)
}
