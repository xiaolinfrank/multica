package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

// This POST is a bounded read and does not initialize a cockpit.
func (h *Handler) ReadIssueOperationBasis(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	var body struct {
		IssueIDs []string `json:"issue_ids"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid operation basis request")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "request must contain one JSON object")
		return
	}
	if len(body.IssueIDs) == 0 || len(body.IssueIDs) > 100 {
		writeError(w, http.StatusBadRequest, "issue_ids requires 1–100 distinct UUIDs")
		return
	}
	ids := make([]pgtype.UUID, 0, len(body.IssueIDs))
	seen := map[pgtype.UUID]bool{}
	for _, raw := range body.IssueIDs {
		id, valid := parseUUIDOrBadRequest(w, raw, "issue_ids")
		if !valid {
			return
		}
		if seen[id] {
			writeError(w, http.StatusBadRequest, "issue_ids must be distinct")
			return
		}
		seen[id] = true
		ids = append(ids, id)
	}
	out, err := h.IssueService.ListIssueOperationBasis(r.Context(), service.IssueOperationBasisQuery{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, Human: p.Human, IssueIDs: ids})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) readContainerOperationBasis(w http.ResponseWriter, r *http.Request, kind string) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), kind+" id")
	if !ok {
		return
	}
	out, err := h.IssueService.GetContainerOperationBasis(r.Context(), service.ContainerOperationBasisQuery{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, Human: p.Human, ResourceID: id, ResourceKind: kind})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) GetNodeOperationBasis(w http.ResponseWriter, r *http.Request) {
	h.readContainerOperationBasis(w, r, "node")
}
func (h *Handler) GetProjectOperationBasis(w http.ResponseWriter, r *http.Request) {
	h.readContainerOperationBasis(w, r, "project")
}
func (h *Handler) GetModuleOperationBasis(w http.ResponseWriter, r *http.Request) {
	h.readContainerOperationBasis(w, r, "module")
}
