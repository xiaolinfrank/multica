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

func overviewQuery(f cockpitWorkflowFixture) CockpitOverviewQuery {
	return CockpitOverviewQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, AsOf: "2026-10-10", View: "team"}
}
func TestCockpitOverviewCountsBoundedPagesAndScope(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	other := f.member(t, "overview-colleague")
	for i := 0; i < 32; i++ {
		status := "backlog"
		if i < 5 {
			status = "done"
		} else if i < 8 {
			status = "cancelled"
		} else if i == 8 {
			status = "future_execution_state"
		} else if i < 11 {
			status = "blocked"
		}
		assigned := any(f.owner)
		if i >= 20 {
			assigned = other
		}
		if i >= 30 {
			assigned = nil
		}
		id := parseTestUUID(t, f.Issue(t, fmt.Sprintf("Dashboard task %02d", i), testutil.Cols{"project_id": f.project, "module_id": f.module, "status": status, "assignee_type": "member", "assignee_id": assigned, "due_date": "2026-10-09"}))
		f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, id)
		if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.a, ActorID: f.owner}); err != nil {
			t.Fatal(err)
		}
	}
	p := overviewQuery(f.cockpitWorkflowFixture)
	p.ProjectID = f.project
	out, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	c := out.Summary.PrimaryIssues
	if c.Total != 32 || c.Active != 24 || c.Done != 5 || c.Closed != 3 || c.Unknown != 1 || c.Overdue != 24 || c.Blocked != 2 || c.Unassigned != 2 {
		t.Fatalf("full scoped facts: %+v", c)
	}
	if out.Summary.MyPrimaryIssues.Total != 20 || out.Summary.MyPrimaryIssues.Active != 12 || out.Summary.Attention.TeamTotal != 24 || out.Summary.Attention.MineTotal != 12 {
		t.Fatalf("personal responsibility differs from management permission: %+v", out.Summary)
	}
	if out.ProjectTitle != "Planning project" || out.Board == nil || out.GeneratedAt == "" || out.ExecutionNodes.Total != 2 || len(out.Attention.Items) != 8 || out.Attention.NextCursor == nil {
		t.Fatalf("bounded overview: %+v", out)
	}
	seen := map[string]bool{}
	p.PageSize = 7
	for {
		page, err := f.issues.ListCockpitOverviewAttention(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 24 || len(page.Items) > 7 {
			t.Fatalf("page counts: %+v", page)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatal("duplicate cursor row")
			}
			seen[item.ID] = true
			if item.Target.Kind != "issue" || item.Target.NodeID == nil || item.IssueIdentifier == "" {
				t.Fatalf("missing source target: %+v", item)
			}
		}
		if page.NextCursor == nil {
			break
		}
		p.Cursor = *page.NextCursor
	}
	if len(seen) != 24 {
		t.Fatalf("lost work: %d", len(seen))
	}
	p.Cursor = *out.Attention.NextCursor
	p.PageSize = 8
	if _, err = f.issues.ListCockpitOverviewAttention(ctx, p); err != nil {
		t.Fatalf("preview continuation: %v", err)
	}
	for _, change := range []func(*CockpitOverviewQuery){func(p *CockpitOverviewQuery) { p.View = "mine" }, func(p *CockpitOverviewQuery) { p.Kind = "issue" }, func(p *CockpitOverviewQuery) { p.AsOf = "2026-10-11" }, func(p *CockpitOverviewQuery) { p.ProjectID = pgtype.UUID{} }, func(p *CockpitOverviewQuery) { p.PageSize = 25 }} {
		altered := p
		change(&altered)
		if _, err = f.issues.ListCockpitOverviewAttention(ctx, altered); !errors.Is(err, ErrCockpitWorkflowInput) {
			t.Fatalf("changed scope accepted cursor: %v", err)
		}
	}
	p.Cursor = ""
	p.ProjectID = dbid.NewV7()
	if _, err = f.issues.GetCockpitOverview(ctx, p); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("missing project appeared empty: %v", err)
	}
}

