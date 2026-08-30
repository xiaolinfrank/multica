package handler

import (
	"fmt"
	"net/http"
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
	Nodes []IssueGraphNodeResponse `json:"nodes"`
	Edges []IssueGraphEdgeResponse `json:"edges"`
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

	// Numbers: parent=TES-1, child=TES-2, referenced=TES-3, mentioning=TES-4.
	parent := dbfx.Issue(t, "Parent", testutil.Cols{"workspace_id": wsID, "project_id": projectID})
	child := dbfx.Issue(t, "Child", testutil.Cols{
		"workspace_id":    wsID,
		"project_id":      projectID,
		"parent_issue_id": parent,
	})
	referenced := dbfx.Issue(t, "Referenced", testutil.Cols{
		"workspace_id": wsID,
		"status":       "in_review",
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
