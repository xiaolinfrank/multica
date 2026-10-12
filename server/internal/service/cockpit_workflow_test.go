package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type cockpitWorkflowFixture struct {
	principalFixture
	issues             *IssueService
	ws, meeting, owner pgtype.UUID
}

func newCockpitWorkflowFixture(t *testing.T) cockpitWorkflowFixture {
	t.Helper()
	f, owner := newPrincipalFixture(t)
	ws := parseTestUUID(t, f.WorkspaceID)
	board := f.Insert(t, "cockpit", testutil.Cols{"workspace_id": f.WorkspaceID, "title": "Workflow test"})
	meeting := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board, "title": "Meeting"})
	// Clean workflow children before the fixture's meeting and workspace rows.
	f.Cleanup(t, "DELETE FROM issue WHERE workspace_id=$1", ws)
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_issue WHERE workspace_id=$1", ws)
	f.Cleanup(t, "DELETE FROM cockpit_node_issue WHERE workspace_id=$1", ws)
	f.Cleanup(t, "DELETE FROM cockpit_minutes_version WHERE workspace_id=$1", ws)
	f.Cleanup(t, "DELETE FROM cockpit_reviewer_handoff WHERE workspace_id=$1", ws)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	return cockpitWorkflowFixture{principalFixture: f, issues: svc, ws: ws, meeting: parseTestUUID(t, meeting), owner: parseTestUUID(t, owner)}
}
func (f cockpitWorkflowFixture) init(t *testing.T, agent string) {
	t.Helper()
	p := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none"}}
	if agent != "" {
		p.NewIssue.AssigneeType = pgtype.Text{String: "agent", Valid: true}
		p.NewIssue.AssigneeID = parseTestUUID(t, agent)
	}
	if err := f.issues.EnableCockpitMeetingWorkPackage(context.Background(), p, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
}
func (f cockpitWorkflowFixture) work(t *testing.T) cockpitMinutesState {
	t.Helper()
	w, e := f.q.GetCockpitMeetingWorkPackage(context.Background(), db.GetCockpitMeetingWorkPackageParams{WorkspaceID: f.ws, ID: f.meeting})
	if e != nil {
		t.Fatal(e)
	}
	return minutesStateFromGet(f.ws, w)
}
func (f cockpitWorkflowFixture) command(t *testing.T) CockpitWorkPackageCommand {
	return CockpitWorkPackageCommand{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ExpectedRevision: f.work(t).Revision}
}
func (f cockpitWorkflowFixture) ready(t *testing.T) {
	t.Helper()
	yes := true
	if e := f.issues.SetCockpitMeetingReadiness(context.Background(), CockpitWorkPackageReadiness{CockpitWorkPackageCommand: f.command(t), Ended: &yes, MaterialsReady: &yes}); e != nil {
		t.Fatal(e)
	}
}
func (f cockpitWorkflowFixture) versions(t *testing.T) []db.CockpitMinutesVersion {
	t.Helper()
	v, e := f.q.ListCockpitMinutesVersions(context.Background(), db.ListCockpitMinutesVersionsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if e != nil {
		t.Fatal(e)
	}
	return v
}

func TestCockpitWorkflowHumanReviewAndPublication(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	if e := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("release without materials = %v", e)
	}
	yes, notEnded := true, false
	if err := f.issues.SetCockpitMeetingReadiness(ctx, CockpitWorkPackageReadiness{CockpitWorkPackageCommand: f.command(t), Ended: &notEnded, MaterialsReady: &yes}); err != nil {
		t.Fatal(err)
	}
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("materials alone released an unfinished meeting: %v", err)
	}
	f.ready(t)
	release := f.command(t)
	if e := f.issues.ReleaseCockpitMeetingMinutes(ctx, release); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.ReleaseCockpitMeetingMinutes(ctx, release); e != nil {
		t.Fatal("release retry:", e)
	}
	if f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.work(t).MinutesIssueID) != 0 {
		t.Fatal("member executor unexpectedly created a Run")
	}
	submission := CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: "Agreed scope and next steps.", ActorType: "member", AuthorID: f.owner}
	if e := f.issues.SubmitCockpitMeetingMinutes(ctx, submission, IssueCreateOpts{}); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.SubmitCockpitMeetingMinutes(ctx, submission, IssueCreateOpts{}); e != nil {
		t.Fatal("submission retry:", e)
	}
	versions := f.versions(t)
	if len(versions) != 1 {
		t.Fatalf("versions = %d", len(versions))
	}
	v := versions[0]
	reviewIssue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: v.ReviewIssueID, WorkspaceID: f.ws})
	if e != nil {
		t.Fatal(e)
	}
	if reviewIssue.AssigneeType.String != "member" || reviewIssue.AssigneeID != f.owner {
		t.Fatalf("review issue = %+v", reviewIssue)
	}
	// Ordinary done is not a review result.
	if _, e = f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID: v.ReviewIssueID, WorkspaceID: f.ws, Status: "done"}); e != nil {
		t.Fatal(e)
	}
	publish := CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: v.ID}
	if e = f.issues.PublishCockpitMeetingMinutes(ctx, publish); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("done published pending version: %v", e)
	}
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: publish, Decision: "approved"}
	if e = f.issues.ReviewCockpitMeetingMinutes(ctx, review); e != nil {
		t.Fatal(e)
	}
	if e = f.issues.ReviewCockpitMeetingMinutes(ctx, review); e != nil {
		t.Fatal("review retry:", e)
	}
	publish.CockpitWorkPackageCommand = f.command(t)
	if e = f.issues.PublishCockpitMeetingMinutes(ctx, publish); e != nil {
		t.Fatal(e)
	}
	if e = f.issues.PublishCockpitMeetingMinutes(ctx, publish); e != nil {
		t.Fatal("publish retry:", e)
	}
	if f.work(t).PublishedVersionID != v.ID {
		t.Fatal("publication did not reference reviewed version")
	}
}

