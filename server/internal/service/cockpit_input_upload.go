package service

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func inputTransferRead(t db.CockpitInputTransfer) CockpitInputRead {
	p := CockpitInputRead{WorkspaceID: t.WorkspaceID, CredentialOwnerID: t.CredentialOwnerUserID, ActorSource: "human"}
	if t.ActorType.String == "agent" {
		p.ActorSource, p.AgentID, p.RunID = "task_token", t.SourceAgentID, t.SourceRunID
	}
	return p
}

// The accepted transfer is the sole authority passed to background work. This
// private path cannot create a new grant or replace its actor with a human.
func (s *IssueService) beginInputTransferCheckpoint(ctx context.Context, accepted db.CockpitInputTransfer) (pgx.Tx, *db.Queries, cockpitInputAuthority, db.CockpitInputVersion, db.CockpitInputTransfer, error) {
	var a cockpitInputAuthority
	var v db.CockpitInputVersion
	var t db.CockpitInputTransfer
	p := inputTransferRead(accepted)
	tx, q, err := s.beginInputCommand(ctx, p, dbid.NewV7())
	if err != nil {
		return nil, nil, a, v, t, err
	}
	fail := func(e error) (pgx.Tx, *db.Queries, cockpitInputAuthority, db.CockpitInputVersion, db.CockpitInputTransfer, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, a, v, t, e
	}
	a, err = inputPrincipalWithGrant(ctx, q, p, true, false, true)
	if err != nil {
		return fail(err)
	}
	ids, err := inputParsePrincipalIDs(a.Principal)
	if err != nil {
		return fail(err)
	}
	if ids.authorizer != accepted.AuthorizingUserID || ids.actor != accepted.ActorID || ids.issue != accepted.SourceIssueID || ids.runtime != accepted.SourceRuntimeID {
		return fail(inputError("permission_revoked", "The persisted transfer's precise authorization is no longer valid."))
	}
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: accepted.WorkspaceID, ID: accepted.InputID}); err != nil {
		return fail(inputConvertError(err))
	}
	v, err = q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, ID: accepted.VersionID})
	if err != nil {
		return fail(inputConvertError(err))
	}
	t, err = q.LockCockpitInputTransfer(ctx, db.LockCockpitInputTransferParams{WorkspaceID: accepted.WorkspaceID, InputID: accepted.InputID, VersionID: accepted.VersionID, ID: accepted.ID})
	if err != nil {
		return fail(inputConvertError(err))
	}
	if t.LeaseToken != accepted.LeaseToken || !t.LeaseToken.Valid || t.FinishedAt.Valid || v.ActiveTransferID != t.ID {
		return fail(inputError("transfer_changed", "This transfer no longer owns the current input attempt."))
	}
	return tx, q, a, v, t, nil
}

func (s *IssueService) UploadCockpitInputBytes(ctx context.Context, p CockpitInputQuery, revision int64, body io.Reader) (CockpitInputUploadResult, error) {
	out := CockpitInputUploadResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: util.UUIDToString(p.InputID), VersionID: util.UUIDToString(p.VersionID), TransferID: util.UUIDToString(p.TransferID)}
	if revision < 1 || body == nil {
		return out, inputError("invalid_input", "Upload requires the observed transfer revision and a byte stream.")
	}
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, dbid.NewV7())
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputNewPrincipal(ctx, q, p.CockpitInputRead, true); err != nil {
		return out, err
	}
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID}); err != nil {
		return out, inputConvertError(err)
	}
	v, err := q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputConvertError(err)
	}
	t, err := q.LockCockpitInputTransfer(ctx, db.LockCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if t.Revision != revision {
		return out, inputError("revision_conflict", "This upload attempt changed. Reconcile its current result before sending bytes.")
	}
	items, err := s.inputTransfers(ctx, q, p.CockpitInputRead, []db.CockpitInputTransfer{t})
	if err != nil {
		return out, err
	}
	if len(items) != 1 || !items[0].CanUpload {
		return out, inputError("upload_unavailable", "This principal or transfer cannot accept bytes. Reconcile the original attempt before restarting.")
	}
	release, err := s.inputIOBudget.reserve(ctx, t.ExpectedBytes)
	if err != nil {
		return out, err
	}
	defer release()
	t, err = q.ClaimCockpitInputUpload(ctx, db.ClaimCockpitInputUploadParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID, Revision: revision, LeaseToken: dbid.NewV7(), LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().UTC().Add(90 * time.Second), Valid: true}})
	if err != nil {
		return out, inputConvertError(err)
	}
	if _, err = q.SetCockpitInputCapturing(ctx, db.SetCockpitInputCapturingParams{WorkspaceID: p.WorkspaceID, ID: p.VersionID, ActiveTransferID: t.ID}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	ioctx, cancel := context.WithTimeout(ctx, cockpitInputIOTimeout)
	defer cancel()
	stopLease := s.inputMaintainLease(ioctx, t)
	defer stopLease()
	expectedHash := v.ClientSha256.String
	if v.ContentHash.Valid {
		expectedHash = v.ContentHash.String
	}
	progress := &inputProgressReader{ctx: ioctx, source: body, queries: s.Queries, transfer: t}
	prepared, err := artifactcapture.PrepareBytes(ioctx, progress, s.CockpitInputCapturer.TempDir, t.ExpectedBytes, expectedHash)
	if err != nil {
		s.inputFailAcceptedTransfer(t, err)
		return out, inputConvertError(err)
	}
	defer prepared.Close()
	err = errors.Join(s.inputWritePrepared(ioctx, t, prepared), prepared.Close())
	if err != nil {
		s.inputRecoverOrFailAcceptedTransfer(t, err)
		return out, inputConvertError(err)
	}
	txRead, qr, _, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	defer txRead.Rollback(ctx)
	current, err := qr.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID})
	if err != nil {
		return out, inputConvertError(err)
	}
	items, err = s.inputTransfers(ctx, qr, p.CockpitInputRead, []db.CockpitInputTransfer{current})
	if err != nil && !errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, err
	}
	if err == nil && len(items) == 1 {
		out.Current = &items[0]
	}
	return out, txRead.Commit(ctx)
}

