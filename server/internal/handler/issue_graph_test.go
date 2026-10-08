package handler

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func graphRequest(method, path, workspaceID string) *http.Request {
	return testutil.WithHeaders(
		testutil.JSONRequest(method, path, nil),
		"X-User-ID", testUserID,
		"X-Workspace-ID", workspaceID,
	)
}

func graphWorkspaceHandler(handler http.HandlerFunc) http.HandlerFunc {
	return middleware.RequireWorkspaceMember(testHandler.Queries)(handler).ServeHTTP
}

// graphFixture builds a private workspace with issue_prefix TES. Issues get
// numbers in insertion order starting at 1 (the workspace is fresh), which the
// bare-identifier assertions below rely on.
func graphFixture(t *testing.T, name string) string {
	t.Helper()
	wsID := dbfx.Workspace(t, name, "graph-"+uuid.NewString(), testutil.Cols{
		"issue_prefix": "TES",
	})
	dbfx.Member(t, wsID, testUserID, "owner")
	return wsID
}

type graphPayload struct {
	Nodes        []IssueGraphNodeResponse         `json:"nodes"`
	Edges        []IssueGraphEdgeResponse         `json:"edges"`
	Meetings     []IssueGraphMeetingResponse      `json:"meetings"`
	Executions   []IssueGraphExecutionResponse    `json:"executions"`
	CockpitNodes []IssueGraphCockpitIndexResponse `json:"cockpit_nodes"`
}

func edgeKeys(g graphPayload) map[string]bool {
	keys := make(map[string]bool, len(g.Edges))
	for _, e := range g.Edges {
		keys[fmt.Sprintf("%s>%s:%s", e.Source, e.Target, e.Kind)] = true
	}
	return keys
}

func nodeIDs(g graphPayload) map[string]IssueGraphNodeResponse {
	nodes := make(map[string]IssueGraphNodeResponse, len(g.Nodes))
	for _, n := range g.Nodes {
		nodes[n.ID] = n
	}
	return nodes
}