func TestCockpitWorkflowConcurrentInitAndRelease(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "minutes")
	init := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none", AssigneeType: pgtype.Text{String: "agent", Valid: true}, AssigneeID: parseTestUUID(t, agent)}}
	runTogether := func(fn func() error) {
		t.Helper()
		var wg sync.WaitGroup
		errs := make(chan error, 4)
		for i := 0; i < 4; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); errs <- fn() }()
		}
		wg.Wait()
		close(errs)
		for e := range errs {
			if e != nil {
				t.Fatal(e)
			}
		}
	}
	runTogether(func() error { return f.issues.EnableCockpitMeetingWorkPackage(ctx, init, IssueCreateOpts{}) })
	var count int
	if e := f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws).Scan(&count); e != nil || count != 1 {
		t.Fatalf("initialization count %d: %v", count, e)
	}
	work := f.work(t)
	issue, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: work.MinutesIssueID, WorkspaceID: f.ws})
	if e != nil {
		t.Fatal(e)
	}
	previewIssue := issue
	previewIssue.Status = "todo"
	if _, ok := f.issues.WillEnqueueRun(ctx, IssueTriggerInput{Issue: previewIssue, PrevStatus: "backlog", StatusChanged: true}, IssueTriggerProbe{}); ok {
		t.Fatal("preview promises a held workflow run")
	}
	for _, origin := range []RunOrigin{OriginDerived, OriginNamed} {
		if _, e := f.svc.TaskSvc.EnqueueTaskForMention(ctx, issue, parseTestUUID(t, agent), pgtype.UUID{}, origin); !errors.Is(e, ErrCockpitWorkflowExecutionBlocked) {
			t.Fatalf("held origin %v = %v", origin, e)
		}
	}
	f.ready(t)
	cmd := f.command(t)
	runTogether(func() error { return f.issues.ReleaseCockpitMeetingMinutes(ctx, cmd) })
	work = f.work(t)
	if e := f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", work.MinutesIssueID).Scan(&count); e != nil || count != 1 {
		t.Fatalf("release count %d: %v", count, e)
	}
}

func TestCockpitWorkflowAdoptionPreservesLegacyLink(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	issue := f.Issue(t, "Existing minutes", testutil.Cols{"status": "backlog", "assignee_type": "member", "assignee_id": f.UserID})
	issueID := parseTestUUID(t, issue)
	if _, e := f.q.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{WorkspaceID: f.ws, MeetingID: f.meeting, IssueID: issueID, Role: "task", Position: 8}); e != nil {
		t.Fatal(e)
	}
	if _, e := f.q.UpdateCockpitMeetingIssueRoles(ctx, db.UpdateCockpitMeetingIssueRolesParams{WorkspaceID: f.ws, MeetingID: f.meeting, IssueID: issueID, Roles: []string{"reference"}}); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.EnableCockpitMeetingWorkPackage(ctx, CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, ExistingIssueID: issueID}, IssueCreateOpts{}); e != nil {
		t.Fatal(e)
	}
	link, e := f.q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: f.ws, MeetingID: f.meeting, IssueID: issueID})
	if e != nil {
		t.Fatal(e)
	}
	if link.Role != "task" || link.Position != 8 || len(link.Roles) != 2 {
		t.Fatalf("legacy link was overwritten: %+v", link)
	}
}

