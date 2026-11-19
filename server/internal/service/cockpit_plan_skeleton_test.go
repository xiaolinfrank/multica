package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

type planNodeView struct {
	ID            string  `json:"id"`
	ParentID      *string `json:"parent_id"`
	ProjectID     *string `json:"project_id"`
	ModuleID      *string `json:"module_id"`
	Code          string  `json:"code"`
	Name          string  `json:"name"`
	Kind          string  `json:"kind"`
	ProjectStatus string  `json:"project_status"`
}

type planTaskCountView struct {
	NodeID         string `json:"node_id"`
	PrimaryTotal   int64  `json:"primary_total"`
	ReferenceTotal int64  `json:"reference_total"`
	Active         int64  `json:"active"`
	Done           int64  `json:"done"`
	Closed         int64  `json:"closed"`
}

func decodePlanNodes(t *testing.T, raw json.RawMessage) map[string]planNodeView {
	t.Helper()
	var nodes []planNodeView
	if err := json.Unmarshal(raw, &nodes); err != nil {
		t.Fatalf("decode plan nodes: %v", err)
	}
	out := make(map[string]planNodeView, len(nodes))
	for _, node := range nodes {
		out[node.ID] = node
	}
	return out
}

func decodeTaskCounts(t *testing.T, raw json.RawMessage) map[string]planTaskCountView {
	t.Helper()
	var counts []planTaskCountView
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatalf("decode task counts: %v", err)
	}
	out := make(map[string]planTaskCountView, len(counts))
	for _, count := range counts {
		out[count.NodeID] = count
	}
	return out
}

