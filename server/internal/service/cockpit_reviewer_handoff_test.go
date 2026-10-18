package service

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func submitHandoffFixtureVersion(t *testing.T, f cockpitWorkflowFixture) (db.CockpitMinutesVersion, CockpitMinutesSubmission) {
	t.Helper()
	in := CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: "Fixed evidence and agreed scope.", ActorType: "member", AuthorID: f.owner}
	if err := f.issues.SubmitCockpitMeetingMinutes(context.Background(), in, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	return f.versions(t)[0], in
}
func handoffInput(t *testing.T, f cockpitWorkflowFixture, target pgtype.UUID) CockpitReviewerHandoff {
	t.Helper()
	return CockpitReviewerHandoff{CockpitWorkPackageCommand: f.command(t), HandoffKey: dbid.NewV7(), ReviewerID: target, Reason: "Reviewer responsibility transferred"}
}
func handoffHistory(t *testing.T, f cockpitWorkflowFixture) []db.CockpitReviewerHandoff {
	t.Helper()
	rows, err := f.q.ListCockpitReviewerHandoffs(context.Background(), db.ListCockpitReviewerHandoffsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	return rows
}
func prepareHandoffPending(t *testing.T, f cockpitWorkflowFixture) (db.CockpitMinutesVersion, CockpitMinutesSubmission) {
	t.Helper()
	f.init(t, "")
	f.ready(t)
	if err := f.issues.ReleaseCockpitMeetingMinutes(context.Background(), f.command(t)); err != nil {
		t.Fatal(err)
	}
	return submitHandoffFixtureVersion(t, f)
}

func TestCockpitReviewerHandoffPendingPreservesVersionAndRetiredGuards(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	before, submission := prepareHandoffPending(t, f)
	target := parseTestUUID(t, f.member(t, "handoff-target"))
	in := handoffInput(t, f, target)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, in, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	after := f.versions(t)[0]
	if after.ReviewerID != target || after.ReviewIssueID == before.ReviewIssueID || after.Decision != "pending" {
		t.Fatalf("pending transfer = %+v", after)
	}
	fixed := after
	fixed.ReviewerID = before.ReviewerID
	fixed.ReviewIssueID = before.ReviewIssueID
	if !reflect.DeepEqual(fixed, before) {
		t.Fatal("handoff changed fixed content, identity, provenance or decision")
	}
	oldIssue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: before.ReviewIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	newIssue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: after.ReviewIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if oldIssue.Status != "cancelled" || oldIssue.AssigneeID != f.owner || newIssue.Status != "todo" || newIssue.AssigneeType.String != "member" || newIssue.AssigneeID != target {
		t.Fatal("review work was not superseded by a new human responsibility")
	}
	history := handoffHistory(t, f)
	if len(history) != 1 || history[0].VersionID != before.ID || history[0].FromReviewIssueID != before.ReviewIssueID || history[0].ToReviewIssueID != after.ReviewIssueID || history[0].Revision != in.ExpectedRevision+1 {
		t.Fatalf("handoff audit = %+v", history)
	}
	if err := f.issues.SubmitCockpitMeetingMinutes(ctx, submission, IssueCreateOpts{}); err != nil {
		t.Fatalf("original submission retry after transfer: %v", err)
	}
	if len(f.versions(t)) != 1 {
		t.Fatal("retry created a second content version")
	}
	// Restoring ordinary task state or changing its assignee cannot restore the
	// superseded review's authority or turn it into agent-executable work.
	agent := f.privateAgentOwnedBy(t, f.UserID, "retired-review")
	f.Exec(t, "UPDATE issue SET status='backlog',assignee_type='agent',assignee_id=$2 WHERE id=$1", before.ReviewIssueID, agent)
	oldIssue, err = f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: before.ReviewIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.TaskSvc.EnqueueTaskForIssueByActor(ctx, oldIssue, f.owner); !errors.Is(err, ErrCockpitWorkflowExecutionBlocked) {
		t.Fatalf("retired review enqueue = %v", err)
	}
	a, err := f.q.GetAgent(ctx, parseTestUUID(t, agent))
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.Pool.Exec(ctx, "INSERT INTO agent_task_queue(id,agent_id,runtime_id,issue_id,status,priority) VALUES($1,$2,$3,$4,'queued',0)", dbid.NewV7(), a.ID, a.RuntimeID, before.ReviewIssueID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "cockpit_workflow_execution_gate" {
		t.Fatalf("retired review database gate = %v", err)
	}
	if linked, err := f.q.CockpitIssueHasWorkflow(ctx, before.ReviewIssueID); err != nil || !linked {
		t.Fatalf("retired issue could be adopted: %v/%v", linked, err)
	}
	if protected, err := f.q.CockpitWorkflowReferencesIssue(ctx, db.CockpitWorkflowReferencesIssueParams{WorkspaceID: f.ws, IssueID: before.ReviewIssueID}); err != nil || !protected {
		t.Fatalf("retired issue lost delete protection: %v/%v", protected, err)
	}
	role, err := f.q.CockpitMeetingWorkflowRequiredRole(ctx, db.CockpitMeetingWorkflowRequiredRoleParams{WorkspaceID: f.ws, MeetingID: f.meeting, IssueID: before.ReviewIssueID})
	if err != nil || role != "review" {
		t.Fatalf("retired issue lost required role: %q/%v", role, err)
	}
	owned, err := f.q.ListCockpitMeetingWorkflowIssueIDs(ctx, db.ListCockpitMeetingWorkflowIssueIDsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, id := range owned {
		found = found || id == before.ReviewIssueID
	}
	if !found {
		t.Fatal("replacement link set can drop retired review")
	}
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: before.ID}, Decision: "approved"}
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, review); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("old reviewer retained authority: %v", err)
	}
	review.ActorID = target
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, review); err != nil {
		t.Fatalf("new reviewer cannot review: %v", err)
	}
}

