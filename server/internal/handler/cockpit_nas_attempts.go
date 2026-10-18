package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) ListCockpitNASExportAttempts(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "exportId"), "export_id")
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	page, err := h.IssueService.ListCockpitMinutesExportAttempts(r.Context(), service.CockpitMinutesExportAttemptList{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ExportID: id, Cursor: r.URL.Query().Get("cursor"), PageSize: size,
	})
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, page)
	}
}
