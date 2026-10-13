package service

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func directoryCreateFixturePlan(t *testing.T, f cockpitWorkflowFixture, p CockpitDirectoryRead, rootID, path string, parts []string) (CockpitDirectoryCommandResult, CockpitDirectoryCreateInput) {
	t.Helper()
	ctx := context.Background()
	m, e := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if e != nil {
		t.Fatal(e)
	}
	input := CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rootID, RelativeDirectory: path, Partitions: parts, ObservedNASDir: m.NasDir, ObservedBindingRevision: m.NasDirRevision, BindAfterBase: true}
	v, e := f.issues.PreviewCockpitMeetingDirectory(ctx, p, input)
	if e != nil || !v.CanConfirm {
		t.Fatalf("preview %+v: %v", v, e)
	}
	command := CockpitDirectoryCreateInput{CockpitDirectoryPreviewInput: input, CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: m.NasDirRevision, ContextToken: v.ContextToken}
	r, e := f.issues.CreateCockpitMeetingDirectory(ctx, p, command)
	if e != nil {
		t.Fatal(e)
	}
	return r, command
}
func directoryApplyOne(t *testing.T, f cockpitWorkflowFixture, op pgtype.UUID) *directoryLease {
	t.Helper()
	ctx := context.Background()
	lease, e := f.issues.claimDirectoryStep(ctx, f.ws, f.meeting, op)
	if e != nil || lease == nil {
		t.Fatalf("claim: %+v %v", lease, e)
	}
	if lease.denied != nil {
		t.Fatal(lease.denied)
	}
	obs, e := f.issues.CockpitDirectoryPreparer.EnsurePreparedDirectory(ctx, lease.target, lease.step.RelativePath)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.issues.finalizeDirectoryStep(ctx, lease, obs, nil); e != nil {
		t.Fatal(e)
	}
	return lease
}
func TestCockpitDirectoryPartialRetryThenHumanClaimPreservesOriginalBindingGrant(t *testing.T) {
	f, p, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	created, _ := directoryCreateFixturePlan(t, f, p, rid, "meeting", []string{"first", "second"})
	originalGrant, e := f.q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: f.ws, MeetingID: f.meeting, CommandKey: parseTestUUID(t, created.CommandKey)})
	if e != nil {
		t.Fatal(e)
	}
	op := parseTestUUID(t, created.Current.ID)
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op}
	directoryApplyOne(t, f, op)
	m, e := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if e != nil || m.NasDir != filepath.Join(root, "meeting") || m.NasDirRevision != 2 {
		t.Fatalf("base binding %+v %v", m, e)
	}
	// ABA path equality cannot validate the original grant revision.
	for _, path := range []string{filepath.Join(root, "other"), m.NasDir} {
		if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET nas_dir=$1 WHERE workspace_id=$2 AND id=$3", path, f.ws, f.meeting); e != nil {
			t.Fatal(e)
		}
	}
	steps, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	selected := []string{util.UUIDToString(steps[1].ID)}
	preview, e := f.issues.PreviewCockpitDirectoryRetry(ctx, query, CockpitDirectoryRetryPreviewInput{StepIDs: selected})
	if e != nil || !preview.CanConfirm {
		t.Fatalf("explicit ABA recheck: %+v %v", preview, e)
	}
	retried, e := f.issues.RetryCockpitDirectoryOperation(ctx, query, CockpitDirectoryRetryInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: preview.OperationRevision, StepIDs: selected, ContextToken: preview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	rows, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	if rows[1].GrantRevision == rows[2].GrantRevision || rows[2].GrantCommandKey != parseTestUUID(t, created.CommandKey) {
		t.Fatal("partial retry reauthorized an unselected step")
	}
	// A fresh human claim gives all unfinished steps one operation-level grant;
	// their previous grant revisions need not be equal.
	claimUser := f.member(t, "directory-claim-admin")
	if _, e = f.Pool.Exec(ctx, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.ws, claimUser); e != nil {
		t.Fatal(e)
	}
	claimQuery := query
	claimQuery.CredentialOwnerID = parseTestUUID(t, claimUser)
	claimed, e := f.issues.ControlCockpitDirectoryOperation(ctx, claimQuery, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: retried.Current.Revision, Transition: "claim", Reason: "Take responsibility for every remaining directory"})
	if e != nil {
		t.Fatal(e)
	}
	if len(claimed.Receipt.DirectoryStepIDs) != 2 || claimed.Receipt.Grant.Revision <= retried.Receipt.Grant.Revision {
		t.Fatal("claim did not cover the precise unfinished set")
	}
	if e = f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	final, e := f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || final.State != "completed" || final.AcceptedBindingRevision == nil || *final.AcceptedBindingRevision != 2 {
		t.Fatalf("regrant replaced the original CAS exception: %+v %v", final, e)
	}
	retainedGrant, e := f.q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: f.ws, MeetingID: f.meeting, CommandKey: parseTestUUID(t, created.CommandKey)})
	if e != nil || retainedGrant.RequestHash != originalGrant.RequestHash || string(retainedGrant.Receipt) != string(originalGrant.Receipt) {
		t.Fatalf("retry or claim rewrote the original fixed binding grant: %+v %v", retainedGrant, e)
	}
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=99 WHERE workspace_id=$1 AND id=$2", f.ws, op); e == nil {
		t.Fatal("accepted binding could be rewritten")
	}
}
func TestCockpitDirectoryAbandonRetainsLateObservationWithoutBindingOrRevival(t *testing.T) {
	f, p, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	r, _ := directoryCreateFixturePlan(t, f, p, rid, "late", nil)
	op := parseTestUUID(t, r.Current.ID)
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op}
	lease, e := f.issues.claimDirectoryStep(ctx, f.ws, f.meeting, op)
	if e != nil || lease == nil || lease.denied != nil {
		t.Fatalf("claim %+v %v", lease, e)
	}
	var running int
	if e = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_directory_step WHERE workspace_id=$1 AND lease_token=$2", f.ws, lease.step.LeaseToken).Scan(&running); e != nil || running != 1 {
		t.Fatalf("one lease claimed %d steps: %v", running, e)
	}
	abandoned, e := f.issues.ControlCockpitDirectoryOperation(ctx, query, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: r.Current.Revision, Transition: "abandon", Reason: "Do not continue this directory plan"})
	if e != nil {
		t.Fatal(e)
	}
	obs, e := f.issues.CockpitDirectoryPreparer.EnsurePreparedDirectory(ctx, lease.target, lease.step.RelativePath)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.issues.finalizeDirectoryStep(ctx, lease, obs, nil); e != nil {
		t.Fatal(e)
	}
	m, e := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if e != nil || m.NasDir != "" {
		t.Fatal("late I/O rebound the meeting")
	}
	attempt, e := f.q.GetCockpitDirectoryAttempt(ctx, db.GetCockpitDirectoryAttemptParams{WorkspaceID: f.ws, MeetingID: f.meeting, OperationID: op, StepID: lease.step.ID, ID: lease.step.LastAttemptID})
	if e != nil || attempt.State != "abandoned" || len(attempt.LateReceipt) == 0 {
		t.Fatalf("late observation %+v %v", attempt, e)
	}
	final, e := f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || final.State != "abandoned" || final.Revision != abandoned.Current.Revision {
		t.Fatal("late callback revived abandoned plan")
	}
	if _, e = os.Stat(filepath.Join(root, "late")); e != nil {
		t.Fatal("fixture did not actually finish its late mkdir")
	}
}
func TestCockpitDirectoryRegrantAcceptsNarrowerPreparationScopeForSameFixedPath(t *testing.T) {
	f, p, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	if e := os.Mkdir(filepath.Join(root, "meetings"), 0700); e != nil {
		t.Fatal(e)
	}
	r, _ := directoryCreateFixturePlan(t, f, p, rid, "meetings/fixed", []string{"materials"})
	op := parseTestUUID(t, r.Current.ID)
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op}
	directoryApplyOne(t, f, op)
	directoryApplyOne(t, f, op)
	h, e := f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil {
		t.Fatal(e)
	}
	paused, e := f.issues.ControlCockpitDirectoryOperation(ctx, query, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: h.Revision, Transition: "pause"})
	if e != nil {
		t.Fatal(e)
	}
	cfg, _ := json.Marshal([]cockpitnas.Root{{WorkspaceID: util.UUIDToString(f.ws), RootID: rid, Path: root, AllowLocal: true, PrepareSubpaths: []string{"meetings"}}})
	f.issues.CockpitDirectoryPreparer, e = cockpitnas.New(string(cfg))
	if e != nil {
		t.Fatal(e)
	}
	h, e = f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || h.CanResume || !h.CanRetry {
		t.Fatalf("paused changed scope has no executable recheck: %+v %v", h, e)
	}
	steps, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{util.UUIDToString(steps[len(steps)-1].ID)}
	v, e := f.issues.PreviewCockpitDirectoryRetry(ctx, query, CockpitDirectoryRetryPreviewInput{StepIDs: ids})
	if e != nil || !v.CanConfirm {
		t.Fatalf("narrowed scope preview %+v %v", v, e)
	}
	retry, e := f.issues.RetryCockpitDirectoryOperation(ctx, query, CockpitDirectoryRetryInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: paused.Current.Revision, StepIDs: ids, ContextToken: v.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	if retry.Receipt.Grant.RootConfigHash == createdGrantHash(r) {
		t.Fatal("retry kept stale root config")
	}
	if e = f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	h, e = f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || h.State != "completed" {
		t.Fatalf("explicit narrower regrant could never progress: %+v %v", h, e)
	}
}
func createdGrantHash(r CockpitDirectoryCommandResult) string { return r.Receipt.Grant.RootConfigHash }
func TestCockpitDirectorySameKeyConcurrentCreateAndReplayBeforeChangedFacts(t *testing.T) {
	f, p, _, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	input := CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rid, RelativeDirectory: "replay", Partitions: []string{}, ObservedBindingRevision: 1, BindAfterBase: true}
	preview, e := f.issues.PreviewCockpitMeetingDirectory(ctx, p, input)
	if e != nil {
		t.Fatal(e)
	}
	command := CockpitDirectoryCreateInput{CockpitDirectoryPreviewInput: input, CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, ContextToken: preview.ContextToken}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	ids := make(chan string, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := f.issues.CreateCockpitMeetingDirectory(ctx, p, command)
			errs <- e
			ids <- r.Receipt.DirectoryOperationID
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	var id string
	for value := range ids {
		if id != "" && id != value {
			t.Fatal("same key created more than one plan")
		}
		id = value
	}
	f.issues.CockpitDirectoryConfigurationError = "prepare_configuration_invalid"
	replay, e := f.issues.CreateCockpitMeetingDirectory(ctx, p, command)
	if e != nil || !replay.Replayed || replay.Receipt.DirectoryOperationID != id {
		t.Fatalf("changed config blocked an exact receipt: %+v %v", replay, e)
	}
	changed := command
	changed.RelativeDirectory = "other"
	if _, e = f.issues.CreateCockpitMeetingDirectory(ctx, p, changed); e == nil {
		t.Fatal("same key changed its fixed target")
	}
}
func TestCockpitDirectoryDelegationSurvivesSourceRunEndAndAllowsPreciseNewRunRecovery(t *testing.T) {
	f, human, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	credentialOwner := f.member(t, "directory-runtime-owner")
	runtime := f.Runtime(t, "Directory runtime", testutil.Cols{"owner_id": credentialOwner, "visibility": "public"})
	agent := f.Agent(t, "Directory producer", runtime, testutil.Cols{"owner_id": f.owner, "permission_mode": "private", "status": "idle"})
	issue := f.Issue(t, "Meeting preparation")
	f.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "issue_id": issue, "role": "task", "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, f.meeting, issue)
	makePrincipal := func() CockpitDirectoryRead {
		run := f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "running", "originator_user_id": f.owner, "accountable_user_id": f.owner})
		token, e := f.q.CreateTaskToken(ctx, db.CreateTaskTokenParams{ID: dbid.NewV7(), TokenHash: util.UUIDToString(dbid.NewV7()), TaskID: parseTestUUID(t, run), AgentID: parseTestUUID(t, agent), WorkspaceID: f.ws, UserID: parseTestUUID(t, credentialOwner), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		if e != nil {
			t.Fatal(e)
		}
		f.Cleanup(t, "DELETE FROM task_token WHERE id=$1", token.ID)
		return CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: parseTestUUID(t, credentialOwner), ActorSource: "task_token", AgentID: parseTestUUID(t, agent), RunID: parseTestUUID(t, run), TaskTokenID: token.ID}
	}
	machine := makePrincipal()
	r, command := directoryCreateFixturePlan(t, f, machine, rid, "delegated", []string{"materials"})
	op := parseTestUUID(t, r.Current.ID)
	if r.Receipt.Principal.CredentialOwnerUserID != credentialOwner || r.Receipt.Principal.AuthorizingUserID != util.UUIDToString(f.owner) || r.Receipt.Principal.ConfirmedByUserID != nil || r.Receipt.Grant.Kind != "delegated_task" {
		t.Fatal("machine confirmation was misrepresented as human")
	}
	if _, e := f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", machine.RunID); e != nil {
		t.Fatal(e)
	}
	directoryApplyOne(t, f, op)
	// A file conflict is a genuine need for explicit new authorization.
	if e := os.WriteFile(filepath.Join(root, "delegated", "materials"), []byte("keep"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	replay, e := f.issues.CreateCockpitMeetingDirectory(ctx, machine, command)
	if e != nil || !replay.Replayed {
		t.Fatalf("ended source run blocked precise original receipt: %v", e)
	}
	if e = os.Remove(filepath.Join(root, "delegated", "materials")); e != nil {
		t.Fatal(e)
	}
	next := makePrincipal()
	query := CockpitDirectoryQuery{CockpitDirectoryRead: next, OperationID: op}
	steps, e := f.issues.ListCockpitDirectorySteps(ctx, query)
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{steps.Items[1].ID}
	preview, e := f.issues.PreviewCockpitDirectoryRetry(ctx, query, CockpitDirectoryRetryPreviewInput{StepIDs: ids})
	if e != nil || !preview.CanConfirm {
		t.Fatalf("same preparation tuple new Run rejected: %+v %v", preview, e)
	}
	retried, e := f.issues.RetryCockpitDirectoryOperation(ctx, query, CockpitDirectoryRetryInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: preview.OperationRevision, StepIDs: ids, ContextToken: preview.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	if retried.Receipt.Principal.RunID == nil || *retried.Receipt.Principal.RunID != util.UUIDToString(next.RunID) || retried.Current.SourcePrincipal.RunID == nil || *retried.Current.SourcePrincipal.RunID != util.UUIDToString(machine.RunID) {
		t.Fatal("recovery overwrote source provenance or failed to record the new grant")
	}
	if e = f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	final, e := f.issues.GetCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: human, OperationID: op})
	if e != nil || final.State != "completed" {
		t.Fatalf("delegated continuation %+v %v", final, e)
	}
	if _, e = f.issues.ControlCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: f.owner, ActorSource: "cloud_pat"}, OperationID: op}, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: final.Revision, Transition: "claim", Reason: "not delegated"}); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("cloud principal gained write authority: %v", e)
	}
}

