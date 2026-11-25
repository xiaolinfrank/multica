package service

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
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
	if len(report.Groups) != 1 || report.Groups[0].Kept == "" || report.Groups[0].KeptCode != "02.02" || len(report.Groups[0].Removed) != 7 {
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

	// Backfilled module rows (NewModuleNodes) strip the code prefix from the
	// module title too, and keep the module's existing directory_name synced
	// onto the L2 row so directory fill never builds double-prefixed names.
	var mod0106Title string
	if err := f.Pool.QueryRow(ctx, "SELECT title FROM module WHERE workspace_id=$1 AND id=$2", f.ws, module0106).Scan(&mod0106Title); err != nil {
		t.Fatal(err)
	}
	if mod0106Title != "资源调研" {
		t.Fatalf("backfilled module 01.06 title = %q, want %q", mod0106Title, "资源调研")
	}
	var mod0106Dir, node0106Dir string
	if err := f.Pool.QueryRow(ctx, "SELECT COALESCE(m.directory_name, ''), COALESCE(n.directory_name, '') FROM module m JOIN cockpit_node n ON n.module_id=m.id WHERE m.workspace_id=$1 AND m.id=$2", f.ws, module0106).Scan(&mod0106Dir, &node0106Dir); err != nil {
		t.Fatal(err)
	}
	if mod0106Dir == "" || mod0106Dir != node0106Dir {
		t.Fatalf("module/node directory_name drift: module=%q node=%q", mod0106Dir, node0106Dir)
	}

	// A second apply is refused: once the plan is reconciled its codes are
	// fixed, and re-applying would renumber rows reordered since. Idempotency
	// is proven by the dry run reporting nothing left to change.
	before := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1", f.ws)
	if _, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true}, snapshot); err == nil {
		t.Fatal("second apply was accepted")
	}
	preview, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.CodeChanges) != 0 || len(preview.NewProjects) != 0 || len(preview.NewModules) != 0 || len(preview.NewRoots) != 0 || len(preview.Issues) != 0 {
		t.Fatalf("preview after apply was not empty: %+v", preview)
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

// The pmo-showcase shape: six workstream L1 rows, three of them reflowing and
// the middle row reflowing BETWEEN two others. The old bug rebuilt st.roots in
// place while assignProjects ranged over it, skipping the middle rows; the
// new roots also numbered 09+ because the deleted L1s kept 01–08 occupied.
func TestCockpitPlanReconcileReflowsEveryMiddleWorkstream(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	projects := []string{"IND 申报", "数据与统计", "供应商与合同"}
	var moduleTitles []string
	for _, title := range projects {
		projectID := f.Project(t, title)
		for _, suffix := range []string{"主责", "支撑"} {
			moduleTitles = append(moduleTitles, title+suffix)
			f.Module(t, projectID, title+suffix)
		}
	}
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	// Six workstream L1 rows, each with one L2 that names a distinct module,
	// so every row reflows and reflow happens at every position including the
	// middle. 11..16 keep clear of the production summary groups (02.x/03.x),
	// whose restoration would rename these rows.
	var oldL1s []pgtype.UUID
	for i := 0; i < 6; i++ {
		l1 := node(float64(i), fmt.Sprintf("L1-%02d", i+11), fmt.Sprintf("职能-%d", i), pgtype.UUID{})
		node(0, fmt.Sprintf("%02d.01", i+11), moduleTitles[i], l1)
		oldL1s = append(oldL1s, l1)
	}
	applied, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(applied.Blockers) != 0 || len(applied.Reflows) != 6 {
		t.Fatalf("reflows = %d, want 6 (blockers %v)", len(applied.Reflows), applied.Blockers)
	}
	// All six old rows gone; exactly three project roots, numbered 01–03 by
	// the order each project first appeared in the original tree.
	for _, l1 := range oldL1s {
		if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, l1); got != 0 {
			t.Fatal("a workstream L1 survived reflow")
		}
	}
	if count := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND parent_id IS NULL", f.ws); count != 3 {
		t.Fatalf("project roots = %d, want 3", count)
	}
	codes := make([]string, 0, 3)
	rows, err := f.Pool.Query(ctx, "SELECT code FROM cockpit_node WHERE workspace_id=$1 AND parent_id IS NULL ORDER BY code", f.ws)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			t.Fatal(err)
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(codes) != 3 || codes[0] != "01" || codes[1] != "02" || codes[2] != "03" {
		t.Fatalf("project root codes = %v, want 01..03", codes)
	}
	// Every L2 now sits under its project's root, bound to its module.
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node n JOIN cockpit_node r ON r.id=n.parent_id AND r.parent_id IS NULL JOIN module m ON m.id=n.module_id WHERE n.workspace_id=$1 AND n.parent_id IS NOT NULL AND n.module_id IS NOT NULL AND m.project_id=r.project_id", f.ws); got != 6 {
		t.Fatalf("L2 rows under their project root and module = %d, want 6", got)
	}
	// Preview after apply: nothing left, and apply again is refused.
	preview, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Reflows) != 0 || len(preview.NewRoots) != 0 || len(preview.CodeChanges) != 0 {
		t.Fatalf("preview after apply still reports work: reflows=%d roots=%d codes=%d", len(preview.Reflows), len(preview.NewRoots), len(preview.CodeChanges))
	}
	if _, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true}, nil); err == nil {
		t.Fatal("second apply was accepted")
	}
}

