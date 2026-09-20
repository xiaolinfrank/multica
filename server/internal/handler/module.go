package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Module API (BayClaw fork). A module (模块) subdivides a project: issues keep
// their project and additionally group into modules for lane and facet views.
// Reads and writes are open to any workspace member, like projects; deletion
// is owner/admin gated like DeleteProject because it re-files every issue in
// the module back to the project root.

type ModuleResponse struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspace_id"`
	ProjectID   string  `json:"project_id"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	Position    float64 `json:"position"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
	IssueCount  int64   `json:"issue_count"`
	DoneCount   int64   `json:"done_count"`
}

func moduleToResponse(m db.Module) ModuleResponse {
	return ModuleResponse{
		ID:          uuidToString(m.ID),
		WorkspaceID: uuidToString(m.WorkspaceID),
		ProjectID:   uuidToString(m.ProjectID),
		Title:       m.Title,
		Description: textToPtr(m.Description),
		Position:    m.Position,
		CreatedAt:   timestampToString(m.CreatedAt),
		UpdatedAt:   timestampToString(m.UpdatedAt),
	}
}

// loadModuleIssueStats resolves one module's issue counts. Shares the project
// stats' terminal-status expansion: done means the same thing there.
func (h *Handler) loadModuleIssueStats(ctx context.Context, workspaceID, moduleID pgtype.UUID) (int64, int64) {
	terminalStatusKeys := h.projectTerminalIssueStatusKeys(ctx, workspaceID)
	stats, err := h.Queries.GetModuleIssueStats(ctx, db.GetModuleIssueStatsParams{
		WorkspaceID:        workspaceID,
		ModuleIds:          []pgtype.UUID{moduleID},
		TerminalStatusKeys: terminalStatusKeys,
	})
	if err != nil || len(stats) == 0 {
		return 0, 0
	}
	return stats[0].TotalCount, stats[0].DoneCount
}

// loadModuleStats batch-fetches issue counts for a module list, keyed by the
// module UUID string — same one-round-trip shape ListProjects uses so a page
// of modules never costs one stats query per row.
func (h *Handler) loadModuleStats(ctx context.Context, workspaceID pgtype.UUID, modules []db.Module) map[string]db.GetModuleIssueStatsRow {
	statsMap := make(map[string]db.GetModuleIssueStatsRow, len(modules))
	if len(modules) == 0 {
		return statsMap
	}
	moduleIDs := make([]pgtype.UUID, len(modules))
	for i, m := range modules {
		moduleIDs[i] = m.ID
	}
	stats, err := h.Queries.GetModuleIssueStats(ctx, db.GetModuleIssueStatsParams{
		WorkspaceID:        workspaceID,
		ModuleIds:          moduleIDs,
		TerminalStatusKeys: h.projectTerminalIssueStatusKeys(ctx, workspaceID),
	})
	if err != nil {
		return statsMap
	}
	for _, s := range stats {
		statsMap[uuidToString(s.ModuleID)] = s
	}
	return statsMap
}

// validateModuleTitle trims and bounds a module title; a non-empty second
// return is the 400 already written.
func validateModuleTitle(w http.ResponseWriter, raw string) (string, bool) {
	title := strings.TrimSpace(raw)
	if title == "" || len([]rune(title)) > 200 {
		writeError(w, http.StatusBadRequest, "title must be 1-200 characters")
		return "", false
	}
	return title, true
}