func TestCockpitOverviewFormalReviewOwnsDutyDespiteOrdinaryIssueEdits(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	work := f.work(t)
	// Attach governance issues to primary L3 to exercise queue deduplication.
	for _, id := range []pgtype.UUID{work.MinutesIssueID, f.version.ReviewIssueID} {
		f.Exec(t, "UPDATE issue SET project_id=$2,module_id=$3 WHERE id=$1", id, f.project, f.module)
		if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.a, ActorID: f.owner}); err != nil {
			t.Fatal(err)
		}
	}
	current, _ := submitHandoffFixtureVersion(t, f.cockpitWorkflowFixture)
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: current.ReviewIssueID, NodeID: f.a, ActorID: f.owner}); err != nil {
		t.Fatal(err)
	}
	colleague := parseTestUUID(t, f.member(t, "review-assignee-only"))
	f.Exec(t, "UPDATE cockpit_meeting SET meet_date='2024-01-01' WHERE id=$1", f.meeting)
	f.Exec(t, "UPDATE issue SET status='done',assignee_id=$2 WHERE id=$1", current.ReviewIssueID, colleague)
	p := overviewQuery(f.cockpitWorkflowFixture)
	out, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if out.Summary.PrimaryIssues.Total != 3 || out.Attention.Total != 1 || out.Summary.Attention.MineTotal != 1 || len(out.RecentMeetings.Items) != 0 {
		t.Fatalf("governance was duplicated or old review hidden: %+v", out)
	}
	item := out.Attention.Items[0]
	if item.Reason != "review_pending" || !item.CanAct || item.AssigneeID == nil || *item.AssigneeID != util.UUIDToString(f.owner) || item.IssueStatus != "done" || item.Target.VersionID == nil || *item.Target.VersionID != util.UUIDToString(current.ID) {
		t.Fatalf("ordinary task status replaced formal authority: %+v", item)
	}
	p.ActorID = colleague
	p.View = "mine"
	page, err := f.issues.ListCockpitOverviewAttention(ctx, p)
	if err != nil || page.Total != 0 {
		t.Fatalf("ordinary assignee gained formal duty: %+v/%v", page, err)
	}
	p.ActorID = f.owner
	p.Human = false
	p.View = "team"
	page, err = f.issues.ListCockpitOverviewAttention(ctx, p)
	if err != nil || page.Items[0].CanAct {
		t.Fatalf("machine credential gained review capability: %+v/%v", page, err)
	}
	if err = f.issues.ChangeCockpitMeetingReviewer(ctx, handoffInput(t, f.cockpitWorkflowFixture, colleague), IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	f.Exec(t, "UPDATE issue SET status='backlog',assignee_id=$2 WHERE id=$1", current.ReviewIssueID, f.owner)
	p.Human = true
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Total != 1 || out.Summary.Attention.MineTotal != 0 || out.Attention.Items[0].CanAct {
		t.Fatalf("retired Review Issue restored authority: %+v/%v", out, err)
	}
	f.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, colleague)
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Total != 1 || out.Attention.Items[0].Reason != "reviewer_missing" || !out.Attention.Items[0].CanAct || out.Summary.Attention.MineTotal != 0 {
		t.Fatalf("missing reviewer recovery facts: %+v/%v", out, err)
	}
}

func TestCockpitOverviewHistoricalActionsAndMeetingWindow(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Old fixed-source action")
	f.Exec(t, "UPDATE cockpit_meeting SET meet_date='2024-01-01' WHERE id=$1", f.meeting)
	current, _ := submitHandoffFixtureVersion(t, f.cockpitWorkflowFixture)
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: current.ID}, Decision: "approved"}); err != nil {
		t.Fatal(err)
	}
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: current.ID}); err != nil {
		t.Fatal(err)
	}
	meeting, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "node_id": f.a}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, f.meeting, f.a)
	for i, date := range []string{"2026-09-10", "2026-09-11", "2026-10-10", "2026-10-17", "2026-10-18"} {
		id := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "code": fmt.Sprintf("window-%d", i), "title": date, "meet_date": date})
		f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": id, "node_id": f.a}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, id, f.a)
		f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": id, "node_id": f.b}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, id, f.b)
	}
	p := overviewQuery(f.cockpitWorkflowFixture)
	p.ProjectID = f.project
	out, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if out.Attention.Total != 1 || out.Attention.Items[0].ID != util.UUIDToString(a.ID) || out.Attention.Items[0].Reason != "action_superseded" || !out.Attention.Items[0].CanAct || out.Attention.Items[0].NextAction != "dismiss_superseded_action" {
		t.Fatalf("old unresolved action lost or promoted: %+v", out.Attention)
	}
	if out.Summary.Attention.MineTotal != 0 || out.RecentMeetings.Total != 3 || out.RecentMeetings.RangeStart != "2026-09-11" || out.RecentMeetings.RangeEnd != "2026-10-17" {
		t.Fatalf("meeting dedupe/window or creator-as-owner: %+v", out)
	}
	p.PageSize = 1
	seen := map[string]bool{}
	for {
		page, err := f.issues.ListCockpitOverviewMeetings(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range page.Items {
			if seen[m.ID] {
				t.Fatal("duplicate meeting")
			}
			seen[m.ID] = true
			if m.WorkflowEnabled || m.WorkflowStage != "not_enabled" {
				t.Fatal("invented workflow")
			}
		}
		if page.NextCursor == nil {
			break
		}
		p.Cursor = *page.NextCursor
	}
	if len(seen) != 3 {
		t.Fatalf("window pagination lost items: %d", len(seen))
	}
}

