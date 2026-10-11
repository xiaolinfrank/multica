package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func preparationFixture(t *testing.T) cockpitWorkflowFixture {
	t.Helper()
	f := lifecycleFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_template WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_template_version WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1", f.ws)
	return f
}

func TestCockpitPreparationCancellationDisclosesWakeupsAndSeparatesExactRunStops(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, application, _ := preparationTemplate(t, f, 1)
	steps := preparationEffects(t, f, application.Current.ID)
	preparationApply(t, f, application.Current.ID, steps[0])
	created := preparationApply(t, f, application.Current.ID, steps[1])
	issueID, _ := preparationUUID(created.Receipt.IssueID)
	agent := f.privateAgentOwnedBy(t, f.UserID, "preparation-stop")
	var runtimeID string
	if err := f.Pool.QueryRow(ctx, "SELECT runtime_id::text FROM agent WHERE id=$1", agent).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	wake := wakeCreate(t, f.principalFixture, &IssueWakeupService{Tasks: f.svc.TaskSvc}, issueID, WakeupInput{AgentID: agent, Kind: "event", EventTypes: []string{"comment.created"}, Instruction: "Inspect an explicitly supplied update."})
	f.Cleanup(t, "DELETE FROM issue_wakeup WHERE issue_id=$1", issueID)
	f.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1", wake.ID)
	running := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "running", "started_at": testutil.Raw("now()")})
	queued := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "queued"})
	wakeupTask := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "queued", "context": testutil.Raw(fmt.Sprintf("'{\"wakeup_id\":\"%s\"}'::jsonb", util.UUIDToString(wake.ID)))})
	issue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issueID})
	if e != nil {
		t.Fatal(e)
	}
	status := "cancelled"
	input := CockpitCancellationPreviewInput{Reason: "Cancel the meeting while retaining its recorded work.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issueID), ExpectedRevision: issue.Revision, Action: "cancel", CancelStatus: &status}}, RunIDs: []string{}}
	preview, e := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), input)
	if e != nil || !preview.CanConfirm || len(preview.Effects) != 1 {
		t.Fatalf("preview %+v %v", preview, e)
	}
	impact := preview.Effects[0].IssueImpact
	if impact == nil || impact.OrdinaryWakeupCount != 1 || impact.UnstartedWakeupRunCount != 1 || impact.OtherQueuedRunCount != 1 || impact.ActiveRunCount != 1 || preview.UnselectedRunTotal != 3 {
		t.Fatalf("close effects were concealed or merged: %+v %+v", impact, preview)
	}
	operation, e := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: input, ContextToken: preview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	result := preparationApply(t, f, operation.Current.ID, preparationEffects(t, f, operation.Current.ID)[0])
	if result.Receipt.StoppedWakeupTotal != 1 || result.Receipt.CancelledQueueTotal != 1 || len(result.Receipt.CancelledQueueIDs) != 1 || result.Receipt.CancelledQueueIDs[0] != wakeupTask || len(result.Receipt.FactsHash) != 64 {
		t.Fatalf("actual close receipt: %+v", result.Receipt)
	}
	for id, want := range map[string]string{running: "running", queued: "queued", wakeupTask: "cancelled"} {
		row, e := f.q.GetAgentTask(ctx, parseTestUUID(t, id))
		if e != nil || row.Status != want {
			t.Fatalf("Issue close changed unselected run %s: %s want%s %v", id, row.Status, want, e)
		}
	}
	before, e := f.issues.GetCockpitMeetingLifecycle(ctx, lifecycleRead(f))
	if e != nil {
		t.Fatal(e)
	}
	stopInput := CockpitCancellationPreviewInput{Reason: "Now stop only the selected running task.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{running}}
	stopPreview, e := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), stopInput)
	if e != nil || !stopPreview.CanConfirm || stopPreview.Intent != "append_disposition" {
		t.Fatalf("append preview: %+v %v", stopPreview, e)
	}
	stopping, e := f.issues.AppendCockpitMeetingDisposition(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(stopPreview.LifecycleRevision), CockpitCancellationPreviewInput: stopInput, ContextToken: stopPreview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	if stopping.Receipt.Occurrence == nil || *stopping.Receipt.Occurrence.CancelledAt != *before.Occurrence.CancelledAt || stopping.Receipt.Occurrence.CancelledReason != before.Occurrence.CancelledReason {
		t.Fatal("append replaced the original cancellation fact")
	}
	stopped := preparationApply(t, f, stopping.Current.ID, preparationEffects(t, f, stopping.Current.ID)[0])
	if stopped.Receipt.RunID == nil || *stopped.Receipt.RunID != running || !stopped.Receipt.Changed || stopped.Receipt.RunStatus == nil || *stopped.Receipt.RunStatus != "cancelled" {
		t.Fatalf("exact stop receipt: %+v", stopped)
	}
	remaining, e := f.q.GetAgentTask(ctx, parseTestUUID(t, queued))
	if e != nil || remaining.Status != "queued" {
		t.Fatal("exact stop expanded into other tasks", e)
	}
}

