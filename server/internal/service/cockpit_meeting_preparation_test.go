package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
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
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1", f.ws)
	return f
}

// preparationIssue creates one issue linked to the meeting as preparation
// work — the state a meeting reaches once its materials are prepared.
func preparationIssue(t *testing.T, f cockpitWorkflowFixture, title string) pgtype.UUID {
	t.Helper()
	id := parseTestUUID(t, f.Issue(t, title))
	f.Exec(t, "INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,position,roles) VALUES($1,$2,$3,0,'{preparation}')", f.ws, f.meeting, id)
	return id
}

// preparationCancel previews and confirms a cancellation, returning the
// disposition operation whose effects carry out the plan.
func preparationCancel(t *testing.T, f cockpitWorkflowFixture, in CockpitCancellationPreviewInput) (CockpitCancellationPreview, CockpitPreparationCommandResult) {
	t.Helper()
	ctx := context.Background()
	preview, e := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycleRead(f), in)
	if e != nil || !preview.CanConfirm {
		t.Fatalf("cancellation preview: %+v %v", preview, e)
	}
	operation, e := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitCancellationPreviewInput: in, ContextToken: preview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	return preview, operation
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

func TestCockpitPreparationCancellationDisclosesWakeupsAndSeparatesExactRunStops(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	issueID := preparationIssue(t, f, "Collect the primary evidence")
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
	preview, operation := preparationCancel(t, f, input)
	if len(preview.Effects) != 1 {
		t.Fatalf("preview effects: %+v", preview)
	}
	impact := preview.Effects[0].IssueImpact
	if impact == nil || impact.OrdinaryWakeupCount != 1 || impact.UnstartedWakeupRunCount != 1 || impact.OtherQueuedRunCount != 1 || impact.ActiveRunCount != 1 || preview.UnselectedRunTotal != 3 {
		t.Fatalf("close effects were concealed or merged: %+v %+v", impact, preview)
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

func TestCockpitPreparationMultipleEffectsAdvanceWithoutInvalidatingOwnAuthorization(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	issueIDs := make([]string, 0, 30)
	choices := make([]CockpitCancellationIssueChoice, 0, 30)
	for i := 0; i < 30; i++ {
		id := preparationIssue(t, f, fmt.Sprintf("Preparation %02d", i))
		issueIDs = append(issueIDs, util.UUIDToString(id))
	}
	status := "cancelled"
	for _, sid := range issueIDs {
		row, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: parseTestUUID(t, sid)})
		if e != nil {
			t.Fatal(e)
		}
		choices = append(choices, CockpitCancellationIssueChoice{IssueID: sid, ExpectedRevision: row.Revision, Action: "cancel", CancelStatus: &status})
	}
	in := CockpitCancellationPreviewInput{Reason: "Cancel the meeting; retain every prepared task as cancelled work.", Issues: choices, RunIDs: []string{}}
	preview, operation := preparationCancel(t, f, in)
	command := CockpitCancellationInput{CockpitLifecycleCommandInput: CockpitLifecycleCommandInput{CommandKey: operation.CommandKey, ExpectedRevision: preview.LifecycleRevision}, CockpitCancellationPreviewInput: in, ContextToken: preview.ContextToken}
	effects := preparationEffects(t, f, operation.Current.ID)
	if len(effects) != 30 {
		t.Fatalf("fixture lost effects: %d", len(effects))
	}
	var last CockpitPreparationEffectResult
	for _, effect := range effects {
		last = preparationApply(t, f, operation.Current.ID, effect)
	}
	if last.Current.State != "completed" || last.Current.Counts.Applied != 30 || last.Current.Counts.Total != 30 {
		t.Fatalf("not all authorized effects completed: %+v", last.Current)
	}
	var issues, cancelled, runs int
	if e := f.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM issue WHERE workspace_id=$1),(SELECT count(*) FROM issue WHERE workspace_id=$1 AND status='cancelled'),(SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1)", f.ws).Scan(&issues, &cancelled, &runs); e != nil {
		t.Fatal(e)
	}
	if issues != 30 || cancelled != 30 || runs != 0 {
		t.Fatalf("authorization dispatched or lost preparation: issues=%d cancelled=%d runs=%d", issues, cancelled, runs)
	}
	replay, e := f.issues.CancelCockpitMeeting(ctx, lifecycleRead(f), command)
	if e != nil || !replay.Replayed || replay.Receipt.RequestHash != operation.Receipt.RequestHash || replay.Receipt.ContextToken != operation.Receipt.ContextToken || replay.Current.Counts.Applied != 30 {
		t.Fatalf("fixed cancellation receipt/current progress: %+v %v", replay, e)
	}
	lastReplay := preparationApply(t, f, operation.Current.ID, effects[len(effects)-1])
	if !lastReplay.Replayed || lastReplay.Receipt.Issue == nil || lastReplay.Receipt.Issue.ID != issueIDs[29] || lastReplay.Receipt.Issue.Status != "cancelled" {
		t.Fatal("effect replay replaced the original task receipt")
	}
}