func TestCockpitWorkflowRejectsDeferredAdoptionAndRollsBack(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "deferred")
	issue := f.Issue(t, "Existing", testutil.Cols{"status": "backlog"})
	a, err := f.q.GetAgent(ctx, parseTestUUID(t, agent))
	if err != nil {
		t.Fatal(err)
	}
	f.Task(t, agent, testutil.Cols{"issue_id": issue, "status": "deferred", "runtime_id": a.RuntimeID})
	e := f.issues.EnableCockpitMeetingWorkPackage(ctx, CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, ExistingIssueID: parseTestUUID(t, issue)}, IssueCreateOpts{})
	if !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("deferred adoption = %v", e)
	}
	var count int
	if e := f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND 'minutes'=ANY(roles)", f.ws).Scan(&count); e != nil || count != 0 {
		t.Fatalf("partial work package count %d: %v", count, e)
	}
	// Failure after canonical issue creation must roll back its issue too.
	f = newCockpitWorkflowFixture(t)
	bad := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NodeID: dbid.NewV7(), NewIssue: IssueCreateParams{Title: "Must roll back", Priority: "none"}}
	if e := f.issues.EnableCockpitMeetingWorkPackage(ctx, bad, IssueCreateOpts{}); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatalf("invalid archive = %v", e)
	}
	if e := f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND title='Must roll back'", f.ws).Scan(&count); e != nil || count != 0 {
		t.Fatalf("orphan issue count %d: %v", count, e)
	}
}

func TestCockpitWorkflowReviewAuthorityAndNewRound(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	f.ready(t)
	if e := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); e != nil {
		t.Fatal(e)
	}
	submit := func(content string) {
		t.Helper()
		if e := f.issues.SubmitCockpitMeetingMinutes(ctx, CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: content, ActorType: "member", AuthorID: f.owner}, IssueCreateOpts{}); e != nil {
			t.Fatal(e)
		}
	}
	submit("Draft 1")
	v1 := f.versions(t)[0]
	other := parseTestUUID(t, f.member(t, "review-other"))
	f.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", f.ws, other)
	// Changing the Issue assignee does not delegate formal reviewer authority.
	f.Exec(t, "UPDATE issue SET assignee_id=$1 WHERE id=$2", other, v1.ReviewIssueID)
	cmd := CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: v1.ID}
	cmd.ActorID = other
	if e := f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: cmd, Decision: "approved"}); !errors.Is(e, ErrCockpitWorkflowForbidden) {
		t.Fatalf("changed assignee gained authority: %v", e)
	}
	cmd.ActorID = f.owner
	if _, e := f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{ID: f.work(t).MinutesIssueID, WorkspaceID: f.ws, Status: "done"}); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: cmd, Decision: "changes_requested", Feedback: "Clarify scope"}); e != nil {
		t.Fatal(e)
	}
	rework, e := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: f.work(t).MinutesIssueID, WorkspaceID: f.ws})
	if e != nil {
		t.Fatal(e)
	}
	if rework.Status != "todo" {
		t.Fatalf("returned minutes did not resume responsibility: %s", rework.Status)
	}
	submit("Draft 2")
	versions := f.versions(t)
	if len(versions) != 2 || versions[0].ReviewIssueID == v1.ReviewIssueID || versions[1].Content != "Draft 1" {
		t.Fatalf("new round did not preserve old review: %+v", versions)
	}
	cmd.CockpitWorkPackageCommand = f.command(t)
	if e := f.issues.PublishCockpitMeetingMinutes(ctx, cmd); !errors.Is(e, ErrCockpitWorkflowConflict) {
		t.Fatalf("old version publish = %v", e)
	}
}