func TestCockpitDirectoryExpiredLeaseRecoversAndLateAttemptCannotConfirmNewLease(t *testing.T) {
	f, p, _, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	created, _ := directoryCreateFixturePlan(t, f, p, rid, "lease", nil)
	op := parseTestUUID(t, created.Current.ID)
	old, e := f.issues.claimDirectoryStep(ctx, f.ws, f.meeting, op)
	if e != nil || old == nil {
		t.Fatalf("initial lease %v", e)
	}
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting_directory_step SET lease_expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2", f.ws, old.step.ID); e != nil {
		t.Fatal(e)
	}
	if e = f.issues.recoverDirectoryLeases(ctx); e != nil {
		t.Fatal(e)
	}
	next, e := f.issues.claimDirectoryStep(ctx, f.ws, f.meeting, op)
	if e != nil || next == nil || next.step.AttemptCount != 2 || next.step.LeaseToken == old.step.LeaseToken {
		t.Fatalf("fresh lease %+v %v", next, e)
	}
	obs, e := f.issues.CockpitDirectoryPreparer.EnsurePreparedDirectory(ctx, old.target, old.step.RelativePath)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.issues.finalizeDirectoryStep(ctx, old, obs, nil); e != nil {
		t.Fatal(e)
	}
	row, e := f.q.GetCockpitDirectoryStep(ctx, db.GetCockpitDirectoryStepParams{WorkspaceID: f.ws, MeetingID: f.meeting, OperationID: op, ID: next.step.ID})
	if e != nil || row.State != "running" || row.LeaseToken != next.step.LeaseToken {
		t.Fatal("expired attempt confirmed or cleared the new lease")
	}
	oldAttempt, e := f.q.GetCockpitDirectoryAttempt(ctx, db.GetCockpitDirectoryAttemptParams{WorkspaceID: f.ws, MeetingID: f.meeting, OperationID: op, StepID: old.step.ID, ID: old.step.LastAttemptID})
	if e != nil || oldAttempt.State != "expired" || len(oldAttempt.LateReceipt) == 0 {
		t.Fatalf("old observation lost: %+v %v", oldAttempt, e)
	}
	obs, e = f.issues.CockpitDirectoryPreparer.EnsurePreparedDirectory(ctx, next.target, next.step.RelativePath)
	if e != nil || obs.Outcome != "observed_existing" {
		t.Fatalf("retry invented mkdir: %+v %v", obs, e)
	}
	if e = f.issues.finalizeDirectoryStep(ctx, next, obs, nil); e != nil {
		t.Fatal(e)
	}
	h, e := f.issues.GetCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op})
	if e != nil || h.State != "completed" {
		t.Fatalf("lease recovery %+v %v", h, e)
	}
}

