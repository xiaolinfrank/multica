package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func surfaceQuery(f planningFixture) CockpitSurfaceQuery {
	return CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, ProjectID: f.project, ModuleID: f.module}
}

func TestCockpitSurfacePlanKeepsContextWithoutOutsidePayments(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	p := surfaceQuery(f)
	ancestors, err := f.q.ListCockpitSurfaceAncestors(ctx, db.ListCockpitSurfaceAncestorsParams{WorkspaceID: f.ws, NodeID: f.a})
	if err != nil {
		t.Fatal(err)
	}
	root := ancestors[len(ancestors)-1].CockpitNode
	for _, payment := range []struct {
		node   pgtype.UUID
		amount int
	}{{root.ID, 1000}, {f.moduleNode, 20}, {f.a, 10}} {
		f.Insert(t, "cockpit_payment", testutil.Cols{"workspace_id": f.ws, "node_id": payment.node, "amount": payment.amount, "label": "installment"})
	}
	out, err := f.issues.GetCockpitPlanSurface(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !out.Complete || out.Counts.Nodes != 5 || out.Counts.Payments != 2 || len(out.ContextNodeIDs) != 1 || out.ContextNodeIDs[0] != util.UUIDToString(root.ID) {
		t.Fatalf("scoped complete plan: %+v", out.Counts)
	}
	var payments []struct {
		Amount float64 `json:"amount"`
	}
	if err = json.Unmarshal(out.Payments, &payments); err != nil {
		t.Fatal(err)
	}
	total := 0.0
	for _, payment := range payments {
		total += payment.Amount
	}
	if total != 30 {
		t.Fatalf("context payment leaked into module: %v", total)
	}
	detail, err := f.issues.GetCockpitSurfaceNode(ctx, p, f.a)
	if err != nil {
		t.Fatal(err)
	}
	if !detail.ScopeMatch || !detail.Binding.Eligible || detail.Binding.ModuleID == nil || *detail.Binding.ModuleID != util.UUIDToString(f.module) || len(detail.Ancestors) != 3 || detail.PaymentTotal != 10 {
		t.Fatalf("node scope/binding: %+v", detail)
	}
	otherModule := parseTestUUID(t, f.Module(t, util.UUIDToString(f.project), "Other module"))
	p.ModuleID = otherModule
	outside, err := f.issues.GetCockpitSurfaceNode(ctx, p, f.a)
	if err != nil || outside.ScopeMatch || !outside.Binding.Eligible {
		t.Fatalf("outside object must retain true identity: %+v/%v", outside, err)
	}
	p.ProjectID = pgtype.UUID{}
	if _, err = f.issues.GetCockpitPlanSurface(ctx, p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("module without project: %v", err)
	}
	p = surfaceQuery(f)
	p.ProjectID = dbid.NewV7()
	if _, err = f.issues.GetCockpitSurfaceContext(ctx, p); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("missing scope rendered as empty: %v", err)
	}
}

