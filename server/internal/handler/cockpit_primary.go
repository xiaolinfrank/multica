package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) ListCockpitNodeTasks(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	out, err := h.IssueService.ListCockpitNodeTasks(r.Context(), service.CockpitNodeTaskList{
		WorkspaceID: cc.workspaceID, NodeID: node.ID, Query: query.Get("q"), Status: query.Get("status"), Category: query.Get("category"),
		Relation: query.Get("relation"), Cursor: query.Get("cursor"), PageSize: size,
	})
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) CreateCockpitNodeTask(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "creating a primary L3 task requires a human actor")
		return
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	var req struct {
		cockpitActionIssueFields
		CreationKey string `json:"creation_key"`
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, req.CreationKey, "creation_key")
	if !ok {
		return
	}
	input, ok := h.cockpitActionIssueInput(w, r, cc, req.cockpitActionIssueFields)
	if !ok {
		return
	}
	input.Title, input.Description = req.Title, pgtype.Text{String: req.Description, Valid: true}
	created, err := h.IssueService.CreateCockpitNodeTask(r.Context(), service.CockpitNodeTaskCreate{
		WorkspaceID: cc.workspaceID, NodeID: node.ID, ActorID: cc.member.UserID, CreationKey: key, NewIssue: input,
	}, service.IssueCreateOpts{ActorID: uuidToString(cc.member.UserID)})
	if writeCockpitActionError(w, r, err) {
		return
	}
	out, err := h.IssueService.ReadCockpitIssueSummary(r.Context(), cc.workspaceID, created.Issue.ID)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitIssuePrimaryNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitIssuePrimaryNode(r.Context(), cc.workspaceID, issue.ID)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) ListCockpitIssueActionSources(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitIssueActionSources(r.Context(), cc.workspaceID, issue.ID, r.URL.Query().Get("cursor"), size)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) SetCockpitIssuePrimaryNode(w http.ResponseWriter, r *http.Request) {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "changing primary ownership requires a human actor")
		return
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "issueId"))
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		NodeID *string `json:"node_id"`
	}
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	_, present := raw["node_id"]
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || !present {
		writeError(w, http.StatusBadRequest, "non-negative expected_revision and explicit node_id (or null to clear) are required")
		return
	}
	var node pgtype.UUID
	if req.NodeID != nil {
		node, ok = parseUUIDOrBadRequest(w, *req.NodeID, "node_id")
		if !ok {
			return
		}
	}
	_, err := h.IssueService.SetCockpitIssuePrimaryNode(r.Context(), service.CockpitPrimaryNodeCommand{
		WorkspaceID: cc.workspaceID, IssueID: issue.ID, NodeID: node, ActorID: cc.member.UserID, ExpectedRevision: *req.ExpectedRevision,
	})
	if writeCockpitActionError(w, r, err) {
		return
	}
	out, err := h.IssueService.GetCockpitIssuePrimaryNode(r.Context(), cc.workspaceID, issue.ID)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
