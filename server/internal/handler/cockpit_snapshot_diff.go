package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
)

func writeCockpitSnapshotDiffLimit(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, service.ErrCockpitSnapshotDiffLimit) {
		return false
	}
	writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error(), "code": "snapshot_diff_limit"})
	return true
}

func (h *Handler) GetCockpitSnapshotDiff(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "snapshotId"), "snapshot_id")
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Has("project_id") || r.URL.Query().Has("module_id") {
		writeError(w, http.StatusBadRequest, "snapshot comparisons cover the complete workspace plan")
		return
	}
	out, err := h.IssueService.GetCockpitSnapshotDiff(r.Context(), p, id, r.URL.Query().Get("cursor"), size)
	if writeCockpitSnapshotDiffLimit(w, err) || writeCockpitSurfaceError(w, r, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}