func TestGetIssueGraphAssemblesNodesAndEdges(t *testing.T) {
	wsID := graphFixture(t, "Graph assembly")
	projectID := dbfx.Project(t, "Graph project", testutil.Cols{"workspace_id": wsID})

	// Assignees for the name-resolution assertions: an agent (own name) and a
	// member (name resolved through the user profile). The agent must live in
	// THIS workspace — the graph resolves names from workspace-scoped lists.
	assignedAgent := dbfx.Agent(t, "graph-assigned-agent", "", testutil.Cols{
		"workspace_id": wsID,
	})
	assigneeUser := dbfx.User(t, "Graph Assignee", "graph-assignee@example.com")
	assigneeMember := dbfx.Member(t, wsID, assigneeUser, "member")

	// Numbers: parent=TES-1, child=TES-2, referenced=TES-3, mentioning=TES-4.
	parent := dbfx.Issue(t, "Parent", testutil.Cols{
		"workspace_id":  wsID,
		"project_id":    projectID,
		"assignee_type": "agent",
		"assignee_id":   assignedAgent,
	})
	child := dbfx.Issue(t, "Child", testutil.Cols{
		"workspace_id":    wsID,
		"project_id":      projectID,
		"parent_issue_id": parent,
	})
	referenced := dbfx.Issue(t, "Referenced", testutil.Cols{
		"workspace_id":  wsID,
		"status":        "in_review",
		"assignee_type": "member",
		"assignee_id":   assigneeMember,
	})
	mentioning := dbfx.Issue(t, "Mentioning", testutil.Cols{
		"workspace_id": wsID,
		// One canonical UUID mention (referenced) plus one bare identifier
		// (TES-1) in the same description.
		"description": fmt.Sprintf("Blocked by [TES-3](mention://issue/%s) and TES-1 too.", referenced),
	})
	dbfx.Comment(t, child, "duplicate of TES-4", testutil.Cols{"workspace_id": wsID})
	dbfx.Insert(t, "issue_dependency", testutil.Cols{
		"issue_id":            child,
		"depends_on_issue_id": referenced,
		"type":                "blocks",
	})

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph", wsID)).
		Want(http.StatusOK).
		JSON(&g)

	nodes := nodeIDs(g)
	if len(g.Nodes) != 4 {
		t.Fatalf("nodes = %d, want 4: %+v", len(g.Nodes), g.Nodes)
	}
	if n := nodes[parent]; n.Identifier != "TES-1" || n.Title != "Parent" {
		t.Errorf("parent node = %+v", n)
	}
	if n := nodes[referenced]; n.StatusCategory != "in_review" {
		t.Errorf("referenced status_category = %q, want in_review", n.StatusCategory)
	}
	if n := nodes[parent]; n.ProjectID == nil || *n.ProjectID != projectID {
		t.Errorf("parent project_id = %v, want %s", n.ProjectID, projectID)
	}
	if n := nodes[referenced]; n.ProjectID != nil {
		t.Errorf("referenced project_id = %v, want nil", n.ProjectID)
	}
	if n := nodes[parent]; n.AssigneeName != "graph-assigned-agent" {
		t.Errorf("parent assignee_name = %q, want graph-assigned-agent", n.AssigneeName)
	}
	if n := nodes[referenced]; n.AssigneeName != "Graph Assignee" {
		t.Errorf("referenced assignee_name = %q, want Graph Assignee", n.AssigneeName)
	}
	if n := nodes[child]; n.AssigneeName != "" {
		t.Errorf("child assignee_name = %q, want empty for unassigned", n.AssigneeName)
	}

	edges := edgeKeys(g)
	want := map[string]bool{
		fmt.Sprintf("%s>%s:child", parent, child):            true, // parent_issue_id
		fmt.Sprintf("%s>%s:mention", mentioning, referenced): true, // canonical UUID mention in description
		fmt.Sprintf("%s>%s:mention", mentioning, parent):     true, // bare TES-1 in description
		fmt.Sprintf("%s>%s:mention", child, mentioning):      true, // bare TES-4 in comment body
		fmt.Sprintf("%s>%s:blocks", child, referenced):       true, // issue_dependency row
	}
	if len(edges) != len(want) {
		t.Fatalf("edges = %d (%v), want %d", len(edges), edges, len(want))
	}
	for key := range want {
		if !edges[key] {
			t.Errorf("missing edge %s; got %v", key, edges)
		}
	}
}

func TestGetIssueGraphProjectScopeDropsCrossProjectEdges(t *testing.T) {
	wsID := graphFixture(t, "Graph project scope")
	p1 := dbfx.Project(t, "One", testutil.Cols{"workspace_id": wsID})
	p2 := dbfx.Project(t, "Two", testutil.Cols{"workspace_id": wsID})

	// Numbers: a1=TES-1, a2=TES-2, b1=TES-3.
	a1 := dbfx.Issue(t, "A1", testutil.Cols{"workspace_id": wsID, "project_id": p1})
	a2 := dbfx.Issue(t, "A2", testutil.Cols{
		"workspace_id": wsID,
		"project_id":   p1,
		// Foreign prefix, self-reference, and a cross-project bare reference.
		"description": "see FOS-1, TES-2 itself, and TES-3 over there.",
	})
	b1 := dbfx.Issue(t, "B1", testutil.Cols{
		"workspace_id": wsID,
		"project_id":   p2,
		"description":  "related to TES-1",
	})

	// Whole workspace: cross-project mention edges are kept, but the foreign
	// prefix and the self-reference never produce edges.
	var whole graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph", wsID)).
		Want(http.StatusOK).
		JSON(&whole)
	if len(whole.Nodes) != 3 {
		t.Fatalf("whole nodes = %d, want 3", len(whole.Nodes))
	}
	wholeEdges := edgeKeys(whole)
	for _, key := range []string{
		fmt.Sprintf("%s>%s:mention", a2, b1),
		fmt.Sprintf("%s>%s:mention", b1, a1),
	} {
		if !wholeEdges[key] {
			t.Errorf("whole graph missing edge %s; got %v", key, wholeEdges)
		}
	}

	// Project scope: only P1 issues and edges whose endpoints both stay.
	var scoped graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph?project_id="+p1, wsID)).
		Want(http.StatusOK).
		JSON(&scoped)
	if len(scoped.Nodes) != 2 {
		t.Fatalf("scoped nodes = %d, want 2: %+v", len(scoped.Nodes), scoped.Nodes)
	}
	if len(scoped.Edges) != 0 {
		t.Fatalf("scoped edges = %v, want none (both surviving edges touched TES-3)", scoped.Edges)
	}
}