// inputWritePrepared is shared by direct uploads and source capture. A durable
// content pin precedes the one storage write; an ambiguous result is never
// retried by uploading a second spool to the same owned key.
func (s *IssueService) inputWritePrepared(ctx context.Context, accepted db.CockpitInputTransfer, prepared *artifactcapture.PreparedBytes) error {
	tx, q, _, v, t, err := s.beginInputTransferCheckpoint(ctx, accepted)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if t.State != "reading" || t.ExpectedBytes != prepared.SizeBytes() {
		return inputError("transfer_changed", "The byte-reading attempt is no longer current.")
	}
	if v.ContentHash.Valid && (v.ContentHash.String != prepared.ContentHash() || v.PinnedSizeBytes.Int64 != prepared.SizeBytes()) {
		return inputError("input_content_mismatch", "Restored bytes must exactly match the original fixed input version.")
	}
	hash, size := pgtype.Text{String: prepared.ContentHash(), Valid: true}, pgtype.Int8{Int64: prepared.SizeBytes(), Valid: true}
	if t.Kind == "source_capture" && v.SourceKind == "nas_file" {
		// The provider's successful EOF and Close have compared the held file,
		// path, root and metadata with this exact original observation.
		if _, err = q.RecordCockpitInputSourceAfter(ctx, db.RecordCockpitInputSourceAfterParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken, SourceAfterFileIdentity: v.SourceFileIdentity, SourceAfterSize: v.SourceSize, SourceAfterMtimeNs: v.SourceMtimeNs}); err != nil {
			return err
		}
	}
	if _, err = q.PinCockpitInputTransfer(ctx, db.PinCockpitInputTransferParams{WorkspaceID: t.WorkspaceID, VersionID: t.VersionID, ID: t.ID, LeaseToken: t.LeaseToken, Revision: t.Revision, ContentHash: hash, PinnedSizeBytes: size}); err != nil {
		return err
	}
	if !v.ContentHash.Valid {
		if _, err = q.PinCockpitInputVersion(ctx, db.PinCockpitInputVersionParams{WorkspaceID: t.WorkspaceID, InputID: t.InputID, ID: t.VersionID, ActiveTransferID: t.ID, ContentHash: hash, PinnedSizeBytes: size}); err != nil {
			return err
		}
	}
	if _, err = q.SetCockpitInputTransferWriting(ctx, db.SetCockpitInputTransferWritingParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	if err = s.CockpitInputCapturer.WriteInputAndVerify(ctx, artifactcapture.InputTarget{WorkspaceID: util.UUIDToString(t.WorkspaceID), VersionID: util.UUIDToString(t.VersionID), TransferID: util.UUIDToString(t.ID), Filename: v.Filename, ContentType: v.ContentType}, prepared); err != nil {
		return err
	}
	finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	return s.inputRecordVerifiedIO(finalCtx, accepted)
}

