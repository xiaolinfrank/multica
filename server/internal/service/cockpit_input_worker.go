package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// RunCockpitInputWorker uses two fixed I/O loops and an independent metadata
// sweep. All I/O also shares the same two-slot budget as HTTP uploads/downloads.
func (s *IssueService) RunCockpitInputWorker(ctx context.Context) {
	var wg sync.WaitGroup
	verifyNext := false
	captureOrVerify := func(ctx context.Context) (bool, error) {
		verifyNext = !verifyNext
		first, second := s.ProcessNextCockpitInputCapture, s.ProcessNextCockpitInputVerification
		if verifyNext {
			first, second = second, first
		}
		worked, err := first(ctx)
		if worked || err != nil {
			return worked, err
		}
		return second(ctx)
	}
	for _, work := range []func(context.Context) (bool, error){captureOrVerify, s.ProcessNextCockpitInputCleanup} {
		wg.Add(1)
		go func(work func(context.Context) (bool, error)) {
			defer wg.Done()
			for ctx.Err() == nil {
				worked, err := work(ctx)
				if err != nil && !errors.Is(err, context.Canceled) && inputErrorCode(err) != "input_io_busy" {
					slog.Warn("input worker attempt", "code", inputErrorCode(err))
				}
				if !worked || err != nil {
					select {
					case <-ctx.Done():
						return
					case <-time.After(time.Second):
					}
				}
			}
		}(work)
	}
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-ticker.C:
			if err := s.SweepCockpitInputLeases(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("input lease sweep", "error", err)
			}
		}
	}
}

func (s *IssueService) ProcessNextCockpitInputCapture(ctx context.Context) (bool, error) {
	if !s.inputFileCaptureAvailable() {
		return false, nil
	}
	awaiting, err := s.Queries.ReadCockpitInputCaptureAwaitingFinalize(ctx)
	if err == nil {
		err = s.inputFinalizeCaptured(ctx, awaiting)
		if err != nil {
			_, deferErr := s.Queries.DeferCockpitInputCaptureFinalize(ctx, db.DeferCockpitInputCaptureFinalizeParams{WorkspaceID: awaiting.WorkspaceID, ID: awaiting.ID, ErrorCode: inputErrorCode(err)})
			err = errors.Join(err, deferErr)
		}
		return true, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	release, err := s.inputIOBudget.reserve(ctx, CockpitInputMaxFileBytes)
	if err != nil {
		return false, err
	}
	defer release()
	t, err := s.Queries.ClaimCockpitInputReconciliation(ctx, dbid.NewV7())
	reconcile := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		t, err = s.Queries.ClaimCockpitInputSourceCapture(ctx, dbid.NewV7())
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ioctx, cancel := context.WithTimeout(ctx, cockpitInputIOTimeout)
	defer cancel()
	stop := s.inputMaintainLease(ioctx, t)
	defer stop()
	if reconcile {
		if err = s.inputReconcileOwnedCopy(ioctx, t); err != nil {
			var capture *artifactcapture.Error
			if errors.As(err, &capture) && capture.Retryable || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				deferCtx, cancelDefer := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
				_, deferErr := s.Queries.DeferCockpitInputReconciliation(deferCtx, db.DeferCockpitInputReconciliationParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken, LeaseToken_2: dbid.NewV7(), ErrorCode: inputErrorCode(err)})
				cancelDefer()
				return true, errors.Join(err, deferErr)
			}
			s.inputFailAcceptedTransfer(t, err)
			return true, err
		}
		if t.Kind == "source_capture" {
			return true, s.inputFinalizeCaptured(ctx, t)
		}
		return true, nil
	}
	tx, q, _, v, current, err := s.beginInputTransferCheckpoint(ioctx, t)
	if err != nil {
		s.inputFailAcceptedTransfer(t, err)
		return true, err
	}
	if _, err = q.SetCockpitInputCapturing(ioctx, db.SetCockpitInputCapturingParams{WorkspaceID: t.WorkspaceID, ID: t.VersionID, ActiveTransferID: t.ID}); err != nil {
		_ = tx.Rollback(ioctx)
		return true, err
	}
	if err = tx.Commit(ioctx); err != nil {
		return true, err
	}
	{
		var reader io.ReadCloser
		reader, err = s.inputOpenSource(ioctx, v)
		if err == nil {
			if v.SourceKind == "nas_file" {
				var updated int64
				updated, err = s.Queries.RecordCockpitInputSourceBefore(ioctx, db.RecordCockpitInputSourceBeforeParams{WorkspaceID: current.WorkspaceID, ID: current.ID, LeaseToken: current.LeaseToken, SourceBeforeRootIdentity: v.SourceRootIdentity, SourceBeforeFileIdentity: v.SourceFileIdentity, SourceBeforeSize: v.SourceSize, SourceBeforeMtimeNs: v.SourceMtimeNs})
				if err != nil || updated != 1 {
					closeErr := reader.Close()
					if err == nil {
						err = inputError("transfer_changed", "The capture changed after its source was opened.")
					}
					s.inputFailAcceptedTransfer(current, err)
					return true, errors.Join(err, closeErr)
				}
			}
			expected := v.ClientSha256.String
			if v.ContentHash.Valid {
				expected = v.ContentHash.String
			}
			progress := &inputProgressReader{ctx: ioctx, source: reader, queries: s.Queries, transfer: current}
			prepared, prepareErr := artifactcapture.PrepareBytes(ioctx, progress, s.CockpitInputCapturer.TempDir, current.ExpectedBytes, expected)
			closeErr := reader.Close()
			err = errors.Join(prepareErr, closeErr)
			if prepared != nil {
				if err == nil {
					err = s.inputWritePrepared(ioctx, current, prepared)
				}
				err = errors.Join(err, prepared.Close())
			}
		}
	}
	if err != nil {
		s.inputRecoverOrFailAcceptedTransfer(current, err)
		return true, err
	}
	// Source captures were explicitly authorized as complete capture commands.
	// Direct uploads retain their separate human/task finalize checkpoint.
	if current.Kind == "source_capture" {
		return true, s.inputFinalizeCaptured(ctx, current)
	}
	return true, nil
}

