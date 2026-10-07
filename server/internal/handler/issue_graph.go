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
	// AssigneeName is the display name of the member or agent the issue is
	// assigned to, resolved through the workspace member/agent lists. Empty
	// when the issue is unassigned (or the assignee row is gone).
	AssigneeName string `json:"assignee_name"`
}

type IssueGraphEdgeResponse struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
}

// Meeting and execution nodes ride alongside the issue nodes as separate
// arrays: an older client only reads `nodes`/`edges`, and edge kinds it does
// not know ("meeting", "execution") are dropped when its graph model is
// built — additive fields keep that contract intact.
//
// Edge endpoints address nodes across the three arrays, so meeting/execution
// endpoints carry an "mtg:"/"run:" prefix: the address space stays unambiguous
// even though all three id columns are UUIDs, and a renderer can tell the
// entity type of an endpoint without a lookup.

const (
	graphMeetingNodePrefix   = "mtg:"
	graphExecutionNodePrefix = "run:"
)

type IssueGraphMeetingResponse struct {
	ID       string `json:"id"`
	Code     string `json:"code"`
	Title    string `json:"title"`
	MeetDate string `json:"meet_date"`
	Status   string `json:"status"`
	Track    string `json:"track"`
	// NasDir is the meeting's folder on the shared storage; empty when the
	// meeting was never provisioned. Absolute server-side path — display only.
	NasDir string `json:"nas_dir"`
}

type IssueGraphExecutionResponse struct {
	ID          string `json:"id"`
	IssueID     string `json:"issue_id"`
	AgentName   string `json:"agent_name"`
	Status      string `json:"status"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
	// TriggerCommentID anchors the run to its source comment, so the client
	// can deep-link to it (issue detail highlights #comment-<id>). Null when
	// the run was not triggered by a comment.
	TriggerCommentID *string `json:"trigger_comment_id"`
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

	// Assignee display names: members resolve through their user profile
	// (member rows carry no name), agents carry their own. Both lists are
	// workspace-scoped and small; building one lookup per snapshot beats a
	// per-node query and reuses the list endpoints' canonical queries.
	assigneeNames := make(map[pgtype.UUID]string)
	members, err := h.Queries.ListMembersWithUser(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	for _, m := range members {
		assigneeNames[m.ID] = m.UserName
	}
	// AnyKind on purpose: this only resolves a display name, never builds a
	// picker, so a system carrier that somehow owns an assignment still
	// resolves instead of silently rendering as unassigned.
	agents, err := h.Queries.ListAllAgentsAnyKind(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	for _, a := range agents {
		assigneeNames[a.ID] = a.Name
	}

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
			AssigneeName:   assigneeNames[n.AssigneeID],
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

	// --- meeting nodes + edges -------------------------------------------
	// The board's meeting register joins the graph as its own node type,
	// linked to the issues the meeting opened or someone attached. In a
	// project-scoped read a meeting survives only when at least one of its
	// linked issues is in the visible set — meetings are workspace-level
	// records, and showing every one of them inside one project's graph would
	// be noise.
	meetings, err := h.Queries.ListIssueGraphMeetings(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	meetingLinks, err := h.Queries.ListIssueGraphMeetingIssues(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	linkedByMeeting := make(map[pgtype.UUID]int) // meeting id -> visible linked issues
	for _, l := range meetingLinks {
		if _, ok := nodeByID[l.IssueID]; !ok {
			continue
		}
		linkedByMeeting[l.MeetingID]++
		edgeSet[IssueGraphEdgeResponse{
			Source: graphMeetingNodePrefix + uuidToString(l.MeetingID),
			Target: uuidToString(l.IssueID),
			Kind:   "meeting",
		}] = struct{}{}
	}
	respMeetings := make([]IssueGraphMeetingResponse, 0, len(meetings))
	for _, m := range meetings {
		if projectFilter.Valid && linkedByMeeting[m.ID] == 0 {
			continue
		}
		respMeetings = append(respMeetings, IssueGraphMeetingResponse{
			ID:       uuidToString(m.ID),
			Code:     m.Code,
			Title:    m.Title,
			MeetDate: derefOr(dateToPtr(m.MeetDate), ""),
			Status:   m.Status,
			Track:    m.Track,
			NasDir:   m.NasDir,
		})
	}

	// --- execution nodes + edges ------------------------------------------
	// The queue's latest run per issue (plus anything still in flight) becomes
	// a node hanging off its issue: the graph answers "what ran on this task"
	// without opening every issue. A run whose issue fell out of the visible
	// set (project scope) is dropped with it.
	runs, err := h.Queries.ListIssueGraphRuns(ctx, wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load issue graph")
		return
	}
	respExecutions := make([]IssueGraphExecutionResponse, 0, len(runs))
	for _, run := range runs {
		if _, ok := nodeByID[run.IssueID]; !ok {
			continue
		}
		respExecutions = append(respExecutions, IssueGraphExecutionResponse{
			ID:               uuidToString(run.ID),
			IssueID:          uuidToString(run.IssueID),
			AgentName:        run.AgentName,
			Status:           run.Status,
			StartedAt:        timestampToString(run.StartedAt),
			CompletedAt:      timestampToString(run.CompletedAt),
			TriggerCommentID: uuidToPtr(run.TriggerCommentID),
		})
		edgeSet[IssueGraphEdgeResponse{
			Source: uuidToString(run.IssueID),
			Target: graphExecutionNodePrefix + uuidToString(run.ID),
			Kind:   "execution",
		}] = struct{}{}
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
		"nodes":      respNodes,
		"edges":      respEdges,
		"meetings":   respMeetings,
		"executions": respExecutions,
	})
}
