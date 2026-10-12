package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func reviseDecision(f planningFixture, a db.CockpitMeetingAction, outcome, reason string) CockpitActionResolution {
	in := f.resolve(a)
	in.ExpectedRevision = a.Revision
	in.DecisionKey = dbid.NewV7()
	in.Outcome = outcome
	in.Reason = reason
	in.NodeID, in.IssueID = pgtype.UUID{}, pgtype.UUID{}
	return in
}

func actionTrail(t *testing.T, f planningFixture, id pgtype.UUID) []map[string]any {
	t.Helper()
	row, err := f.q.GetCockpitMeetingAction(context.Background(), db.GetCockpitMeetingActionParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	var trail []map[string]any
	if err := json.Unmarshal(row.PreviousResolutions, &trail); err != nil {
		t.Fatalf("previous_resolutions is not a JSON trail: %v (%s)", err, row.PreviousResolutions)
	}
	return trail
}

func TestCockpitPlanningReviseTrailsDecisionsAndKeepsCreatedIssues(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Accept, reconsider, then re-create")
	accepted, err := f.issues.ResolveCockpitMeetingAction(ctx, f.resolve(a), IssueCreateOpts{})
	if err != nil || accepted.Status != "accepted" || !accepted.IssueID.Valid {
		t.Fatalf("forward acceptance = %+v / %v", accepted, err)
	}
	createdIssue := accepted.IssueID
	issuesAfterAccept := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws)

	// accepted -> dismiss: the create decision lands in the trail, the issue
	// it created keeps its ordinary lifecycle and ownership.
	dismiss := reviseDecision(f, accepted, "dismiss", "Owned by the delivery stream already")
	dismiss.NodeID = pgtype.UUID{}
	dismissed, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, dismiss, IssueCreateOpts{})
	if err != nil || dismissed.Status != "dismissed" || dismissed.Reason != "Owned by the delivery stream already" {
		t.Fatalf("revise to dismiss = %+v / %v", dismissed, err)
	}
	if dismissed.Revision != accepted.Revision+1 || dismissed.DecisionKey != dismiss.DecisionKey {
		t.Fatalf("revision did not consume the decision key: %+v", dismissed)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2", f.ws, createdIssue); got != 1 {
		t.Fatal("revising to dismiss deleted the previously created issue")
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2 AND node_id=$3 AND issue_deleted_at IS NULL", f.ws, createdIssue, f.a); got != 1 {
		t.Fatal("revising to dismiss unbound the created issue's primary ownership")
	}
	trail := actionTrail(t, f, a.ID)
	if len(trail) != 1 || trail[0]["resolution"] != "create" || trail[0]["status"] != "accepted" || trail[0]["issue_id"] != util.UUIDToString(createdIssue) {
		t.Fatalf("outgoing create decision missing from the trail: %+v", trail)
	}
	if key, _ := trail[0]["decision_key"].(string); key != util.UUIDToString(accepted.DecisionKey) || trail[0]["reason"] != accepted.Reason {
		t.Fatalf("trail entry lost the outgoing decision's facts: %+v", trail[0])
	}

	// Replay of the same revise command is idempotent: same row, no second
	// trail entry, no revision bump.
	replayed, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, dismiss, IssueCreateOpts{})
	if err != nil || replayed.Revision != dismissed.Revision || replayed.Status != "dismissed" {
		t.Fatalf("revise replay = %+v / %v", replayed, err)
	}
	if trail = actionTrail(t, f, a.ID); len(trail) != 1 {
		t.Fatalf("replay appended a duplicate trail entry: %+v", trail)
	}

	// dismissed -> create: the revision builds new work normally and keeps
	// both outgoing decisions in the trail.
	recreate := reviseDecision(f, dismissed, "create", "Scope returned to this meeting")
	recreate.NodeID = f.b
	recreated, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, recreate, IssueCreateOpts{})
	if err != nil || recreated.Status != "accepted" || !recreated.IssueID.Valid || recreated.IssueID == createdIssue {
		t.Fatalf("revise to create = %+v / %v", recreated, err)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws); got != issuesAfterAccept+1 {
		t.Fatalf("revise create produced %d new issues, want exactly 1", got-issuesAfterAccept)
	}
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: recreated.IssueID})
	if err != nil || issue.Status != "backlog" || issue.ModuleID != f.module {
		t.Fatalf("re-created issue = %+v / %v", issue, err)
	}
	if trail = actionTrail(t, f, a.ID); len(trail) != 2 || trail[1]["resolution"] != "dismiss" || trail[1]["status"] != "dismissed" || trail[1]["issue_id"] != nil {
		t.Fatalf("outgoing dismissal missing from the trail: %+v", trail)
	}
	view, err := f.issues.GetCockpitMeetingAction(ctx, CockpitActionRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActionID: a.ID, ActorID: f.owner, Human: true})
	if err != nil || view.Status != "accepted" || view.Issue == nil || view.Issue.ID != util.UUIDToString(recreated.IssueID) {
		t.Fatalf("projection after revise = %+v / %v", view, err)
	}
}