func TestCockpitReviewerHandoffDefaultOnlyAndTerminalHistory(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	b := parseTestUUID(t, f.member(t, "default-b"))
	c := parseTestUUID(t, f.member(t, "default-c"))
	first := handoffInput(t, f, b)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, first, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	history := handoffHistory(t, f)
	if len(history) != 1 || history[0].VersionID.Valid || history[0].FromReviewIssueID.Valid || history[0].ToReviewIssueID.Valid {
		t.Fatal("default-only command fabricated review work")
	}
	if n := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws); n != 1 {
		t.Fatalf("default-only command created %d issues", n)
	}
	f.ready(t)
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); err != nil {
		t.Fatal(err)
	}
	version, _ := submitHandoffFixtureVersion(t, f)
	if version.ReviewerID != b {
		t.Fatal("new version did not use the new default reviewer")
	}
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, first, IssueCreateOpts{}); err != nil {
		t.Fatalf("default-only replay with pending version = %v", err)
	}
	// Exercise a replay discovered only after entering the pending create hook.
	_, err := f.issues.Create(ctx, IssueCreateParams{WorkspaceID: f.ws, CreatorType: "member", CreatorID: f.owner, AllowDuplicate: true, CockpitWorkflow: &CockpitWorkflowIssue{Handoff: &first}}, IssueCreateOpts{})
	if !errors.Is(err, errCockpitHandoffReplayed) {
		t.Fatalf("default-only hook replay = %v", err)
	}
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Decision: "approved"}
	review.ActorID = b
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, review); err != nil {
		t.Fatal(err)
	}
	terminal := f.versions(t)[0]
	second := handoffInput(t, f, c)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, second, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(terminal, f.versions(t)[0]) {
		t.Fatal("default change rewrote a completed decision")
	}
	if f.work(t).ReviewerID != c {
		t.Fatal("future default did not change")
	}
	if h := handoffHistory(t, f)[0]; h.VersionID.Valid || h.ToReviewIssueID.Valid {
		t.Fatal("terminal version received a new review issue")
	}
	publish := CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}
	publish.ActorID = c
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, publish); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("future reviewer gained old publication authority: %v", err)
	}
	publish.ActorID = b
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, publish); err != nil {
		t.Fatalf("old approved reviewer lost publication authority: %v", err)
	}
}

func TestCockpitReviewerHandoffReplaysAuditWithoutRevertingCurrentReviewer(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	prepareHandoffPending(t, f)
	b := parseTestUUID(t, f.member(t, "replay-b"))
	c := parseTestUUID(t, f.member(t, "replay-c"))
	first := handoffInput(t, f, b)
	first.Reason = "  First handoff  "
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, first, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	second := handoffInput(t, f, c)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, second, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	f.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, b)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, first, IssueCreateOpts{}); err != nil {
		t.Fatalf("retry after target left = %v", err)
	}
	if f.work(t).ReviewerID != c || f.versions(t)[0].ReviewerID != c || len(handoffHistory(t, f)) != 2 {
		t.Fatal("old retry reverted current responsibility")
	}
	different := first
	different.Reason = "Different intent"
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, different, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("key reuse reason = %v", err)
	}
	different = first
	different.ExpectedRevision++
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, different, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("key reuse revision = %v", err)
	}
}