func preparationTemplate(t *testing.T, f cockpitWorkflowFixture, tasks int) (CockpitMeetingTemplateSaveResult, CockpitPreparationCommandResult, CockpitTemplateApplicationInput) {
	t.Helper()
	ctx := context.Background()
	in := templateInputFixture()
	first := in.Config.Slots[0]
	task := in.Config.Slots[1]
	in.Config.Slots = []CockpitMeetingTemplateSlot{first}
	for i := 0; i < tasks; i++ {
		next := task
		next.SlotID = util.UUIDToString(dbid.NewV7())
		copyIssue := *task.NewIssue
		copyIssue.Title = fmt.Sprintf("Preparation %02d", i)
		next.NewIssue = &copyIssue
		in.Config.Slots = append(in.Config.Slots, next)
	}
	saved, e := f.issues.SaveCockpitMeetingTemplate(ctx, CockpitMeetingTemplateQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true}, in)
	if e != nil {
		t.Fatal(e)
	}
	bindings := []CockpitMeetingTemplateBinding{}
	for _, slot := range in.Config.Slots {
		bindings = append(bindings, CockpitMeetingTemplateBinding{SlotID: slot.SlotID, Selected: true})
	}
	previewIn := CockpitTemplateApplicationPreviewInput{TemplateVersionID: saved.Receipt.ID, Bindings: bindings}
	preview, e := f.issues.PreviewCockpitTemplateApplication(ctx, lifecycleRead(f), previewIn)
	if e != nil || !preview.CanConfirm {
		t.Fatalf("preview: %+v %v", preview, e)
	}
	command := CockpitTemplateApplicationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitTemplateApplicationPreviewInput: previewIn, ContextToken: preview.ContextToken}
	operation, e := f.issues.CreateCockpitTemplateApplication(ctx, lifecycleRead(f), command)
	if e != nil {
		t.Fatal(e)
	}
	return saved, operation, command
}

func preparationEffects(t *testing.T, f cockpitWorkflowFixture, operation string) []CockpitPreparationEffect {
	t.Helper()
	id, e := util.ParseUUID(operation)
	if e != nil {
		t.Fatal(e)
	}
	page, e := f.issues.ListCockpitPreparationEffects(context.Background(), CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: id, PageSize: 100})
	if e != nil {
		t.Fatal(e)
	}
	return page.Items
}

func preparationApply(t *testing.T, f cockpitWorkflowFixture, operation string, effect CockpitPreparationEffect) CockpitPreparationEffectResult {
	t.Helper()
	op, _ := util.ParseUUID(operation)
	id, _ := util.ParseUUID(effect.ID)
	out, e := f.issues.ApplyCockpitPreparationEffect(context.Background(), CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: op, EffectID: id}, CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}, IssueCreateOpts{})
	if e != nil {
		t.Fatalf("apply %s/%s: %v", effect.Kind, effect.ID, e)
	}
	return out
}