func TestCockpitSurfaceMeetingPaginationSearchAndCompleteCalendar(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	header, err := f.issues.GetCockpitSurfaceContext(ctx, surfaceQuery(f))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 32; i++ {
		meeting := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.ws, "cockpit_id": header.Cockpit.ID, "title": fmt.Sprintf("Title %02d", i), "meet_date": "2026-10-10", "kind": "register regression", "parties": "集团（研发、临床）、合作方", "note": "bodyword " + strings.Repeat("长正文", 2000), "minutes": "not a decision", "actions": "Act", "track": ""})
		f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": meeting, "node_id": f.a}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, meeting, f.a)
	}
	p := CockpitMeetingRegisterQuery{CockpitSurfaceQuery: surfaceQuery(f), Query: "bodyword title", Kinds: []string{"register regression"}, Parties: []string{"集团（研发、临床）"}, Tracks: []string{""}, Only: []string{"consensus", "links"}, DateFrom: "2026-10-01", DateTo: "2026-10-31", PageSize: 10, NodeID: f.moduleNode}
	page, err := f.issues.ListCockpitMeetingRegister(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 32 || len(page.Items) != 10 || page.NextCursor == nil || len(page.DayCounts) != 1 || page.DayCounts[0].Total != 32 {
		t.Fatalf("calendar must count all filtered meetings: %+v", page)
	}
	seen := map[string]bool{}
	for {
		for _, item := range page.Items {
			var raw map[string]json.RawMessage
			if err = json.Unmarshal(item, &raw); err != nil {
				t.Fatal(err)
			}
			for _, field := range []string{"note", "minutes", "decisions", "actions"} {
				if _, exists := raw[field]; exists {
					t.Fatalf("list carries full body field %s", field)
				}
			}
			var id string
			if err = json.Unmarshal(raw["id"], &id); err != nil {
				t.Fatal(err)
			}
			if seen[id] {
				t.Fatal("duplicated meeting across pages")
			}
			seen[id] = true
		}
		if page.NextCursor == nil {
			break
		}
		p.Cursor = *page.NextCursor
		page, err = f.issues.ListCockpitMeetingRegister(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != 32 {
		t.Fatalf("lost meetings: %d", len(seen))
	}
	p.Parties = []string{"研发"}
	if _, err = f.issues.ListCockpitMeetingRegister(ctx, p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("changed filter reused cursor: %v", err)
	}
	p.Cursor = ""
	empty, err := f.issues.ListCockpitMeetingRegister(ctx, p)
	if err != nil || empty.Total != 0 {
		t.Fatalf("split inside brackets: %+v/%v", empty, err)
	}
	p.Parties = nil
	p.DateTo = ""
	page, err = f.issues.ListCockpitMeetingRegister(ctx, p)
	if err != nil || page.Total != 32 || len(page.DayCounts) != 0 {
		t.Fatalf("open date bound must filter without incomplete calendar: %+v/%v", page, err)
	}
}

func TestCockpitSurfaceObjectPagesKeepUnloadedRelations(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	p := surfaceQuery(f)
	p.ProjectID = pgtype.UUID{}
	p.ModuleID = pgtype.UUID{}
	for i := 0; i < 32; i++ {
		f.Insert(t, "cockpit_payment", testutil.Cols{"workspace_id": f.ws, "node_id": f.a, "amount": i + 1, "label": fmt.Sprintf("Installment %02d", i), "position": float64(i % 3)})
	}
	detail, err := f.issues.GetCockpitSurfaceNode(ctx, p, f.a)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Payments.Items) != 25 || detail.Payments.Total != 32 || detail.Payments.NextCursor == nil || detail.PaymentTotal != 528 {
		t.Fatalf("first page lost true totals: %+v", detail.Payments)
	}
	tail, err := f.issues.ListCockpitSurfaceObjectPage(ctx, p, f.a, "payments", *detail.Payments.NextCursor, 25)
	if err != nil || len(tail.Items) != 7 || tail.NextCursor != nil || tail.PaymentTotal != 528 {
		t.Fatalf("payment continuation: %+v/%v", tail, err)
	}
	if _, err = f.issues.ListCockpitSurfaceObjectPage(ctx, p, f.b, "payments", *detail.Payments.NextCursor, 25); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cursor crossed objects: %v", err)
	}
	if _, err = f.issues.GetCockpitSurfaceNode(ctx, p, dbid.NewV7()); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("unknown detail: %v", err)
	}
}

func TestCockpitSurfaceEmptyReadsDoNotCreateBoard(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	service := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	p := CockpitSurfaceQuery{WorkspaceID: parseTestUUID(t, f.WorkspaceID), ActorID: parseTestUUID(t, owner), Human: true}
	out, err := service.GetCockpitSurfaceContext(context.Background(), p)
	if err != nil || out.Cockpit != nil {
		t.Fatalf("empty header: %+v/%v", out, err)
	}
	plan, err := service.GetCockpitPlanSurface(context.Background(), p)
	if err != nil || plan.Cockpit != nil || !plan.Complete || plan.Counts.Nodes != 0 {
		t.Fatalf("empty plan: %+v/%v", plan, err)
	}
	var count int
	if err = f.Pool.QueryRow(context.Background(), "SELECT count(*) FROM cockpit WHERE workspace_id=$1", p.WorkspaceID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("read initialized board: %d/%v", count, err)
	}
}

