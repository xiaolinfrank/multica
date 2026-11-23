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
	project, module, moduleNode, a, b pgtype.UUID
	version                           db.CockpitMinutesVersion
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
	// Work items are the third level: directly under the module row. The
	// legacy display-group level is gone after reconciliation.
	a, b := node("execution-a", moduleNode, nil), node("execution-b", moduleNode, nil)
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
	return planningFixture{cockpitWorkflowFixture: f, project: parseTestUUID(t, project), module: parseTestUUID(t, module), moduleNode: moduleNode, a: a, b: b, version: f.versions(t)[0]}
}

// attachWorkItem files an issue under a node using its current revision. The
// compat endpoint's expected_revision is the ISSUE's revision now, so tests
// that do not care about the race guard read it rather than passing 0.
func attachWorkItem(t *testing.T, f cockpitWorkflowFixture, issue, node pgtype.UUID) (db.CockpitIssuePrimary, error) {
	t.Helper()
	row, err := f.q.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: issue})
	if err != nil {
		return db.CockpitIssuePrimary{}, err
	}
	return f.issues.SetCockpitIssuePrimaryNode(context.Background(), CockpitPrimaryNodeCommand{
		WorkspaceID: f.ws, IssueID: issue, NodeID: node, ActorID: f.owner, ExpectedRevision: row.Revision,
	})
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

// Reusing an issue as action execution files it under the chosen work item
// (project and module follow). Execution fields stay untouched, the old work
// item remains as a related node, and replaying the accepted action does not
// move the issue back.
func TestCockpitPlanningReuseRefilesOnceAndReplayKeepsTheMove(t *testing.T) {
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
	if _, err := attachWorkItem(t, f.cockpitWorkflowFixture, id, f.b); err != nil {
		t.Fatal(err)
	}
	a := f.draft(t, "Reuse planned work")
	in := f.resolve(a)
	in.Outcome = "reuse"
	in.IssueID = id
	resolved, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{})
	if err != nil {
		t.Fatalf("reuse refiles the issue: %v", err)
	}
	after, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	if after.WorkItemID != f.a || after.ProjectID != before.ProjectID || after.ModuleID != before.ModuleID || resolved.IssueID != id {
		t.Fatalf("reuse filing = %v/%v/%v", after.WorkItemID, after.ProjectID, after.ModuleID)
	}
	if after.Title != before.Title || after.Status != before.Status || after.AssigneeID != before.AssigneeID || after.DueDate != before.DueDate {
		t.Fatal("reuse modified existing issue execution fields")
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_node_issue WHERE node_id=$1 AND issue_id=$2", f.b, id) != 1 {
		t.Fatal("refile lost the previous work item as a related node")
	}
	// Moving it again explicitly, then replaying the old acceptance, must not
	// drag the issue back to the action's node.
	current, err := attachWorkItem(t, f.cockpitWorkflowFixture, id, f.b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ResolveCockpitMeetingAction(ctx, in, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	view, err := f.issues.GetCockpitIssuePrimaryNode(ctx, f.ws, id)
	if err != nil || view.NodeID == nil || *view.NodeID != util.UUIDToString(f.b) {
		t.Fatalf("old acceptance replay silently moved Issue back: %+v / %v (revision %d)", view, err, current.Revision)
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

// Naming a work item refiles the issue, project and module included; the old
// "ownership never refiles an issue" refusal is gone. The creation receipt
// still guards direct deletion.
func TestCockpitPlanningRefileAndReceiptDeletionGuard(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	created, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Refile me"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}

	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	// The legacy endpoint moves within one project only now: a cross-project
	// refile belongs to the issue update, which runs the workflow checks this
	// path has never had. The refile below therefore stays in the task's own
	// project, asserting the same filing write as before.
	// Same project, another module: a node row may not bind the project twice,
	// so the branch node stays unbound and the module row carries the binding.
	otherModule := f.Module(t, f.project.String(), "Refile module")
	otherRoot := f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": "RP", "name": "Refile branch",
		"position": 9,
	})
	otherModuleNode := f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "parent_id": otherRoot, "code": "RP.01", "name": "Refile module",
		"position": 0, "project_id": f.project, "module_id": otherModule,
	})
	otherNode := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "parent_id": otherModuleNode, "code": "RP.01.01", "name": "Refile work item",
		"position": 0,
	}))

	before, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: created.Issue.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: created.Issue.ID, NodeID: otherNode, ActorID: f.owner, ExpectedRevision: before.Revision}); err != nil {
		t.Fatalf("attach refiles the issue: %v", err)
	}
	after, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: created.Issue.ID})
	if err != nil {
		t.Fatal(err)
	}
	if after.WorkItemID != otherNode || after.ProjectID != f.project || after.ModuleID != parseTestUUID(t, otherModule) {
		t.Fatalf("after refile: work_item=%v project=%v module=%v", after.WorkItemID, after.ProjectID, after.ModuleID)
	}
	// Cross-project through the legacy endpoint is a refusal, naming the path
	// that runs the checks.
	crossProject := f.Project(t, "Cross project")
	crossModule := f.Module(t, crossProject, "Cross module")
	_ = crossModule
	crossRoot := f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": "CP", "name": "Cross project",
		"position": 19, "project_id": crossProject,
	})
	crossModuleNode := f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "parent_id": crossRoot, "code": "CP.01", "name": "Cross module",
		"position": 0, "project_id": crossProject, "module_id": crossModule,
	})
	crossNode := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "parent_id": crossModuleNode, "code": "CP.01.01", "name": "Cross work item",
		"position": 0,
	}))
	before, err = f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: created.Issue.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: created.Issue.ID, NodeID: crossNode, ActorID: f.owner, ExpectedRevision: before.Revision}); !errors.Is(err, ErrCockpitCrossProjectPrimary) {
		t.Fatalf("cross-project attach = %v", err)
	}
	// An unfiled task gaining a project through this endpoint is the same
	// move: the issue update runs the workflow checks for it, so the legacy
	// path refuses it too rather than writing project and module blind.
	unfiledID := parseTestUUID(t, f.Issue(t, "Unfiled refile", testutil.Cols{"assignee_type": "member", "assignee_id": f.owner}))
	unfiledRow, err := f.q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: unfiledID})
	if err != nil {
		t.Fatal(err)
	}
	if unfiledRow.ProjectID.Valid || unfiledRow.ModuleID.Valid || unfiledRow.WorkItemID.Valid {
		t.Fatalf("fixture: the task was expected to be unfiled, project=%v module=%v work_item=%v", unfiledRow.ProjectID, unfiledRow.ModuleID, unfiledRow.WorkItemID)
	}
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: unfiledID, NodeID: otherNode, ActorID: f.owner, ExpectedRevision: unfiledRow.Revision}); !errors.Is(err, ErrCockpitCrossProjectPrimary) {
		t.Fatalf("unfiled attach into a project = %v", err)
	}

	if err := f.q.DeleteIssue(ctx, db.DeleteIssueParams{WorkspaceID: f.ws, ID: created.Issue.ID}); !IsCockpitPrimaryIntegrityError(err) {
		t.Fatalf("unguarded direct deletion = %v", err)
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
		if _, err := attachWorkItem(t, f.cockpitWorkflowFixture, id, f.a); err != nil {
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
	query = CockpitNodeTaskList{WorkspaceID: f.ws, NodeID: f.moduleNode}
	page, err = f.issues.ListCockpitNodeTasks(ctx, query)
	if err != nil || page.Eligibility.Eligible || len(page.Items) != 0 {
		t.Fatal("a module row is an eligible primary task destination")
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
