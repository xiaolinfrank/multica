package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
)

func TestCockpitScopeSelectorsResolveUUIDLeavesAndBoundPages(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	ws := parseTestUUID(t, f.WorkspaceID)
	board := f.Insert(t, "cockpit", testutil.Cols{"workspace_id": f.WorkspaceID})
	project := f.Project(t, "Scope project")
	module := f.Module(t, project, "Scope module")
	node := func(title, parent string, extra testutil.Cols) string {
		cols := testutil.Cols{"workspace_id": f.WorkspaceID, "cockpit_id": board, "name": title, "code": title}
		if parent != "" {
			cols["parent_id"] = parent
		}
		for key, value := range extra {
			cols[key] = value
		}
		return f.Insert(t, "cockpit_node", cols)
	}
	// A mapped module can be the root of a nonstandard plan. Depth and names cannot determine eligibility.
	root := node("Root module", "", testutil.Cols{"project_id": project, "module_id": module})
	for index := 0; index < 25; index++ {
		node(fmt.Sprintf("Delivery %02d", index), root, nil)
	}
	group := node("Display grouping", root, nil)
	deep := node("Deep delivery", group, nil)
	unbound := node("01.01.01 Pretend mapping", "", nil)
	otherProject := f.Project(t, "Other project")
	wrongModule := f.Module(t, otherProject, "Other module")
	badRoot := node("Broken module binding", "", testutil.Cols{"project_id": project, "module_id": wrongModule})
	badLeaf := node("Broken leaf", badRoot, nil)
	query := CockpitNodeSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: ws, ActorID: parseTestUUID(t, owner), ProjectID: parseTestUUID(t, project), ModuleID: parseTestUUID(t, module), Human: true}, EligibleOnly: true, PageSize: 20}
	first, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 20 || first.Total != 26 || first.FilteredTotal != 26 || first.NextCursor == nil {
		t.Fatalf("bad bounded page: %+v", first)
	}
	seen := make(map[string]bool)
	for _, item := range first.Items {
		if !item.Eligible || item.ProjectID == nil || *item.ProjectID != project || item.ModuleID == nil || *item.ModuleID != module || item.Reason != "" {
			t.Fatalf("invalid execution choice: %+v", item)
		}
		seen[item.ID] = true
	}
	query.Cursor = *first.NextCursor
	second, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil || len(second.Items) != 6 || second.NextCursor != nil {
		t.Fatalf("bad continuation: %+v %v", second, err)
	}
	for _, item := range second.Items {
		if seen[item.ID] {
			t.Fatal("cursor repeated a node")
		}
		seen[item.ID] = true
	}
	if !seen[deep] || seen[unbound] || seen[badLeaf] || seen[root] || seen[group] {
		t.Fatalf("binding/depth semantics incorrect: %v", seen)
	}
	query.Query = "Deep"
	if _, err := svc.ListCockpitScopeNodes(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("search accepted another filter's cursor: %v", err)
	}
	query.Cursor = ""
	filtered, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil || filtered.Total != 26 || filtered.FilteredTotal != 1 || len(filtered.Items) != 1 || filtered.Items[0].ID != deep {
		t.Fatalf("search did not preserve full-scope counts: %+v %v", filtered, err)
	}

	query.Query = deep
	byID, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil || len(byID.Items) != 1 || byID.Items[0].ID != deep || !byID.Items[0].Eligible {
		t.Fatalf("exact identity search did not preserve eligibility: %+v %v", byID, err)
	}
	query.Query = badLeaf
	outsideScope, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil || len(outsideScope.Items) != 0 {
		t.Fatalf("exact identity bypassed scope/eligibility: %+v %v", outsideScope, err)
	}
	query.ProjectID, query.ModuleID, query.EligibleOnly, query.Query = pgtype.UUID{}, pgtype.UUID{}, false, "Broken leaf"
	invalid, err := svc.ListCockpitScopeNodes(context.Background(), query)
	if err != nil || len(invalid.Items) != 1 || invalid.Items[0].Eligible || invalid.Items[0].Reason != "binding_conflict" {
		t.Fatalf("broken stored binding was guessed valid: %+v %v", invalid, err)
	}
}