// The fosun-bio project-03 shape: module titles carry the DISPLAY numbering,
// while the stored L2 codes are the pre-merge ones. Matching on stored codes
// bound 03.03「数据、工具与方法准备」 to module「03.03 科学测评与用户验证」and
// left「03.02 数据与工具的开发」without a row; matching must run on display
// codes: code+name → name → code, and no module binds twice.
func TestCockpitPlanReconcileMatchesModulesByDisplayCode(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "03药研智能体及应用案例")
	// Module titles as the gantt shows them (display numbering).
	mScenes := f.Module(t, project, "03.01 场景的定义及方向")
	mTools := f.Module(t, project, "03.02 数据与工具的开发")
	mEval := f.Module(t, project, "03.03 科学测评与用户验证")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-03", "药研智能体及应用案例", pgtype.UUID{})
	// Stored rows: 03.01/03.02 are the「场景」group, 03.03–03.05 the「数据与
	// 工具」group, 03.06/03.07 the「科学测评」group. Display order after the
	// merge is 场景(03.01) → 数据与工具(03.02) → 科学测评(03.03).
	node(0, "03.01", "场景一", l1)
	node(1, "03.02", "场景二", l1)
	node(2, "03.03", "数据、工具与方法准备", l1)
	node(3, "03.04", "工具二", l1)
	node(4, "03.05", "工具三", l1)
	node(5, "03.06", "科学评测与用户验证", l1)
	node(6, "03.07", "评测二", l1)

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	binding := map[string]string{}
	for _, m := range report.Modules {
		binding[m.ModuleID] = m.Method
	}
	for _, want := range []struct{ module, method string }{
		{mScenes, "code_name"}, {mTools, "code_name"}, {mEval, "code_name"},
	} {
		if got, ok := binding[want.module]; !ok || got != want.method {
			t.Fatalf("module %s matched %q, want %q (all matches: %v)", want.module, got, want.method, binding)
		}
	}
	// No module got a second row, and no duplicate module was invented.
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND module_id IS NOT NULL AND parent_id=$2", f.ws, l1); got != 3 {
		t.Fatalf("bound module rows = %d, want 3", got)
	}
	if got := f.Count(t, "SELECT count(*) FROM module WHERE workspace_id=$1 AND project_id=$2", f.ws, project); got != 3 {
		t.Fatalf("new modules were created: %d total", got)
	}
	// Each L2 keeps the module title as its name.
	var name string
	if err := f.Pool.QueryRow(ctx, "SELECT name FROM cockpit_node WHERE workspace_id=$1 AND module_id=$2", f.ws, mTools).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "数据与工具的开发" {
		t.Fatalf("tools row name = %q, want the module title", name)
	}
}

