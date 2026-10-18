package main

import "github.com/multica-ai/multica/server/internal/handler"

// Enable only the fully wired domain runtime. File support is an independent
// provider capability: a public S3 deployment still supports text artifacts and
// formal acceptance without pretending its fixed files are private.
func enableCockpitArtifactRuntime(h *handler.Handler) bool {
	if h == nil || h.IssueService == nil {
		return false
	}
	s := h.IssueService
	s.CockpitArtifactBackendReady = false
	if s.Queries == nil || s.TxStarter == nil || s.TaskService == nil {
		return false
	}
	s.CockpitArtifactBackendReady = true
	return true
}
