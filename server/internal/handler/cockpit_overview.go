package handler

import (
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

// Overview must not use requireCockpit: that legacy loader creates a board.
func (h *Handler) cockpitOverviewQuery(w http.ResponseWriter, r *http.Request, section string) (service.CockpitOverviewQuery, bool) {
	var out service.CockpitOverviewQuery
	ws := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, ws, "workspace id")
	if !ok {
		return out, false
	}
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return out, false
	}
	values := r.URL.Query()
	var project pgtype.UUID
	if ref := values.Get("project_id"); ref != "" {
		project, ok = parseUUIDOrBadRequest(w, ref, "project_id")
		if !ok {
			return out, false
		}
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return out, false
	}
	var days int32
	if value := values.Get("days"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 || n > 90 {
			writeError(w, http.StatusBadRequest, "days must be between 1 and 90")
			return out, false
		}
		days = int32(n)
	}
	view, kind := values.Get("view"), values.Get("kind")
	if section == "overview" {
		view = values.Get("attention_view")
		kind = ""
	}
	if section == "execution" || section == "meetings" {
		view = "mine"
		kind = ""
	}
	out = service.CockpitOverviewQuery{WorkspaceID: id, ProjectID: project, ActorID: member.UserID, Human: !isMachineCredentialActor(r), AsOf: values.Get("as_of"), View: view, Kind: kind, Cursor: values.Get("cursor"), PageSize: size, Days: days}
	return out, true
}
func (h *Handler) GetCockpitOverview(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitOverviewQuery(w, r, "overview")
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitOverview(r.Context(), p)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitOverviewAttention(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitOverviewQuery(w, r, "attention")
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitOverviewAttention(r.Context(), p)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitOverviewExecution(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitOverviewQuery(w, r, "execution")
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitOverviewExecution(r.Context(), p)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
func (h *Handler) ListCockpitOverviewMeetings(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitOverviewQuery(w, r, "meetings")
	if !ok {
		return
	}
	out, err := h.IssueService.ListCockpitOverviewMeetings(r.Context(), p)
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