// Renumbering must survive the unique index on (cockpit_id, code). Two shapes
// break a naive row-by-row update: a rename onto a code a merged-away row
// still holds (fosun-bio: 02.10 → 02.03 while 02.03 is deleted), and two rows
// swapping codes. The merge member is deleted first, then every renumbered row
// takes a temporary code before its final one.
func TestCockpitPlanReconcileApplyRenumbersAroundDeletesAndSwaps(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "02AI+医药数据平台")
	f.Module(t, project, "02.01 基础设施与算力服务")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-02", "AI+医药数据平台", pgtype.UUID{})
	node(0, "02.01", "基础设施与算力服务", l1)
	// The eight summary-group members merge into the first one.
	for i := 2; i <= 9; i++ {
		node(float64(i-1), fmt.Sprintf("02.%02d", i), fmt.Sprintf("方向 %d", i), l1)
	}
	// 02.10 takes the freed 02.03 (renamed by the display rename table), 02.11
	// takes 02.04 — the classic "write a code a deleted row still holds".
	node(8, "02.10", "院端一体机与部署", l1)
	node(9, "02.11", "测试与质量保障", l1)
	// A swap: positions 10/11 hold the codes reversed, so renumbering asks
	// 02.11 → 02.12 and 02.12 → 02.11 in one pass.
	node(10, "02.12", "交换 A", l1)
	node(11, "02.13", "交换 B", l1)

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	// 02.01, the merged group 02.02, then 02.03..02.04 from the renames and
	// 02.05/02.06 for the two extra rows: 6 children, unique codes.
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, l1); got != 6 {
		t.Fatalf("children after merge+renumber = %d, want 6", got)
	}
	if got := f.Count(t, "SELECT count(DISTINCT code) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, l1); got != 6 {
		t.Fatalf("distinct child codes = %d, want 6", got)
	}
	var landing string
	if err := f.Pool.QueryRow(ctx, "SELECT code FROM cockpit_node WHERE workspace_id=$1 AND name='院端一体机与部署'", f.ws).Scan(&landing); err != nil {
		t.Fatal(err)
	}
	if landing != "02.03" {
		t.Fatalf("renamed row code = %q, want 02.03 (the deleted member's code)", landing)
	}
}