func TestCockpitPreparationMultipleEffectsAdvanceWithoutInvalidatingOwnAuthorization(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, operation, command := preparationTemplate(t, f, 30)
	effects := preparationEffects(t, f, operation.Current.ID)
	if len(effects) != 31 {
		t.Fatal("fixture lost effects")
	}
	var last CockpitPreparationEffectResult
	for _, effect := range effects {
		last = preparationApply(t, f, operation.Current.ID, effect)
	}
	if last.Current.State != "completed" || last.Current.Counts.Applied != 31 || last.Current.Counts.Total != 31 {
		t.Fatalf("not all authorized effects completed: %+v", last.Current)
	}
	var issues, backlog, runs int
	if e := f.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM issue WHERE workspace_id=$1),(SELECT count(*) FROM issue WHERE workspace_id=$1 AND status='backlog'),(SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1)", f.ws).Scan(&issues, &backlog, &runs); e != nil {
		t.Fatal(e)
	}
	if issues != 30 || backlog != 30 || runs != 0 {
		t.Fatalf("authorization dispatched or lost preparation: issues=%d backlog=%d runs=%d", issues, backlog, runs)
	}
	replay, e := f.issues.CreateCockpitTemplateApplication(ctx, lifecycleRead(f), command)
	if e != nil || !replay.Replayed || replay.Receipt.ContextToken != operation.Receipt.ContextToken || replay.Current.Counts.Applied != 31 {
		t.Fatalf("fixed application receipt/current progress: %+v %v", replay, e)
	}
	lastReplay := preparationApply(t, f, operation.Current.ID, effects[len(effects)-1])
	if !lastReplay.Replayed || lastReplay.Receipt.Issue == nil || lastReplay.Receipt.Issue.Status != "backlog" {
		t.Fatal("effect replay replaced the original task receipt")
	}
}

func TestCockpitPreparationPrearchiveAuthorizationResumesAndSkipReceiptIsExact(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, operation, _ := preparationTemplate(t, f, 1)
	op, _ := util.ParseUUID(operation.Current.ID)
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: op}
	paused, e := f.issues.ControlCockpitPreparationOperation(ctx, p, CockpitPreparationControlInput{CockpitLifecycleCommandInput: lifecycleInput(operation.Current.Revision), Transition: "pause"})
	if e != nil {
		t.Fatal(e)
	}
	h, e := f.issues.GetCockpitMeetingLifecycle(ctx, lifecycleRead(f))
	if e != nil {
		t.Fatal(e)
	}
	archived, e := f.issues.ChangeCockpitMeetingDisposition(ctx, lifecycleRead(f), CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "archive", Reason: "Keep the already authorized preparation available."})
	if e != nil || archived.Current.Archive.ArchivedAt == nil {
		t.Fatal(e)
	}
	resumed, e := f.issues.ControlCockpitPreparationOperation(ctx, p, CockpitPreparationControlInput{CockpitLifecycleCommandInput: lifecycleInput(paused.Current.Revision), Transition: "resume"})
	if e != nil || !resumed.Current.CanContinue {
		t.Fatalf("archival stranded existing authorization: %+v %v", resumed, e)
	}
	effects := preparationEffects(t, f, operation.Current.ID)
	first := preparationApply(t, f, operation.Current.ID, effects[0])
	effect := effects[1].ID
	skipped, e := f.issues.ControlCockpitPreparationOperation(ctx, p, CockpitPreparationControlInput{CockpitLifecycleCommandInput: lifecycleInput(first.Current.Revision), Transition: "skip", EffectID: &effect, Reason: "This task is no longer needed."})
	if e != nil {
		t.Fatal(e)
	}
	if skipped.Receipt.EffectID == nil || *skipped.Receipt.EffectID != effect || len(skipped.Receipt.EffectIDs) != 1 || skipped.Receipt.EffectIDs[0] != effect || skipped.Current.State != "completed" {
		t.Fatalf("skip cannot be confirmed exactly: %+v", skipped)
	}
	if _, e = f.issues.CreateCockpitMeetingPreparationIssue(ctx, lifecycleRead(f), mustLifecycleUUID(first.Receipt.AgendaID), CockpitPreparationIssueInput{CockpitLifecycleCommandInput: lifecycleInput(1), NewIssue: CockpitPreparationIssueFields{Title: "Unapproved new preparation"}}, IssueCreateOpts{}); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("direct creation bypassed archive: %v", e)
	}
}

