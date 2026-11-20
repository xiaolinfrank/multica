package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Moving a work item into another module takes the issues filed under it: the
// module and project come from the tree, and crossing projects maps the status
// exactly as the issue detail path does.
func TestRefileWorkItemScopeFollowsMove(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	// Destination: a named workflow with a started step, so "in_progress"
	// maps onto it instead of falling outside the workflow.
	workflow := f.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": f.WorkspaceID, "name": "目标工作流", "initial_status_key": "backlog",
		"steps": `[{"status_key":"backlog"},{"status_key":"in_progress"},{"status_key":"done"}]`,
	})
	project := f.Project(t, "目标项目", testutil.Cols{"workflow_id": workflow})
	module := f.Module(t, project, "目标模块")
	node := func(code string, parent pgtype.UUID, extra testutil.Cols) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": code}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		for k, v := range extra {
			cols[k] = v
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	root := node("R-target", pgtype.UUID{}, testutil.Cols{"project_id": project})
	moduleNode := node("M-target", root, testutil.Cols{"project_id": project, "module_id": module})
	// A child under the moved work item keeps its own filing (I4 makes it the
	// same work item), so both rows must be rewritten.
	issue := f.Issue(t, "工作项下的 issue", testutil.Cols{"project_id": f.project, "module_id": f.module, "work_item_id": f.a, "status": "in_progress"})
	child := f.Issue(t, "子 issue", testutil.Cols{"project_id": f.project, "module_id": f.module, "work_item_id": f.a, "parent_issue_id": issue, "status": "todo"})

	// Move the work item: reparent it to the destination module row.
	if _, err := f.Pool.Exec(ctx, `UPDATE cockpit_node SET parent_id=$2 WHERE workspace_id=$1 AND id=$3`, f.ws, moduleNode, f.a); err != nil {
		t.Fatal(err)
	}
	rows, err := f.issues.RefileWorkItemScope(ctx, f.q, f.ws, f.a)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("refiled rows = %d, want 2", len(rows))
	}
	for _, want := range []struct {
		id     pgtype.UUID
		status string
	}{{parseTestUUID(t, issue), "in_progress"}, {parseTestUUID(t, child), "backlog"}} {
		var projectID, moduleID pgtype.UUID
		var status string
		if err := f.Pool.QueryRow(ctx, `SELECT project_id, module_id, status FROM issue WHERE workspace_id=$1 AND id=$2`, f.ws, want.id).Scan(&projectID, &moduleID, &status); err != nil {
			t.Fatal(err)
		}
		if projectID != parseTestUUID(t, project) || moduleID != parseTestUUID(t, module) {
			t.Fatalf("issue scope = %v/%v", projectID, moduleID)
		}
		// Each status keeps its lifecycle category: started → in_progress,
		// unstarted → backlog (the destination's own keys).
		if status != want.status {
			t.Fatalf("status = %q, want %q", status, want.status)
		}
	}
}

// A destination workflow with no step for the issue's lifecycle refuses the
// move rather than writing a status the workflow does not list — the same
// outcome the issue detail path gives.
func TestRefileWorkItemScopeRefusesUnmappableStatus(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	board, err := f.q.GetCockpitByWorkspace(ctx, f.ws)
	if err != nil {
		t.Fatal(err)
	}
	workflow := f.Insert(t, "issue_workflow", testutil.Cols{
		"workspace_id": f.WorkspaceID, "name": "只有 backlog 的工作流", "initial_status_key": "backlog",
		"steps": `[{"status_key":"backlog"},{"status_key":"done"}]`,
	})
	project := f.Project(t, "受限项目", testutil.Cols{"workflow_id": workflow})
	module := f.Module(t, project, "受限模块")
	node := func(code string, parent pgtype.UUID, extra testutil.Cols) pgtype.UUID {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board.ID, "code": code, "name": code}
		if parent.Valid {
			cols["parent_id"] = parent
		}
		for k, v := range extra {
			cols[k] = v
		}
		return parseTestUUID(t, f.Insert(t, "cockpit_node", cols))
	}
	root := node("R-target", pgtype.UUID{}, testutil.Cols{"project_id": project})
	moduleNode := node("M-target", root, testutil.Cols{"project_id": project, "module_id": module})
	f.Issue(t, "进行中的 issue", testutil.Cols{"project_id": f.project, "module_id": f.module, "work_item_id": f.a, "status": "in_progress"})
	if _, err := f.Pool.Exec(ctx, `UPDATE cockpit_node SET parent_id=$2 WHERE workspace_id=$1 AND id=$3`, f.ws, moduleNode, f.a); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.RefileWorkItemScope(ctx, f.q, f.ws, f.a); err == nil {
		t.Fatal("a move onto an unlisted status was accepted")
	}
}

// Deleting a work item unfiles its issues and leaves their project/module.
func TestDeleteWorkItemClearsFiling(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	issue := f.Issue(t, "被删工作项下的 issue", testutil.Cols{"project_id": f.project, "module_id": f.module, "work_item_id": f.a})
	if _, err := f.Pool.Exec(ctx, `DELETE FROM cockpit_node WHERE workspace_id=$1 AND id=$2`, f.ws, f.a); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.Queries.ClearIssuesFiledAtNode(ctx, db.ClearIssuesFiledAtNodeParams{WorkspaceID: f.ws, WorkItemID: f.a}); err != nil {
		t.Fatal(err)
	}
	var workItem, project, module pgtype.UUID
	if err := f.Pool.QueryRow(ctx, `SELECT work_item_id, project_id, module_id FROM issue WHERE workspace_id=$1 AND id=$2`, f.ws, issue).Scan(&workItem, &project, &module); err != nil {
		t.Fatal(err)
	}
	if workItem.Valid {
		t.Fatal("issue kept a work item that no longer exists")
	}
	if project != f.project || module != f.module {
		t.Fatal("unfiling changed the issue's project or module")
	}
}