// §3.3 wants the report to name what it did NOT do. An issue with two work-item
// links that cannot be told apart, and a child that matched while its parent
// did not, both appear in the unfiled section instead of silently vanishing.
func TestCockpitPlanReconcileReportsUnfiledIssues(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	projectA := f.Project(t, "A 项目")
	projectB := f.Project(t, "B 项目")
	moduleA := f.Module(t, projectA, "A 模块")
	f.Module(t, projectB, "B 模块")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1a := node(0, "L1-01", "A 项目", pgtype.UUID{})
	l2a := node(0, "01.01", "A 模块", l1a)
	l1b := node(1, "L1-02", "B 项目", pgtype.UUID{})
	l2b := node(0, "02.01", "B 模块", l1b)
	workA := node(0, "01.01.01", "A 工作项", l2a)
	workB := node(0, "02.01.01", "B 工作项", l2b)

	// Two work items in different projects, issue in none of them: the links
	// give no same-project tie-break, so nothing may be filed.
	ambiguous := f.Issue(t, "两个工作项", nil)
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(workA), "issue_id": ambiguous})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(workB), "issue_id": ambiguous})
	// A child that matched a work item while its parent matched nothing.
	parent := f.Issue(t, "父 issue 无归属", testutil.Cols{"project_id": projectA, "module_id": moduleA})
	child := f.Issue(t, "子 issue 命中了工作项", testutil.Cols{"project_id": projectA, "module_id": moduleA, "parent_issue_id": parent})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(workA), "issue_id": child})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	number := func(id string) int {
		var n int
		if err := f.Pool.QueryRow(ctx, `SELECT number FROM issue WHERE workspace_id=$1 AND id=$2`, f.ws, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	reasons := map[string]string{}
	for _, entry := range report.Unfiled {
		reasons[entry.Identifier] = entry.Reason
	}
	if got := reasons[fmt.Sprintf("#%d", number(ambiguous))]; got != "ambiguous_links" {
		t.Fatalf("ambiguous issue reason = %q (all: %v)", got, reasons)
	}
	if got := reasons[fmt.Sprintf("#%d", number(child))]; got != "child_matched_without_parent" {
		t.Fatalf("child-only issue reason = %q (all: %v)", got, reasons)
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2 AND work_item_id IS NOT NULL", f.ws, ambiguous); got != 0 {
		t.Fatal("ambiguous issue was filed")
	}
}

// A cross-project filing is left to a human when the destination project runs a
// NAMED workflow that does not list the issue's status. The reconcile does not
// translate statuses; it refuses to land the issue on a status the project
// forbids, and names it in the unfiled section.
func TestCockpitPlanReconcileHoldsCrossProjectStatusNotInWorkflow(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	// Destination project: a named workflow with only backlog and done.
	workflowID := f.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": f.WorkspaceID, "name": "受限工作流", "initial_status_key": "backlog",
		"steps": `[{"status_key":"backlog"},{"status_key":"done"}]`,
	})
	projectB := f.Project(t, "B 项目", testutil.Cols{"workflow_id": workflowID})
	moduleB := f.Module(t, projectB, "B 模块")
	projectA := f.Project(t, "A 项目")
	moduleA := f.Module(t, projectA, "A 模块")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1b := node(1, "L1-02", "B 项目", pgtype.UUID{})
	l2b := node(0, "02.01", "B 模块", l1b)
	workB := node(0, "02.01.01", "B 工作项", l2b)
	_ = moduleB

	// The issue lives in A on a status the B workflow rejects.
	issueID := f.Issue(t, "跨项目 issue", testutil.Cols{"project_id": projectA, "module_id": moduleA, "status": "in_progress"})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(workB), "issue_id": issueID})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var reason string
	for _, entry := range report.Unfiled {
		if entry.IssueID == issueID {
			reason = entry.Reason
		}
	}
	if reason != "cross_project_status_not_in_workflow" {
		t.Fatalf("unfiled reason = %q (unfiled: %+v)", reason, report.Unfiled)
	}
	for _, filed := range report.Issues {
		if filed.IssueID == issueID {
			t.Fatal("the blocked issue was still scheduled to move")
		}
	}
}

// A title's leading code is human-typed text, so the plan only lets it name a
// work item in the issue's OWN module; when the code points into another module
// of the same project the issue keeps its module and is reported instead.
func TestCockpitPlanReconcileDoesNotMoveIssueToAnotherModuleByTitleCode(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "P 项目")
	moduleOne := f.Module(t, project, "01.01 甲模块")
	f.Module(t, project, "01.02 乙模块")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-01", "P 项目", pgtype.UUID{})
	l2one := node(0, "01.01", "甲模块", l1)
	l2two := node(1, "01.02", "乙模块", l1)
	node(0, "01.01.01", "甲工作项", l2one)
	node(0, "01.02.01", "乙工作项", l2two)

	// The issue sits in 甲模块 but its title carries 乙模块's work-item code.
	issueID := f.Issue(t, "01.02.01 乙模块的工作", testutil.Cols{"project_id": project, "module_id": moduleOne, "number": 9001})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var reason string
	for _, entry := range report.Unfiled {
		if entry.IssueID == issueID {
			reason = entry.Reason
		}
	}
	if reason != "title_code_other_module" {
		t.Fatalf("reason = %q, want title_code_other_module (unfiled: %+v)", reason, report.Unfiled)
	}
	for _, filed := range report.Issues {
		if filed.IssueID == issueID {
			t.Fatalf("issue was refiled into another module: %+v", filed)
		}
	}
}

