package service

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitCancellationPausesDirectoryPlansWithoutCancellingInflightIO(t *testing.T) {
	f, directoryRead, _, rootID := legacyDirectoryFixture(t, true)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_operation WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_preparation_effect WHERE workspace_id=$1", f.ws)
	ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	createPlan := func(relative string) CockpitDirectoryCommandResult {
		input := CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rootID, RelativeDirectory: relative, Partitions: []string{"Materials"}, ObservedBindingRevision: 1, BindAfterBase: true}
		preview, err := f.issues.PreviewCockpitMeetingDirectory(ctx, directoryRead, input)
		if err != nil || !preview.CanConfirm {
			t.Fatalf("preview directory plan: %+v %v", preview, err)
		}
		out, err := f.issues.CreateCockpitMeetingDirectory(ctx, directoryRead, CockpitDirectoryCreateInput{CockpitDirectoryPreviewInput: input,
			CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, ContextToken: preview.ContextToken})
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := createPlan("Original target")
	lifecycle := lifecycleRead(f)
	selection := CockpitCancellationPreviewInput{Reason: "The physical meeting will not be held.", Issues: []CockpitCancellationIssueChoice{}, RunIDs: []string{}}
	stale, err := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycle, selection)
	if err != nil || stale.DirectoryImpact == nil || stale.DirectoryImpact.WillPauseTotal != 1 {
		t.Fatalf("first preview omitted directory work: %+v %v", stale, err)
	}
	second := createPlan("Alternative target")
	input := CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(stale.LifecycleRevision), CockpitCancellationPreviewInput: selection, ContextToken: stale.ContextToken}
	if _, err := f.issues.CancelCockpitMeeting(ctx, lifecycle, input); !errors.Is(err, ErrCockpitPreparationContextChanged) {
		t.Fatalf("cancellation silently included a plan created after preview: %v", err)
	}
	current, err := f.issues.GetCockpitMeetingLifecycle(ctx, lifecycle)
	if err != nil || current.Occurrence.State != "unconfirmed" {
		t.Fatalf("stale cancellation changed the meeting: %+v %v", current, err)
	}
	query := CockpitDirectoryQuery{CockpitDirectoryRead: directoryRead, OperationID: parseTestUUID(t, first.Current.ID)}
	steps, err := f.issues.ListCockpitDirectorySteps(ctx, query)
	if err != nil || len(steps.Items) != 2 {
		t.Fatalf("expected a base and partition: %+v %v", steps, err)
	}
	base := steps.Items[0]
	lease := dbid.NewV7()
	attempt := f.Insert(t, "cockpit_meeting_directory_attempt", testutil.Cols{"id": dbid.NewV7(), "workspace_id": f.ws, "meeting_id": f.meeting,
		"operation_id": query.OperationID, "step_id": base.ID, "attempt_number": 1, "grant_command_key": base.GrantCommandKey, "grant_revision": base.GrantRevision,
		"lease_token": lease, "state": "running"})
	if _, err := f.Pool.Exec(ctx, `UPDATE cockpit_meeting_directory_step SET state='running',lease_token=$1,lease_expires_at=now()+interval '1 minute',
 last_attempt_id=$2,attempt_count=1,next_attempt_at=NULL,revision=revision+1 WHERE workspace_id=$3 AND id=$4`, lease, attempt, f.ws, base.ID); err != nil {
		t.Fatal(err)
	}
	fresh, err := f.issues.PreviewCockpitMeetingCancellation(ctx, lifecycle, selection)
	if err != nil || !fresh.CanConfirm || fresh.DirectoryImpact == nil || fresh.DirectoryImpact.UnfinishedTotal != 2 || fresh.DirectoryImpact.WillPauseTotal != 2 || len(fresh.DirectoryImpact.SampleOperationIDs) != 2 {
		t.Fatalf("fresh preview did not disclose both plans: %+v %v", fresh, err)
	}
	input = CockpitCancellationInput{CockpitLifecycleCommandInput: lifecycleInput(fresh.LifecycleRevision), CockpitCancellationPreviewInput: selection, ContextToken: fresh.ContextToken}
	result, err := f.issues.CancelCockpitMeeting(ctx, lifecycle, input)
	if err != nil || result.Receipt.DirectoryEffect == nil || result.Receipt.DirectoryEffect.PausedTotal != 2 || len(result.Receipt.DirectoryEffect.SampleOperationIDs) != 2 || len(result.Receipt.DirectoryEffect.FactsHash) != 64 {
		t.Fatalf("cancellation omitted its actual directory result: %+v %v", result, err)
	}
	for _, plan := range []CockpitDirectoryCommandResult{first, second} {
		op, err := f.q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: parseTestUUID(t, plan.Current.ID)})
		if err != nil || op.State != "paused" {
			t.Fatalf("directory was not paused: %+v %v", op, err)
		}
		rows, err := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op.ID})
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if row.State != "running" && row.NextAttemptAt.Valid {
				t.Fatal("cancelled meeting left future directory steps scheduled")
			}
		}
	}
	running, err := f.q.GetCockpitDirectoryStep(ctx, db.GetCockpitDirectoryStepParams{WorkspaceID: f.ws, MeetingID: f.meeting, OperationID: query.OperationID, ID: parseTestUUID(t, base.ID)})
	if err != nil || running.State != "running" || running.LeaseToken != lease || !running.LeaseExpiresAt.Valid {
		t.Fatalf("cancellation falsely revoked an in-flight filesystem attempt: %+v %v", running, err)
	}
	replayed, err := f.issues.CancelCockpitMeeting(ctx, lifecycle, input)
	if err != nil || !replayed.Replayed || !reflect.DeepEqual(replayed.Receipt.DirectoryEffect, result.Receipt.DirectoryEffect) {
		t.Fatalf("replay replaced the original directory result: %+v %v", replayed, err)
	}
	current, err = f.issues.GetCockpitMeetingLifecycle(ctx, lifecycle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ChangeCockpitMeetingDisposition(ctx, lifecycle, CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(current.LifecycleRevision), Transition: "reinstate", Reason: "Plan another date; keep preparation paused until reviewed."}); err != nil {
		t.Fatal(err)
	}
	op, err := f.q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: query.OperationID})
	if err != nil || op.State != "paused" {
		t.Fatalf("reinstating a meeting silently resumed directory work: %+v %v", op, err)
	}
	basis, err := f.issues.GetCockpitMeetingOperationBasis(ctx, lifecycle)
	if err != nil || basis.Pending.DirectoryOperations != 2 || basis.Delete.State != "blocked" {
		t.Fatalf("retained directory work was omitted from operation basis: %+v %v", basis, err)
	}
	found := false
	for _, target := range basis.Targets {
		if target.DirectoryOperationID != "" {
			found = true
			if target.Kind != "meeting" || target.MeetingID != util.UUIDToString(f.meeting) || target.View != "resources" || target.OperationID != "" || target.Label == "" {
				t.Fatalf("directory recovery target is ambiguous: %+v", target)
			}
		}
	}
	if !found || f.Count(t, "SELECT count(*) FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id WHERE i.workspace_id=$1", f.ws) != 0 {
		t.Fatal("directory recovery lost its precise target or created an Agent run")
	}
}