func TestCockpitPreparationReauthorizationPreservesIntentAndRejectsOldInflightGrant(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, application, _ := preparationTemplate(t, f, 1)
	effects := preparationEffects(t, f, application.Current.ID)
	preparationApply(t, f, application.Current.ID, effects[0])
	created := preparationApply(t, f, application.Current.ID, effects[1])
	issueID, _ := preparationUUID(created.Receipt.IssueID)
	issue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issueID})
	if e != nil {
		t.Fatal(e)
	}
	due := "2026-12-20"
	previewInput := CockpitCancellationPreviewInput{Reason: "The meeting will not occur; preserve this preparation for the revised date.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issueID), ExpectedRevision: issue.Revision, Action: "change_due_date", DueDate: &due}}, RunIDs: []string{}}
	preview, e := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), previewInput)
	if e != nil || !preview.CanConfirm {
		t.Fatalf("cancellation preview: %+v %v", preview, e)
	}
	cancelled, e := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: previewInput, ContextToken: preview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	step := preparationEffects(t, f, cancelled.Current.ID)[0]
	op, _ := util.ParseUUID(cancelled.Current.ID)
	id, _ := util.ParseUUID(step.ID)
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: op, EffectID: id}
	params := RetainedIssueUpdateFields(issue)
	params.Priority = pgtype.Text{String: "high", Valid: true}
	if _, e = f.q.UpdateIssue(ctx, params); e != nil {
		t.Fatal(e)
	}
	oldInput := CockpitPreparationEffectApplyInput{CommandKey: step.CommandKey, AuthorizationKey: step.AuthorizationKey, AuthorizationRevision: step.AuthorizationRevision}
	if _, e = f.issues.ApplyCockpitPreparationEffect(ctx, p, oldInput, IssueCreateOpts{}); !errors.Is(e, ErrCockpitPreparationContextChanged) {
		t.Fatalf("stale intent was not stopped: %v", e)
	}
	newPreview, e := f.issues.PreviewCockpitPreparationReauthorization(ctx, p)
	if e != nil || !newPreview.CanConfirm || newPreview.CurrentImpact == nil || newPreview.PreviousAuthorization.Impact == nil || newPreview.CurrentImpact.IssueRevision == newPreview.PreviousAuthorization.Impact.IssueRevision {
		t.Fatalf("new/old impact unavailable: %+v %v", newPreview, e)
	}
	grantInput := CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: lifecycleInput(newPreview.EffectRevision), ContextToken: newPreview.ContextToken, Reason: "I checked the updated task and confirm the same due date."}
	grant, e := f.issues.ReauthorizeCockpitPreparationEffect(ctx, p, grantInput)
	if e != nil || grant.Receipt.Authorization == nil {
		t.Fatalf("reauthorize: %+v %v", grant, e)
	}
	if _, e = f.issues.ApplyCockpitPreparationEffect(ctx, p, oldInput, IssueCreateOpts{}); !errors.Is(e, ErrCockpitPreparationContextChanged) {
		t.Fatalf("old request borrowed new authorization: %v", e)
	}
	current, e := f.issues.GetCockpitPreparationEffect(ctx, p)
	if e != nil || current.Effect.State != "pending" {
		t.Fatalf("old request poisoned fresh authorization: %+v %v", current, e)
	}
	result := preparationApply(t, f, cancelled.Current.ID, current.Effect)
	if result.Receipt.Issue == nil || result.Receipt.Issue.DueDate == nil || *result.Receipt.Issue.DueDate != due || result.Receipt.AuthorizationKey != grantInput.CommandKey || result.Receipt.AuthorizationRevision != 2 || !result.Receipt.Changed || len(result.Receipt.FactsHash) != 64 {
		t.Fatalf("wrong effect receipt: %+v", result)
	}
	if _, e = f.issues.ReauthorizeCockpitPreparationEffect(ctx, p, CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: lifecycleInput(current.Effect.Revision), ContextToken: newPreview.ContextToken, Reason: "Repeat"}); !errors.Is(e, ErrCockpitPreparationContextChanged) {
		t.Fatalf("applied effect was reopened: %v", e)
	}
}