func TestCockpitReviewerHandoffRecoversMissingReviewer(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	old := parseTestUUID(t, f.member(t, "departed-reviewer"))
	next := parseTestUUID(t, f.member(t, "replacement-reviewer"))
	init := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: old, NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none"}}
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, init, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	f.ready(t)
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); err != nil {
		t.Fatal(err)
	}
	version, _ := submitHandoffFixtureVersion(t, f)
	f.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, old)
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, handoffInput(t, f, next), IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Decision: "approved"}
	review.ActorID = next
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, review); err != nil {
		t.Fatalf("replacement could not resolve blocked review: %v", err)
	}
}

func TestCockpitReviewerHandoffConflictAuthorizationAndRollback(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	before, _ := prepareHandoffPending(t, f)
	target := parseTestUUID(t, f.member(t, "rollback-target"))
	ordinary := parseTestUUID(t, f.member(t, "not-manager"))
	in := handoffInput(t, f, target)
	denied := in
	denied.ActorID = ordinary
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, denied, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("nonmanager = %v", err)
	}
	same := in
	same.ReviewerID = f.owner
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, same, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("same reviewer = %v", err)
	}
	injected := errors.New("handoff commit rejected")
	f.issues.TxStarter = &rejectIssueCommitTxStarter{pool: f.Pool, err: injected}
	var eventsAfter atomic.Int64
	for _, kind := range []string{protocol.EventIssueCreated, protocol.EventIssueUpdated} {
		f.issues.Bus.Subscribe(kind, func(e events.Event) { eventsAfter.Add(1) })
	}
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, in, IssueCreateOpts{}); !errors.Is(err, injected) {
		t.Fatalf("commit error = %v", err)
	}
	if !reflect.DeepEqual(before, f.versions(t)[0]) || f.work(t).ReviewerID != f.owner || f.work(t).Revision != in.ExpectedRevision || len(handoffHistory(t, f)) != 0 {
		t.Fatal("handoff escaped rollback")
	}
	old, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: before.ReviewIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if old.Status != "todo" || f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws) != 2 || eventsAfter.Load() != 0 {
		t.Fatal("rollback cancelled old work, created review work, or emitted events")
	}
}

func TestCockpitReviewerHandoffConcurrentSameKeyCreatesOneResponsibility(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	prepareHandoffPending(t, f)
	target := parseTestUUID(t, f.member(t, "concurrent-target"))
	in := handoffInput(t, f, target)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- f.issues.ChangeCockpitMeetingReviewer(ctx, in, IssueCreateOpts{}) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(handoffHistory(t, f)) != 1 || f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws) != 3 || f.work(t).Revision != in.ExpectedRevision+1 {
		t.Fatal("concurrent replay created duplicate work or revisions")
	}
}

func TestCockpitReviewerHandoffRacesReviewWithoutChangingDecision(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	version, _ := prepareHandoffPending(t, f)
	target := parseTestUUID(t, f.member(t, "race-review-target"))
	handoff := handoffInput(t, f, target)
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: handoff.CockpitWorkPackageCommand, VersionID: version.ID}, Decision: "approved"}
	start := make(chan struct{})
	changed := make(chan error, 1)
	reviewed := make(chan error, 1)
	go func() { <-start; changed <- f.issues.ChangeCockpitMeetingReviewer(ctx, handoff, IssueCreateOpts{}) }()
	go func() { <-start; reviewed <- f.issues.ReviewCockpitMeetingMinutes(ctx, review) }()
	close(start)
	handoffErr, reviewErr := <-changed, <-reviewed
	after := f.versions(t)[0]
	if handoffErr == nil {
		if !errors.Is(reviewErr, ErrCockpitWorkflowForbidden) || after.Decision != "pending" || after.ReviewerID != target || len(handoffHistory(t, f)) != 1 {
			t.Fatalf("handoff winner: review=%v state=%+v", reviewErr, after)
		}
	} else {
		if !errors.Is(handoffErr, ErrCockpitWorkflowConflict) || reviewErr != nil || after.Decision != "approved" || after.ReviewerID != f.owner || len(handoffHistory(t, f)) != 0 {
			t.Fatalf("review winner: handoff=%v review=%v", handoffErr, reviewErr)
		}
	}
}
