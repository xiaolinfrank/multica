package handler

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	"net/http"
)

func (h *Handler) ListCockpitAssigneeChoices(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitSelectorSize(w, r)
	if !ok {
		return
	}
	var selected pgtype.UUID
	if value := r.URL.Query().Get("selected_id"); value != "" {
		selected, ok = parseUUIDOrBadRequest(w, value, "selected_id")
		if !ok {
			return
		}
	}
	out, err := h.IssueService.ListCockpitAssigneeChoices(r.Context(), service.CockpitAssigneeSelectorQuery{CockpitSurfaceQuery: p, Query: r.URL.Query().Get("q"), Kind: r.URL.Query().Get("kind"), Cursor: r.URL.Query().Get("cursor"), SelectedType: r.URL.Query().Get("selected_type"), SelectedID: selected, PageSize: size})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
