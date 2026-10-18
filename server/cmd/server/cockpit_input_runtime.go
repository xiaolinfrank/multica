package main

import (
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/service"
)

var _ service.CockpitInputAPI = (*service.IssueService)(nil)

// Storage configuration initializes the shared finite I/O budget. Neither
// product capability is enabled by provider availability alone; complete
// domain and canonical Run wiring are separate acceptance boundaries.
func configureCockpitInputRuntime(h *handler.Handler, files *cockpitnas.Files, configurationError string) {
	if h == nil || h.IssueService == nil {
		return
	}
	s := h.IssueService
	s.CockpitInputBackendReady = false
	s.CockpitRunInputManifestBackendReady = false
	s.ConfigureCockpitInputStorage(h.Storage)
	s.ConfigureCockpitInputNAS(files, configurationError)
	if s.Queries == nil || s.TxStarter == nil || s.TaskService == nil || s.TaskService.Queries == nil || s.TaskService.TxStarter == nil {
		return
	}
	s.CockpitInputBackendReady = true
	s.CockpitRunInputManifestBackendReady = true
}