func TestCockpitPreparationDerivedScopeCanBeExplicitlyReauthorized(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	meeting, err := f.q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "Original project")
	module := f.Module(t, project, "Original module")
	nextProject := f.Project(t, "Confirmed replacement project")
	nextModule := f.Module(t, nextProject, "Confirmed replacement module")
	root := f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": util.UUIDToString(meeting.CockpitID), "name": "Module", "code": "M", "project_id": project, "module_id": module})
	node := f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": util.UUIDToString(meeting.CockpitID), "name": "Stable delivery", "code": "L3", "parent_id": root})
	f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1", f.ws)
	in := templateInputFixture()
	saved, err := f.issues.SaveCockpitMeetingTemplate(ctx, CockpitMeetingTemplateQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true}, in)
	if err != nil {
		t.Fatal(err)
	}
	bindings := []CockpitMeetingTemplateBinding{{SlotID: in.Config.Slots[0].SlotID, Selected: true, NodeID: &node}, {SlotID: in.Config.Slots[1].SlotID, Selected: true}}
	previewInput := CockpitTemplateApplicationPreviewInput{TemplateVersionID: saved.Receipt.ID, Bindings: bindings}
	preview, err := f.issues.PreviewCockpitTemplateApplication(ctx, lifecycleRead(f), previewInput)
	if err != nil || !preview.CanConfirm {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	application, err := f.issues.CreateCockpitTemplateApplication(ctx, lifecycleRead(f), CockpitTemplateApplicationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitTemplateApplicationPreviewInput: previewInput, ContextToken: preview.ContextToken})
	if err != nil {
		t.Fatal(err)
	}
	effects := preparationEffects(t, f, application.Current.ID)
	preparationApply(t, f, application.Current.ID, effects[0])
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_node SET project_id=$2,module_id=$3 WHERE workspace_id=$1 AND id=$4", f.ws, nextProject, nextModule, root); err != nil {
		t.Fatal(err)
	}
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: parseTestUUID(t, application.Current.ID), EffectID: parseTestUUID(t, effects[1].ID)}
	old := CockpitPreparationEffectApplyInput{CommandKey: effects[1].CommandKey, AuthorizationKey: effects[1].AuthorizationKey, AuthorizationRevision: effects[1].AuthorizationRevision}
	if _, err = f.issues.ApplyCockpitPreparationEffect(ctx, p, old, IssueCreateOpts{}); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("changed mapping silently accepted: %v", err)
	}
	review, err := f.issues.PreviewCockpitPreparationReauthorization(ctx, p)
	if err != nil || !review.CanConfirm || review.CurrentScope == nil || review.PreviousAuthorization.Scope == nil || review.CurrentScope.NodeID == nil || *review.CurrentScope.NodeID != node || *review.CurrentScope.ProjectID != nextProject || *review.PreviousAuthorization.Scope.ProjectID != project {
		t.Fatalf("derived scope cannot be reviewed: %+v %v", review, err)
	}
	grant, err := f.issues.ReauthorizeCockpitPreparationEffect(ctx, p, CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: lifecycleInput(review.EffectRevision), ContextToken: review.ContextToken, Reason: "Confirm the same delivery in its newly assigned project and module."})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.ApplyCockpitPreparationEffect(ctx, p, old, IssueCreateOpts{}); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("old grant borrowed new scope: %v", err)
	}
	current, err := f.issues.GetCockpitPreparationEffect(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	created := preparationApply(t, f, application.Current.ID, current.Effect)
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: mustLifecycleUUID(created.Receipt.IssueID)})
	if err != nil || issue.ProjectID != parseTestUUID(t, nextProject) || issue.ModuleID != parseTestUUID(t, nextModule) || created.Receipt.AuthorizationKey != grant.CommandKey {
		t.Fatalf("new grant did not govern created scope: %+v %+v %v", issue, created, err)
	}
	var primary string
	if err = f.Pool.QueryRow(ctx, "SELECT node_id::text FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, issue.ID).Scan(&primary); err != nil || primary != node {
		t.Fatalf("stable primary identity lost: %s %v", primary, err)
	}
}