func TestCockpitDirectoryArchivedRegrantUsesSuccessfulBaseGrantWithoutRebasingOldSteps(t *testing.T) {
	f, p, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	created, _ := directoryCreateFixturePlan(t, f, p, rid, "archived-fixed", []string{"selected", "unselected"})
	op := parseTestUUID(t, created.Current.ID)
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op}
	paused, e := f.issues.ControlCockpitDirectoryOperation(ctx, query, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: created.Current.Revision, Transition: "pause"})
	if e != nil {
		t.Fatal(e)
	}
	changedBinding := filepath.Join(root, "external-binding")
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting SET nas_dir=$1 WHERE workspace_id=$2 AND id=$3", changedBinding, f.ws, f.meeting); e != nil {
		t.Fatal(e)
	}
	lh, e := f.issues.GetCockpitMeetingLifecycle(ctx, lifecycleRead(f))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.ChangeCockpitMeetingDisposition(ctx, lifecycleRead(f), CockpitMeetingDispositionInput{CockpitLifecycleCommandInput: lifecycleInput(lh.LifecycleRevision), Transition: "archive", Reason: "Retain this meeting while its accepted directory plan finishes"}); e != nil {
		t.Fatal(e)
	}
	rows, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	selected := []string{util.UUIDToString(rows[0].ID), util.UUIDToString(rows[1].ID)}
	v, e := f.issues.PreviewCockpitDirectoryRetry(ctx, query, CockpitDirectoryRetryPreviewInput{StepIDs: selected})
	if e != nil || !v.CanConfirm || v.ObservedBinding.NASDir != changedBinding || v.ObservedBinding.Revision != 2 {
		t.Fatalf("archived fixed plan has no binding recovery: %+v %v", v, e)
	}
	retry, e := f.issues.RetryCockpitDirectoryOperation(ctx, query, CockpitDirectoryRetryInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: paused.Current.Revision, StepIDs: selected, ContextToken: v.ContextToken})
	if e != nil {
		t.Fatal(e)
	}
	if e = f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	h, e := f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || h.State != "needs_attention" || h.AcceptedBindingRevision == nil || *h.AcceptedBindingRevision != 3 {
		t.Fatalf("new base grant transition was not retained: %+v %v", h, e)
	}
	steps, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	if steps[0].State != "satisfied" || steps[1].State != "satisfied" || steps[2].State != "needs_attention" || steps[2].LastErrorCode != "binding_changed" || steps[2].GrantCommandKey != parseTestUUID(t, created.CommandKey) {
		t.Fatalf("new base CAS was borrowed by an unselected old grant: %+v", steps)
	}
	if retry.Receipt.Grant.ObservedBinding.Revision+1 != *h.AcceptedBindingRevision || created.Receipt.Grant.ObservedBinding.Revision+1 == *h.AcceptedBindingRevision {
		t.Fatal("accepted revision still assumes operation's original observation")
	}
	fresh, e := f.issues.PreviewCockpitMeetingDirectory(ctx, p, CockpitDirectoryPreviewInput{Mode: "repair", RootID: rid, RelativeDirectory: "another-plan", Partitions: []string{}, ObservedNASDir: h.Target.Directory, ObservedBindingRevision: 3, BindAfterBase: true})
	if e != nil || fresh.CanConfirm {
		t.Fatalf("archive allowed a new target: %+v %v", fresh, e)
	}
	admin := f.member(t, "archived-directory-admin")
	if _, e = f.Pool.Exec(ctx, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.ws, admin); e != nil {
		t.Fatal(e)
	}
	claimQuery := query
	claimQuery.CredentialOwnerID = parseTestUUID(t, admin)
	claimed, e := f.issues.ControlCockpitDirectoryOperation(ctx, claimQuery, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: h.Revision, Transition: "claim", Reason: "Take responsibility for the remaining fixed step"})
	if e != nil || len(claimed.Receipt.DirectoryStepIDs) != 1 {
		t.Fatalf("archived fixed claim failed: %+v %v", claimed, e)
	}
	if e = f.issues.DriveCockpitDirectoryOperation(ctx, f.ws, f.meeting, op); e != nil {
		t.Fatal(e)
	}
	h, e = f.issues.GetCockpitDirectoryOperation(ctx, query)
	if e != nil || h.State != "completed" || h.AcceptedBindingRevision == nil || *h.AcceptedBindingRevision != 3 {
		t.Fatalf("archived continuation did not complete: %+v %v", h, e)
	}
}

