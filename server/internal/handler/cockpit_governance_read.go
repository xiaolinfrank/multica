package handler

import (
	"github.com/multica-ai/multica/server/internal/service"
	"net/http"
)

func (h *Handler) ListCockpitChangePage(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	v := r.URL.Query()
	out, err := h.IssueService.ListCockpitChangePage(r.Context(), service.CockpitGovernanceQuery{CockpitSurfaceQuery: p, Query: v.Get("q"), Status: v.Get("status"), Cursor: v.Get("cursor"), PageSize: size})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitSnapshotPage(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	if r.URL.Query().Has("status") {
		writeError(w, http.StatusBadRequest, "saved board history has no change status filter")
		return
	}
	v := r.URL.Query()
	out, err := h.IssueService.ListCockpitSnapshotPage(r.Context(), service.CockpitGovernanceQuery{CockpitSurfaceQuery: p, Query: v.Get("q"), Cursor: v.Get("cursor"), PageSize: size})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