func TestCockpitPreparationPrearchiveAuthorizationResumesAndSkipReceiptIsExact(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	first := preparationIssue(t, f, "Keep the checked evidence")
	second := preparationIssue(t, f, "Drop the duplicate survey")
	choices := []CockpitCancellationIssueChoice{}
	status := "cancelled"
	for _, sid := range []string{util.UUIDToString(first), util.UUIDToString(second)} {
		row, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: parseTestUUID(t, sid)})
		if e != nil {
			t.Fatal(e)
		}
		choices = append(choices, CockpitCancellationIssueChoice{IssueID: sid, ExpectedRevision: row.Revision, Action: "cancel", CancelStatus: &status})
	}
	_, operation := preparationCancel(t, f, CockpitCancellationPreviewInput{Reason: "Cancel before the archive keeps the authorized preparation available.", Issues: choices, RunIDs: []string{}})
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
	applied := preparationApply(t, f, operation.Current.ID, effects[0])
	effect := effects[1].ID
	skipped, e := f.issues.ControlCockpitPreparationOperation(ctx, p, CockpitPreparationControlInput{CockpitLifecycleCommandInput: lifecycleInput(applied.Current.Revision), Transition: "skip", EffectID: &effect, Reason: "This task is no longer needed."})
	if e != nil {
		t.Fatal(e)
	}
	if skipped.Receipt.EffectID == nil || *skipped.Receipt.EffectID != effect || len(skipped.Receipt.EffectIDs) != 1 || skipped.Receipt.EffectIDs[0] != effect || skipped.Current.State != "completed" {
		t.Fatalf("skip cannot be confirmed exactly: %+v", skipped)
	}
	basis, e := f.issues.GetCockpitMeetingOperationBasis(ctx, lifecycleRead(f))
	if e != nil || basis.AddPreparation.State != "blocked" || basis.CanAddPreparation || len(basis.AddPreparation.ReasonCodes) != 1 || basis.AddPreparation.ReasonCodes[0] != "meeting_cancelled" {
		t.Fatalf("cancelled archived meeting lost its preparation guard: %+v %v", basis.AddPreparation, e)
	}
	if e = RequireCockpitMeetingPreparationOpen(ctx, f.q, f.ws, f.meeting); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("cancelled archived meeting accepted new preparation: %v", e)
	}
	if _, e = f.issues.ChangeCockpitMeetingDisposition(ctx, lifecycleRead(f), CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(archived.Current.LifecycleRevision), Transition: "reinstate", Reason: "Withdraw cancellation without changing the archive."}); e != nil {
		t.Fatal(e)
	}
	basis, e = f.issues.GetCockpitMeetingOperationBasis(ctx, lifecycleRead(f))
	if e != nil || basis.AddPreparation.State != "blocked" || basis.CanAddPreparation || len(basis.AddPreparation.ReasonCodes) != 1 || basis.AddPreparation.ReasonCodes[0] != "meeting_archived" {
		t.Fatalf("reinstating the meeting bypassed its archive guard: %+v %v", basis.AddPreparation, e)
	}
	if e = RequireCockpitMeetingPreparationOpen(ctx, f.q, f.ws, f.meeting); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("archived meeting accepted new preparation: %v", e)
	}
}