type directoryBlockingPreparation struct {
	cockpitnas.Preparation
	entered chan struct{}
	release <-chan struct{}
}

func (p *directoryBlockingPreparation) EnsurePreparedDirectory(ctx context.Context, target cockpitnas.PreparationTarget, path string) (cockpitnas.PreparationObservation, error) {
	observation, err := p.Preparation.EnsurePreparedDirectory(ctx, target, path)
	p.entered <- struct{}{}
	<-p.release // Simulates a blocked completion after the filesystem side effect.
	return observation, err
}
func TestCockpitDirectoryLeaseSweepContinuesWhileFixedFilesystemExecutorIsBlocked(t *testing.T) {
	f, p, _, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	created, _ := directoryCreateFixturePlan(t, f, p, rid, "blocked-kernel", nil)
	op := parseTestUUID(t, created.Current.ID)
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	base := f.issues.CockpitDirectoryPreparer
	f.issues.CockpitDirectoryPreparer = &directoryBlockingPreparation{Preparation: base, entered: entered, release: release}
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	workerDone := make(chan struct{})
	go func() { f.issues.RunCockpitDirectoryWorker(workerCtx); close(workerDone) }()
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("executor did not enter its bounded filesystem call")
	}
	steps, e := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: op})
	if e != nil || len(steps) != 1 || steps[0].State != "running" {
		t.Fatalf("running step %+v %v", steps, e)
	}
	old := steps[0].LastAttemptID
	if _, e = f.Pool.Exec(ctx, "UPDATE cockpit_meeting_directory_step SET lease_expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2", f.ws, steps[0].ID); e != nil {
		t.Fatal(e)
	}
	// The separate DB loop must expire the first lease even while its I/O has
	// not returned. The second fixed executor can then own its fresh attempt.
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("blocked I/O stalled independent lease recovery")
	}
	previous, e := f.q.GetCockpitDirectoryAttempt(ctx, db.GetCockpitDirectoryAttemptParams{WorkspaceID: f.ws, MeetingID: f.meeting, OperationID: op, StepID: steps[0].ID, ID: old})
	if e != nil || previous.State != "expired" {
		t.Fatalf("old lease was not expired: %+v %v", previous, e)
	}
	h, e := f.issues.GetCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.issues.ControlCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op}, CockpitDirectoryControlInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: h.Revision, Transition: "abandon", Reason: "Stop this plan while storage is unresponsive"}); e != nil {
		t.Fatal(e)
	}
	close(release)
	released = true
	deadline := time.Now().Add(5 * time.Second)
	for {
		var late int
		if e = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_directory_attempt WHERE workspace_id=$1 AND operation_id=$2 AND late_receipt IS NOT NULL", f.ws, op).Scan(&late); e != nil {
			t.Fatal(e)
		}
		if late == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("both bounded late observations were not retained: %d", late)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-workerDone:
	case <-time.After(time.Second):
		t.Fatal("lease coordinator did not stop")
	}
	h, e = f.issues.GetCockpitDirectoryOperation(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: op})
	if e != nil || h.State != "abandoned" {
		t.Fatalf("late executor revived plan: %+v %v", h, e)
	}
}