func TestCockpitWorkflowDatabaseGateBlocksBypass(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "gate")
	f.init(t, agent)
	a, e := f.q.GetAgent(ctx, parseTestUUID(t, agent))
	if e != nil {
		t.Fatal(e)
	}
	issueID := f.work(t).MinutesIssueID
	_, e = f.Pool.Exec(ctx, "INSERT INTO agent_task_queue(id,agent_id,runtime_id,issue_id,status,priority) VALUES($1,$2,$3,$4,'queued',1)", dbid.NewV7(), a.ID, a.RuntimeID, issueID)
	if e == nil {
		t.Fatal("direct task insert bypassed gate")
	}
	f.ready(t)
	if e := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); e != nil {
		t.Fatal(e)
	}
	if e := f.issues.SubmitCockpitMeetingMinutes(ctx, CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: "Fixed review text", ActorType: "member", AuthorID: f.owner}, IssueCreateOpts{}); e != nil {
		t.Fatal(e)
	}
	reviewID := f.versions(t)[0].ReviewIssueID
	if e := GuardCockpitIssueExecution(ctx, f.q, reviewID); !errors.Is(e, ErrCockpitWorkflowExecutionBlocked) {
		t.Fatalf("review guard = %v", e)
	}
	// The transition trigger covers claim/start of an externally staged task too.
	task := f.Task(t, agent, testutil.Cols{"issue_id": reviewID, "status": "cancelled", "runtime_id": a.RuntimeID})
	if _, err := f.svc.TaskSvc.StartTask(ctx, parseTestUUID(t, task)); !errors.Is(err, ErrCockpitWorkflowExecutionBlocked) {
		t.Fatalf("review task service start = %v", err)
	}
	for _, status := range []string{"queued", "dispatched", "running"} {
		if _, e := f.Pool.Exec(ctx, "UPDATE agent_task_queue SET status=$1 WHERE id=$2", status, task); e == nil {
			t.Fatal(fmt.Sprintf("review task entered %s", status))
		}
	}
}

func TestCockpitWorkflowReleaseCommitFailureRollsBackEverything(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "rollback-release")
	f.init(t, agent)
	f.ready(t)
	before := f.work(t)
	injected := errors.New("injected workflow commit failure")
	f.issues.TxStarter = &rejectIssueCommitTxStarter{pool: f.Pool, err: injected}
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); !errors.Is(err, injected) {
		t.Fatalf("release error = %v", err)
	}
	after := f.work(t)
	if after.Released || after.Revision != before.Revision {
		t.Fatalf("release ledger escaped rollback: %+v", after)
	}
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: before.MinutesIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if issue.Status != "backlog" {
		t.Fatalf("status escaped rollback: %s", issue.Status)
	}
	var n int
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tasks escaped rollback %d: %v", n, err)
	}
}

func TestCockpitWorkflowConcurrentSubmissionIsOneVersionAndReview(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	f.ready(t)
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); err != nil {
		t.Fatal(err)
	}
	input := CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: "Concurrent fixed content", ActorType: "member", AuthorID: f.owner}
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- f.issues.SubmitCockpitMeetingMinutes(ctx, input, IssueCreateOpts{}) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(f.versions(t)) != 1 {
		t.Fatal("submission created duplicate versions")
	}
	var n int
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws).Scan(&n); err != nil || n != 2 {
		t.Fatalf("expected minutes and one review, got %d: %v", n, err)
	}
}

func TestCockpitWorkflowWakeupCannotDispatchHeldIssue(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "held-wakeup")
	f.init(t, agent)
	issue := f.work(t).MinutesIssueID
	wakes := &IssueWakeupService{Tasks: f.svc.TaskSvc}
	w, err := wakes.Create(ctx, issue, f.owner, pgtype.UUID{}, WakeupInput{AgentID: agent, Kind: "every", Mode: "continuous", IntervalSeconds: 60, Instruction: "Check material readiness"})
	if err != nil {
		t.Fatal(err)
	}
	f.Cleanup(t, "DELETE FROM issue_wakeup_receipt WHERE wakeup_id=$1", w.ID)
	f.Cleanup(t, "DELETE FROM issue_wakeup WHERE id=$1", w.ID)
	f.Exec(t, "UPDATE issue_wakeup SET next_fire_at=now()-interval '1 minute' WHERE id=$1", w.ID)
	if err := wakes.dispatch(ctx, w); !errors.Is(err, ErrCockpitWorkflowExecutionBlocked) {
		t.Fatalf("held wakeup dispatch = %v", err)
	}
	var n int
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue).Scan(&n); err != nil || n != 0 {
		t.Fatalf("wakeup created task %d: %v", n, err)
	}
}

