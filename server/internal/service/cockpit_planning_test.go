package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type planningFixture struct {
	cockpitWorkflowFixture
	project, module, moduleNode, grouping, a, b pgtype.UUID
	version                                     db.CockpitMinutesVersion
}

func newPlanningFixture(t *testing.T) planningFixture {
	t.Helper()
	f := newCockpitWorkflowFixture(t)
	m, err := f.q.GetCockpitMeeting(context.Background(), db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "Planning project")
	module := f.Module(t, project, "Planning module")
	node := func(code string, parent pgtype.UUID, extra testutil.Cols) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": m.CockpitID, "code": code, "name": code}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		for k, v := range extra {
			cols[k] = v
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	root := node("P", pgtype.UUID{}, testutil.Cols{"project_id": project})
	moduleNode := node("M", root, testutil.Cols{"project_id": project, "module_id": module})
	group := node("display-group", moduleNode, nil)
	a, b := node("execution-a", group, nil), node("execution-b", group, nil)
	// All planning rows are removed before fixture issues, nodes and modules.
	f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1", f.ws)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_action WHERE workspace_id=$1", f.ws)
	v, _ := prepareHandoffPending(t, f)
	if err := f.issues.ReviewCockpitMeetingMinutes(context.Background(), CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: v.ID}, Decision: "approved"}); err != nil {
		t.Fatal(err)
	}
	if err := f.issues.PublishCockpitMeetingMinutes(context.Background(), CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: v.ID}); err != nil {
		t.Fatal(err)
	}
	return planningFixture{cockpitWorkflowFixture: f, project: parseTestUUID(t, project), module: parseTestUUID(t, module), moduleNode: moduleNode, grouping: group, a: a, b: b, version: f.versions(t)[0]}
}
func (f planningFixture) draft(t *testing.T, title string) db.CockpitMeetingAction {
	t.Helper()
	a, err := f.issues.CreateCockpitMeetingAction(context.Background(), CockpitActionDraft{WorkspaceID: f.ws, MeetingID: f.meeting, VersionID: f.version.ID, ActorID: f.owner, ProposalKey: dbid.NewV7(), Title: title, Description: "Deliver the agreed scope.", SourceQuote: "Fixed evidence"})
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func (f planningFixture) resolve(a db.CockpitMeetingAction) CockpitActionResolution {
	return CockpitActionResolution{WorkspaceID: f.ws, MeetingID: f.meeting, ActionID: a.ID, ActorID: f.owner, DecisionKey: dbid.NewV7(), ExpectedRevision: a.Revision, Outcome: "create", NodeID: f.a}
}
func (f planningFixture) createInput(title string) CockpitNodeTaskCreate {
	return CockpitNodeTaskCreate{WorkspaceID: f.ws, NodeID: f.a, ActorID: f.owner, CreationKey: dbid.NewV7(), NewIssue: IssueCreateParams{Title: title}}
}

func TestCockpitPlanningActionCreatesOneAtomicBacklogIssue(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Implement the fixed boundary")
	in := f.resolve(a)
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	ids := make(chan pgtype.UUID, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{})
			errs <- err
			ids <- out.IssueID
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id pgtype.UUID
	for next := range ids {
		if id.Valid && id != next {
			t.Fatal("acceptance created multiple issues")
		}
		id = next
	}
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	if issue.Status != "backlog" || issue.AssigneeType.String != "member" || issue.AssigneeID != f.owner || issue.ProjectID != f.project || issue.ModuleID != f.module {
		t.Fatalf("unexpected issue filing/execution: %+v", issue)
	}
	if f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", id) != 0 {
		t.Fatal("accepting action dispatched an Agent")
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE workspace_id=$1 AND issue_id=$2", f.ws, id) != 0 {
		t.Fatal("primary was double-written into legacy reference links")
	}
	view, err := f.issues.GetCockpitMeetingAction(ctx, CockpitActionRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActionID: a.ID, ActorID: f.owner, Human: true})
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != "accepted" || view.SourceContentHash != f.version.ContentHash || view.Issue == nil || view.Issue.PrimaryNodeID == nil || *view.Issue.PrimaryNodeID != util.UUIDToString(f.a) {
		t.Fatalf("action receipt = %+v", view)
	}
	if _, err := f.q.UpdateIssueStatus(ctx, db.UpdateIssueStatusParams{WorkspaceID: f.ws, ID: id, Status: "done"}); err != nil {
		t.Fatal(err)
	}
	view, err = f.issues.GetCockpitMeetingAction(ctx, CockpitActionRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActionID: a.ID, ActorID: f.owner, Human: true})
	if err != nil || view.Status != "accepted" || view.Issue.Status != "done" {
		t.Fatal("action duplicated execution state instead of reading live Issue status")
	}
	in.NewIssue.Priority = "high"
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("changed acceptance replay = %v", err)
	}
}