type directoryInspectionCounter struct {
	cockpitnas.Preparation
	inspects atomic.Int32
	writes   atomic.Int32
}

func (c *directoryInspectionCounter) InspectPreparation(ctx context.Context, target cockpitnas.PreparationTarget, paths []string) ([]cockpitnas.PreparationInspection, error) {
	c.inspects.Add(1)
	return c.Preparation.InspectPreparation(ctx, target, paths)
}
func (c *directoryInspectionCounter) EnsurePreparedDirectory(ctx context.Context, target cockpitnas.PreparationTarget, path string) (cockpitnas.PreparationObservation, error) {
	c.writes.Add(1)
	return c.Preparation.EnsurePreparedDirectory(ctx, target, path)
}

func TestCockpitDirectoryPreviewRejectsInvalidPrincipalBeforeFilesystemInspection(t *testing.T) {
	f, _, root, rid := legacyDirectoryFixture(t, true)
	ctx := context.Background()
	credentialOwner := f.member(t, "preview-runtime-owner")
	runtime := f.Runtime(t, "Preview runtime", testutil.Cols{"owner_id": credentialOwner, "visibility": "public"})
	agent := f.Agent(t, "Preview producer", runtime, testutil.Cols{"owner_id": f.owner, "permission_mode": "private", "status": "idle"})
	issue := f.Issue(t, "Authorized preparation")
	otherIssue := f.Issue(t, "Unrelated preparation")
	f.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "issue_id": issue, "role": "task", "roles": []string{"preparation"}}, "workspace_id=$1 AND meeting_id=$2 AND issue_id=$3", f.ws, f.meeting, issue)
	principal := func(source string, authorizer pgtype.UUID) CockpitDirectoryRead {
		run := f.Task(t, agent, testutil.Cols{"issue_id": source, "runtime_id": runtime, "status": "running", "originator_user_id": authorizer, "accountable_user_id": authorizer})
		token, err := f.q.CreateTaskToken(ctx, db.CreateTaskTokenParams{ID: dbid.NewV7(), TokenHash: util.UUIDToString(dbid.NewV7()), TaskID: parseTestUUID(t, run), AgentID: parseTestUUID(t, agent), WorkspaceID: f.ws, UserID: parseTestUUID(t, credentialOwner), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		if err != nil {
			t.Fatal(err)
		}
		f.Cleanup(t, "DELETE FROM task_token WHERE id=$1", token.ID)
		return CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: parseTestUUID(t, credentialOwner), ActorSource: "task_token", AgentID: parseTestUUID(t, agent), RunID: parseTestUUID(t, run), TaskTokenID: token.ID}
	}
	original := principal(issue, f.owner)
	made, _ := directoryCreateFixturePlan(t, f, original, rid, "known-target", []string{"会议纪要与录音转写", "会议材料", "照片"})
	counter := &directoryInspectionCounter{Preparation: f.issues.CockpitDirectoryPreparer}
	f.issues.CockpitDirectoryPreparer = counter
	input := CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rid, RelativeDirectory: "known-target", Partitions: []string{"会议纪要与录音转写", "会议材料", "照片"}, ObservedBindingRevision: 1, BindAfterBase: true}
	legacy := CockpitLegacyDirectoryInput{Directory: filepath.Join(root, "known-target")}
	assertDenied := func(t *testing.T, p CockpitDirectoryRead, historical bool) {
		t.Helper()
		counter.inspects.Store(0)
		counter.writes.Store(0)
		var err error
		if historical {
			_, err = f.issues.ProvisionCockpitMeetingDirectory(ctx, p, legacy)
		} else {
			_, err = f.issues.PreviewCockpitMeetingDirectory(ctx, p, input)
		}
		if !errors.Is(err, ErrCockpitWorkflowForbidden) || counter.inspects.Load() != 0 || counter.writes.Load() != 0 {
			t.Fatalf("refused principal touched filesystem: historical=%v inspections=%d writes=%d err=%v", historical, counter.inspects.Load(), counter.writes.Load(), err)
		}
	}
	steps, err := f.q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: f.ws, OperationID: parseTestUUID(t, made.Current.ID)})
	if err != nil || len(steps) == 0 {
		t.Fatalf("retained steps: %v", err)
	}
	assertRetryDenied := func(t *testing.T, p CockpitDirectoryRead) {
		t.Helper()
		counter.inspects.Store(0)
		counter.writes.Store(0)
		_, err := f.issues.PreviewCockpitDirectoryRetry(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p, OperationID: parseTestUUID(t, made.Current.ID)}, CockpitDirectoryRetryPreviewInput{StepIDs: []string{util.UUIDToString(steps[0].ID)}})
		if !errors.Is(err, ErrCockpitWorkflowForbidden) || counter.inspects.Load() != 0 || counter.writes.Load() != 0 {
			t.Fatalf("refused retry principal touched filesystem: inspections=%d writes=%d err=%v", counter.inspects.Load(), counter.writes.Load(), err)
		}
	}
	t.Run("unrelated Issue cannot probe a new or retained target", func(t *testing.T) {
		p := principal(otherIssue, f.owner)
		assertDenied(t, p, false)
		assertDenied(t, p, true)
		assertRetryDenied(t, p)
	})
	t.Run("credential owner cannot substitute for originator invocation", func(t *testing.T) {
		p := principal(issue, parseTestUUID(t, credentialOwner))
		assertDenied(t, p, false)
		assertDenied(t, p, true)
		assertRetryDenied(t, p)
	})
	t.Run("mismatched task token cannot probe", func(t *testing.T) {
		p := original
		p.TaskTokenID = dbid.NewV7()
		assertDenied(t, p, false)
		assertDenied(t, p, true)
		assertRetryDenied(t, p)
	})
	if _, err := f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status='completed' WHERE id=$1", original.RunID); err != nil {
		t.Fatal(err)
	}
	t.Run("terminal Run cannot request public preview", func(t *testing.T) {
		assertDenied(t, original, false)
		assertRetryDenied(t, original)
	})
	t.Run("another current member cannot inspect a retry grant", func(t *testing.T) {
		p := CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: parseTestUUID(t, credentialOwner), ActorSource: "human"}
		assertRetryDenied(t, p)
	})
	t.Run("terminal same source may continue and inspect only retained target", func(t *testing.T) {
		result, err := f.issues.ProvisionCockpitMeetingDirectory(ctx, original, legacy)
		if err != nil || result.OperationID != made.Current.ID || result.State != "completed" {
			t.Fatalf("retained continuation: %+v %v", result, err)
		}
		counter.inspects.Store(0)
		counter.writes.Store(0)
		result, err = f.issues.ProvisionCockpitMeetingDirectory(ctx, original, legacy)
		if err != nil || result.OperationID != made.Current.ID || counter.inspects.Load() != 1 || counter.writes.Load() != 0 {
			t.Fatalf("retained inspection: %+v %v inspections=%d writes=%d", result, err, counter.inspects.Load(), counter.writes.Load())
		}
		changed := legacy
		changed.Directory = filepath.Join(root, "never-authorized")
		counter.inspects.Store(0)
		_, err = f.issues.ProvisionCockpitMeetingDirectory(ctx, original, changed)
		if !errors.Is(err, ErrCockpitWorkflowForbidden) || counter.inspects.Load() != 0 || counter.writes.Load() != 0 {
			t.Fatalf("terminal task probed a different target: %v inspections=%d writes=%d", err, counter.inspects.Load(), counter.writes.Load())
		}
	})
	t.Run("retained authority still requires current INVOKE", func(t *testing.T) {
		if _, err := f.Pool.Exec(ctx, "UPDATE agent SET owner_id=$1 WHERE id=$2", credentialOwner, agent); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := f.Pool.Exec(ctx, "UPDATE agent SET owner_id=$1 WHERE id=$2", f.owner, agent); err != nil {
				t.Fatal(err)
			}
		}()
		assertDenied(t, original, false)
		assertDenied(t, original, true)
	})
	t.Run("retained authority still requires authorizer membership", func(t *testing.T) {
		if _, err := f.Pool.Exec(ctx, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, f.owner); err != nil {
			t.Fatal(err)
		}
		assertDenied(t, original, false)
		assertDenied(t, original, true)
	})
}
