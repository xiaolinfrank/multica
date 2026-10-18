package service

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitPlanExportDeduplicatesAndExcludesContextMappings(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	owned, err := f.issues.CreateCockpitNodeTask(ctx, f.createInput("Export primary and reference"), IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	ref := f.Issue(t, "Export reference", testutil.Cols{"project_id": f.project, "module_id": f.module})
	ancestors, err := f.q.ListCockpitSurfaceAncestors(ctx, db.ListCockpitSurfaceAncestorsParams{WorkspaceID: f.ws, NodeID: f.a})
	if err != nil {
		t.Fatal(err)
	}
	root := ancestors[len(ancestors)-1].CockpitNode.ID
	for _, link := range []struct {
		node  pgtype.UUID
		issue string
	}{{f.a, util.UUIDToString(owned.Issue.ID)}, {f.b, ref}, {root, ref}} {
		f.InsertNoID(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.ws, "node_id": link.node, "issue_id": link.issue}, "workspace_id=$1 AND node_id=$2 AND issue_id=$3", f.ws, link.node, link.issue)
	}
	// A malformed legacy link must not expose another tenant's issue.
	outside, _ := newPrincipalFixture(t)
	foreign := outside.Issue(t, "Not in export")
	f.InsertNoID(t, "cockpit_node_issue", testutil.Cols{"workspace_id": f.ws, "node_id": f.a, "issue_id": foreign}, "workspace_id=$1 AND node_id=$2 AND issue_id=$3", f.ws, f.a, foreign)
	out, err := f.issues.GetCockpitPlanExport(ctx, surfaceQuery(f))
	if err != nil {
		t.Fatal(err)
	}
	if !out.Complete || out.IssueLinkTotal != 2 || len(out.IssueLinks) != 2 || out.Scope.ModuleID == nil || *out.Scope.ModuleID != util.UUIDToString(f.module) {
		t.Fatalf("incorrect scoped export: %+v", out)
	}
	if _, err := time.Parse(time.RFC3339Nano, out.GeneratedAt); err != nil {
		t.Fatalf("export timestamp: %v", err)
	}
	seen := map[string]bool{}
	for _, link := range out.IssueLinks {
		key := link.NodeID + ":" + link.IssueIdentifier
		if seen[key] || link.NodeID == util.UUIDToString(root) || link.IssueIdentifier == "" {
			t.Fatalf("duplicate or context link: %+v", link)
		}
		seen[key] = true
	}
	p := surfaceQuery(f)
	p.ModuleID = pgtype.UUID{}
	p.ProjectID = pgtype.UUID{}
	all, err := f.issues.GetCockpitPlanExport(ctx, p)
	if err != nil || all.IssueLinkTotal != 3 {
		t.Fatalf("workspace export lost true root reference: %d/%v", all.IssueLinkTotal, err)
	}
	data, err := json.Marshal(out.IssueLinks)
	if err != nil {
		t.Fatal(err)
	}
	var compact []map[string]any
	if err = json.Unmarshal(data, &compact); err != nil {
		t.Fatal(err)
	}
	for _, row := range compact {
		if len(row) != 2 {
			t.Fatalf("export mapping expanded into task body: %v", row)
		}
	}
}
