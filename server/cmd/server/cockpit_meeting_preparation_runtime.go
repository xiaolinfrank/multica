package main

import "github.com/multica-ai/multica/server/internal/handler"

// Preparation commands use canonical Issue and task transactions. Both entry
// points become available together only after those dependencies are wired.
func enableCockpitMeetingPreparationRuntime(h *handler.Handler) bool {
	if h == nil || h.IssueService == nil {
		return false
	}
	s := h.IssueService
	s.CockpitMeetingTemplatesBackendReady = false
	s.CockpitMeetingDispositionBackendReady = false
	if s.Queries == nil || s.TxStarter == nil || s.TaskService == nil || s.TaskService.Queries == nil || s.TaskService.TxStarter == nil || !s.CockpitMeetingLifecycleBackendReady {
		return false
	}
	s.CockpitMeetingTemplatesBackendReady = true
	s.CockpitMeetingDispositionBackendReady = true
	return true
}