func TestCockpitPreparationCancelledMeetingCannotBypassLegacyReadiness(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	f.init(t, "")
	agenda, original := lifecycleAgenda(t, f, "Retained agenda", "Original notes")
	previewInput := CockpitCancellationPreviewInput{Reason: "Cancelled before occurrence; keep all existing work.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{}}
	preview, err := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), previewInput)
	if err != nil || !preview.CanConfirm {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	if _, err = f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: previewInput, ContextToken: preview.ContextToken}); err != nil {
		t.Fatal(err)
	}
	yes := true
	if err = f.issues.SetCockpitMeetingReadiness(ctx, CockpitWorkPackageReadiness{CockpitWorkPackageCommand: f.command(t), Ended: &yes, MaterialsReady: &yes}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("legacy readiness reopened cancellation: %v", err)
	}
	if err = f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("legacy release dispatched cancelled meeting: %v", err)
	}
	h, err := f.issues.GetCockpitMeetingLifecycle(ctx, lifecycleRead(f))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.ChangeCockpitMeetingOccurrence(ctx, lifecycleRead(f), CockpitOccurrenceInput{CockpitLifecycleCommandInput: lifecycleInput(h.LifecycleRevision), Transition: "end"}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("new occurrence bypassed reinstate: %v", err)
	}
	if _, err = f.issues.ConfirmCockpitMeetingMaterials(ctx, lifecycleRead(f), CockpitMaterialsInput{CockpitLifecycleCommandInput: lifecycleInput(f.work(t).Revision), MaterialsReady: &yes}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("cancelled materials confirmed: %v", err)
	}
	if _, err = f.issues.SaveCockpitMeetingAgenda(ctx, lifecycleRead(f), pgtype.UUID{}, CockpitAgendaInput{CockpitLifecycleCommandInput: lifecycleInput(h.AgendaRevision), Title: original.Title}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("new agenda bypassed cancellation: %v", err)
	}
	replayed, err := f.issues.SaveCockpitMeetingAgenda(ctx, lifecycleRead(f), pgtype.UUID{}, original)
	if err != nil || !replayed.Replayed {
		t.Fatalf("old receipt cannot be recovered: %+v %v", replayed, err)
	}
	notes := "Retained follow-up notes remain editable."
	if _, err = f.issues.SaveCockpitMeetingAgenda(ctx, lifecycleRead(f), mustLifecycleUUID(agenda.Receipt.AgendaID), CockpitAgendaInput{CockpitLifecycleCommandInput: lifecycleInput(agenda.Receipt.Revision), Notes: &notes}); err != nil {
		t.Fatalf("cancel made retained notes read-only: %v", err)
	}
	var runs int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1", f.ws).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("cancel guard dispatched: %d %v", runs, err)
	}
}

func TestCockpitPreparationMultipleStopsDoNotInvalidateSiblingAuthorization(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, application, _ := preparationTemplate(t, f, 1)
	steps := preparationEffects(t, f, application.Current.ID)
	preparationApply(t, f, application.Current.ID, steps[0])
	created := preparationApply(t, f, application.Current.ID, steps[1])
	issueID := mustLifecycleUUID(created.Receipt.IssueID)
	agent := f.privateAgentOwnedBy(t, f.UserID, "multiple-preparation-stops")
	var runtimeID string
	if err := f.Pool.QueryRow(ctx, "SELECT runtime_id::text FROM agent WHERE id=$1", agent).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	a := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "running", "started_at": testutil.Raw("now()")})
	b := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "queued"})
	unselected := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "running", "started_at": testutil.Raw("now()")})
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issueID})
	if err != nil {
		t.Fatal(err)
	}
	status := "cancelled"
	in := CockpitCancellationPreviewInput{Reason: "Stop only the two selected tasks and then cancel preparation.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issueID), ExpectedRevision: issue.Revision, Action: "cancel", CancelStatus: &status}}, RunIDs: []string{a, b}}
	preview, err := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), in)
	if err != nil || !preview.CanConfirm || preview.UnselectedRunTotal != 1 {
		t.Fatalf("mixed preview: %+v %v", preview, err)
	}
	op, err := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: in, ContextToken: preview.ContextToken})
	if err != nil {
		t.Fatal(err)
	}
	effects := preparationEffects(t, f, op.Current.ID)
	if len(effects) != 3 || effects[0].Kind != "stop_run" || effects[1].Kind != "stop_run" || effects[2].Kind != "cancel_issue" {
		t.Fatalf("unsafe execution order: %+v", effects)
	}
	var last CockpitPreparationEffectResult
	for _, effect := range effects {
		last = preparationApply(t, f, op.Current.ID, effect)
	}
	if last.Current.State != "completed" || last.Receipt.Issue == nil || last.Receipt.Issue.Status != "cancelled" {
		t.Fatalf("same authorization invalidated itself: %+v", last)
	}
	for id, want := range map[string]string{a: "cancelled", b: "cancelled", unselected: "running"} {
		run, err := f.q.GetAgentTask(ctx, parseTestUUID(t, id))
		if err != nil || run.Status != want {
			t.Fatalf("exact selected task %s: %+v %v", id, run, err)
		}
	}
}