func TestCockpitWorkflowArchiveBindingMatchesIssueScope(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	p1 := f.Project(t, "Bound project")
	p2 := f.Project(t, "Other project")
	m1 := f.Module(t, p1, "Bound module")
	m2 := f.Module(t, p1, "Other module")
	meeting, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{ID: f.meeting, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	root := f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "not-a-derived-number", "project_id": p1, "module_id": m1})
	archive := f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "archive", "parent_id": root})
	init := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NodeID: parseTestUUID(t, archive), NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none", ProjectID: parseTestUUID(t, p2)}}
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, init, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cross-project archive = %v", err)
	}
	init.NewIssue.ProjectID = parseTestUUID(t, p1)
	init.NewIssue.ModuleID = parseTestUUID(t, m2)
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, init, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cross-module archive = %v", err)
	}
	init.NewIssue.ModuleID = parseTestUUID(t, m1)
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, init, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: f.work(t).MinutesIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if issue.ProjectID != parseTestUUID(t, p1) || issue.ModuleID != parseTestUUID(t, m1) {
		t.Fatal("archive changed issue filing")
	}
}

func TestCockpitWorkflowConcurrentAdoptionAndEnqueueCannotBothWin(t *testing.T) {
	for i := 0; i < 3; i++ {
		t.Run(fmt.Sprintf("attempt_%d", i), func(t *testing.T) {
			f := newCockpitWorkflowFixture(t)
			ctx := context.Background()
			agent := f.privateAgentOwnedBy(t, f.UserID, "adopt-race")
			id := parseTestUUID(t, f.Issue(t, "Existing backlog", testutil.Cols{"status": "backlog", "assignee_type": "agent", "assignee_id": agent}))
			issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: id, WorkspaceID: f.ws})
			if err != nil {
				t.Fatal(err)
			}
			// Both contenders operate on a real runnable fake agent. The blocker makes
			// adoption's active-task check and the queue insertion contend on ownership.
			tx, err := f.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.q.WithTx(tx).LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{ID: id, WorkspaceID: f.ws}); err != nil {
				t.Fatal(err)
			}
			adopted := make(chan error, 1)
			queued := make(chan error, 1)
			go func() {
				adopted <- f.issues.EnableCockpitMeetingWorkPackage(ctx, CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, ExistingIssueID: id}, IssueCreateOpts{})
			}()
			go func() { _, err := f.svc.TaskSvc.EnqueueTaskForIssueByActor(ctx, issue, f.owner); queued <- err }()
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			adoptErr, queueErr := <-adopted, <-queued
			var packages, tasks int
			if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_meeting_issue WHERE workspace_id=$1 AND 'minutes'=ANY(roles)", f.ws).Scan(&packages); err != nil {
				t.Fatal(err)
			}
			if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", id).Scan(&tasks); err != nil {
				t.Fatal(err)
			}
			switch {
			case packages == 1 && tasks == 0:
				if adoptErr != nil || queueErr == nil {
					t.Fatalf("adoption winner: adopt=%v queue=%v", adoptErr, queueErr)
				}
				var pgErr *pgconn.PgError
				if !errors.Is(queueErr, ErrCockpitWorkflowExecutionBlocked) && (!errors.As(queueErr, &pgErr) || pgErr.ConstraintName != "cockpit_workflow_execution_gate") {
					t.Fatalf("queue failed for unrelated reason: %v", queueErr)
				}
			case packages == 0 && tasks == 1:
				if queueErr != nil || !errors.Is(adoptErr, ErrCockpitWorkflowConflict) {
					t.Fatalf("enqueue winner: adopt=%v queue=%v", adoptErr, queueErr)
				}
			default:
				t.Fatalf("unsafe race packages=%d tasks=%d adopt=%v queue=%v", packages, tasks, adoptErr, queueErr)
			}
		})
	}
}

func TestCockpitWorkflowCannotPublishApprovedSupersededVersion(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	f.ready(t)
	if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); err != nil {
		t.Fatal(err)
	}
	submit := func(content string) {
		t.Helper()
		if err := f.issues.SubmitCockpitMeetingMinutes(ctx, CockpitMinutesSubmission{CockpitWorkPackageCommand: f.command(t), SubmissionKey: dbid.NewV7(), Content: content, ActorType: "member", AuthorID: f.owner}, IssueCreateOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	submit("Approved old version")
	old := f.versions(t)[0]
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: old.ID}, Decision: "approved"}); err != nil {
		t.Fatal(err)
	}
	submit("New current draft")
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: old.ID}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("superseded approved version publish = %v", err)
	}
	if f.work(t).PublishedVersionID.Valid {
		t.Fatal("published an outdated version")
	}
}