// The compat primary endpoint may not unfil a child whose parent is still
// filed: I4 says a child follows its parent's work item, so clearing it alone
// would strand it outside.
func TestCockpitPrimaryCompatClearRefusesFiledChild(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	parent := f.Issue(t, "父 issue", testutil.Cols{"work_item_id": f.a, "project_id": f.project, "module_id": f.module})
	child := f.Issue(t, "子 issue", testutil.Cols{"work_item_id": f.a, "project_id": f.project, "module_id": f.module, "parent_issue_id": parent})
	revision := f.issueRevision(t, child)
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: parseTestUUID(t, child), ActorID: f.owner, ExpectedRevision: revision}); err == nil {
		t.Fatal("clearing a filed child's work item was accepted")
	}
	if got := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND id=$2 AND work_item_id IS NOT NULL", f.ws, child); got != 1 {
		t.Fatal("the child lost its filing despite the refusal")
	}
}

// A subtree refile bumps every descendant's revision, so every descendant gets
// its own update event — a listener caching one issue would otherwise never
// hear that the issue moved with its parent.
func TestCockpitPrimaryRefilePublishesEverySubtreeRow(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	parent := f.Issue(t, "父 issue", testutil.Cols{"work_item_id": f.a, "project_id": f.project, "module_id": f.module})
	child := f.Issue(t, "子 issue", testutil.Cols{"work_item_id": f.a, "project_id": f.project, "module_id": f.module, "parent_issue_id": parent})
	seen := map[string]bool{}
	f.issues.Bus.Subscribe(protocol.EventIssueUpdated, func(event events.Event) {
		payload, ok := event.Payload.(map[string]any)
		if !ok || payload["work_item_changed"] != true {
			return
		}
		issue, ok := payload["issue"].(map[string]any)
		if !ok {
			return
		}
		if id, ok := issue["id"].(string); ok {
			seen[id] = true
		}
	})
	revision := f.issueRevision(t, parent)
	if _, err := f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: parseTestUUID(t, parent), NodeID: f.b, ActorID: f.owner, ExpectedRevision: revision}); err != nil {
		t.Fatal(err)
	}
	if !seen[parent] || !seen[child] {
		t.Fatalf("update events = %v, want both parent and child", seen)
	}
}

// issueRevision reads an issue's current revision for the compat endpoint's
// optimistic check.
func (f planningFixture) issueRevision(t *testing.T, issue string) int64 {
	t.Helper()
	row, err := f.q.GetIssueInWorkspace(context.Background(), db.GetIssueInWorkspaceParams{WorkspaceID: f.ws, ID: parseTestUUID(t, issue)})
	if err != nil {
		t.Fatal(err)
	}
	return row.Revision
}

