package service

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/storage"
)

const cockpitInputIOTimeout = 8 * time.Minute

// The Go process enforces this budget independently of web/CLI/daemon transport.
// A blocked kernel call retains its reservation until it actually returns.
type cockpitInputIOBudget struct {
	mu     sync.Mutex
	active int
	bytes  int64
}

func (b *cockpitInputIOBudget) reserve(ctx context.Context, bytes int64) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if b == nil {
		return nil, inputError("storage_unavailable", "Input storage has not been configured.")
	}
	if bytes < 0 || bytes > CockpitInputMaxFileBytes {
		return nil, inputError("invalid_input", "The declared input size is outside the supported limit.")
	}
	b.mu.Lock()
	if b.active >= 2 || b.bytes+bytes > 2*CockpitInputMaxFileBytes {
		b.mu.Unlock()
		return nil, inputError("input_io_busy", "Input file capacity is busy. Retry after the current transfers finish.")
	}
	b.active++
	b.bytes += bytes
	b.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { b.mu.Lock(); b.active--; b.bytes -= bytes; b.mu.Unlock() }) }, nil
}

// ConfigureCockpitInputStorage initializes bounded shared I/O but does not open
// either product capability. DI enables those only after complete validation.
func (s *IssueService) ConfigureCockpitInputStorage(store storage.Storage) bool {
	s.CockpitInputStorage = store
	s.CockpitInputCapturer = nil
	s.inputIOBudget = &cockpitInputIOBudget{}
	if stream, ok := store.(artifactcapture.Store); ok {
		s.CockpitInputCapturer = &artifactcapture.Capturer{Store: stream}
	}
	return s.inputFileCaptureAvailable()
}
func (s *IssueService) ConfigureCockpitInputNAS(files *cockpitnas.Files, configurationError string) {
	s.CockpitInputNAS = files
	s.CockpitInputConfigurationError = configurationError
}
func (s *IssueService) inputFileCaptureAvailable() bool {
	return s.CockpitInputCapturer != nil && storage.SupportsPrivateInputFiles(s.CockpitInputStorage) && storage.SupportsPrivateInputFiles(s.CockpitInputCapturer.Store)
}

type CockpitInputError struct {
	Code                string
	Message             string
	Retryable           bool
	WorkspaceID         string
	InputID             string
	VersionID           string
	TransferID          string
	ExistingReferenceID string
	cause               error
}

func (e *CockpitInputError) Error() string { return e.Message }
func (e *CockpitInputError) Unwrap() error { return e.cause }
func inputError(code, message string) *CockpitInputError {
	cause := ErrCockpitWorkflowConflict
	switch code {
	case "invalid_input":
		cause = ErrCockpitWorkflowInput
	case "permission_revoked", "task_context_required", "delegation_unavailable", "source_run_unavailable", "private_storage_required", "input_scope_not_configured":
		cause = ErrCockpitWorkflowForbidden
	case "not_found":
		cause = ErrCockpitWorkflowNotFound
	case "target_gone":
		cause = ErrCockpitLifecycleGone
	}
	return &CockpitInputError{Code: code, Message: message, Retryable: code == "input_io_busy" || code == "storage_unavailable", cause: cause}
}
func inputErrorCode(err error) string {
	var typed *CockpitInputError
	if errors.As(err, &typed) {
		return typed.Code
	}
	var nas *cockpitnas.Error
	if errors.As(err, &nas) {
		return nas.Code
	}
	var capture *artifactcapture.Error
	if errors.As(err, &capture) {
		return capture.Code
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return "verification_timeout"
	}
	return "input_unavailable"
}