// This records an observed storage fact, not a new user authorization. It does
// not publish readiness. A revoked source principal cannot finalize or read the
// bytes, while a current manager can explicitly accept an already verified copy.
func (s *IssueService) inputRecordVerifiedIO(ctx context.Context, accepted db.CockpitInputTransfer) error {
	current, err := s.Queries.CompleteCockpitInputTransferIO(ctx, db.CompleteCockpitInputTransferIOParams{WorkspaceID: accepted.WorkspaceID, ID: accepted.ID, LeaseToken: accepted.LeaseToken})
	if err != nil {
		_, lateErr := s.Queries.ObserveCockpitInputLateIO(ctx, db.ObserveCockpitInputLateIOParams{WorkspaceID: accepted.WorkspaceID, ID: accepted.ID, LeaseToken: accepted.LeaseToken, IoOutcome: pgtype.Text{String: "verified", Valid: true}})
		return errors.Join(inputConvertError(err), lateErr)
	}
	s.inputChanged(current.WorkspaceID, current.InputID, CockpitInputPrincipal{ActorType: current.ActorType.String, ActorID: util.UUIDToString(current.ActorID)})
	return nil
}

func (s *IssueService) inputFailAcceptedTransfer(t db.CockpitInputTransfer, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	// Failure recovery locks in the same input -> version -> transfer order and
	// only modifies the still-owned lease. It cannot revive an abandoned attempt.
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: t.WorkspaceID, ID: t.InputID}); err != nil {
		return
	}
	if _, err = q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: t.WorkspaceID, InputID: t.InputID, ID: t.VersionID}); err != nil {
		return
	}
	code := inputErrorCode(cause)
	failed, err := q.FailCockpitInputTransfer(ctx, db.FailCockpitInputTransferParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken, State: "failed", ErrorCode: code, ErrorMessage: "The input attempt could not finish. Reconcile its fixed result or explicitly create a new attempt."})
	if err != nil {
		return
	}
	if _, err = q.ClearCockpitInputActiveTransfer(ctx, db.ClearCockpitInputActiveTransferParams{WorkspaceID: t.WorkspaceID, InputID: t.InputID, ID: t.VersionID, ActiveTransferID: failed.ID, CaptureErrorCode: code, CaptureError: failed.ErrorMessage}); err != nil {
		return
	}
	if tx.Commit(ctx) == nil {
		s.inputChanged(t.WorkspaceID, t.InputID, CockpitInputPrincipal{ActorType: t.ActorType.String, ActorID: util.UUIDToString(t.ActorID)})
	}
}

func (s *IssueService) inputRecoverOrFailAcceptedTransfer(t db.CockpitInputTransfer, cause error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The attempt's exact owned key and content pin make this a read-only
	// reconciliation. A new lease identity fences the original request keeper.
	updated, err := s.Queries.ScheduleCockpitInputReconciliation(ctx, db.ScheduleCockpitInputReconciliationParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken, LeaseToken_2: dbid.NewV7(), ErrorCode: inputErrorCode(cause)})
	if err == nil && updated == 1 {
		s.inputChanged(t.WorkspaceID, t.InputID, CockpitInputPrincipal{ActorType: t.ActorType.String, ActorID: util.UUIDToString(t.ActorID)})
		return
	}
	s.inputFailAcceptedTransfer(t, cause)
}

// There are at most two active I/O reservations, hence at most two lease
// keepers. A blocked provider retains its slot; cancellation does not spawn a
// replacement I/O goroutine behind its back.
func (s *IssueService) inputMaintainLease(ctx context.Context, t db.CockpitInputTransfer) func() {
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				leaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				_, _ = s.Queries.RenewCockpitInputTransferLease(leaseCtx, db.RenewCockpitInputTransferLeaseParams{WorkspaceID: t.WorkspaceID, ID: t.ID, LeaseToken: t.LeaseToken})
				cancel()
			}
		}
	}()
	return func() { close(stop); <-done }
}

type inputProgressReader struct {
	ctx      context.Context
	source   io.Reader
	queries  *db.Queries
	transfer db.CockpitInputTransfer
	bytes    atomic.Int64
	last     time.Time
}

func (r *inputProgressReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.source.Read(p)
	count := r.bytes.Add(int64(n))
	if count > r.transfer.ExpectedBytes {
		return n, inputError("input_content_mismatch", "The upload exceeds its declared fixed size.")
	}
	if n > 0 && (r.last.IsZero() || time.Since(r.last) >= time.Second) {
		updated, e := r.queries.UpdateCockpitInputTransferProgress(r.ctx, db.UpdateCockpitInputTransferProgressParams{WorkspaceID: r.transfer.WorkspaceID, ID: r.transfer.ID, LeaseToken: r.transfer.LeaseToken, BytesReceived: pgtype.Int8{Int64: count, Valid: true}})
		r.last = time.Now()
		if e != nil {
			return n, e
		}
		if updated != 1 {
			return n, inputError("transfer_changed", "The upload lease is no longer current.")
		}
	}
	return n, err
}