func TestCockpitSurfaceMarkersDeduplicateDescendantsAndBoundWindows(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	p := surfaceQuery(f)
	header, err := f.issues.GetCockpitSurfaceContext(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		meeting := f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.ws, "cockpit_id": header.Cockpit.ID, "title": fmt.Sprintf("Review %02d", i), "meet_date": "2026-10-10", "start_time": "10:00"})
		for _, node := range []pgtype.UUID{f.a, f.b} {
			f.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{"workspace_id": f.ws, "meeting_id": meeting, "node_id": node}, "workspace_id=$1 AND meeting_id=$2 AND node_id=$3", f.ws, meeting, node)
		}
	}
	query := CockpitPlanMarkerQuery{CockpitSurfaceQuery: p, Rows: []CockpitPlanMarkerRow{{RowKey: util.UUIDToString(f.grouping), NodeIDs: []string{util.UUIDToString(f.grouping)}}, {RowKey: util.UUIDToString(f.a), NodeIDs: []string{util.UUIDToString(f.a)}}}, DateFrom: "2026-10-01", DateTo: "2026-10-31"}
	query.Rows = append(query.Rows, CockpitPlanMarkerRow{RowKey: "merged-directions", NodeIDs: []string{util.UUIDToString(f.a), util.UUIDToString(f.b)}})
	out, err := f.issues.GetCockpitPlanMeetingMarkers(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if out.TotalGroups != 3 || len(out.Groups) != 3 || out.NextCursor != nil {
		t.Fatalf("bounded marker groups: %+v", out)
	}
	for _, group := range out.Groups {
		if group.Total != 8 || len(group.Items) != 5 {
			t.Fatalf("duplicate descendant links or unbounded preview: %+v", group)
		}
	}
	query.DateTo = "2027-10-10"
	if _, err = f.issues.GetCockpitPlanMeetingMarkers(ctx, query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("unbounded marker window: %v", err)
	}
	query.DateTo = "2026-10-31"
	query.Rows = []CockpitPlanMarkerRow{{RowKey: "missing", NodeIDs: []string{util.UUIDToString(dbid.NewV7())}}}
	if _, err = f.issues.GetCockpitPlanMeetingMarkers(ctx, query); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("missing marker node silently appeared empty: %v", err)
	}
}

func TestCockpitSurfaceNextCodeUsesAllCodesWithoutReserving(t *testing.T) {
	f := newPlanningFixture(t)
	ctx := context.Background()
	p := surfaceQuery(f)
	header, err := f.issues.GetCockpitSurfaceContext(ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"20261010-02", "20261010-29", "20261010-3", "20261010-30custom", "20261011-99"} {
		f.Insert(t, "cockpit_meeting", testutil.Cols{"workspace_id": f.ws, "cockpit_id": header.Cockpit.ID, "title": "Numbered meeting", "code": code})
	}
	for range 2 {
		out, err := f.issues.GetCockpitMeetingNextCode(ctx, p, "2026-10-10")
		if err != nil || out.Code != "20261010-30" {
			t.Fatalf("preview moved or loaded only dated rows: %+v/%v", out, err)
		}
	}
}

func TestCockpitSurfaceOverviewModuleKeepsItsOwnIssueFacts(t *testing.T) {
	f := newPlanningFixture(t)
	// Register last on every exit, before the new nodes and issues are removed.
	defer f.Cleanup(t, "DELETE FROM cockpit_issue_primary WHERE workspace_id=$1", f.ws)
	ctx := context.Background()
	otherModule := parseTestUUID(t, f.Module(t, util.UUIDToString(f.project), "Separate module"))
	moduleNode, err := f.q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: f.ws, ID: f.moduleNode})
	if err != nil {
		t.Fatal(err)
	}
	otherParent := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": moduleNode.CockpitID, "parent_id": moduleNode.ParentID, "project_id": f.project, "module_id": otherModule, "code": "M-other", "name": "Separate module"}))
	otherLeaf := parseTestUUID(t, f.Insert(t, "cockpit_node", testutil.Cols{"workspace_id": f.ws, "cockpit_id": moduleNode.CockpitID, "parent_id": otherParent, "code": "L3-other", "name": "Separate work"}))
	for _, item := range []struct {
		module, node pgtype.UUID
		status       string
	}{{f.module, f.a, "done"}, {otherModule, otherLeaf, "todo"}} {
		id := parseTestUUID(t, f.Issue(t, "Scope task", testutil.Cols{"project_id": f.project, "module_id": item.module, "status": item.status}))
		if _, err = f.issues.SetCockpitIssuePrimaryNode(ctx, CockpitPrimaryNodeCommand{WorkspaceID: f.ws, IssueID: id, NodeID: item.node, ActorID: f.owner}); err != nil {
			t.Fatal(err)
		}
	}
	query := overviewQuery(f.cockpitWorkflowFixture)
	query.ProjectID = f.project
	query.ModuleID = f.module
	out, err := f.issues.GetCockpitOverview(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if out.ModuleID == nil || *out.ModuleID != util.UUIDToString(f.module) || out.Summary.PrimaryIssues.Total != 1 || out.Summary.PrimaryIssues.Done != 1 || out.ExecutionNodes.Total != 2 {
		t.Fatalf("module overview mixed unrelated facts: %+v", out)
	}
	query.ModuleID = otherModule
	out, err = f.issues.GetCockpitOverview(ctx, query)
	if err != nil {
		t.Fatal(err)
	}
	if out.Summary.PrimaryIssues.Total != 1 || out.Summary.PrimaryIssues.Done != 0 || out.ExecutionNodes.Total != 1 {
		t.Fatalf("second module mixed facts: %+v", out)
	}
}