func TestCockpitPreparationReauthorizationPreservesIntentAndRejectsOldInflightGrant(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	issueID := preparationIssue(t, f, "Collect the primary evidence")
	issue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issueID})
	if e != nil {
		t.Fatal(e)
	}
	due := "2026-12-20"
	previewInput := CockpitCancellationPreviewInput{Reason: "The meeting will not occur; preserve this preparation for the revised date.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issueID), ExpectedRevision: issue.Revision, Action: "change_due_date", DueDate: &due}}, RunIDs: []string{}}
	_, cancelled := preparationCancel(t, f, previewInput)
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
	issue := preparationIssue(t, f, "Stable delivery")
	setScope := func(projectID, moduleID string) {
		t.Helper()
		row, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issue})
		if e != nil {
			t.Fatal(e)
		}
		params := RetainedIssueUpdateFields(row)
		params.ProjectID, params.ModuleID = parseTestUUID(t, projectID), parseTestUUID(t, moduleID)
		if _, e = f.q.UpdateIssue(ctx, params); e != nil {
			t.Fatal(e)
		}
	}
	setScope(project, module)
	primaryBinding, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: issue, NodeID: parseTestUUID(t, node), ActorID: f.owner})
	if err != nil {
		t.Fatal(err)
	}
	due := "2026-12-20"
	issueRow, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issue})
	if err != nil {
		t.Fatal(err)
	}
	_, application := preparationCancel(t, f, CockpitCancellationPreviewInput{Reason: "Move the retained preparation with its confirmed delivery.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issue), ExpectedRevision: issueRow.Revision, Action: "change_due_date", DueDate: &due}}, RunIDs: []string{}})
	effects := preparationEffects(t, f, application.Current.ID)
	// An existing primary prevents changing its inherited scope underneath the
	// Issue. Withdraw the binding, change the mapping, then explicitly reattach.
	unlinked, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: issue, ActorID: f.owner, ExpectedRevision: primaryBinding.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_node SET project_id=$2,module_id=$3 WHERE workspace_id=$1 AND id=$4", f.ws, nextProject, nextModule, root); err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: issue, NodeID: parseTestUUID(t, node), ActorID: f.owner, ExpectedRevision: unlinked.Revision}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("ownership silently refiled an Issue with mismatched scope: %v", err)
	}
	setScope(nextProject, nextModule)
	if _, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: issue, NodeID: parseTestUUID(t, node), ActorID: f.owner, ExpectedRevision: unlinked.Revision}); err != nil {
		t.Fatal(err)
	}
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: parseTestUUID(t, application.Current.ID), EffectID: parseTestUUID(t, effects[0].ID)}
	old := CockpitPreparationEffectApplyInput{CommandKey: effects[0].CommandKey, AuthorizationKey: effects[0].AuthorizationKey, AuthorizationRevision: effects[0].AuthorizationRevision}
	if _, err = f.issues.ApplyCockpitPreparationEffect(ctx, p, old, IssueCreateOpts{}); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("changed mapping silently accepted: %v", err)
	}
	review, err := f.issues.PreviewCockpitPreparationReauthorization(ctx, p)
	if err != nil || !review.CanConfirm || review.CurrentImpact == nil || review.PreviousAuthorization.Impact == nil || review.CurrentImpact.Issue.PrimaryNodeID == nil || *review.CurrentImpact.Issue.PrimaryNodeID != node || review.CurrentImpact.Issue.ProjectID == nil || *review.CurrentImpact.Issue.ProjectID != nextProject || review.PreviousAuthorization.Impact.Issue.ProjectID == nil || *review.PreviousAuthorization.Impact.Issue.ProjectID != project {
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
	updated, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: parseTestUUID(t, *created.Receipt.IssueID)})
	if err != nil || updated.ID != issue || !updated.DueDate.Valid || updated.DueDate.Time.Format("2006-01-02") != due || updated.ProjectID != parseTestUUID(t, nextProject) || updated.ModuleID != parseTestUUID(t, nextModule) || created.Receipt.AuthorizationKey != grant.CommandKey {
		t.Fatalf("new grant did not govern the retained Issue: %+v %+v %v", updated, created, err)
	}
	var primary string
	if err = f.Pool.QueryRow(ctx, "SELECT node_id::text FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, updated.ID).Scan(&primary); err != nil || primary != node {
		t.Fatalf("stable primary identity lost: %s %v", primary, err)
	}
}

