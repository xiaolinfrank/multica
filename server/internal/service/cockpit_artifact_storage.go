package service

import (
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/storage"
)

// ConfigureCockpitArtifactStorage wires the existing platform object store.
// Readiness is enabled separately after the complete domain runtime is wired.
func (s *IssueService) ConfigureCockpitArtifactStorage(store storage.Storage) bool {
	s.CockpitArtifactStorage = store
	s.CockpitArtifactCapturer = nil
	stream, ok := store.(artifactcapture.Store)
	if !ok {
		return false
	}
	s.CockpitArtifactCapturer = &artifactcapture.Capturer{Store: stream}
	return s.artifactFileCaptureAvailable()
}

func (s *IssueService) artifactFileCaptureAvailable() bool {
	return s.CockpitArtifactCapturer != nil && storage.SupportsPrivateArtifactFiles(s.CockpitArtifactStorage) && storage.SupportsPrivateArtifactFiles(s.CockpitArtifactCapturer.Store)
}