func TestCockpitOverviewReadinessDoesNotReleaseFutureMeetings(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	f.init(t, "")
	f.Exec(t, "UPDATE cockpit_meeting SET meet_date='2026-10-17' WHERE id=$1", f.meeting)
	p := overviewQuery(f)
	out, err := f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Total != 0 || out.RecentMeetings.Items[0].WorkflowStage != "waiting_meeting" {
		t.Fatalf("future meeting prematurely actionable: %+v/%v", out, err)
	}
	f.Exec(t, "UPDATE cockpit_meeting SET meet_date='2024-01-01' WHERE id=$1", f.meeting)
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Items[0].Reason != "readiness_needed" || out.Summary.Attention.MineTotal != 0 {
		t.Fatalf("past date incorrectly implied actual end: %+v/%v", out, err)
	}
	yes := true
	if err = f.issues.SetCockpitMeetingReadiness(ctx, CockpitWorkPackageReadiness{CockpitWorkPackageCommand: f.command(t), Ended: &yes}); err != nil {
		t.Fatal(err)
	}
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Items[0].Reason != "materials_needed" {
		t.Fatalf("readiness needs materials: %+v/%v", out, err)
	}
	f.ready(t)
	f.Exec(t, "UPDATE issue SET status='done' WHERE id=$1", f.work(t).MinutesIssueID)
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Items[0].Reason != "restore_backlog" {
		t.Fatalf("not-releasable task advertised release: %+v/%v", out, err)
	}
	f.Exec(t, "UPDATE issue SET status='backlog' WHERE id=$1", f.work(t).MinutesIssueID)
	out, err = f.issues.GetCockpitOverview(ctx, p)
	if err != nil || out.Attention.Items[0].Reason != "release_ready" {
		t.Fatalf("ready next step missing: %+v/%v", out, err)
	}
	if f.work(t).ReleasedAt.Valid || f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.work(t).MinutesIssueID) != 0 {
		t.Fatal("read model dispatched work")
	}
}

func TestCockpitOverviewFactsPrioritizeIssuesAndKeepRecordedNASExceptions(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	ids := []string{}
	for i, status := range []string{"backlog", "blocked", "backlog"} {
		due := "2026-10-11"
		if i == 2 {
			due = "2026-10-09"
		}
		id := parseTestUUID(t, f.Issue(t, fmt.Sprintf("Priority task %d", i), testutil.Cols{"project_id": f.project, "module_id": f.module, "status": status, "due_date": due, "assignee_type": "member", "assignee_id": f.owner}))
		f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, id)
		if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.a, ActorID: f.owner}); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, util.UUIDToString(id))
	}
	p := overviewQuery(f.cockpitWorkflowFixture)
	p.Kind = "issue"
	p.PageSize = 1
	for _, want := range []string{ids[2], ids[1], ids[0]} {
		page, err := f.issues.ListCockpitOverviewAttention(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 || page.Items[0].ID != want || page.Total != 3 {
			t.Fatalf("actual overdue/blocked priority: %+v want %s", page, want)
		}
		if page.NextCursor != nil {
			p.Cursor = *page.NextCursor
		}
	}
	for i, status := range []string{"retry_wait", "needs_attention", "queued", "succeeded"} {
		f.Insert(t, "cockpit_minutes_export", testutil.Cols{"id": dbid.NewV7(), "workspace_id": f.ws, "meeting_id": f.meeting, "version_id": f.version.ID, "version_number": f.version.VersionNumber,
			"source_issue_id": f.version.SourceIssueID, "root_id": fmt.Sprintf("test-root-%d", i), "root_path": "/nonexistent-test-root", "directory": "/nonexistent-test-root/meeting",
			"relative_path": fmt.Sprintf("meeting/minutes-%d.md", i), "target_path": fmt.Sprintf("/nonexistent-test-root/meeting/minutes-%d.md", i), "content_hash": f.version.ContentHash,
			"status": status, "last_error_code": "unsupported_commit", "created_by": f.owner})
	}
	p = overviewQuery(f.cockpitWorkflowFixture)
	p.Kind = "nas"
	page, err := f.issues.ListCockpitOverviewAttention(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.Items) != 2 {
		t.Fatalf("recorded failure scope: %+v", page)
	}
	for _, item := range page.Items {
		if !item.CanAct || item.Responsibility != "team_management" || item.Target.ExportID == nil || item.Target.VersionID == nil || *item.Target.VersionID != util.UUIDToString(f.version.ID) || len(item.Flags) != 1 || item.Flags[0] != "unsupported_commit" {
			t.Fatalf("NAS source/capability: %+v", item)
		}
	}
	p.View = "mine"
	page, err = f.issues.ListCockpitOverviewAttention(ctx, p)
	if err != nil || page.Total != 0 {
		t.Fatalf("creator inferred as NAS personal assignee: %+v/%v", page, err)
	}
}