func TestCockpitPreparationCancelledMeetingCannotBypassLegacyReadiness(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	f.init(t, "")
	previewInput := CockpitCancellationPreviewInput{Reason: "Cancelled before occurrence; keep all existing work.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{}}
	_, _ = preparationCancel(t, f, previewInput)
	yes := true
	if err := f.issues.SetCockpitMeetingReadiness(ctx, CockpitWorkPackageReadiness{CockpitWorkPackageCommand: f.command(t), Ended: &yes, MaterialsReady: &yes}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("legacy readiness reopened cancellation: %v", err)
	}
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); !errors.Is(err, ErrCockpitWorkflowConflict) {
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
	var runs int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1", f.ws).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("cancel guard dispatched: %d %v", runs, err)
	}
}

func TestCockpitPreparationMultipleStopsDoNotInvalidateSiblingAuthorization(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	issueID := preparationIssue(t, f, "Collect the primary evidence")
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
	_, op := preparationCancel(t, f, in)
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
	issueID := preparationIssue(t, f, "Collect the primary evidence")
	agent := f.privateAgentOwnedBy(t, f.UserID, "preparation-run-recheck")
	var runtimeID string
	if err := f.Pool.QueryRow(ctx, "SELECT runtime_id::text FROM agent WHERE id=$1", agent).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	selected := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "running", "started_at": testutil.Raw("now()")})
	in := CockpitCancellationPreviewInput{Reason: "Stop the explicitly selected task only.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{selected}}
	_, op := preparationCancel(t, f, in)
	effect := preparationEffects(t, f, op.Current.ID)[0]
	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), OperationID: parseTestUUID(t, op.Current.ID), EffectID: parseTestUUID(t, effect.ID)}
	newRun := f.Task(t, agent, testutil.Cols{"runtime_id": runtimeID, "issue_id": util.UUIDToString(issueID), "status": "queued"})
	old := CockpitPreparationEffectApplyInput{CommandKey: effect.CommandKey, AuthorizationKey: effect.AuthorizationKey, AuthorizationRevision: effect.AuthorizationRevision}
	if _, err := f.issues.ApplyCockpitPreparationEffect(ctx, p, old, IssueCreateOpts{}); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("new activity was not surfaced: %v", err)
	}
	if _, err := f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='completed',completed_at=now() WHERE id=$1", selected); err != nil {
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

func TestCockpitPreparationLinkMeetingOnlyRequiresTargetMeeting(t *testing.T) {
	issue, target := util.UUIDToString(dbid.NewV7()), util.UUIDToString(dbid.NewV7())
	input := func(value *string) CockpitCancellationPreviewInput {
		return CockpitCancellationPreviewInput{Reason: "Retain preparation in another meeting.", Issues: []CockpitCancellationIssueChoice{{IssueID: issue, ExpectedRevision: 1, Action: "link_meeting", TargetMeetingID: value}}, RunIDs: []string{}}
	}
	valid := input(&target)
	if err := normalizeCancellation(&valid); err != nil {
		t.Fatalf("direct meeting link still requires a retired agenda: %v", err)
	}
	for _, value := range []*string{nil, new(string), func() *string { value := "not-a-uuid"; return &value }()} {
		invalid := input(value)
		if err := normalizeCancellation(&invalid); !errors.Is(err, ErrCockpitWorkflowInput) {
			t.Fatalf("invalid target meeting accepted: %v", err)
		}
	}
}

func TestCockpitPreparationLinkMeetingMergesPurposesTransactionally(t *testing.T) {
	for _, roles := range [][]string{nil, {"support", "future_purpose"}, {"preparation", "support"}} {
		t.Run(fmt.Sprint(roles), func(t *testing.T) {
			f := preparationFixture(t)
			ctx := context.Background()
			issue := preparationIssue(t, f, "Retained preparation")
			var board string
			if err := f.Pool.QueryRow(ctx, "SELECT cockpit_id::text FROM cockpit_meeting WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting).Scan(&board); err != nil {
				t.Fatal(err)
			}
			target := parseTestUUID(t, f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board, "title": "Another meeting"}))
			if roles != nil {
				f.Exec(t, "INSERT INTO cockpit_meeting_issue(workspace_id,meeting_id,issue_id,role,position,roles) VALUES($1,$2,$3,'task',7,$4)", f.ws, target, issue, roles)
			}
			tx, err := f.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			q := f.q.WithTx(tx)
			if _, err = lockLifecycleMeeting(ctx, q, f.ws, target); err != nil {
				t.Fatal(err)
			}
			if _, err = linkPreparationIssueToMeeting(ctx, q, f.ws, target, issue, f.owner); err != nil {
				t.Fatal(err)
			}
			link, err := q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: f.ws, MeetingID: target, IssueID: issue})
			if err != nil || !slices.Contains(link.Roles, "preparation") {
				t.Fatalf("target association lost preparation purpose: %+v %v", link, err)
			}
			want := append([]string{}, roles...)
			if !slices.Contains(want, "preparation") {
				want = append(want, "preparation")
			}
			if !slices.Equal(link.Roles, want) || (roles != nil && (link.Role != "task" || link.Position != 7)) {
				t.Fatalf("existing purposes or provisioning marker changed: %+v want %v", link, want)
			}
			if err = tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			if roles == nil {
				if f.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, target, issue) != 0 {
					t.Fatal("rolled-back association escaped its transaction")
				}
			} else {
				old, err := f.q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: f.ws, MeetingID: target, IssueID: issue})
				if err != nil || !slices.Equal(old.Roles, roles) {
					t.Fatalf("rolled-back purpose update escaped its transaction: %+v %v", old, err)
				}
			}
		})
	}
}

