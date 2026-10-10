package handler

import (
	"errors"
	"net/http"

	"github.com/multica-ai/multica/server/internal/service"
)

func (h *Handler) GetCockpitPlanExport(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	out, err := h.IssueService.GetCockpitPlanExport(r.Context(), p)
	if errors.Is(err, service.ErrCockpitExportLimit) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": err.Error(), "code": "export_limit"})
		return
	}
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}