func TestCockpitPlanningReviseBoundaries(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	draftAction := f.draft(t, "Still a draft suggestion")
	// A draft suggestion is confirmed, not revised; both outcomes refuse.
	for _, outcome := range []string{"dismiss", "create"} {
		in := reviseDecision(f, draftAction, outcome, "No decision exists yet")
		if outcome == "create" {
			in.NodeID = f.a
		}
		if _, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
			t.Fatalf("revise of draft (%s) = %v", outcome, err)
		}
	}
	accepted, err := f.issues.ResolveCockpitMeetingAction(ctx, f.resolve(draftAction), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	// A revision without a reason is rejected input in every direction.
	noReason := reviseDecision(f, accepted, "dismiss", "  ")
	if _, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, noReason, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("reasonless revise = %v", err)
	}
	// Confirming never rewrites a written decision: fresh keys on the resolve
	// channel conflict instead of revising.
	forward := reviseDecision(f, accepted, "dismiss", "Wrong channel")
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, forward, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("resolve rewrote a written decision: %v", err)
	}
	forwardCreate := reviseDecision(f, accepted, "create", "Wrong channel")
	forwardCreate.NodeID = f.a
	forwardCreate.NewIssue.Priority = "high"
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, forwardCreate, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("resolve create rewrote a written decision: %v", err)
	}
	// A stale revision cannot revise past a concurrent decision.
	stale := reviseDecision(f, accepted, "dismiss", "Behind the current state")
	stale.ExpectedRevision = accepted.Revision - 1
	if _, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, stale, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("stale revise = %v", err)
	}
	// Only a human manager or the version reviewer may revise.
	stranger := reviseDecision(f, accepted, "dismiss", "Not my call")
	stranger.ActorID = parseTestUUID(t, f.member(t, "revise-bystander"))
	if _, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, stranger, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("bystander revised a decision: %v", err)
	}
	if row, err := f.q.GetCockpitMeetingAction(ctx, db.GetCockpitMeetingActionParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: accepted.ID}); err != nil || row.Status != "accepted" || row.Revision != accepted.Revision {
		t.Fatalf("rejected commands still changed the row: %+v / %v", row, err)
	}
}

func TestCockpitPlanningReviseReuseRebindsTheNewPrimary(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Redirect execution to existing work")
	accepted, err := f.issues.ResolveCockpitMeetingAction(ctx, f.resolve(a), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	target, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Existing execution target"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	primary, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, target.Issue.ID)
	if err != nil || primary.NodeID == nil || *primary.NodeID != util.UUIDToString(f.a) {
		t.Fatalf("target primary before revise = %+v / %v", primary, err)
	}
	// Governance issues stay out of execution reuse even on the revise channel.
	governed := reviseDecision(f, accepted, "reuse", "Bind the minutes task")
	governed.NodeID, governed.IssueID = f.a, f.version.ReviewIssueID
	if _, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, governed, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("governed issue reused through revise: %v", err)
	}
	reuse := reviseDecision(f, accepted, "reuse", "The team already tracks this work")
	reuse.NodeID, reuse.IssueID = f.a, target.Issue.ID
	revised, err := f.issues.ReviseCockpitMeetingActionResolution(ctx, reuse, IssueCreateOpts{})
	if err != nil || revised.Status != "accepted" || revised.Resolution != "reuse" || revised.IssueID != target.Issue.ID {
		t.Fatalf("revise to reuse = %+v / %v", revised, err)
	}
	// The reused issue moved under the chosen node; the issue the outgoing
	// create decision produced stays untouched with its own ownership.
	current, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, target.Issue.ID)
	if err != nil || current.NodeID == nil || *current.NodeID != util.UUIDToString(f.a) {
		t.Fatalf("reused issue primary after revise = %+v / %v", current, err)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2", f.ws, accepted.IssueID); got != 1 {
		t.Fatal("revise reuse deleted the previously created issue")
	}
	trail := actionTrail(t, f, a.ID)
	if len(trail) != 1 || trail[0]["resolution"] != "create" || trail[0]["issue_id"] != util.UUIDToString(accepted.IssueID) {
		t.Fatalf("reuse revision trail = %+v", trail)
	}
}