func TestCockpitWorkflowLegacyProvisionCannotCreateRunnableIssue(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	agent := f.privateAgentOwnedBy(t, f.UserID, "legacy-race")
	f.init(t, agent)
	_, err := f.issues.Create(ctx, IssueCreateParams{WorkspaceID: f.ws, Title: "Legacy immediate task", Status: "todo", Priority: "none", AssigneeType: pgtype.Text{String: "agent", Valid: true}, AssigneeID: parseTestUUID(t, agent), CreatorType: "member", CreatorID: f.owner, MeetingTask: &CockpitMeetingTask{MeetingID: f.meeting}}, IssueCreateOpts{})
	if !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("legacy task bypass = %v", err)
	}
	var issues, tasks int
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws).Scan(&issues); err != nil {
		t.Fatal(err)
	}
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", f.ws).Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if issues != 1 || tasks != 0 {
		t.Fatalf("legacy provision escaped workflow: %d issues %d tasks", issues, tasks)
	}
}

func TestCockpitWorkflowInitRetryRequiresSameIntent(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	p1 := f.Project(t, "Initial project")
	p2 := f.Project(t, "Different project")
	m1 := f.Module(t, p1, "Initial module")
	m2 := f.Module(t, p1, "Different module")
	meeting, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{ID: f.meeting, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	nodeA := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "archive-a"}))
	nodeB := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": "archive-b"}))
	initial := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NodeID: nodeA, NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none", ModuleID: parseTestUUID(t, m1)}}
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, initial, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	work := f.work(t)
	// Both default member execution and module-derived project resolve to the
	// same intent on a retry, without needing a new initialization signature.
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, initial, IssueCreateOpts{}); err != nil {
		t.Fatalf("same intent retry = %v", err)
	}
	explicit := initial
	explicit.NewIssue.ProjectID = parseTestUUID(t, p1)
	explicit.NewIssue.AssigneeType = pgtype.Text{String: "member", Valid: true}
	explicit.NewIssue.AssigneeID = f.owner
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, explicit, IssueCreateOpts{}); err != nil {
		t.Fatalf("equivalent explicit retry = %v", err)
	}
	other := parseTestUUID(t, f.member(t, "init-other-executor"))
	cases := map[string]CockpitWorkPackageInit{}
	changed := initial
	changed.NewIssue.AssigneeType = pgtype.Text{String: "member", Valid: true}
	changed.NewIssue.AssigneeID = other
	cases["executor"] = changed
	changed = initial
	changed.NewIssue.ModuleID = pgtype.UUID{}
	changed.NewIssue.ProjectID = parseTestUUID(t, p2)
	cases["project"] = changed
	changed = initial
	changed.NewIssue.ModuleID = parseTestUUID(t, m2)
	cases["module"] = changed
	changed = initial
	changed.NodeID = nodeB
	cases["archive"] = changed
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, input, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
				t.Fatalf("different initialization intent = %v", err)
			}
		})
	}
	// Adopting the same identity is also a retry, not permission to add a new
	// archive relationship under an already-existing package.
	adopt := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, ExistingIssueID: work.MinutesIssueID, NodeID: nodeB}
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, adopt, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("adoption retry changed archive = %v", err)
	}
	adopt.NodeID = nodeA
	if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, adopt, IssueCreateOpts{}); err != nil {
		t.Fatalf("same adoption retry = %v", err)
	}
	var issues, links int
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws).Scan(&issues); err != nil {
		t.Fatal(err)
	}
	if err := f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_node_issue WHERE issue_id=$1", work.MinutesIssueID).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if issues != 1 || links != 1 {
		t.Fatalf("retry mutated existing work: %d issues %d links", issues, links)
	}
}

