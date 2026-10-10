package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type cockpitArtifactCaptured struct {
	Capture db.CockpitArtifactCapture
	Attempt db.CockpitArtifactCaptureAttempt
	Result  artifactcapture.Result
}

// RunCockpitArtifactCaptureWorker is a bounded sequential worker. Context
// cancellation stops scheduling; it does not claim an in-flight storage write
// was undone. Every attempted object has a durable cleanup owner before I/O.
func (s *IssueService) RunCockpitArtifactCaptureWorker(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		found, err := s.ProcessNextCockpitArtifactCapture(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("artifact capture cycle failed", "error", err)
		}
		if _, cleanupErr := s.ProcessNextCockpitArtifactObjectCleanup(ctx); cleanupErr != nil && !errors.Is(cleanupErr, context.Canceled) {
			slog.Warn("artifact object cleanup failed", "error", cleanupErr)
		}
		delay := time.Second * 3
		if found {
			delay = time.Millisecond * 25
		}
		timer.Reset(delay)
	}
}
func (s *IssueService) ProcessNextCockpitArtifactCapture(ctx context.Context) (bool, error) {
	candidate, err := s.Queries.GetDueCockpitArtifactCapture(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, candidate.WorkspaceID); err != nil {
		return false, cockpitWorkflowError(err)
	}
	if _, err = q.LockCockpitForWorkspaceChanges(ctx, candidate.WorkspaceID); err != nil {
		return false, cockpitWorkflowError(err)
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: candidate.WorkspaceID, ID: candidate.ArtifactID})
	if err != nil {
		return false, cockpitWorkflowError(err)
	}
	if a.CurrentVersionID != candidate.VersionID || a.ArchivedAt.Valid {
		return false, artifactConflict("capture no longer belongs to the current active version")
	}
	if !s.artifactFileCaptureAvailable() {
		disabled, e := q.DisableCockpitArtifactCaptureForStorage(ctx, db.DisableCockpitArtifactCaptureForStorageParams{WorkspaceID: candidate.WorkspaceID, ArtifactID: candidate.ArtifactID, VersionID: candidate.VersionID})
		if errors.Is(e, pgx.ErrNoRows) {
			return false, nil
		}
		if e != nil {
			return false, e
		}
		if _, e = q.SetCockpitArtifactVersionCapture(ctx, db.SetCockpitArtifactVersionCaptureParams{WorkspaceID: disabled.WorkspaceID, ArtifactID: disabled.ArtifactID, ID: disabled.VersionID, CaptureStatus: "needs_attention", CaptureErrorCode: "private_storage_required", CaptureError: disabled.LastError}); e != nil {
			return false, e
		}
		if e = tx.Commit(ctx); e != nil {
			return false, e
		}
		s.artifactChanged(a, disabled.CreatedBy)
		return true, nil
	}
	verified, verifiedErr := q.GetCockpitArtifactVerifiedAttempt(ctx, db.GetCockpitArtifactVerifiedAttemptParams{WorkspaceID: candidate.WorkspaceID, VersionID: candidate.VersionID})
	if verifiedErr != nil && !errors.Is(verifiedErr, pgx.ErrNoRows) {
		return false, verifiedErr
	}
	reuse := verifiedErr == nil && verified.ContentHash.Valid && verified.SizeBytes.Valid
	lease, attemptID := dbid.NewV7(), dbid.NewV7()
	if reuse {
		attemptID = verified.ID
	}
	c, err := q.ClaimCockpitArtifactCapture(ctx, db.ClaimCockpitArtifactCaptureParams{WorkspaceID: candidate.WorkspaceID, ArtifactID: candidate.ArtifactID, VersionID: candidate.VersionID, LeaseToken: lease, AttemptID: attemptID})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	request := artifactcapture.Request{WorkspaceID: util.UUIDToString(c.WorkspaceID), VersionID: util.UUIDToString(c.VersionID), AttemptID: util.UUIDToString(attemptID), ExpectedHash: c.ExpectedHash.String,
		Source: artifactcapture.Source{AttachmentID: util.UUIDToString(c.SourceAttachmentID), StorageKey: c.SourceStorageKey, Filename: c.SourceFilename, ContentType: c.SourceContentType, SizeBytes: c.SourceSizeBytes}}
	attempt := verified
	if reuse && c.ExpectedHash.Valid && c.ExpectedHash.String != verified.ContentHash.String {
		return false, artifactConflict("verified recovery object does not match the pinned capture hash")
	}
	if !reuse {
		key, e := artifactcapture.TargetKey(request)
		if e != nil {
			return false, e
		}
		attempt, err = q.CreateCockpitArtifactCaptureAttempt(ctx, db.CreateCockpitArtifactCaptureAttemptParams{ID: attemptID, WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, VersionID: c.VersionID, AttemptNumber: c.Attempts, LeaseToken: lease, LeaseExpiresAt: c.LeaseExpiresAt, StorageKey: key, ObjectUrl: s.CockpitArtifactStorage.ObjectURL(key)})
		if err != nil {
			return false, err
		}
	}
	if _, err = q.SetCockpitArtifactVersionCapture(ctx, db.SetCockpitArtifactVersionCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, ID: c.VersionID, CaptureStatus: "running"}); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	s.artifactChanged(a, c.CreatedBy)
	// This bounded deadline does not permit a second goroutine to outlive the
	// call or claim success before the provider reports its final outcome.
	ioCtx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	var result artifactcapture.Result
	var captureErr error
	if reuse {
		result = artifactcapture.Result{StorageKey: attempt.StorageKey, Filename: c.SourceFilename, ContentType: c.SourceContentType, SizeBytes: attempt.SizeBytes.Int64, ContentHash: attempt.ContentHash.String, AttachmentID: util.UUIDToString(c.SourceAttachmentID)}
		captureErr = s.CockpitArtifactCapturer.Verify(ioCtx, result.StorageKey, result.SizeBytes, result.ContentHash)
	} else {
		result, captureErr = s.CockpitArtifactCapturer.Capture(ioCtx, request)
	}
	cancel()
	// Record I/O completion even when shutdown cancelled the work context. This
	// permits workspace-deletion reconciliation to clean the known attempt.
	settleCtx, settleCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer settleCancel()
	finish := db.FinishCockpitArtifactCaptureIOParams{ID: attempt.ID, LeaseToken: lease, State: "failed"}
	if captureErr == nil {
		finish.State = "verified"
		finish.ContentHash = pgtype.Text{String: result.ContentHash, Valid: true}
		finish.SizeBytes = pgtype.Int8{Int64: result.SizeBytes, Valid: true}
	} else {
		finish.LastError = captureErr.Error()
	}
	if !reuse {
		if _, err = s.Queries.FinishCockpitArtifactCaptureIO(settleCtx, finish); err != nil {
			return true, err
		}
	}
	if captureErr == nil {
		hook := &cockpitArtifactIssue{captured: &cockpitArtifactCaptured{Capture: c, Attempt: attempt, Result: result}}
		_, captureErr = s.Create(settleCtx, IssueCreateParams{WorkspaceID: c.WorkspaceID, CreatorID: c.CreatedBy, CreatorType: "member", CockpitArtifact: hook}, IssueCreateOpts{ActorID: util.UUIDToString(c.CreatedBy)})
		if captureErr == nil {
			s.artifactChanged(hook.artifact, c.CreatedBy)
			return true, nil
		}
	}
	return true, s.failCockpitArtifactCapture(settleCtx, c, result, captureErr)
}
func (s *IssueService) failCockpitArtifactCapture(ctx context.Context, c db.CockpitArtifactCapture, result artifactcapture.Result, cause error) error {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, c.WorkspaceID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err = q.LockCockpitForWorkspaceChanges(ctx, c.WorkspaceID); err != nil {
		return cockpitWorkflowError(err)
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: c.WorkspaceID, ID: c.ArtifactID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	current, err := q.LockCockpitArtifactCapture(ctx, db.LockCockpitArtifactCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, VersionID: c.VersionID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if current.LeaseToken != c.LeaseToken || current.Status != "running" {
		return nil
	}
	code, message, retryable := "capture_finalize_failed", "The fixed copy could not be linked to its human review task. Resolve the reviewer or workspace limit, then retry.", false
	var typed *artifactcapture.Error
	if errors.As(cause, &typed) {
		code, message, retryable = typed.Code, typed.Message, typed.Retryable
	}
	status := "needs_attention"
	if retryable && current.CycleAttempts < 8 {
		status = "retry_wait"
	}
	delay := int32(5)
	for i := int32(1); i < current.CycleAttempts && delay < 300; i++ {
		delay *= 2
	}
	if delay > 300 {
		delay = 300
	}
	var hash pgtype.Text
	if result.ContentHash != "" {
		hash = pgtype.Text{String: result.ContentHash, Valid: true}
	}
	if _, err = q.FailCockpitArtifactCapture(ctx, db.FailCockpitArtifactCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, VersionID: c.VersionID, LeaseToken: c.LeaseToken, Status: status, ExpectedHash: hash, ErrorCode: code, ErrorMessage: message, DelaySeconds: delay}); err != nil {
		return err
	}
	if _, err = q.SetCockpitArtifactVersionCapture(ctx, db.SetCockpitArtifactVersionCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, ID: c.VersionID, CaptureStatus: status, CaptureErrorCode: code, CaptureError: message}); err != nil {
		return err
	}
	// Failed partial objects can be removed after the I/O completion record.
	// Verified objects remain owned for recovery until a later attempt succeeds.
	if !hash.Valid {
		if err = q.QueueCockpitArtifactAttemptCleanup(ctx, db.QueueCockpitArtifactAttemptCleanupParams{WorkspaceID: c.WorkspaceID, VersionID: c.VersionID, ExceptID: pgtype.UUID{}}); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.artifactChanged(a, c.CreatedBy)
	return nil
}
func prepareCockpitArtifactCaptured(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitArtifact
	captured := h.captured
	c := captured.Capture
	// The original submission already authorized this durable system effect.
	// Its author may have left since then; only the current designated reviewer
	// needs live membership. No API command can enter this private typed hook.
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, c.WorkspaceID); err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if _, err := q.LockCockpitForWorkspaceChanges(ctx, c.WorkspaceID); err != nil {
		return nil, cockpitWorkflowError(err)
	}
	a, err := q.LockCockpitArtifact(ctx, db.LockCockpitArtifactParams{WorkspaceID: c.WorkspaceID, ID: c.ArtifactID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	h.artifact = a
	current, err := q.LockCockpitArtifactCapture(ctx, db.LockCockpitArtifactCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, VersionID: c.VersionID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if a.ArchivedAt.Valid || a.CurrentVersionID != c.VersionID || current.Status != "running" || current.LeaseToken != c.LeaseToken || current.CurrentAttemptID != captured.Attempt.ID {
		return nil, artifactConflict("capture lease or current version changed")
	}
	v, err := q.LockCockpitArtifactVersion(ctx, db.LockCockpitArtifactVersionParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, ID: c.VersionID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if v.Decision != "not_requested" || v.CaptureStatus != "running" {
		return nil, artifactConflict("capture no longer owns this version")
	}
	if err = artifactReviewer(ctx, q, c.WorkspaceID, v.ReviewerID); err != nil {
		return nil, err
	}
	h.version = v
	p.Title = fmt.Sprintf("Review artifact: %s · v%d", a.Title, v.VersionNumber)
	p.Description = pgtype.Text{String: fmt.Sprintf("Review the verified fixed file in artifact %s, version %s. Use the artifact reader to record its formal human decision.", util.UUIDToString(a.ID), util.UUIDToString(v.ID)), Valid: true}
	p.Status = "todo"
	p.Priority = "none"
	p.ProjectID = a.ProjectID
	p.ModuleID = a.ModuleID
	p.AssigneeType = pgtype.Text{String: "member", Valid: true}
	p.AssigneeID = v.ReviewerID
	p.ParentIssueID = pgtype.UUID{}
	p.AllowDuplicate = true
	return nil, nil
}
func linkCockpitArtifactCaptured(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitArtifact
	c := h.captured.Capture
	r := h.captured.Result
	if _, err := q.CompleteCockpitArtifactCapture(ctx, db.CompleteCockpitArtifactCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, VersionID: c.VersionID, LeaseToken: c.LeaseToken, ExpectedHash: pgtype.Text{String: r.ContentHash, Valid: true}}); err != nil {
		return cockpitWorkflowError(err)
	}
	v, err := q.CompleteCockpitArtifactVersionCapture(ctx, db.CompleteCockpitArtifactVersionCaptureParams{WorkspaceID: c.WorkspaceID, ArtifactID: c.ArtifactID, ID: c.VersionID, StorageKey: pgtype.Text{String: r.StorageKey, Valid: true}, ObjectUrl: pgtype.Text{String: h.captured.Attempt.ObjectUrl, Valid: true}, ContentHash: pgtype.Text{String: r.ContentHash, Valid: true}, SizeBytes: pgtype.Int8{Int64: r.SizeBytes, Valid: true}, ReviewIssueID: issue.ID})
	if err != nil {
		return err
	}
	h.version = v
	if _, err = q.CreateCockpitIssuePrimary(ctx, db.CreateCockpitIssuePrimaryParams{WorkspaceID: c.WorkspaceID, IssueID: issue.ID, NodeID: h.artifact.OwnerNodeID, CreatedBy: c.CreatedBy}); err != nil {
		return err
	}
	if err = q.QueueCockpitArtifactAttemptCleanup(ctx, db.QueueCockpitArtifactAttemptCleanupParams{WorkspaceID: c.WorkspaceID, VersionID: c.VersionID, ExceptID: h.captured.Attempt.ID}); err != nil {
		return err
	}
	h.artifact, err = q.SetCockpitArtifactCurrentVersion(ctx, db.SetCockpitArtifactCurrentVersionParams{WorkspaceID: c.WorkspaceID, ID: c.ArtifactID, CurrentVersionID: c.VersionID})
	return err
}
func (s *IssueService) RetryCockpitArtifactCapture(ctx context.Context, p CockpitArtifactCaptureRetry) error {
	tx, q, a, m, err := s.beginArtifact(ctx, p.CockpitArtifactCommand)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if !artifactManager(a, p.ActorID, m.Role, p.Human) {
		return ErrCockpitWorkflowForbidden
	}
	v, err := q.LockCockpitArtifactVersion(ctx, db.LockCockpitArtifactVersionParams{WorkspaceID: p.WorkspaceID, ArtifactID: p.ArtifactID, ID: p.VersionID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if a.CurrentVersionID != v.ID || a.ArchivedAt.Valid || v.PayloadKind != "attachment" {
		return ErrCockpitWorkflowConflict
	}
	if v.Revision < p.ExpectedRevision || p.ExpectedRevision < 1 {
		return ErrCockpitWorkflowConflict
	}
	if v.CaptureStatus == "queued" || v.CaptureStatus == "running" || v.CaptureStatus == "ready" {
		return nil
	}
	if err = artifactExpected(v.Revision, p.ExpectedRevision); err != nil {
		return err
	}
	if v.Decision != "not_requested" {
		return ErrCockpitWorkflowConflict
	}
	if !s.artifactFileCaptureAvailable() {
		return ErrCockpitArtifactPrivateStorageRequired
	}
	if err = artifactReviewer(ctx, q, a.WorkspaceID, v.ReviewerID); err != nil {
		return err
	}
	if _, err = q.RetryCockpitArtifactCapture(ctx, db.RetryCockpitArtifactCaptureParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, VersionID: v.ID}); err != nil {
		return cockpitWorkflowError(err)
	}
	if _, err = q.SetCockpitArtifactVersionCapture(ctx, db.SetCockpitArtifactVersionCaptureParams{WorkspaceID: a.WorkspaceID, ArtifactID: a.ID, ID: v.ID, CaptureStatus: "queued"}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.artifactChanged(a, p.ActorID)
	return nil
}