// A backfilled L2 can take the exact number a merged-away member row still
// holds (fosun-bio: modules「03.04/03.05 对外汇报材料」backfilled as 03.04/03.05
// while the old 03.04/03.05 members are only deleted in the same transaction).
// Created rows enter with a temporary code and join the same two-phase
// renumbering, so the merge and the backfill commit together.
func TestCockpitPlanReconcileCreatesModuleRowsOntoDeletedCodes(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "03药研智能体及应用案例")
	// Two modules of this project have no L2 row yet; their titles carry the
	// display numbers the backfilled rows will take.
	f.Module(t, project, "03.04 对外汇报材料")
	f.Module(t, project, "03.05 对外汇报材料二")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-03", "药研智能体及应用案例", pgtype.UUID{})
	// 03.01–03.02 merge into 03.01; 03.03–03.05 merge into 03.03, so the
	// surviving children are 03.01, 03.03, 03.06/03.07 → renumbered 03.01,
	// 03.02, 03.03, 03.04. The deleted members 03.04/03.05 hold the numbers
	// the backfilled module rows need.
	for i := 1; i <= 7; i++ {
		node(float64(i-1), fmt.Sprintf("03.%02d", i), fmt.Sprintf("方向 %d", i), l1)
	}
	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	if len(report.NewModuleNodes) == 0 {
		t.Fatal("the fixtures produced no backfilled module row")
	}
	// The backfilled rows took the deleted members' numbers, and no code
	// appears twice under the project.
	if got := f.Count(t, "SELECT count(DISTINCT code) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, l1); got != f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND parent_id=$2", f.ws, l1) {
		t.Fatal("duplicate codes after merge+backfill")
	}
	// The report shows the FINAL code of every backfilled row.
	for _, entry := range report.NewModuleNodes {
		var actual string
		if err := f.Pool.QueryRow(ctx, "SELECT code FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, entry.NodeID).Scan(&actual); err != nil {
			t.Fatal(err)
		}
		if entry.Code != actual {
			t.Fatalf("report code %q for %s, row holds %q", entry.Code, entry.Title, actual)
		}
	}
}

// Production numbering: the workstream rows are L1-01 and L1-04..L1-08 (not
// 01..06), and one project has no old L2 at all. All new roots must number
// 01/02/03 by position after the old rows release theirs — an eager
// nextL1Code() handed the no-L2 project 09 because L1-04..08 still held
// their numbers at that moment.
func TestCockpitPlanReconcileNumbersRootsAfterReleaseAtProductionShape(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	projects := []string{"HLX22", "FS-501", "PMO 数字化建设（内部）"}
	for _, title := range projects {
		projectID := f.Project(t, title)
		f.Module(t, projectID, title+"模块")
	}
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	// Production numbering: the workstream rows are L1-01 and L1-04 (01–03 and
	// 05–08 do not exist), each carrying one L2 that maps to a module. The
	// third project has no row at all and gets a root from createRootForProject
	// — the "next" source that used to land on 09.
	for i, code := range []string{"L1-01", "L1-04"} {
		l1 := node(float64(i), code, fmt.Sprintf("职能-%d", i), pgtype.UUID{})
		node(0, fmt.Sprintf("%02d.01", i+1), projects[i]+"模块", l1)
	}
	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	roots := map[string]string{}
	rows, err := f.Pool.Query(ctx, "SELECT code, name FROM cockpit_node WHERE workspace_id=$1 AND parent_id IS NULL ORDER BY position", f.ws)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var code, name string
		if err := rows.Scan(&code, &name); err != nil {
			t.Fatal(err)
		}
		roots[code] = name
	}
	if len(roots) != 3 || roots["01"] == "" || roots["02"] == "" || roots["03"] == "" {
		t.Fatalf("root codes = %v, want 01/02/03", roots)
	}
	// The no-L2 project is the third one, and it got 03, not 09.
	if roots["03"] != "PMO 数字化建设（内部）" {
		t.Fatalf("root 03 = %q", roots["03"])
	}
	if _, ok := roots["09"]; ok {
		t.Fatal("a root was numbered 09")
	}
}

// A created row's report entry shows its final code, not a provisional one.
func TestCockpitPlanReconcileReportsFinalCodesForNewRows(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	// A project with no L1 row at all: the reconcile creates one from the
	// project's own number (title_prefix), then a module row beneath it.
	project := f.Project(t, "07 海外注册")
	f.Module(t, project, "07.01 申报资料")
	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.NewRoots) != 1 || len(report.NewModuleNodes) == 0 {
		t.Fatalf("report new roots=%d modules=%d", len(report.NewRoots), len(report.NewModuleNodes))
	}
	if report.NewRoots[0].Code != "07" || report.NewRoots[0].Source != "title_prefix" {
		t.Fatalf("new root = %q/%q, want 07/title_prefix", report.NewRoots[0].Code, report.NewRoots[0].Source)
	}
	if report.NewModuleNodes[0].Code != "07.01" {
		t.Fatalf("new module row code = %q, want 07.01", report.NewModuleNodes[0].Code)
	}
}

