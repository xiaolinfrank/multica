package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

func cockpitSelectorSize(w http.ResponseWriter, r *http.Request) (int32, bool) {
	value := r.URL.Query().Get("page_size")
	if value == "" {
		return 20, true
	}
	size, err := strconv.Atoi(value)
	if err != nil || size < 1 || size > 100 {
		writeError(w, http.StatusBadRequest, "page_size must be between 1 and 100")
		return 0, false
	}
	return int32(size), true
}
func (h *Handler) ListCockpitScopeNodes(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitSelectorSize(w, r)
	if !ok {
		return
	}
	eligible := true
	if value := r.URL.Query().Get("eligible"); value != "" {
		if value != "true" && value != "false" {
			writeError(w, http.StatusBadRequest, "eligible must be true or false")
			return
		}
		eligible = value == "true"
	}
	out, err := h.IssueService.ListCockpitScopeNodes(r.Context(), service.CockpitNodeSelectorQuery{CockpitSurfaceQuery: p,
		Query: r.URL.Query().Get("q"), Cursor: r.URL.Query().Get("cursor"), EligibleOnly: eligible, PageSize: size})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitScopeMembers(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	size, ok := cockpitSelectorSize(w, r)
	if !ok {
		return
	}
	ids := make([]pgtype.UUID, 0)
	if raw := r.URL.Query().Get("ids"); raw != "" {
		parts := strings.Split(raw, ",")
		if len(parts) > 20 {
			writeError(w, http.StatusBadRequest, "ids accepts at most 20 people")
			return
		}
		for _, value := range parts {
			id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(value), "member id")
			if !ok {
				return
			}
			ids = append(ids, id)
		}
	}
	out, err := h.IssueService.ListCockpitScopeMembers(r.Context(), service.CockpitMemberSelectorQuery{CockpitSurfaceQuery: p,
		Query: r.URL.Query().Get("q"), Cursor: r.URL.Query().Get("cursor"), UserIDs: ids, PageSize: size})
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