func (s *IssueService) inputOpenSource(ctx context.Context, v db.CockpitInputVersion) (io.ReadCloser, error) {
	switch v.SourceKind {
	case "nas_file":
		if s.CockpitInputConfigurationError != "" {
			return nil, inputError(s.CockpitInputConfigurationError, "The configured input source is unavailable.")
		}
		if s.CockpitInputNAS == nil {
			return nil, inputError("input_scope_not_configured", "No permitted NAS input source is configured.")
		}
		return s.CockpitInputNAS.OpenInput(ctx, inputStoredNASObservation(v))
	case "attachment":
		a, err := s.Queries.GetAttachment(ctx, db.GetAttachmentParams{WorkspaceID: v.WorkspaceID, ID: v.SourceAttachmentID})
		if err != nil {
			return nil, inputConvertError(err)
		}
		if a.IssueID != v.SourceAttachmentIssueID || a.SizeBytes != v.DeclaredSizeBytes.Int64 {
			return nil, inputError("source_changed", "The original attachment identity changed.")
		}
		key := s.CockpitInputStorage.KeyFromURL(a.Url)
		if key == "" || !strings.HasPrefix(key, "workspaces/"+util.UUIDToString(v.WorkspaceID)+"/") || strings.Contains(key, "..") || strings.Contains(key, "\\") {
			return nil, inputError("source_unavailable", "The attachment has no owned source object in this workspace.")
		}
		return s.CockpitInputStorage.GetReader(ctx, key)
	case "artifact_version":
		if v.PayloadKind == "text" {
			a, err := s.Queries.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: v.WorkspaceID, ArtifactID: v.SourceArtifactID, ID: v.SourceArtifactVersionID})
			if err != nil {
				return nil, inputConvertError(err)
			}
			if !a.Content.Valid || a.CaptureStatus != "ready" || a.ContentHash != v.ContentHash || a.SizeBytes != v.PinnedSizeBytes {
				return nil, inputError("source_changed", "The fixed artifact no longer identifies these exact bytes.")
			}
			return io.NopCloser(strings.NewReader(a.Content.String)), nil
		}
		a, err := s.Queries.ReadCockpitArtifactFile(ctx, db.ReadCockpitArtifactFileParams{WorkspaceID: v.WorkspaceID, ArtifactID: v.SourceArtifactID, ID: v.SourceArtifactVersionID})
		if err != nil {
			return nil, inputConvertError(err)
		}
		if a.ContentHash != v.ContentHash || a.SizeBytes != v.PinnedSizeBytes || !a.StorageKey.Valid {
			return nil, inputError("source_changed", "The fixed artifact file no longer identifies these exact bytes.")
		}
		// The caller's one spool verifies the same immutable artifact pin. There
		// is no second full-file spool or invented attachment identity.
		if s.CockpitArtifactCapturer == nil || !storage.SupportsPrivateArtifactFiles(s.CockpitArtifactCapturer.Store) {
			return nil, inputError("private_storage_required", "The original artifact file requires its private storage provider.")
		}
		return s.CockpitArtifactCapturer.Store.GetReader(ctx, a.StorageKey.String)
	default:
		return nil, inputError("source_unavailable", "This source requires an explicit byte upload.")
	}
}

