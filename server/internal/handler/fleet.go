package handler

import (
	"net/http"
	"time"
)

// GetFleetStatus returns a live snapshot of the compute pool (the coordinator
// host plus the LAN Mac workers). The device list is global infrastructure
// config rather than workspace data, so the endpoint only gates on workspace
// membership — any member may view fleet health — and does not filter by
// workspace. See internal/fleet for the collector.
func (h *Handler) GetFleetStatus(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}

	if h.Fleet == nil {
		// Collector not wired (e.g. minimal test harness) — degrade to empty
		// rather than 500 so the dashboard renders its empty state.
		writeJSON(w, http.StatusOK, map[string]any{
			"devices":      []any{},
			"collected_at": "",
		})
		return
	}

	devices, at := h.Fleet.Collect(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"devices":      devices,
		"collected_at": at.UTC().Format(time.RFC3339),
	})
}
