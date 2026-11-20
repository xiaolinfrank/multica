package service

import (
	"context"
	"testing"
)

// A module created after reconciliation gets its L2 row from the skeleton pass,
// and that row carries the directory name it will own (S3): the code plus the
// module title, the same shape the reconcile writes.
func TestEnsureCockpitPlanSkeletonWritesModuleDirectoryName(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	if _, err := f.Pool.Exec(ctx, `UPDATE cockpit SET plan_reconciled_at=now() WHERE workspace_id=$1`, f.ws); err != nil {
		t.Fatal(err)
	}
	project := f.Project(t, "后建项目")
	module := f.Module(t, project, "后建模块")
	if _, err := f.issues.EnsureCockpitPlanSkeleton(ctx, f.ws); err != nil {
		t.Fatal(err)
	}
	var code, directory string
	if err := f.Pool.QueryRow(ctx, `SELECT code, COALESCE(directory_name,'') FROM cockpit_node WHERE workspace_id=$1 AND module_id=$2`, f.ws, module).Scan(&code, &directory); err != nil {
		t.Fatal(err)
	}
	want := code + "后建模块"
	if directory != want {
		t.Fatalf("directory name = %q, want %q", directory, want)
	}
}
