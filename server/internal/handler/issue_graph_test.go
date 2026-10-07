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
	Nodes      []IssueGraphNodeResponse      `json:"nodes"`
	Edges      []IssueGraphEdgeResponse      `json:"edges"`
	Meetings   []IssueGraphMeetingResponse   `json:"meetings"`
	Executions []IssueGraphExecutionResponse `json:"executions"`
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
	wsID := graphFixture(t, "Graph meetings and runs")
	issue := dbfx.Issue(t, "Linked issue", testutil.Cols{"workspace_id": wsID})
	other := dbfx.Issue(t, "No links", testutil.Cols{"workspace_id": wsID})
	agentID := dbfx.Agent(t, "graph-runner", "", testutil.Cols{"workspace_id": wsID})

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

	// Three runs on the linked issue: two completed ones (both graphed — the
	// terminal window keeps the newest five per issue) and one still running
	// (always graphed). The queue's check constraint wants completed_at on
	// finished rows and a runtime on active ones.
	runtimeID := dbfx.Runtime(t, "graph-runtime", testutil.Cols{"workspace_id": wsID})
	olderDone := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issue, "status": "completed", "created_at": testutil.Raw("now() - interval '3 days'"),
		"completed_at": testutil.Raw("now() - interval '3 days'"),
	})
	latestDone := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issue, "status": "completed", "created_at": testutil.Raw("now() - interval '1 day'"),
		"completed_at": testutil.Raw("now() - interval '1 day'"),
	})
	running := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issue, "status": "running", "created_at": testutil.Raw("now()"),
		"runtime_id": runtimeID,
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

	if len(g.Executions) != 3 {
		t.Fatalf("executions = %d, want both completed (window keeps newest 5) + running: %+v", len(g.Executions), g.Executions)
	}
	runIDs := map[string]IssueGraphExecutionResponse{}
	for _, r := range g.Executions {
		runIDs[r.ID] = r
	}
	if _, ok := runIDs[latestDone]; !ok {
		t.Errorf("latest completed run missing")
	}
	if _, ok := runIDs[olderDone]; !ok {
		t.Errorf("older completed run missing from the widened window")
	}
	r, ok := runIDs[running]
	if !ok || r.AgentName != "graph-runner" || r.Status != "running" {
		t.Errorf("running run = %+v, present=%v", r, ok)
	}

	edges := edgeKeys(g)
	for _, key := range []string{
		fmt.Sprintf("mtg:%s>%s:meeting", meeting, issue),
		fmt.Sprintf("%s>run:%s:execution", issue, latestDone),
		fmt.Sprintf("%s>run:%s:execution", issue, olderDone),
		fmt.Sprintf("%s>run:%s:execution", issue, running),
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

// The terminal-run window caps at the five newest finished runs per issue;
// active runs never count against it.
func TestGetIssueGraphRunWindowKeepsNewestFive(t *testing.T) {
	wsID := graphFixture(t, "Graph run window")
	issue := dbfx.Issue(t, "Busy issue", testutil.Cols{"workspace_id": wsID})
	agentID := dbfx.Agent(t, "graph-runner", "", testutil.Cols{"workspace_id": wsID})
	runtimeID := dbfx.Runtime(t, "graph-runtime", testutil.Cols{"workspace_id": wsID})

	ids := make([]string, 0, 6)
	for days := 6; days >= 1; days-- {
		interval := fmt.Sprintf("now() - interval '%d days'", days)
		ids = append(ids, dbfx.Task(t, agentID, testutil.Cols{
			"issue_id": issue, "status": "completed",
			"created_at": testutil.Raw(interval), "completed_at": testutil.Raw(interval),
		}))
	}
	running := dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": issue, "status": "running", "created_at": testutil.Raw("now()"),
		"runtime_id": runtimeID,
	})

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph", wsID)).
		Want(http.StatusOK).
		JSON(&g)

	if len(g.Executions) != 6 {
		t.Fatalf("executions = %d, want newest 5 terminal + 1 running: %+v", len(g.Executions), g.Executions)
	}
	got := map[string]bool{}
	for _, r := range g.Executions {
		got[r.ID] = true
	}
	if got[ids[0]] {
		t.Errorf("oldest terminal run %s should fall outside the window", ids[0])
	}
	for _, id := range append(ids[1:], running) {
		if !got[id] {
			t.Errorf("run %s missing from the graph", id)
		}
	}
}

// Project scope: meetings survive only through a linked issue inside the
// project; executions follow their issue out of the set.
func TestGetIssueGraphProjectScopeFiltersMeetingsAndRuns(t *testing.T) {
	wsID := graphFixture(t, "Graph project scope meetings")
	p1 := dbfx.Project(t, "One", testutil.Cols{"workspace_id": wsID})
	p2 := dbfx.Project(t, "Two", testutil.Cols{"workspace_id": wsID})
	in := dbfx.Issue(t, "In P1", testutil.Cols{"workspace_id": wsID, "project_id": p1})
	out := dbfx.Issue(t, "In P2", testutil.Cols{"workspace_id": wsID, "project_id": p2})
	agentID := dbfx.Agent(t, "graph-runner", "", testutil.Cols{"workspace_id": wsID})

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
	dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": in, "status": "completed", "completed_at": testutil.Raw("now()"),
	})
	dbfx.Task(t, agentID, testutil.Cols{
		"issue_id": out, "status": "completed", "completed_at": testutil.Raw("now()"),
	})

	var g graphPayload
	testutil.Call(t, graphWorkspaceHandler(testHandler.GetIssueGraph),
		graphRequest(http.MethodGet, "/api/issues/graph?project_id="+p1, wsID)).
		Want(http.StatusOK).
		JSON(&g)

	if len(g.Meetings) != 1 || g.Meetings[0].ID != mIn {
		t.Fatalf("scoped meetings = %+v, want only the P1 meeting", g.Meetings)
	}
	if len(g.Executions) != 1 || g.Executions[0].IssueID != in {
		t.Fatalf("scoped executions = %+v, want only the P1 issue's run", g.Executions)
	}
	for _, e := range g.Edges {
		if e.Kind == "meeting" && e.Source != "mtg:"+mIn {
			t.Errorf("unexpected meeting edge %+v", e)
		}
	}
}