type CreateModuleRequest struct {
	ProjectID   string  `json:"project_id"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
}

type UpdateModuleRequest struct {
	Title       *string  `json:"title"`
	Description *string  `json:"description"`
	Position    *float64 `json:"position"`
}

func (h *Handler) ListModules(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	// project_id is optional: absent lists the whole workspace's modules.
	var projectFilter pgtype.UUID
	if p := r.URL.Query().Get("project_id"); p != "" {
		id, ok := parseUUIDOrBadRequest(w, p, "project_id")
		if !ok {
			return
		}
		projectFilter = id
	}
	modules, err := h.Queries.ListModules(r.Context(), db.ListModulesParams{
		WorkspaceID: wsUUID,
		ProjectID:   projectFilter,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list modules")
		return
	}

	statsMap := h.loadModuleStats(r.Context(), wsUUID, modules)
	resp := make([]ModuleResponse, len(modules))
	for i, m := range modules {
		resp[i] = moduleToResponse(m)
		if s, ok := statsMap[resp[i].ID]; ok {
			resp[i].IssueCount = s.TotalCount
			resp[i].DoneCount = s.DoneCount
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": resp, "total": len(resp)})
}

func (h *Handler) GetModule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	workspaceID := h.resolveWorkspaceID(r)
	idUUID, ok := parseUUIDOrBadRequest(w, id, "module id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	module, err := h.Queries.GetModuleInWorkspace(r.Context(), db.GetModuleInWorkspaceParams{
		ID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "module not found")
		return
	}
	resp := moduleToResponse(module)
	resp.IssueCount, resp.DoneCount = h.loadModuleIssueStats(r.Context(), wsUUID, module.ID)
	writeJSON(w, http.StatusOK, map[string]any{"module": resp})
}

func (h *Handler) CreateModule(w http.ResponseWriter, r *http.Request) {
	var req CreateModuleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	title, ok := validateModuleTitle(w, req.Title)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}
	projectUUID, ok := parseUUIDOrBadRequest(w, req.ProjectID, "project_id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
		ID: projectUUID, WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusBadRequest, "project not found in this workspace")
		return
	}
	module, err := h.Queries.CreateModule(r.Context(), db.CreateModuleParams{
		WorkspaceID: wsUUID,
		ProjectID:   projectUUID,
		Title:       title,
		Description: ptrToText(req.Description),
	})
	if err != nil {
		slog.Error("create module failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create module")
		return
	}
	resp := moduleToResponse(module)
	h.publish(protocol.EventModuleCreated, workspaceID, "member", userID, map[string]any{"module": resp})
	writeJSON(w, http.StatusCreated, map[string]any{"module": resp})
}

func (h *Handler) UpdateModule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	workspaceID := h.resolveWorkspaceID(r)
	idUUID, ok := parseUUIDOrBadRequest(w, id, "module id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	module, err := h.Queries.GetModuleInWorkspace(r.Context(), db.GetModuleInWorkspaceParams{
		ID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "module not found")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	var req UpdateModuleRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	var rawFields map[string]json.RawMessage
	json.Unmarshal(bodyBytes, &rawFields)

	params := db.UpdateModuleParams{
		ID:          module.ID,
		WorkspaceID: module.WorkspaceID,
		Description: module.Description,
	}
	if req.Title != nil {
		title, ok := validateModuleTitle(w, *req.Title)
		if !ok {
			return
		}
		params.Title = pgtype.Text{String: title, Valid: true}
	}
	if req.Position != nil {
		params.Position = pgtype.Float8{Float64: *req.Position, Valid: true}
	}
	// Same presence contract as UpdateProject: an absent key keeps the prior
	// description, a present null clears it.
	if _, ok := rawFields["description"]; ok {
		if req.Description != nil {
			params.Description = pgtype.Text{String: *req.Description, Valid: true}
		} else {
			params.Description = pgtype.Text{Valid: false}
		}
	}
	updated, err := h.Queries.UpdateModule(r.Context(), params)
	if err != nil {
		slog.Error("update module failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update module")
		return
	}
	resp := moduleToResponse(updated)
	resp.IssueCount, resp.DoneCount = h.loadModuleIssueStats(r.Context(), wsUUID, updated.ID)
	h.publish(protocol.EventModuleUpdated, workspaceID, "member", userID, map[string]any{"module": resp})
	writeJSON(w, http.StatusOK, map[string]any{"module": resp})
}

// ReorderModulesRequest names one project's COMPLETE module set in its new
// order. A partial list is rejected: positions become 0..n-1 of the submitted
// order, so an unsubmitted row would end up interleaved on the new ladder.
type ReorderModulesRequest struct {
	ModuleIDs []string `json:"module_ids"`
}

// ReorderModules rewrites a project's module order as 0..n-1, atomically.
// Validation and the write share one transaction, mirroring
// ReorderIssueStatuses: checking outside it would let a concurrent delete
// commit between the check and the UPDATE, silently skipping a row while
// still answering 200.
func (h *Handler) ReorderModules(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	var req ReorderModulesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.ModuleIDs) == 0 {
		writeError(w, http.StatusBadRequest, "module_ids must not be empty")
		return
	}
	ids := make([]pgtype.UUID, 0, len(req.ModuleIDs))
	seen := make(map[string]struct{}, len(req.ModuleIDs))
	for _, raw := range req.ModuleIDs {
		if _, duplicate := seen[raw]; duplicate {
			writeError(w, http.StatusBadRequest, "duplicate module_ids")
			return
		}
		seen[raw] = struct{}{}
		id, err := util.ParseUUID(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid module id")
			return
		}
		ids = append(ids, id)
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	modules, err := qtx.GetModulesByIDs(r.Context(), db.GetModulesByIDsParams{
		WorkspaceID: wsUUID,
		Ids:         ids,
	})
	if err != nil {
		slog.Warn("ReorderModules load failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}
	if len(modules) != len(ids) {
		writeError(w, http.StatusNotFound, "module not found")
		return
	}
	projectID := modules[0].ProjectID
	for _, m := range modules[1:] {
		if m.ProjectID != projectID {
			writeError(w, http.StatusBadRequest, "module_ids must all belong to the same project")
			return
		}
	}

	// The payload must cover the project's WHOLE module set. Reorder rewrites
	// positions as 0..n-1 of the submitted order, so a partial set would leave
	// the unsubmitted rows interleaved on the new ladder. All submitted ids are
	// known to belong to this project and carry no duplicates, so an equal
	// count proves set equality. Read through the transaction so a concurrent
	// create/delete is decided on the same snapshot the rewrite applies to.
	existing, err := qtx.ListModules(r.Context(), db.ListModulesParams{
		WorkspaceID: wsUUID,
		ProjectID:   projectID,
	})
	if err != nil {
		slog.Warn("ReorderModules list project failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}
	if len(existing) != len(ids) {
		writeError(w, http.StatusBadRequest, "module_ids must cover every module of the project")
		return
	}

	positions := make([]float64, len(ids))
	for i := range positions {
		positions[i] = float64(i)
	}
	affected, err := qtx.ReorderModules(r.Context(), db.ReorderModulesParams{
		WorkspaceID: wsUUID,
		Ids:         ids,
		Positions:   positions,
	})
	if err != nil {
		slog.Warn("ReorderModules failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}
	if affected != int64(len(ids)) {
		// Belt and braces: if the UPDATE declined a row anyway, roll the whole
		// order back rather than commit a prefix.
		slog.Warn("ReorderModules touched an unexpected row count",
			append(logger.RequestAttrs(r), "affected", affected, "expected", len(ids))...)
		writeError(w, http.StatusConflict, "modules changed during reorder")
		return
	}

	updated, err := qtx.ListModules(r.Context(), db.ListModulesParams{
		WorkspaceID: wsUUID,
		ProjectID:   projectID,
	})
	if err != nil {
		slog.Warn("list modules after reorder failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Warn("ReorderModules commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reorder modules")
		return
	}

	statsMap := h.loadModuleStats(r.Context(), wsUUID, updated)
	resp := make([]ModuleResponse, len(updated))
	for i, m := range updated {
		resp[i] = moduleToResponse(m)
		if s, ok := statsMap[resp[i].ID]; ok {
			resp[i].IssueCount = s.TotalCount
			resp[i].DoneCount = s.DoneCount
		}
		// One event per moved module keeps the module:updated payload shape
		// ("module", singular) intact; a reorder touches every row anyway.
		h.publish(protocol.EventModuleUpdated, workspaceID, "member", userID, map[string]any{"module": resp[i]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"modules": resp})
}

func (h *Handler) DeleteModule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	workspaceID := h.resolveWorkspaceID(r)
	idUUID, ok := parseUUIDOrBadRequest(w, id, "module id")
	if !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	module, err := h.Queries.GetModuleInWorkspace(r.Context(), db.GetModuleInWorkspaceParams{
		ID: idUUID, WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "module not found")
		return
	}
	requester, ok := h.requireWorkspaceRole(w, r, uuidToString(module.WorkspaceID), "module not found", "owner", "admin")
	if !ok {
		return
	}
	userID := uuidToString(requester.UserID)
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	// The issues survive: they fall back to sitting directly under the
	// project. Detach first, in the same transaction as the delete, so no
	// reader can observe a dangling module_id.
	if _, err := qtx.DetachIssuesFromModule(r.Context(), db.DetachIssuesFromModuleParams{
		ModuleID:    module.ID,
		WorkspaceID: module.WorkspaceID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to detach module issues")
		return
	}
	deleted, err := qtx.DeleteModule(r.Context(), db.DeleteModuleParams{
		ID:          module.ID,
		WorkspaceID: module.WorkspaceID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete module")
		return
	}
	if deleted == 0 {
		writeError(w, http.StatusNotFound, "module not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit module delete")
		return
	}
	h.publish(protocol.EventModuleDeleted, workspaceID, "member", userID, map[string]any{
		"module_id":  uuidToString(module.ID),
		"project_id": uuidToString(module.ProjectID),
	})
	w.WriteHeader(http.StatusNoContent)
}