func TestCockpitPlanningAcceptanceRollbackLeavesNoOrphan(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Atomic acceptance")
	before := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws)
	injected := errors.New("injected planning commit failure")
	f.issues.TxStarter = &rejectIssueCommitTxStarter{pool: f.Pool, err: injected}
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, f.resolve(a), IssueCreateOpts{}); !errors.Is(err, injected) {
		t.Fatalf("commit failure = %v", err)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", f.ws); got != before {
		t.Fatal("failed acceptance left an Issue")
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1", f.ws) != 0 {
		t.Fatal("failed acceptance left primary ownership")
	}
	stored, err := f.q.GetCockpitMeetingAction(ctx, db.GetCockpitMeetingActionParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: a.ID})
	if err != nil || stored.Status != "draft" || stored.DecisionKey.Valid {
		t.Fatal("failed acceptance consumed its decision key")
	}
}

func TestCockpitPlanningReusePreservesIssueAndRequiresExplicitMove(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	id := parseTestUUID(t, f.Issue(t, "Existing execution", testutil.Cols{"project_id": f.project, "module_id": f.module, "status": "in_progress", "assignee_type": "member", "assignee_id": f.owner, "due_date": "2027-01-31"}))
	// These rows are later than Fixture.Issue's own cleanup registration.
	f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, id)
	f.Cleanup(t, "DELETE FROM cockpit_meeting_action WHERE workspace_id=$1 AND issue_id=$2", f.ws, id)
	before, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	primary, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.b, ActorID: f.owner})
	if err != nil {
		t.Fatal(err)
	}
	a := f.draft(t, "Reuse planned work")
	in := f.resolve(a)
	in.Outcome = "reuse"
	in.IssueID = id
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("implicit move = %v", err)
	}
	primary, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.a, ActorID: f.owner, ExpectedRevision: primary.Revision})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	if after.Title != before.Title || after.Status != before.Status || after.AssigneeID != before.AssigneeID || after.DueDate != before.DueDate || resolved.IssueID != id {
		t.Fatal("reuse modified existing issue execution fields")
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE node_id=$1 AND issue_id=$2", f.b, id) != 1 {
		t.Fatal("explicit move lost the previous reference")
	}
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.b, ActorID: f.owner, ExpectedRevision: primary.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	current, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, id)
	if err != nil || current.NodeID == nil || *current.NodeID != util.UUIDToString(f.b) {
		t.Fatal("old acceptance replay silently moved Issue back")
	}
}

func TestCockpitPlanningCreationReceiptSurvivesClearMoveAndDeletion(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	in := f.createInput("Replayable direct task")
	first, err := f.issues.CreateCockpitNodeTask(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	primary, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, first.Issue.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: first.Issue.ID, NodeID: f.b, ActorID: f.owner, ExpectedRevision: primary.Revision}); err != nil {
		t.Fatal(err)
	}
	replay, err := f.issues.CreateCockpitNodeTask(ctx, in, IssueCreateOpts{})
	if err != nil || replay.Issue.ID != first.Issue.ID {
		t.Fatalf("creation retry = %v", err)
	}
	primary, err = f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, first.Issue.ID)
	if err != nil || primary.NodeID == nil || *primary.NodeID != util.UUIDToString(f.b) {
		t.Fatal("creation replay reset primary")
	}
	if _, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: first.Issue.ID, ActorID: f.owner, ExpectedRevision: primary.Revision}); err != nil {
		t.Fatal(err)
	}
	replay, err = f.issues.CreateCockpitNodeTask(ctx, in, IssueCreateOpts{})
	if err != nil || replay.Issue.ID != first.Issue.ID {
		t.Fatal("clearing primary lost creation receipt")
	}
	if err := f.q.DeleteIssue(ctx, db.DeleteIssueParams{WorkspaceID: f.ws, ID: first.Issue.ID}); !IsCockpitPrimaryIntegrityError(err) {
		t.Fatalf("unguarded direct deletion = %v", err)
	}
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := f.q.WithTx(tx)
	if err := q.TombstoneCockpitIssuePrimary(ctx, db.TombstoneCockpitIssuePrimaryParams{WorkspaceID: f.ws, IssueID: first.Issue.ID}); err != nil {
		t.Fatal(err)
	}
	if err := q.DeleteIssue(ctx, db.DeleteIssueParams{WorkspaceID: f.ws, ID: first.Issue.ID}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.CreateCockpitNodeTask(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("deleted-key replay = %v", err)
	}
	if count := f.Count(t, "SELECT count(*) FROM cockpit_issue_primary WHERE workspace_id=$1 AND creation_key=$2 AND issue_deleted_at IS NOT NULL", f.ws, in.CreationKey); count != 1 {
		t.Fatal("deleted creation key was discarded")
	}
}