func (s *IssueService) inputReconcileOwnedCopy(ctx context.Context, accepted db.CockpitInputTransfer) error {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	t, err := q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, VersionID: accepted.VersionID, ID: accepted.ID})
	if err != nil {
		return inputConvertError(err)
	}
	v, err := q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, ID: accepted.VersionID})
	if err != nil {
		return inputConvertError(err)
	}
	key, err := artifactcapture.InputTargetKey(artifactcapture.InputTarget{WorkspaceID: util.UUIDToString(t.WorkspaceID), VersionID: util.UUIDToString(t.VersionID), TransferID: util.UUIDToString(t.ID), Filename: v.Filename, ContentType: v.ContentType})
	if err != nil {
		return err
	}
	if t.State != "verifying" || t.LeaseToken != accepted.LeaseToken || t.OwnedStorageKey != key || v.ActiveTransferID != t.ID || !t.ContentHash.Valid || t.ContentHash != v.ContentHash || t.PinnedSizeBytes != v.PinnedSizeBytes {
		return inputError("transfer_changed", "The reconciliation lease is no longer current.")
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = s.CockpitInputCapturer.VerifyInput(ctx, key, t.PinnedSizeBytes.Int64, t.ContentHash.String); err != nil {
		return err
	}
	return s.inputRecordVerifiedIO(ctx, t)
}

func (s *IssueService) inputFinalizeCaptured(ctx context.Context, accepted db.CockpitInputTransfer) error {
	p := inputTransferRead(accepted)
	key := dbid.NewV7()
	tx, q, err := s.beginInputCommand(ctx, p, key)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	a, err := inputPrincipalWithGrant(ctx, q, p, true, false, true)
	if err != nil {
		return err
	}
	ids, err := inputParsePrincipalIDs(a.Principal)
	if err != nil {
		return err
	}
	if ids.authorizer != accepted.AuthorizingUserID || ids.issue != accepted.SourceIssueID {
		return inputError("permission_revoked", "The captured input's original delegation changed.")
	}
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: accepted.WorkspaceID, ID: accepted.InputID}); err != nil {
		return err
	}
	v, err := q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, ID: accepted.VersionID})
	if err != nil {
		return err
	}
	t, err := q.LockCockpitInputTransfer(ctx, db.LockCockpitInputTransferParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, VersionID: accepted.VersionID, ID: accepted.ID})
	if err != nil {
		return err
	}
	if t.State == "verified" {
		return tx.Commit(ctx)
	}
	if t.State != "awaiting_finalize" || t.Kind != "source_capture" || v.ActiveTransferID != t.ID || t.ContentHash != v.ContentHash || t.PinnedSizeBytes != v.PinnedSizeBytes || t.IoOutcome.String != "verified" {
		return inputError("transfer_changed", "This captured copy is no longer awaiting acceptance.")
	}
	query := CockpitInputQuery{CockpitInputRead: p, InputID: t.InputID, VersionID: t.VersionID, TransferID: t.ID}
	in := CockpitInputFinalizeInput{CommandKey: util.UUIDToString(key), ExpectedRevision: t.Revision, ExpectedContentHash: t.ContentHash.String}
	hash := inputWriteHash(p, "input_transfer_finalize", t.ID, in)
	receipt := inputTransferReceipt(query, a.Principal, t, in.CommandKey, hash, "input_transfer_finalize", "", "verified", t.Revision, t.Revision+1)
	if _, err = q.FinalizeCockpitInputTransfer(ctx, db.FinalizeCockpitInputTransferParams{WorkspaceID: t.WorkspaceID, VersionID: t.VersionID, ID: t.ID, FinalizeKey: key, FinalizeHash: pgtype.Text{String: hash, Valid: true}, FinalizeReceipt: inputRaw(receipt)}); err != nil {
		return err
	}
	if _, err = q.PublishCockpitInputCopy(ctx, db.PublishCockpitInputCopyParams{WorkspaceID: t.WorkspaceID, InputID: t.InputID, ID: t.VersionID, CurrentTransferID: t.ID, ContentHash: t.ContentHash, PinnedSizeBytes: t.PinnedSizeBytes}); err != nil {
		return err
	}
	if v.CurrentTransferID.Valid && v.CurrentTransferID != t.ID {
		if _, err = q.QueueSupersededCockpitInputCopy(ctx, db.QueueSupersededCockpitInputCopyParams{WorkspaceID: t.WorkspaceID, VersionID: t.VersionID, ID: v.CurrentTransferID}); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.inputChanged(t.WorkspaceID, t.InputID, a.Principal)
	return nil
}

