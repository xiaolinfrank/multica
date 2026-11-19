package service

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitPlanReconcileRestoresStructureAndFilesIssues(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project01 := f.Project(t, "01高质量数据集")
	project02 := f.Project(t, "02AI+医药数据平台")
	shadow := f.Project(t, "01高质量数据集")
	module0101 := f.Module(t, project01, "01.01 数据采集")
	module0106 := f.Module(t, project01, "01.06 资源调研")
	module0201 := f.Module(t, project02, "02.01 平台底座")
	f.Module(t, project02, "02.02 平台架构与开发")

	node := func(code, name string, parent pgtype.UUID, project, module string) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": 0}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		if project != "" {
			cols["project_id"] = project
		}
		if module != "" {
			cols["module_id"] = module
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node("L1-01", "高质量数据集", pgtype.UUID{}, "", "")
	l2 := node("01.01", "数据采集", l1, project01, module0101)
	l3a := node("01.01.01", "采集任务 A", l2, "", "")
	node("01.01.02", "采集任务 B", l2, "", "")
	l1b := node("L1-02", "AI+医药数据平台", pgtype.UUID{}, "", "")
	l2b := node("02.01", "平台底座", l1b, project02, module0201)
	l3c := node("02.01.01", "底座任务", l2b, "", "")
	// The display group: eight directions merge into the first one.
	var groupChildren []pgtype.UUID
	for i := 2; i <= 9; i++ {
		l2g := node(fmt.Sprintf("02.%02d", i), fmt.Sprintf("方向 %d", i), l1b, "", "")
		groupChildren = append(groupChildren, node(fmt.Sprintf("02.%02d.01", i), fmt.Sprintf("方向 %d 任务", i), l2g, "", ""))
	}

	issueA := f.Issue(t, "Linked collection work", testutil.Cols{"project_id": project01, "module_id": module0101})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": l3a, "issue_id": issueA})
	issueB := f.Issue(t, "01.01.02 资源调研任务", testutil.Cols{"project_id": project01, "module_id": module0101})
	parentIssue := f.Issue(t, "Parent platform work", testutil.Cols{"project_id": project02, "module_id": module0201})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": l3c, "issue_id": parentIssue})
	childIssue := f.Issue(t, "Child of platform work", testutil.Cols{"project_id": project02, "module_id": module0201, "parent_issue_id": parentIssue})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	if len(report.Groups) != 1 || report.Groups[0].Kept == "" || len(report.Groups[0].Removed) != 7 {
		t.Fatalf("summary group = %+v", report.Groups)
	}
	if len(report.Projects) != 2 {
		t.Fatalf("project matches = %+v", report.Projects)
	}
	for _, match := range report.Projects {
		if match.Method != "name" {
			t.Fatalf("project match method = %+v", match)
		}
		if match.NodeID == util.UUIDToString(l1) && len(match.Candidates) != 1 {
			t.Fatalf("duplicate project tie-break lost: %+v", match)
		}
	}
	foundRoot := false
	for _, root := range report.NewRoots {
		if root.ProjectID == shadow {
			foundRoot = true
		}
	}
	if !foundRoot {
		t.Fatalf("shadow project did not get an L1 row: %+v", report.NewRoots)
	}
	foundModuleNode := false
	for _, created := range report.NewModuleNodes {
		if created.ModuleID == module0106 {
			foundModuleNode = true
		}
	}
	if !foundModuleNode {
		t.Fatalf("01.06 module did not get an L2 row: %+v", report.NewModuleNodes)
	}
	rules := map[string]string{}
	for _, filing := range report.Issues {
		rules[filing.IssueID] = filing.Rule
	}
	if rules[issueA] != "single_work_item" || rules[issueB] != "title_code" || rules[childIssue] != "followed_parent" || rules[parentIssue] != "single_work_item" {
		t.Fatalf("issue rules = %+v", rules)
	}
	// A dry run writes nothing.
	if count := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws); count != 23 {
		t.Fatalf("dry run changed node count: %d", count)
	}
	after, _ := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if after.PlanReconciledAt.Valid {
		t.Fatal("dry run marked the plan reconciled")
	}

	snapshots := 0
	snapshot := func(context.Context, *db.Queries, db.Cockpit) (string, error) {
		snapshots++
		return "snapshot-1", nil
	}
	applied, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true}, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !applied.Apply || applied.SnapshotID != "snapshot-1" || snapshots != 1 || len(applied.Blockers) != 0 {
		t.Fatalf("apply report = %+v (snapshots %d)", applied, snapshots)
	}
	if count := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws); count != 18 {
		t.Fatalf("merged node count = %d, want 18 (23 - 7 merged + shadow root + 01.06 row)", count)
	}
	after, _ = f.q.GetCockpitByWorkspace(ctx, f.ws)
	if !after.PlanReconciledAt.Valid {
		t.Fatal("apply did not mark the plan reconciled")
	}
	// Every work item carries the next outline code.
	var code string
	if err := f.Pool.QueryRow(ctx, "SELECT code FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, l3a).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if code != "01.01.01" {
		t.Fatalf("work item code = %s", code)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2 AND work_item_id IS NOT NULL AND module_id=$3", f.ws, issueA, module0101); got != 1 {
		t.Fatal("linked issue was not filed under its work item")
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, report.Groups[0].Kept); got != 8 {
		t.Fatalf("merged group children = %d, want 8", got)
	}

	// Re-running is a no-op: same nodes, no new codes or filings.
	before := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws)
	again, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true}, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.CodeChanges) != 0 || len(again.NewProjects) != 0 || len(again.NewModules) != 0 || len(again.NewRoots) != 0 || len(again.Issues) != 0 {
		t.Fatalf("second apply was not idempotent: %+v", again)
	}
	if after := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws); after != before {
		t.Fatalf("second apply changed node count: %d -> %d", before, after)
	}
}