func TestGetIssueGraphIsolatesWorkspaces(t *testing.T) {
	wsA := graphFixture(t, "Graph isolation A")
	wsB := graphFixture(t, "Graph isolation B")

	issueA := dbfx.Issue(t, "In A", testutil.Cols{"workspace_id": wsA})
	// wsB reuses prefix TES and number 1, so identifier alone cannot tell the
	// two apart — the graph of B must not link to A's issue through it.
	dbfx.Issue(t, "In B", testutil.Cols{
		"workspace_id": wsB,
		"description":  "see TES-1",
	})

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph", wsA)).
		Want(http.StatusOK).
		JSON(&g)
	if len(g.Nodes) != 1 {
		t.Fatalf("nodes = %d, want only ws A's issue: %+v", len(g.Nodes), g.Nodes)
	}
	if n := g.Nodes[0]; n.ID != issueA {
		t.Errorf("node id = %s, want %s", n.ID, issueA)
	}
}

func TestGetIssueGraphRejectsMalformedProjectID(t *testing.T) {
	wsID := graphFixture(t, "Graph malformed filter")

	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph?project_id=not-a-uuid", wsID)).
		Want(http.StatusBadRequest)
}

// Meetings and executions ride alongside the issue nodes: meetings come from
// the workspace's cockpit board, executions are the latest run per issue plus
// anything still active. Their edges use the mtg:/run: address prefixes.
func TestGetIssueGraphIncludesMeetingsAndExecutions(t *testing.T) {
	wsID := graphFixture(t, "Graph meetings and exec nodes")
	issue := dbfx.Issue(t, "Linked issue", testutil.Cols{"workspace_id": wsID})
	other := dbfx.Issue(t, "No links", testutil.Cols{"workspace_id": wsID})

	cockpitID := dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": wsID})
	meeting := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
		"workspace_id": wsID,
		"cockpit_id":   cockpitID,
		"code":         "20261001-01",
		"title":        "Kickoff",
		"status":       "已召开",
		"track":        "项目管理",
		"nas_dir":      "/Volumes/share/meetings/20261001-01",
	})
	// A second meeting with no issue links still appears as an isolate in the
	// workspace-scope graph.
	lonely := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
		"workspace_id": wsID,
		"cockpit_id":   cockpitID,
		"code":         "20261002-01",
		"title":        "Unlinked review",
	})
	dbfx.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{
		"workspace_id": wsID,
		"meeting_id":   meeting,
		"issue_id":     issue,
		"role":         "task",
	}, "meeting_id = '"+meeting+"' AND issue_id = '"+issue+"'")

	// The execution layer mirrors the cockpit gantt's L3 rows: depth comes
	// from the parent chain (root L1 -> L2 -> L3). The L1/L2 ancestors must
	// not appear, and neither must a deeper L4 row.
	l1 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "code": "L1-01", "name": "Line one",
	})
	l2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l1, "code": "01.01", "name": "Group one",
	})
	l3 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l2,
		"code": "L3-01-01", "name": "中心启动", "status": "进行中", "progress": 45,
		"start_date": "2026-09-01", "end_date": "2026-11-30", "owner": "何群",
	})
	dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l3, "code": "L4-01-01-01", "name": "Too deep",
	})
	dbfx.InsertNoID(t, "cockpit_node_issue", testutil.Cols{
		"workspace_id": wsID, "node_id": l3, "issue_id": issue,
	}, "node_id = '"+l3+"' AND issue_id = '"+issue+"'")
	dbfx.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{
		"workspace_id": wsID, "meeting_id": meeting, "node_id": l3,
	}, "meeting_id = '"+meeting+"' AND node_id = '"+l3+"'")
	// An L3 row with no links stays as an isolate (same rule as meetings).
	l3solo := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l2, "code": "L3-01-02", "name": "Solo row",
	})

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph", wsID)).
		Want(http.StatusOK).
		JSON(&g)

	if len(g.Meetings) != 2 {
		t.Fatalf("meetings = %d, want 2: %+v", len(g.Meetings), g.Meetings)
	}
	byID := map[string]IssueGraphMeetingResponse{}
	for _, m := range g.Meetings {
		byID[m.ID] = m
	}
	if m := byID[meeting]; m.Code != "20261001-01" || m.NasDir == "" || m.Track != "项目管理" {
		t.Errorf("meeting payload = %+v", m)
	}
	if _, ok := byID[lonely]; !ok {
		t.Errorf("unlinked meeting missing from workspace-scope graph")
	}

	// Executions: exactly the two L3 rows — never their L1/L2 ancestors nor
	// the deeper L4 row.
	if len(g.Executions) != 2 {
		t.Fatalf("executions = %d, want the 2 L3 rows: %+v", len(g.Executions), g.Executions)
	}
	byExecID := map[string]IssueGraphExecutionResponse{}
	for _, e := range g.Executions {
		byExecID[e.ID] = e
	}
	ex, ok := byExecID[l3]
	if !ok {
		t.Fatalf("L3 row missing from executions: %+v", g.Executions)
	}
	if ex.Code != "L3-01-01" || ex.Name != "中心启动" || ex.Status != "进行中" ||
		ex.Progress != 45 || ex.Owner != "何群" || ex.StartDate != "2026-09-01" || ex.EndDate != "2026-11-30" {
		t.Errorf("execution payload = %+v", ex)
	}
	if _, ok := byExecID[l3solo]; !ok {
		t.Errorf("unlinked L3 row missing from workspace-scope graph")
	}

	// The cockpit node index ships the whole tree (L1/L2/L3/L4 alike): the
	// client rebuilds it to derive the positional row codes the gantt shows.
	if len(g.CockpitNodes) != 5 {
		t.Fatalf("cockpit_nodes = %d, want the full 5-row tree: %+v", len(g.CockpitNodes), g.CockpitNodes)
	}
	byIndexID := map[string]IssueGraphCockpitIndexResponse{}
	for _, n := range g.CockpitNodes {
		byIndexID[n.ID] = n
	}
	if r := byIndexID[l3]; r.Code != "L3-01-01" || r.ParentID == nil || *r.ParentID != l2 {
		t.Errorf("index row for the L3 node = %+v", r)
	}
	if r := byIndexID[l1]; r.ParentID != nil {
		t.Errorf("root index row parent_id = %v, want nil", r.ParentID)
	}

	edges := edgeKeys(g)
	for _, key := range []string{
		fmt.Sprintf("mtg:%s>%s:meeting", meeting, issue),
		fmt.Sprintf("exc:%s>%s:execution", l3, issue),
		fmt.Sprintf("mtg:%s>exc:%s:meeting", meeting, l3),
	} {
		if !edges[key] {
			t.Errorf("missing edge %s; got %v", key, edges)
		}
	}
	// The unlinked issue carries no execution/meeting edges at all.
	for key := range edges {
		if strings.Contains(key, other) {
			t.Errorf("unexpected edge on link-less issue: %s", key)
		}
	}
}