func TestCockpitWorkflowConcurrentDifferentInitIntentConflicts(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	other := parseTestUUID(t, f.member(t, "competing-init-executor"))
	first := CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, NewIssue: IssueCreateParams{Title: "Minutes", Priority: "none"}}
	second := first
	second.NewIssue.AssigneeType = pgtype.Text{String: "member", Valid: true}
	second.NewIssue.AssigneeID = other
	start := make(chan struct{})
	results := make(chan struct {
		executor pgtype.UUID
		err      error
	}, 2)
	for i, input := range []CockpitWorkPackageInit{first, second} {
		executor := f.owner
		if i == 1 {
			executor = other
		}
		go func(input CockpitWorkPackageInit, executor pgtype.UUID) {
			<-start
			results <- struct {
				executor pgtype.UUID
				err      error
			}{executor, f.issues.EnableCockpitMeetingWorkPackage(ctx, input, IssueCreateOpts{})}
		}(input, executor)
	}
	close(start)
	a, b := <-results, <-results
	winner, loser := a, b
	if winner.err != nil {
		winner, loser = loser, winner
	}
	if winner.err != nil || !errors.Is(loser.err, ErrCockpitWorkflowConflict) {
		t.Fatalf("competing intents = %v / %v", a.err, b.err)
	}
	work := f.work(t)
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: work.MinutesIssueID, WorkspaceID: f.ws})
	if err != nil {
		t.Fatal(err)
	}
	if issue.AssigneeID != winner.executor {
		t.Fatal("losing initializer changed the committed executor")
	}
	if count := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws); count != 1 {
		t.Fatalf("initializers created %d issues", count)
	}
}

func TestCockpitWorkflowReleaseHandoffConnectsAdoptedMinutesToSubmission(t *testing.T) {
	for _, kind := range []string{"agent", "squad"} {
		t.Run(kind, func(t *testing.T) {
			f := newCockpitWorkflowFixture(t)
			ctx := context.Background()
			agent := f.privateAgentOwnedBy(t, f.UserID, "handoff-"+kind)
			assignee := agent
			if kind == "squad" {
				assignee = f.Squad(t, "Minutes writers", agent)
			}
			original := "An adopted issue with an old directory reference; keep this description unchanged."
			issueID := parseTestUUID(t, f.Issue(t, "Existing minutes", testutil.Cols{"status": "backlog", "assignee_type": kind, "assignee_id": assignee, "description": original}))
			if err := f.issues.EnableCockpitMeetingWorkPackage(ctx, CockpitWorkPackageInit{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, ReviewerID: f.owner, ExistingIssueID: issueID}, IssueCreateOpts{}); err != nil {
				t.Fatal(err)
			}
			f.ready(t)
			if err := f.issues.ReleaseCockpitMeetingMinutes(ctx, f.command(t)); err != nil {
				t.Fatal(err)
			}
			var taskID pgtype.UUID
			if e := f.Pool.QueryRow(ctx, "SELECT id FROM agent_task_queue WHERE issue_id=$1 ORDER BY created_at DESC LIMIT 1", f.work(t).MinutesIssueID).Scan(&taskID); e != nil {
				t.Fatal(e)
			}
			task, err := f.q.GetAgentTask(ctx, taskID)
			if err != nil {
				t.Fatal(err)
			}
			meetingID := util.UUIDToString(f.meeting)
			for _, fragment := range []string{meetingID, "multica cockpit meeting show " + meetingID + " --json", "multica cockpit meeting lifecycle show " + meetingID, "multica cockpit meeting agenda list " + meetingID, "multica cockpit meeting agenda show " + meetingID, "multica cockpit meeting agenda references " + meetingID, "multica cockpit meeting workflow summary " + meetingID, "multica cockpit meeting workflow version " + meetingID, "multica cockpit meeting workflow submit " + meetingID, "--revision", "--submission-key", "--content-file", "--compact"} {
				if !task.HandoffNote.Valid || !strings.Contains(task.HandoffNote.String, fragment) {
					t.Errorf("handoff does not provide %q: %q", fragment, task.HandoffNote.String)
				}
			}
			if strings.Contains(task.HandoffNote.String, "multica cockpit show") {
				t.Fatal("handoff still requests the unbounded board")
			}
			if strings.Contains(task.HandoffNote.String, "multica cockpit meeting workflow show ") {
				t.Fatal("new handoff still requests unbounded version history")
			}
			if strings.Contains(task.HandoffNote.String, original) {
				t.Fatal("handoff elevated editable issue content into instructions")
			}
			if task.AgentID != parseTestUUID(t, agent) || (kind == "squad" && !task.IsLeaderTask) {
				t.Fatalf("wrong executor for %s handoff", kind)
			}
			after, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issueID, WorkspaceID: f.ws})
			if err != nil {
				t.Fatal(err)
			}
			if after.Description.String != original {
				t.Fatal("release rewrote the adopted issue description")
			}
		})
	}
}