// Two shapes the per-issue check missed: an issue with NO project gaining one
// counts as a project move (the update path treats null → project that way),
// and holding only the parent would let its children follow it into a project
// whose workflow rejects them — so the whole family is held and each row is
// listed with its own reason.
func TestCockpitPlanReconcileHoldsWholeFamilyAcrossProjectMove(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	workflowID := f.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": f.WorkspaceID, "name": "受限工作流", "initial_status_key": "backlog",
		"steps": `[{"status_key":"backlog"},{"status_key":"done"}]`,
	})
	project := f.Project(t, "B 项目", testutil.Cols{"workflow_id": workflowID})
	f.Module(t, project, "B 模块")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-02", "B 项目", pgtype.UUID{})
	l2 := node(0, "02.01", "B 模块", l1)
	work := node(0, "02.01.01", "B 工作项", l2)

	// Parent lives OUTSIDE any project on a status the workflow rejects; its
	// child sits in a permissive project. The child's link is the same work
	// item, so it would follow the parent into the restricted project.
	parent := f.Issue(t, "无项目父 issue", testutil.Cols{"status": "in_progress"})
	child := f.Issue(t, "子 issue", testutil.Cols{"project_id": project, "module_id": parseTestUUID(t, f.Insert(t, "module", testutil.Cols{"workspace_id": f.WorkspaceID, "project_id": project, "title": "B 子模块"})), "parent_issue_id": parent})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(work), "issue_id": parent})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": util.UUIDToString(work), "issue_id": child})

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, entry := range report.Unfiled {
		reasons[entry.IssueID] = entry.Reason
	}
	if got := reasons[parent]; got != "cross_project_status_not_in_workflow" {
		t.Fatalf("parent reason = %q (all: %v)", got, reasons)
	}
	if got := reasons[child]; got != "family_cross_project_status" {
		t.Fatalf("child reason = %q, want family_cross_project_status (all: %v)", got, reasons)
	}
	for _, filed := range report.Issues {
		if filed.IssueID == parent || filed.IssueID == child {
			t.Fatalf("a held family member was still scheduled to move: %+v", filed)
		}
	}
}

// A pre-bound L2 row is the authority on its module: a later row that
// name-matches the same module must surface as a blocker, whichever order the
// two rows appear in. The pre-bound row keeps its binding.
func TestCockpitPlanReconcileBlocksSecondClaimOnPreBoundModule(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "P 项目")
	module := f.Module(t, project, "01.01 甲模块")
	node := func(position float64, code, name string, parent pgtype.UUID, moduleID pgtype.UUID) pgtype.UUID {
		// The project row binds the project. An unbound L2 resolves its scope
		// through the parent, so it carries neither binding; a bound L2 carries
		// project+module (the module check requires the project, and the
		// project-only index is partial so the two never collide).
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		} else {
			cols["project_id"] = project
		}
		if moduleID.Valid {
			cols["module_id"] = moduleID
			cols["project_id"] = project
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-01", "P 项目", pgtype.UUID{}, pgtype.UUID{})
	// Position 0: a plain row named like the module (would match by name).
	node(0, "01.01", "甲模块", l1, pgtype.UUID{})
	// Position 1: the pre-bound row, appearing AFTER the name match.
	node(1, "01.02", "旧名", l1, parseTestUUID(t, module))

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) == 0 {
		t.Fatal("two rows claiming one module was not blocked")
	}
	if got := f.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND module_id=$2", f.ws, module); got != 1 {
		t.Fatalf("module holders in the fixture = %d", got)
	}
}