// A board whose L1 rows are workstreams reflows by project: the L2 rows keep
// their modules, move under one L1 per project, and the old L1 disappears
// with its milestones carried over.
func TestCockpitPlanReconcileReflowsWorkstreamBoard(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "HLX22")
	f.Module(t, project, "临床运营")
	f.Module(t, project, "数据统计")
	node := func(code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": 0}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1a := node("L1-01", "临床运营", pgtype.UUID{})
	l2a := node("01.01", "临床运营", l1a)
	l1b := node("L1-04", "数据统计", pgtype.UUID{})
	node("04.01", "数据统计", l1b)
	f.Insert(t, "cockpit_milestone", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "name": "Start", "node_id": l1a, "position": 0})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true}, func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 || len(report.Reflows) != 2 {
		t.Fatalf("reflow report = %+v", report)
	}
	var rootID string
	if err := f.Pool.QueryRow(ctx, "SELECT id::text FROM cockpit_node WHERE workspace_id=$1 AND parent_id IS NULL", f.ws).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, rootID); got != 2 {
		t.Fatalf("reflowed L2 count = %d", got)
	}
	for _, old := range []pgtype.UUID{l1a, l1b} {
		if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, old); got != 0 {
			t.Fatal("old workstream L1 survived reflow")
		}
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, l2a); got != 1 {
		t.Fatal("reflow dropped a module row")
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_milestone WHERE workspace_id=$1 AND node_id=$2", f.ws, rootID); got != 1 {
		t.Fatal("reflow did not carry the milestone")
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND project_id=$2 AND parent_id IS NULL", f.ws, project); got != 1 {
		t.Fatalf("project root binding = %d, want 1", got)
	}
}

// A summary group whose members still carry payments must not merge at all:
// the dry run has to say so up front and apply must write nothing, rather than
// deleting a member together with its money.
func TestCockpitPlanReconcileBlocksGroupsWithDependents(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	f.Project(t, "02AI+医药数据平台")
	node := func(code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": 0}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node("L1-02", "AI+医药数据平台", pgtype.UUID{})
	var paying pgtype.UUID
	for i := 2; i <= 9; i++ {
		l2 := node(fmt.Sprintf("02.%02d", i), fmt.Sprintf("方向 %d", i), l1)
		node(fmt.Sprintf("02.%02d.01", i), fmt.Sprintf("方向 %d 任务", i), l2)
		if i == 3 {
			paying = l2
		}
	}
	f.Insert(t, "cockpit_payment", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": paying, "amount": "10.0000", "label": "已付款"})
	before := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws)

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 1 || !strings.Contains(report.Blockers[0], "02.02-09") || !strings.Contains(report.Blockers[0], "02.03") {
		t.Fatalf("blockers = %+v", report.Blockers)
	}
	if len(report.Groups) != 0 {
		t.Fatalf("blocked group was reported as mergeable: %+v", report.Groups)
	}

	snapshots := 0
	applied, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { snapshots++; return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if !applied.Apply || len(applied.Blockers) != 1 || snapshots != 0 {
		t.Fatalf("blocked apply = %+v (snapshots %d)", applied, snapshots)
	}
	if after := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws); after != before {
		t.Fatalf("blocked apply changed node count: %d -> %d", before, after)
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_payment WHERE workspace_id=$1 AND node_id=$2", f.ws, paying); got != 1 {
		t.Fatal("blocked apply dropped the payment")
	}
	if boardAfter, _ := f.q.GetCockpitByWorkspace(ctx, f.ws); boardAfter.PlanReconciledAt.Valid {
		t.Fatal("blocked apply marked the plan reconciled")
	}
}

// A workstream L1 that still owns money cannot reflow, and the dry run must not
// paper over that by inventing a project or root for it.
func TestCockpitPlanReconcileBlocksReflowWithDependents(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "HLX22")
	f.Module(t, project, "临床运营")
	node := func(code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": 0}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node("L1-01", "临床运营", pgtype.UUID{})
	node("01.01", "临床运营", l1)
	f.Insert(t, "cockpit_payment", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": l1, "amount": "8.0000", "label": "已付款"})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 1 || !strings.Contains(report.Blockers[0], "L1-01") {
		t.Fatalf("blockers = %+v", report.Blockers)
	}
	if len(report.Reflows) != 0 || len(report.NewRoots) != 0 || len(report.NewProjects) != 0 {
		t.Fatalf("blocked reflow leaked a substitute tree: reflows=%+v roots=%+v projects=%+v", report.Reflows, report.NewRoots, report.NewProjects)
	}

	before := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws)
	applied, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Blockers) != 1 {
		t.Fatalf("apply blockers = %+v", applied.Blockers)
	}
	if after := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws); after != before {
		t.Fatalf("blocked apply changed node count: %d -> %d", before, after)
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_payment WHERE workspace_id=$1 AND node_id=$2", f.ws, l1); got != 1 {
		t.Fatal("blocked apply dropped the payment")
	}
}