func TestCockpitPlanningScopeAndStructureGuards(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	created, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Owned leaf task"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	for name, query := range map[string]string{
		"issue filing":    "UPDATE issue SET module_id=NULL WHERE id=$1",
		"node reparent":   "UPDATE cockpit_node SET parent_id=NULL WHERE id=$1",
		"ancestor unbind": "UPDATE cockpit_node SET module_id=NULL,project_id=NULL WHERE id=$1",
		"node deletion":   "DELETE FROM cockpit_node WHERE id=$1",
	} {
		t.Run(name, func(t *testing.T) {
			id := f.a
			if name == "issue filing" {
				id = created.Issue.ID
			} else if name == "ancestor unbind" {
				id = f.moduleNode
			}
			_, err := f.Pool.Exec(ctx, query, id)
			if !IsCockpitPrimaryIntegrityError(err) {
				t.Fatalf("guard = %v", err)
			}
		})
	}
	_, err = f.Pool.Exec(ctx, "INSERT INTO cockpit_node(workspace_id,cockpit_id,parent_id,code,name) SELECT workspace_id,cockpit_id,id,'forbidden-child','child' FROM cockpit_node WHERE id=$1", f.a)
	if !IsCockpitPrimaryIntegrityError(err) {
		t.Fatalf("owned leaf became group: %v", err)
	}
	otherProject := f.Project(t, "Unrelated project")
	otherModule := f.Module(t, otherProject, "Unrelated module")
	unrelated := parseTestUUID(t, f.Issue(t, "Wrong scope", testutil.Cols{"project_id": otherProject, "module_id": otherModule}))
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: unrelated, NodeID: f.a, ActorID: f.owner}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("ownership silently refiled issue: %v", err)
	}
}

func TestCockpitPlanningNodePaginationCountsAndUnknownStates(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	for i := 0; i < 32; i++ {
		status := "backlog"
		if i < 5 {
			status = "done"
		} else if i < 8 {
			status = "cancelled"
		} else if i == 8 {
			status = "future_execution_state"
		}
		id := parseTestUUID(t, f.Issue(t, fmt.Sprintf("Paged task %02d", i), testutil.Cols{"project_id": f.project, "module_id": f.module, "status": status}))
		f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1 AND issue_id=$2", f.ws, id)
		if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: f.a, ActorID: f.owner}); err != nil {
			t.Fatal(err)
		}
	}
	query := CockpitNodeTaskList{WorkspaceID: f.ws, NodeID: f.a, PageSize: 10}
	page, err := f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 10 || page.Total != 32 || page.FilteredTotal != 32 || page.NextCursor == nil || page.Summary.Done != 5 || page.Summary.Closed != 3 || page.Summary.Unknown != 1 || !page.Eligibility.Eligible {
		t.Fatalf("page/summary: %+v", page)
	}
	seen := map[string]bool{}
	for _, i := range page.Items {
		seen[i.ID] = true
	}
	query.Cursor = *page.NextCursor
	second, err := f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range second.Items {
		if seen[i.ID] {
			t.Fatal("cursor duplicated an issue")
		}
	}
	query.Category = "active"
	if _, err := f.issues.ListCockpitNodeTasks(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("filter reused stale cursor: %v", err)
	}
	query.Cursor = ""
	query.PageSize = 25
	page, err = f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil || page.FilteredTotal != 24 || page.Total != 32 || page.Summary.Total != 32 {
		t.Fatalf("active/full summary: %+v/%v", page, err)
	}
	query.Category = "unknown"
	page, err = f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil || len(page.Items) != 1 || page.Items[0].StatusCategory != "unknown" {
		t.Fatalf("unknown was lost: %+v/%v", page, err)
	}
	query.NodeID = f.b
	query.Cursor = *second.NextCursor
	if _, err := f.issues.ListCockpitNodeTasks(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cross-node cursor = %v", err)
	}
	query = CockpitNodeTaskList{WorkspaceID: f.ws, NodeID: f.grouping}
	page, err = f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil || page.Eligibility.Eligible || len(page.Items) != 0 {
		t.Fatal("display grouping is an eligible primary task destination")
	}
}

