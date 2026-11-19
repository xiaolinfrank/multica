package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// The endpoint is the console/CLI entry point for the one-time plan migration:
// dry run previews, apply is human-only, and apply backs the board up first.
func TestCockpitPlanReconcileHTTPDryRunIsReadOnlyAndApplyIsHumanOnly(t *testing.T) {
	ws := cockpitFixture(t, "reconcile http")
	root := createNode(t, ws, map[string]any{"code": "L1-01", "name": "高质量数据集"})

	path := "/api/cockpit/plan/reconcile"
	var preview service.CockpitReconcileReport
	testutil.Call(t, cockpitHandler(testHandler.ReconcileCockpitPlan),
		cockpitRequest(http.MethodPost, path, ws, map[string]any{})).Want(http.StatusOK).JSON(&preview)
	if preview.Apply || preview.WorkspaceID != ws || len(preview.Blockers) != 0 {
		t.Fatalf("preview report = %+v", preview)
	}
	if len(preview.NewProjects) != 1 || preview.NewProjects[0].NodeID != root.ID || preview.NewProjects[0].ProjectID == "" {
		t.Fatalf("unbound L1 was not planned as a project: %+v", preview.NewProjects)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM project WHERE workspace_id=$1", ws); n != 0 {
		t.Fatalf("dry run created %d projects", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws); n != 0 {
		t.Fatalf("dry run wrote %d snapshots", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND plan_reconciled_at IS NOT NULL", ws); n != 0 {
		t.Fatal("dry run marked the plan reconciled")
	}

	// A task token can read the plan but must not rewrite it.
	machine := cockpitRequest(http.MethodPost, path, ws, map[string]any{"apply": true})
	machine.Header.Set("X-Actor-Source", "task_token")
	testutil.Call(t, cockpitHandler(testHandler.ReconcileCockpitPlan), machine).Want(http.StatusForbidden)
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws); n != 0 {
		t.Fatalf("refused apply wrote %d snapshots", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND project_id IS NOT NULL", ws); n != 0 {
		t.Fatal("refused apply bound the root to a project")
	}

	var applied service.CockpitReconcileReport
	testutil.Call(t, cockpitHandler(testHandler.ReconcileCockpitPlan),
		cockpitRequest(http.MethodPost, path, ws, map[string]any{"apply": true})).Want(http.StatusOK).JSON(&applied)
	if !applied.Apply || applied.SnapshotID == "" || len(applied.Blockers) != 0 || len(applied.NewProjects) != 1 {
		t.Fatalf("apply report = %+v", applied)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1 AND label='对账前自动快照'", ws); got != 1 {
		t.Fatalf("apply took %d pre-apply snapshots", got)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND plan_reconciled_at IS NOT NULL", ws); got != 1 {
		t.Fatal("apply did not mark the plan reconciled")
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM project WHERE workspace_id=$1 AND id=$2::uuid AND title='高质量数据集'", ws, applied.NewProjects[0].ProjectID); got != 1 {
		t.Fatalf("project %s was not created with the stripped title", applied.NewProjects[0].ProjectID)
	}
	if got := dbfx.Count(t, "SELECT count(*) FROM cockpit_node WHERE workspace_id=$1 AND id=$2 AND project_id=$3::uuid", ws, root.ID, applied.NewProjects[0].ProjectID); got != 1 {
		t.Fatal("apply did not bind the L1 row to its project")
	}
}

// An empty board has nothing to back up; apply must still reconcile it so the
// skeleton starts mirroring projects created afterwards.
func TestCockpitPlanReconcileHTTPEmptyBoardAppliesWithoutSnapshot(t *testing.T) {
	ws := cockpitFixture(t, "reconcile empty")
	var out service.CockpitReconcileReport
	testutil.Call(t, cockpitHandler(testHandler.ReconcileCockpitPlan),
		cockpitRequest(http.MethodPost, "/api/cockpit/plan/reconcile", ws, map[string]any{"apply": true})).Want(http.StatusOK).JSON(&out)
	if !out.Apply || out.SnapshotID != "" || len(out.Groups) != 0 || len(out.NewProjects) != 0 || len(out.Issues) != 0 {
		t.Fatalf("empty apply report = %+v", out)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit_snapshot WHERE workspace_id=$1", ws); n != 0 {
		t.Fatalf("empty board produced %d snapshots", n)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM cockpit WHERE workspace_id=$1 AND plan_reconciled_at IS NOT NULL", ws); n != 1 {
		t.Fatal("empty apply did not mark the plan reconciled")
	}
}