// After reconciliation, a project/module created without a tree row still
// shows up on the next plan read, appended with the next outline number. The
// pass is idempotent and leaves existing codes alone.
func TestCockpitPlanSurfaceFillsMissingSkeleton(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}

	alphaProject := parseTestUUID(t, f.Project(t, "Alpha project"))
	alphaModule := parseTestUUID(t, f.Module(t, util.UUIDToString(alphaProject), "Alpha module"))
	alphaRoot := f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": "01", "name": "Alpha project",
		"position": 0, "project_id": alphaProject,
	})
	f.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": "01.01", "name": "Alpha module",
		"position": 0, "parent_id": alphaRoot, "project_id": alphaProject, "module_id": alphaModule,
	})

	// A project and a module the reconcile pass has not seen yet.
	betaProject := f.Project(t, "Beta project")
	f.Module(t, betaProject, "Beta module")

	if _, err := f.Pool.Exec(ctx, `UPDATE cockpit SET plan_reconciled_at = now() WHERE id = $1`, board.ID); err != nil {
		t.Fatal(err)
	}

	p := CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true}
	first, err := f.issues.GetCockpitPlanSurface(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if first.Counts.Nodes != 4 {
		t.Fatalf("nodes after skeleton = %d, want 4: %+v", first.Counts.Nodes, first.Counts)
	}
	nodes := decodePlanNodes(t, first.Nodes)
	var beta planNodeView
	for _, node := range nodes {
		if node.Kind == "project" && node.Code == "02" {
			beta = node
		}
	}
	if beta.ID == "" || beta.Name != "Beta project" || beta.ProjectStatus != "planned" {
		t.Fatalf("beta project row = %+v", beta)
	}
	var betaModule planNodeView
	for _, node := range nodes {
		if node.Kind == "module" && node.ParentID != nil && *node.ParentID == beta.ID {
			betaModule = node
		}
	}
	if betaModule.Code != "02.01" || betaModule.Name != "Beta module" {
		t.Fatalf("beta module row = %+v", betaModule)
	}

	second, err := f.issues.GetCockpitPlanSurface(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if second.Counts.Nodes != 4 {
		t.Fatalf("skeleton must be idempotent, nodes = %d", second.Counts.Nodes)
	}
}

// The plan read derives structure from the tree instead of the old binding
// inheritance: each row carries its kind, project/module titles stand in for
// L1/L2 names, closed projects hide from the workspace tree, and work-item
// counts roll up so an L1/L2 row answers for the work below it.
func TestCockpitPlanSurfaceDerivesStructureAndCounts(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	if _, err := f.Pool.Exec(ctx, `UPDATE project SET status = 'paused' WHERE id = $1`, f.project); err != nil {
		t.Fatal(err)
	}
	issue := func(title string, workItem pgtype.UUID, status string) string {
		return f.Issue(t, title, testutil.Cols{
			"work_item_id": workItem, "project_id": f.project, "module_id": f.module, "status": status,
		})
	}
	a1 := issue("a1", f.a, "todo")
	issue("a2", f.a, "done")
	issue("b1", f.b, "todo")
	// a1 is filed under a; a link back to a is the filing, not a reference.
	// The same issue linked to b is related work and must count there.
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": f.a, "issue_id": a1})
	f.Insert(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.WorkspaceID, "node_id": f.b, "issue_id": a1})

	plan, err := f.issues.GetCockpitPlanSurface(ctx, surfaceQuery(f))
	if err != nil {
		t.Fatal(err)
	}
	nodes := decodePlanNodes(t, plan.Nodes)
	if len(nodes) != 4 {
		t.Fatalf("nodes = %d, want 4", len(nodes))
	}
	a := nodes[util.UUIDToString(f.a)]
	if a.Kind != "work_item" || a.Name != "execution-a" {
		t.Fatalf("execution-a row = %+v", a)
	}
	moduleNode := nodes[util.UUIDToString(f.moduleNode)]
	if moduleNode.Kind != "module" || moduleNode.Name != "Planning module" || moduleNode.ProjectStatus != "paused" {
		t.Fatalf("module row = %+v", moduleNode)
	}
	var root planNodeView
	for _, node := range nodes {
		if node.Kind == "project" {
			root = node
		}
	}
	if root.ID == "" || root.Name != "Planning project" || root.ProjectStatus != "paused" {
		t.Fatalf("project row = %+v", root)
	}

	counts := decodeTaskCounts(t, plan.TaskCounts)
	if got := counts[util.UUIDToString(f.a)]; got.PrimaryTotal != 2 || got.Active != 1 || got.Done != 1 {
		t.Fatalf("work item a counts = %+v", got)
	}
	if got := counts[util.UUIDToString(f.b)]; got.PrimaryTotal != 1 || got.Active != 1 || got.ReferenceTotal != 1 {
		t.Fatalf("work item b counts = %+v", got)
	}
	// Context ancestors outside the module scope keep their identity but carry
	// no counts, exactly like payments; the module and the group below it do.
	if got := counts[util.UUIDToString(f.moduleNode)]; got.PrimaryTotal != 3 || got.Active != 2 || got.Done != 1 {
		t.Fatalf("rolled-up counts at the module = %+v", got)
	}

	wide := CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true}
	hidden, err := f.issues.GetCockpitPlanSurface(ctx, wide)
	if err != nil {
		t.Fatal(err)
	}
	if hidden.Counts.Nodes != 0 {
		t.Fatalf("paused project leaked into the default workspace tree: %+v", hidden.Counts)
	}
	wide.IncludeClosed = true
	shown, err := f.issues.GetCockpitPlanSurface(ctx, wide)
	if err != nil {
		t.Fatal(err)
	}
	if shown.Counts.Nodes != 4 {
		t.Fatalf("include_closed nodes = %d, want 4", shown.Counts.Nodes)
	}
	// Workspace-wide, the project root is part of the scope and answers for the
	// same three issues.
	shownCounts := decodeTaskCounts(t, shown.TaskCounts)
	if got := shownCounts[root.ID]; got.PrimaryTotal != 3 || got.Active != 2 || got.Done != 1 {
		t.Fatalf("root counts in the workspace tree = %+v", got)
	}
}
