package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitGovernanceChangesPageScopesCountsAndCursor(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	p := surfaceQuery(f)
	node, err := f.q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: f.ws, ID: f.a})
	if err != nil {
		t.Fatal(err)
	}
	foreignProject := f.Project(t, "Outside")
	foreignNode := f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": node.CockpitID, "code": "outside", "project_id": foreignProject})
	for i := 0; i < 31; i++ {
		status := "rejected"
		if i == 0 {
			status = "pending"
		}
		f.Insert(t, "cockpit_pending_change", testutil.Cols{"workspace_id": f.ws, "cockpit_id": node.CockpitID, "node_id": f.a, "field": "note", "new_value": fmt.Sprintf("Proposal %d", i), "status": status, "created_at": time.Date(2026, 10, 10, 12, 0, i, 0, time.UTC)})
	}
	f.Insert(t, "cockpit_pending_change", testutil.Cols{"workspace_id": f.ws, "cockpit_id": node.CockpitID, "node_id": foreignNode, "field": "note", "new_value": "Outside", "status": "pending"})
	query := CockpitGovernanceQuery{CockpitSurfaceQuery: p}
	first, err := f.issues.ListCockpitChangePage(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 31 || len(first.Items) != 25 || first.NextCursor == nil || first.Counts.Pending != 1 || first.Counts.Decided != 30 {
		t.Fatalf("scope/page counts: %+v", first)
	}
	seen := map[string]bool{}
	for _, item := range first.Items {
		var row struct{ ID, Status string }
		if err = json.Unmarshal(item, &row); err != nil {
			t.Fatal(err)
		}
		seen[row.ID] = true
	}
	var firstRow struct{ Status string }
	_ = json.Unmarshal(first.Items[0], &firstRow)
	if firstRow.Status != "pending" {
		t.Fatal("open proposals must precede decision history")
	}
	query.Cursor = *first.NextCursor
	last, err := f.issues.ListCockpitChangePage(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if len(last.Items) != 6 || last.NextCursor != nil || last.Total != 31 {
		t.Fatalf("last page: %+v", last)
	}
	for _, item := range last.Items {
		var row struct{ ID string }
		_ = json.Unmarshal(item, &row)
		if seen[row.ID] {
			t.Fatal("cursor repeated a proposal")
		}
		seen[row.ID] = true
	}
	query.Status = "pending"
	if _, err = f.issues.ListCockpitChangePage(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cursor reused across status: %v", err)
	}
	query.Cursor = ""
	pending, err := f.issues.ListCockpitChangePage(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if pending.Total != 1 || pending.Counts.Decided != 30 || pending.Scope.ProjectID == nil || *pending.Scope.ProjectID != util.UUIDToString(f.project) {
		t.Fatalf("pending filters lost scope/history count: %+v", pending)
	}
	query.ProjectID = parseTestUUID(t, foreignProject)
	query.ModuleID = pgtype.UUID{}
	other, err := f.issues.ListCockpitChangePage(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if other.Total != 1 {
		t.Fatalf("wrong project subset: %+v", other)
	}
}

func TestCockpitGovernanceSnapshotsPageIsExplicitlyGlobalAndBodyless(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	ctx := context.Background()
	meeting, err := f.q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: f.ws, ID: f.meeting})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 27; i++ {
		f.Insert(t, "cockpit_snapshot", testutil.Cols{"workspace_id": f.ws, "cockpit_id": meeting.CockpitID, "trigger_kind": "manual", "label": fmt.Sprintf("Baseline %d", i), "payload": json.RawMessage(`{"private_body":"must not be in list"}`), "created_at": time.Date(2026, 10, 10, 12, 0, i, 0, time.UTC)})
	}
	p := CockpitGovernanceQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true}, Query: "Baseline"}
	first, err := f.issues.ListCockpitSnapshotPage(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(first)
	if first.Scope != "workspace" || first.Total != 27 || len(first.Items) != 25 || first.NextCursor == nil || strings.Contains(string(raw), "private_body") || strings.Contains(string(raw), "payload") {
		t.Fatalf("snapshot metadata page: %s", raw)
	}
	p.Cursor = *first.NextCursor
	last, err := f.issues.ListCockpitSnapshotPage(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(last.Items) != 2 || last.NextCursor != nil {
		t.Fatalf("snapshot last page: %+v", last)
	}
	p.Query = "other"
	if _, err = f.issues.ListCockpitSnapshotPage(ctx, p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("snapshot cursor accepted different search: %v", err)
	}
	p.Cursor = ""
	p.ProjectID = parseTestUUID(t, f.Project(t, "Project"))
	if _, err = f.issues.ListCockpitSnapshotPage(ctx, p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("global snapshots appeared scope filtered: %v", err)
	}
}