// A project whose title carries its own number keeps it (§3.2 item 3, §0 item
// 16): the deferred root pass must not renumber a title_prefix root away. The
// board also reflows, so the deferred pass runs and rebuilds the claim set —
// which is where the number used to be lost.
func TestCockpitPlanReconcileKeepsTitlePrefixRootNumber(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	// 00 has no L1 row and must get one numbered 00 from its title.
	team := f.Project(t, "00团队资料管理（基础支撑）")
	f.Module(t, team, "团队资料模块")
	// A workstream board that reflows, so assignDeferredRootCodes runs.
	flow := f.Project(t, "流程项目")
	f.Module(t, flow, "流程模块")
	node := func(position float64, code, name string, parent pgtype.UUID) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": name, "position": position}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	l1 := node(0, "L1-05", "职能行", pgtype.UUID{})
	node(0, "05.01", "流程模块", l1)

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	var teamRoot *CockpitReconcileNewRoot
	for i := range report.NewRoots {
		if report.NewRoots[i].ProjectID == team {
			teamRoot = &report.NewRoots[i]
		}
	}
	if teamRoot == nil {
		t.Fatalf("no root reported for the 00 project: %+v", report.NewRoots)
	}
	if teamRoot.Code != "00" || teamRoot.Source != "title_prefix" {
		t.Fatalf("00 root = code %q source %q, want 00/title_prefix", teamRoot.Code, teamRoot.Source)
	}
	// The stored row and the title split agree with it.
	var stored string
	if err := f.Pool.QueryRow(ctx, "SELECT code FROM cockpit_node WHERE workspace_id=$1 AND id=$2", f.ws, teamRoot.NodeID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "00" {
		t.Fatalf("stored root code = %q, want 00", stored)
	}
	var splitCode string
	if err := f.Pool.QueryRow(ctx, "SELECT title FROM project WHERE workspace_id=$1 AND id=$2", f.ws, team).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "团队资料管理（基础支撑）" {
		t.Fatalf("project title = %q, want the code stripped", stored)
	}
	for _, split := range report.TitleSplits {
		if split.Kind == "project" && split.ID == team {
			splitCode = split.Code
		}
	}
	if splitCode != "00" {
		t.Fatalf("title split code = %q, want 00", splitCode)
	}
	// The reflow root took the next free number, not 00 and not 01-over-00.
	var reflowCode string
	for _, root := range report.NewRoots {
		if root.ProjectID == flow {
			reflowCode = root.Code
		}
	}
	if reflowCode == "" || reflowCode == "00" {
		t.Fatalf("reflow root code = %q", reflowCode)
	}
}

func TestReconcileCockpitPlanPreservesExistingModuleDirectoryName(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "01 高质量数据集")
	mod := f.Module(t, project, "01.04 组学数据产出协同")
	if _, err := f.Pool.Exec(ctx, "UPDATE module SET directory_name = $1 WHERE id = $2", "01.04 组学数据产出协同", mod); err != nil {
		t.Fatal(err)
	}
	l1 := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": "01", "name": "高质量数据集", "position": 0}))
	l2 := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "parent_id": l1, "code": "01.04", "name": "组学数据产出协同", "position": 0}))

	report, err := f.issues.ReconcileCockpitPlan(ctx, CockpitReconcileInput{WorkspaceID: f.ws, ActorID: f.owner, Apply: true},
		func(context.Context, *db.Queries, db.Cockpit) (string, error) { return "snap", nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Blockers) != 0 {
		t.Fatalf("blockers: %v", report.Blockers)
	}
	var modDir, nodeDir string
	if err := f.Pool.QueryRow(ctx, "SELECT COALESCE(m.directory_name, ''), COALESCE(n.directory_name, '') FROM module m JOIN cockpit_node n ON n.id = $1 WHERE m.id = $2", l2, mod).Scan(&modDir, &nodeDir); err != nil {
		t.Fatal(err)
	}
	if modDir != "01.04 组学数据产出协同" || nodeDir != "01.04 组学数据产出协同" {
		t.Fatalf("directory_name = module %q / node %q, want both preserved as %q", modDir, nodeDir, "01.04 组学数据产出协同")
	}
}