func TestCockpitScopeSelectorsMembersPageAndSelectedIdentity(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	ws := parseTestUUID(t, f.WorkspaceID)
	selected := ""
	for index := 0; index < 26; index++ {
		selected = f.member(t, fmt.Sprintf("reviewer-%02d", index))
	}
	outsider := f.User(t, "Outside workspace", fmt.Sprintf("outside-scope-%d@multica.test", principalSeq.Add(1)))
	query := CockpitMemberSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: ws, ActorID: parseTestUUID(t, owner), Human: true}, PageSize: 20}
	first, err := svc.ListCockpitScopeMembers(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 27 || first.FilteredTotal != 27 || len(first.Items) != 20 || first.NextCursor == nil {
		t.Fatalf("bad member page: %+v", first)
	}
	query.Cursor = *first.NextCursor
	second, err := svc.ListCockpitScopeMembers(context.Background(), query)
	if err != nil || len(second.Items) != 7 || second.NextCursor != nil {
		t.Fatalf("bad member continuation: %+v %v", second, err)
	}
	query.Cursor, query.UserIDs = "", []pgtype.UUID{parseTestUUID(t, selected), parseTestUUID(t, outsider)}
	lookup, err := svc.ListCockpitScopeMembers(context.Background(), query)
	if err != nil || len(lookup.Items) != 1 || lookup.Items[0].ID != selected || lookup.Total != 1 || lookup.NextCursor != nil {
		t.Fatalf("selected lookup leaked outsider or depended on first page: %+v %v", lookup, err)
	}
	query.Query = "reviewer"
	if _, err := svc.ListCockpitScopeMembers(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("ids was mixed with search: %v", err)
	}
	query.UserIDs = nil
	searched, err := svc.ListCockpitScopeMembers(context.Background(), query)
	if err != nil || searched.Total != 27 || searched.FilteredTotal != 26 {
		t.Fatalf("member count/filter mismatch: %+v %v", searched, err)
	}
	if lookup.Items[0].Email == "" {
		t.Fatal("selected member omitted its existing workspace-visible email")
	}
	query.Query = lookup.Items[0].Email
	byEmail, err := svc.ListCockpitScopeMembers(context.Background(), query)
	if err != nil || byEmail.FilteredTotal != 1 || len(byEmail.Items) != 1 || byEmail.Items[0].ID != selected {
		t.Fatalf("member email did not disambiguate the selected account: %+v/%v", byEmail, err)
	}
	if _, err := f.q.GetCockpitByWorkspace(context.Background(), ws); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("member read initialized a cockpit: %v", err)
	}
}

func TestCockpitScopeSelectorsRejectCrossWorkspaceAndInvalidScope(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	query := CockpitNodeSelectorQuery{CockpitSurfaceQuery: CockpitSurfaceQuery{WorkspaceID: parseTestUUID(t, f.WorkspaceID), ActorID: parseTestUUID(t, owner)}, EligibleOnly: true}
	query.ModuleID = parseTestUUID(t, f.Module(t, f.Project(t, "Project"), "Module"))
	if _, err := svc.ListCockpitScopeNodes(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("module without project accepted: %v", err)
	}
	query.ModuleID = pgtype.UUID{}
	other := f.Workspace(t, "Other workspace", fmt.Sprintf("scope-other-%d", principalSeq.Add(1)))
	query.WorkspaceID = parseTestUUID(t, other)
	if _, err := svc.ListCockpitScopeNodes(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("non-member scope read returned data: %v", err)
	}
	query.WorkspaceID = parseTestUUID(t, f.WorkspaceID)
	query.PageSize = 101
	if _, err := svc.ListCockpitScopeNodes(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("unbounded page accepted: %v", err)
	}
	if util.UUIDToString(query.WorkspaceID) != f.WorkspaceID {
		t.Fatal("fixture scope drifted")
	}
}