func (s *IssueService) SweepCockpitInputLeases(ctx context.Context) error {
	if _, err := s.Queries.RecoverCockpitInputVerificationLeases(ctx); err != nil {
		return err
	}
	if _, err := s.Queries.RecoverCockpitInputCleanupLeases(ctx); err != nil {
		return err
	}
	rows, err := s.Queries.ListCockpitInputExpiredTransfers(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		tx, e := s.TxStarter.Begin(ctx)
		if e != nil {
			return e
		}
		q := s.Queries.WithTx(tx)
		if _, e = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: row.WorkspaceID, ID: row.InputID}); e == nil {
			_, e = q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: row.WorkspaceID, InputID: row.InputID, ID: row.VersionID})
		}
		if e == nil {
			var t db.CockpitInputTransfer
			t, e = q.ExpireCockpitInputTransfer(ctx, db.ExpireCockpitInputTransferParams{WorkspaceID: row.WorkspaceID, ID: row.ID})
			if e == nil {
				_, e = q.ClearCockpitInputActiveTransfer(ctx, db.ClearCockpitInputActiveTransferParams{WorkspaceID: t.WorkspaceID, InputID: t.InputID, ID: t.VersionID, ActiveTransferID: t.ID, CaptureErrorCode: t.ErrorCode, CaptureError: t.ErrorMessage})
			}
		}
		if e == nil {
			e = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
	}
	return nil
}

func (s *IssueService) ProcessNextCockpitInputCleanup(ctx context.Context) (bool, error) {
	if s.CockpitInputStorage == nil {
		return false, nil
	}
	release, err := s.inputIOBudget.reserve(ctx, 0)
	if err != nil {
		return false, err
	}
	defer release()
	t, err := s.Queries.ClaimCockpitInputObjectCleanup(ctx, dbid.NewV7())
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	key, err := artifactcapture.InputTargetKey(artifactcapture.InputTarget{WorkspaceID: util.UUIDToString(t.WorkspaceID), VersionID: util.UUIDToString(t.VersionID), TransferID: util.UUIDToString(t.ID), Filename: "cleanup.bin", ContentType: "application/octet-stream"})
	if err == nil && key != t.OwnedStorageKey {
		err = inputError("invalid_input", "The cleanup key is outside this exact owned transfer.")
	}
	if err == nil {
		allowed, e := s.Queries.CanCleanupCockpitInputTransfer(ctx, db.CanCleanupCockpitInputTransferParams{WorkspaceID: t.WorkspaceID, ID: t.ID, CleanupLeaseToken: t.CleanupLeaseToken})
		err = e
		if err == nil && !allowed {
			err = inputError("transfer_changed", "The object is current or its cleanup lease changed; it cannot be removed.")
		}
	}
	if err == nil {
		ioctx, cancel := context.WithTimeout(ctx, cockpitInputIOTimeout)
		err = s.CockpitInputStorage.DeleteObject(ioctx, key)
		cancel()
	}
	state, delay := "deleted", pgtype.Interval{Microseconds: int64(24 * time.Hour / time.Microsecond), Valid: true}
	if err != nil {
		state, delay = "retry_wait", pgtype.Interval{Microseconds: int64(time.Minute / time.Microsecond), Valid: true}
	}
	finish, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	_, saveErr := s.Queries.FinishCockpitInputObjectCleanup(finish, db.FinishCockpitInputObjectCleanupParams{ID: t.ID, WorkspaceID: t.WorkspaceID, CleanupLeaseToken: t.CleanupLeaseToken, CleanupState: state, RetryAfter: delay})
	return true, errors.Join(err, saveErr)
}
