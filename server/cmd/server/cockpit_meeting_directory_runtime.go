package main

import (
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/handler"
)

// An empty, valid root configuration still serves retained directory history.
// Per-workspace preparation permission is checked by the directory service.
func enableCockpitMeetingDirectoryRuntime(h *handler.Handler, preparer cockpitnas.Preparation, configurationError string) bool {
	if h == nil || h.IssueService == nil {
		return false
	}
	s := h.IssueService
	s.CockpitMeetingDirectoryBackendReady = false
	s.CockpitDirectoryPreparer = preparer
	s.CockpitDirectoryConfigurationError = configurationError
	if s.Queries == nil || s.TxStarter == nil || !s.CockpitMeetingLifecycleBackendReady || preparer == nil && configurationError != "prepare_configuration_invalid" {
		return false
	}
	s.CockpitMeetingDirectoryBackendReady = true
	return true
}
