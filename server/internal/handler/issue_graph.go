package handler

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuegraph"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// GET /api/issues/graph — one whole-workspace (or single-project) snapshot of
// the issue graph for the Obsidian-style graph view. Nodes are issues, edges
// are the three issue-to-issue relations the product tracks:
//
//   - child (parent_issue_id): source is the parent, target the child
//   - blocks / blocked_by / related (issue_dependency rows, passed through
//     with source=issue_id, target=depends_on_issue_id)
//   - mention: source's stored prose (description or comment bodies)
//     references target, extracted at read time — there is no persisted
//     reference index, so the graph always matches the text
//
// Edges whose endpoints are not both in the returned node set are dropped
// (project scoping, the issue window, and deleted targets all funnel through
// that one rule).
type IssueGraphNodeResponse struct {
	ID             string  `json:"id"`
	Identifier     string  `json:"identifier"`
	Number         int32   `json:"number"`
	Title          string  `json:"title"`
	Status         string  `json:"status"`
	StatusCategory string  `json:"status_category"`
	Priority       string  `json:"priority"`
	ProjectID      *string `json:"project_id"`
	UpdatedAt      string  `json:"updated_at"`
}

type IssueGraphEdgeResponse struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
}

func (h *Handler) GetIssueGraph(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}

	var projectFilter pgtype.UUID
	if p := r.URL.Query().Get("project_id"); p != "" {
		id, ok := parseUUIDOrBadRequest(w, p, "project_id")
		if !ok {
			return
		}
		projectFilter = id
	}

	nodes, err := h.Queries.ListIssueGraphNodes(ctx, db.ListIssueGraphNodesParams{
		WorkspaceID: wsUUID,
		ProjectID:   projectFilter,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}


	prefix := h.getIssuePrefix(ctx, wsUUID)

	nodeByID := make(map[pgtype.UUID]int, len(nodes))
	respNodes := make([]IssueGraphNodeResponse, len(nodes))
	categoryResolver := issuestatus.NewResolver(wsUUID)
	for i, n := range nodes {
		nodeByID[n.ID] = i
		respNodes[i] = IssueGraphNodeResponse{
			ID:             uuidToString(n.ID),
			Identifier:     prefix + "-" + strconv.Itoa(int(n.Number)),
			Number:         n.Number,
			Title:          n.Title,
			Status:         n.Status,
			StatusCategory: categoryResolver.Effective(ctx, h.Queries, n.Status),
			Priority:       n.Priority,
			ProjectID:      uuidToPtr(n.ProjectID),
			UpdatedAt:      timestampToString(n.UpdatedAt),
		}
	}

	edgeSet := make(map[IssueGraphEdgeResponse]struct{})
	addEdge := func(source, target pgtype.UUID, kind string) {
		// Both endpoints must be in the node set; self-references are noise.
		if _, ok := nodeByID[source]; !ok {
			return
		}
		if _, ok := nodeByID[target]; !ok {
			return
		}
		if source == target {
			return
		}
		edgeSet[IssueGraphEdgeResponse{
			Source: uuidToString(source),
			Target: uuidToString(target),
			Kind:   kind,
		}] = struct{}{}
	}

	// Parent-child edges: parent_issue_id points up, the edge points down.
	for _, n := range nodes {
		if n.ParentIssueID.Valid {
			addEdge(n.ParentIssueID, n.ID, "child")
		}
	}

	deps, err := h.Queries.ListIssueGraphDependencies(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	for _, d := range deps {
		addEdge(d.IssueID, d.DependsOnIssueID, d.Type)
	}

	// Mention edges: extract references from every issue description and
	// every comment body, then resolve them against this workspace only.
	type mentionRef struct {
		source    pgtype.UUID
		rawTarget string
	}
	refs := make([]mentionRef, 0)
	for _, n := range nodes {
		if n.Description.Valid && n.Description.String != "" {
			for _, id := range issuegraph.ExtractIssueReferences(n.Description.String) {
				refs = append(refs, mentionRef{source: n.ID, rawTarget: id})
			}
		}
	}
	comments, err := h.Queries.ListIssueGraphCommentBodies(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	commentRefs := make([]mentionRef, 0)
	for _, c := range comments {
		for _, id := range issuegraph.ExtractIssueReferences(c.Content) {
			commentRefs = append(commentRefs, mentionRef{source: c.IssueID, rawTarget: id})
		}
	}
	refs = append(refs, commentRefs...)

	// Batch-resolve identifier-form references (PREFIX-N) to UUIDs with one
	// query; UUID-form references resolve directly against the node set.
	numbers := make(map[int32]struct{})
	for _, ref := range refs {
		if issuegraph.IsUUIDShape(ref.rawTarget) {
			continue
		}
		if !issuegraph.MatchesWorkspacePrefix(ref.rawTarget, prefix) {
			continue
		}
		if n, ok := issuegraph.ParseIdentifierNumber(ref.rawTarget); ok {
			numbers[n] = struct{}{}
		}
	}
	numberToID := make(map[int32]pgtype.UUID, len(numbers))
	if len(numbers) > 0 {
		list := make([]int32, 0, len(numbers))
		for n := range numbers {
			list = append(list, n)
		}
		sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
		rows, numErr := h.Queries.ListIssueIDsByNumbers(ctx, db.ListIssueIDsByNumbersParams{
			WorkspaceID: wsUUID,
			Column2:     list,
		})
		if numErr != nil {
			writeError(w, http.StatusInternalServerError, "failed to load issue graph")
			return
		}
		for _, row := range rows {
			numberToID[row.Number] = row.ID
		}
	}
	for _, ref := range refs {
		var target pgtype.UUID
		if issuegraph.IsUUIDShape(ref.rawTarget) {
			target = parseUUID(ref.rawTarget)
		} else if n, ok := issuegraph.ParseIdentifierNumber(ref.rawTarget); ok {
			target = numberToID[n]
		}
		if !target.Valid {
			continue
		}
		addEdge(ref.source, target, "mention")
	}

	respEdges := make([]IssueGraphEdgeResponse, 0, len(edgeSet))
	for e := range edgeSet {
		respEdges = append(respEdges, e)
	}
	// map iteration order is random; sort so responses are stable (and test
	// assertions can be written without set gymnastics)
	sort.Slice(respEdges, func(i, j int) bool {
		if respEdges[i].Source != respEdges[j].Source {
			return respEdges[i].Source < respEdges[j].Source
		}
		if respEdges[i].Target != respEdges[j].Target {
			return respEdges[i].Target < respEdges[j].Target
		}
		return respEdges[i].Kind < respEdges[j].Kind
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"nodes": respNodes,
		"edges": respEdges,
	})
}