// Project scope: meetings and L3 execution rows survive only through a linked
// issue inside the project, and meeting↔L3 edges with a scoped-out endpoint
// are dropped server-side.
func TestGetIssueGraphProjectScopeFiltersMeetingsAndExecNodes(t *testing.T) {
	wsID := graphFixture(t, "Graph project scope meetings")
	p1 := dbfx.Project(t, "One", testutil.Cols{"workspace_id": wsID})
	p2 := dbfx.Project(t, "Two", testutil.Cols{"workspace_id": wsID})
	in := dbfx.Issue(t, "In P1", testutil.Cols{"workspace_id": wsID, "project_id": p1})
	out := dbfx.Issue(t, "In P2", testutil.Cols{"workspace_id": wsID, "project_id": p2})

	cockpitID := dbfx.Insert(t, "cockpit", testutil.Cols{"workspace_id": wsID})
	mIn := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "code": "20261003-01", "title": "P1 meeting",
	})
	mOut := dbfx.Insert(t, "cockpit_meeting", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "code": "20261004-01", "title": "P2 meeting",
	})
	dbfx.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{
		"workspace_id": wsID, "meeting_id": mIn, "issue_id": in,
	}, "meeting_id = '"+mIn+"' AND issue_id = '"+in+"'")
	dbfx.InsertNoID(t, "cockpit_meeting_issue", testutil.Cols{
		"workspace_id": wsID, "meeting_id": mOut, "issue_id": out,
	}, "meeting_id = '"+mOut+"' AND issue_id = '"+out+"'")

	l1 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "code": "L1-01", "name": "Line one",
	})
	l2 := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l1, "code": "01.01", "name": "Group one",
	})
	l3In := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l2, "code": "L3-01-01", "name": "In row",
	})
	l3Out := dbfx.Insert(t, "cockpit_node", testutil.Cols{
		"workspace_id": wsID, "cockpit_id": cockpitID, "parent_id": l2, "code": "L3-01-02", "name": "Out row",
	})
	dbfx.InsertNoID(t, "cockpit_node_issue", testutil.Cols{
		"workspace_id": wsID, "node_id": l3In, "issue_id": in,
	}, "node_id = '"+l3In+"' AND issue_id = '"+in+"'")
	dbfx.InsertNoID(t, "cockpit_node_issue", testutil.Cols{
		"workspace_id": wsID, "node_id": l3Out, "issue_id": out,
	}, "node_id = '"+l3Out+"' AND issue_id = '"+out+"'")
	dbfx.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{
		"workspace_id": wsID, "meeting_id": mIn, "node_id": l3In,
	}, "meeting_id = '"+mIn+"' AND node_id = '"+l3In+"'")
	dbfx.InsertNoID(t, "cockpit_meeting_node", testutil.Cols{
		"workspace_id": wsID, "meeting_id": mOut, "node_id": l3Out,
	}, "meeting_id = '"+mOut+"' AND node_id = '"+l3Out+"'")

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph?project_id="+p1, wsID)).
		Want(http.StatusOK).
		JSON(&g)

	if len(g.Meetings) != 1 || g.Meetings[0].ID != mIn {
		t.Fatalf("scoped meetings = %+v, want only the P1 meeting", g.Meetings)
	}
	if len(g.Executions) != 1 || g.Executions[0].ID != l3In {
		t.Fatalf("scoped executions = %+v, want only the P1-linked L3 row", g.Executions)
	}
	edges := edgeKeys(g)
	if !edges[fmt.Sprintf("mtg:%s>exc:%s:meeting", mIn, l3In)] {
		t.Errorf("missing meeting->exec edge for the in-scope pair; got %v", edges)
	}
	for key := range edges {
		if strings.Contains(key, mOut) || strings.Contains(key, l3Out) {
			t.Errorf("scoped response leaks an out-of-project edge: %s", key)
		}
	}
}