func TestCockpitPreparationRunReauthorizationShowsTerminalTargetWithoutStoppingNewRun(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	_, application, _ := preparationTemplate(t, f, 1)
	steps := preparationEffects(t, f, application.Current.ID)
	preparationApply(t, f, application.Current.ID, steps[0])
	created := preparationApply(t, f, application.Current.ID, steps[1])
	issueID := mustLifecycleUUID(created.Receipt.IssueID)
	agent := f.privateAgentOwnedBy(t, f.UserID, "preparation-run-recheck")
	var runtimeID string
	if err := f.Pool.QueryRow(ctx, "SELECT runtime_id::text FROM agent WHERE id=$1", agent).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	selected := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "running", "started_at": testutil.Raw("now()")})
	in := CockpitCancellationPreviewInput{Reason: "Stop the explicitly selected task only.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{selected}}
	preview, err := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), in)
	if err != nil || !preview.CanConfirm {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	op, err := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: in, ContextToken: preview.ContextToken})
	if err != nil {
		t.Fatal(err)
	}
	effect := preparationEffects(t, f, op.Current.ID)[0]
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: parseTestUUID(t, op.Current.ID), EffectID: parseTestUUID(t, effect.ID)}
	newRun := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "queued"})
	old := CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}
	if _, err = f.issues.ApplyCockpitPreparationEffect(ctx, p, old, IssueCreateOpts{}); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("new activity was not surfaced: %v", err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", selected); err != nil {
		t.Fatal(err)
	}
	review, err := f.issues.PreviewCockpitPreparationReauthorization(ctx, p)
	if err != nil || !review.CanConfirm || review.CurrentRun == nil || review.PreviousAuthorization.SelectedRun == nil || review.CurrentRun.ID != selected || review.CurrentRun.Status != "completed" || review.CurrentRun.CanStop || review.PreviousAuthorization.SelectedRun.Status != "running" {
		t.Fatalf("exact target transition concealed: %+v %v", review, err)
	}
	if _, err = f.issues.ReauthorizeCockpitPreparationEffect(ctx, p, CockpitPreparationReauthorizationInput{CockpitLifecycleCommandInput: lifecycleInput(review.EffectRevision), ContextToken: review.ContextToken, Reason: "Record the selected run's completed state; leave new activity alone."}); err != nil {
		t.Fatal(err)
	}
	current, err := f.issues.GetCockpitPreparationEffect(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	observed := preparationApply(t, f, op.Current.ID, current.Effect)
	if observed.Receipt.Changed || observed.Receipt.RunStatus == nil || *observed.Receipt.RunStatus != "completed" || observed.Receipt.RunID == nil || *observed.Receipt.RunID != selected {
		t.Fatalf("terminal observation became a fake cancellation: %+v", observed)
	}
	remaining, err := f.q.GetAgentTask(ctx, parseTestUUID(t, newRun))
	if err != nil || remaining.Status != "queued" {
		t.Fatalf("new unselected task was stopped: %+v %v", remaining, err)
	}
}