func TestCockpitPreparationCancellationLinksRetainedIssueWithoutAgenda(t *testing.T) {
	f := preparationFixture(t)
	ctx := context.Background()
	issue := preparationIssue(t, f, "Carry preparation into another meeting")
	var board string
	if err := f.Pool.QueryRow(ctx, "SELECT cockpit_id::text FROM cockpit_meeting WHERE workspace_id=$1 AND id=$2", f.ws, f.meeting).Scan(&board); err != nil {
		t.Fatal(err)
	}
	target := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board, "title": "Next meeting"})
	before, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issue})
	if err != nil {
		t.Fatal(err)
	}
	_, operation := preparationCancel(t, f, CockpitCancellationPreviewInput{Reason: "Retain work and link it to the next meeting.", Issues: []CockpitCancellationIssueChoice{{IssueID: util.UUIDToString(issue), ExpectedRevision: before.Revision, Action: "link_meeting", TargetMeetingID: &target}}, RunIDs: []string{}})
	steps := preparationEffects(t, f, operation.Current.ID)
	if len(steps) != 1 || steps[0].Kind != "link_meeting" {
		t.Fatalf("cancellation did not record one direct link effect: %+v", steps)
	}
	applied := preparationApply(t, f, operation.Current.ID, steps[0])
	if applied.Current.State != "completed" || applied.Receipt.TargetMeetingID == nil || *applied.Receipt.TargetMeetingID != target || applied.Receipt.IssueID == nil || *applied.Receipt.IssueID != util.UUIDToString(issue) {
		t.Fatalf("direct link receipt: %+v", applied)
	}
	targetRead := lifecycleRead(f)
	targetRead.MeetingID = parseTestUUID(t, target)
	impact, err := f.issues.ListCockpitCancellationImpact(ctx, CockpitPreparationQuery{CockpitLifecycleRead: targetRead, PageSize: 100})
	if err != nil || impact.Total != 1 || len(impact.Items) != 1 || impact.Items[0].Issue.ID != util.UUIDToString(issue) {
		t.Fatalf("target meeting cannot discover its retained preparation: %+v %v", impact, err)
	}
	if _, err = f.issues.ListCockpitDispositionRuns(ctx, CockpitPreparationQuery{CockpitLifecycleRead: targetRead, IssueID: issue, PageSize: 100}); err != nil {
		t.Fatalf("target meeting rejects preparation run lookup: %v", err)
	}
	after, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issue})
	if err != nil || after.Revision != before.Revision || after.Status != before.Status || after.ProjectID != before.ProjectID || after.ModuleID != before.ModuleID {
		t.Fatalf("association mutated retained Issue ownership or work: %+v %v", after, err)
	}
	if f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws) != 1 || f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue) != 0 || f.Count(t, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND issue_id=$2 AND 'preparation'=ANY(roles)", f.ws, issue) != 2 {
		t.Fatal("direct association duplicated work, executed it, or lost either preparation purpose")
	}
	replay := preparationApply(t, f, operation.Current.ID, steps[0])
	if !replay.Replayed || replay.Receipt.FactsHash != applied.Receipt.FactsHash {
		t.Fatal("replay replaced the fixed association receipt")
	}
}