func TestCockpitPlanningActionPagesQuoteAndSupersession(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	bad := CockpitActionDraft{WorkspaceID: f.ws, MeetingID: f.meeting, VersionID: f.version.ID, ActorID: f.owner, ProposalKey: dbid.NewV7(), Title: "Invented quote", SourceQuote: "not in the fixed source"}
	if _, err := f.issues.CreateCockpitMeetingAction(ctx, bad); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("invented source quote = %v", err)
	}
	for i := 0; i < 31; i++ {
		f.draft(t, fmt.Sprintf("Action %02d", i))
	}
	query := CockpitActionList{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: f.owner, Human: true, PageSize: 25}
	page, err := f.issues.ListCockpitMeetingActions(ctx, query)
	if err != nil || len(page.Items) != 25 || page.Total != 31 || page.FilteredTotal != 31 || page.NextCursor == nil || !page.CanAdd {
		t.Fatalf("action first page: %+v/%v", page, err)
	}
	query.Cursor = *page.NextCursor
	last, err := f.issues.ListCockpitMeetingActions(ctx, query)
	if err != nil || len(last.Items) != 6 || last.NextCursor != nil {
		t.Fatalf("action second page: %+v/%v", last, err)
	}
	query.Status = "accepted"
	if _, err := f.issues.ListCockpitMeetingActions(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("wrong-filter action cursor = %v", err)
	}
	old, err := f.q.GetCockpitMeetingAction(ctx, db.GetCockpitMeetingActionParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: parseTestUUID(t, page.Items[0].ID)})
	if err != nil {
		t.Fatal(err)
	}
	newVersion, _ := submitHandoffFixtureVersion(t, f.cockpitWorkflowFixture)
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: newVersion.ID}, Decision: "approved"}); err != nil {
		t.Fatal(err)
	}
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: newVersion.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, f.resolve(old), IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("superseded draft created work: %v", err)
	}
	dismiss := f.resolve(old)
	dismiss.Outcome = "dismiss"
	dismiss.NodeID = pgtype.UUID{}
	dismiss.Reason = "Superseded by the new review"
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, dismiss, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	view, err := f.issues.GetCockpitMeetingAction(ctx, CockpitActionRead{WorkspaceID: f.ws, MeetingID: f.meeting, ActionID: old.ID, ActorID: f.owner, Human: true})
	if err != nil || view.Status != "dismissed" || !view.SourceSuperseded {
		t.Fatalf("superseded dismissal = %+v/%v", view, err)
	}
}

func TestCockpitPlanningActionPermissionsAndGovernanceReuse(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	a := f.draft(t, "Permission boundary")
	in := f.resolve(a)
	in.ActorID = parseTestUUID(t, f.member(t, "ordinary-planner"))
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("ordinary member confirmed action: %v", err)
	}
	in = f.resolve(a)
	in.Outcome = "reuse"
	in.IssueID = f.version.ReviewIssueID
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("formal review reused as action executor: %v", err)
	}
	_, err := f.issues.GetCockpitMeetingAction(ctx, CockpitActionRead{WorkspaceID: dbid.NewV7(), MeetingID: f.meeting, ActionID: a.ID, ActorID: f.owner, Human: true})
	if !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("cross workspace read = %v", err)
	}
	_, err = f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: dbid.NewV7()})
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
}

func TestCockpitPlanningAssignedAgentWaitsInBacklog(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	agent := parseTestUUID(t, f.privateAgentOwnedBy(t, f.UserID, "planned-action-agent"))
	action := f.draft(t, "Agent work requires a later explicit start")
	in := f.resolve(action)
	in.NewIssue.AssigneeType = pgtype.Text{String: "agent", Valid: true}
	in.NewIssue.AssigneeID = agent
	resolved, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	issue, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: resolved.IssueID})
	if err != nil || issue.Status != "backlog" || issue.AssigneeID != agent || issue.AssigneeType.String != "agent" {
		t.Fatalf("planned agent issue = %+v / %v", issue, err)
	}
	if f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 0 {
		t.Fatal("accepting a planned agent action started a run")
	}
}
