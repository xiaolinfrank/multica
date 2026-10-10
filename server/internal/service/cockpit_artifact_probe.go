package service

import (
	"context"
	"errors"
	"fmt"
	"github.com/multica-ai/multica/server/internal/storage"
	"time"
)

var ErrCockpitArtifactPrivateStorageRequired = fmt.Errorf("%w: private artifact storage is required for fixed files; text artifacts remain available", ErrCockpitWorkflowConflict)

var ErrCockpitArtifactVerificationTimeout = fmt.Errorf("%w: fixed content verification timed out; retry verification or return the request with feedback", ErrCockpitWorkflowConflict)

const cockpitArtifactProbeTimeout = 20 * time.Second

func (s *IssueService) artifactProbeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	budget := s.artifactProbeTimeout
	if budget <= 0 {
		budget = cockpitArtifactProbeTimeout
	}
	return context.WithTimeout(ctx, budget)
}
func artifactProbeError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return ErrCockpitArtifactVerificationTimeout
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}
func (s *IssueService) probeArtifactFile(ctx context.Context, key string, size int64, hash string) error {
	if s.CockpitArtifactCapturer == nil || !storage.SupportsPrivateArtifactFiles(s.CockpitArtifactCapturer.Store) {
		return ErrCockpitArtifactPrivateStorageRequired
	}
	bounded, cancel := s.artifactProbeContext(ctx)
	defer cancel()
	err := s.CockpitArtifactCapturer.Verify(bounded, key, size, hash)
	return artifactProbeError(bounded, err)
}
