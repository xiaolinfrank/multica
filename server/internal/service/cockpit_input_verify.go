package service

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// Verify schedules a durable metadata observation. It never reads a potentially
// large object within the ordinary JSON request's deadline.
func (s *IssueService) VerifyCockpitInputVersion(ctx context.Context, p CockpitInputQuery) (CockpitInputVersionMetadata, error) {
	var out CockpitInputVersionMetadata
	if _, err := s.ReadCockpitInputFile(ctx, p); err != nil {
		return out, err
	}
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, dbid.NewV7())
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	a, err := inputReadPrincipal(ctx, q, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	if _, err = q.QueueCockpitInputVerification(ctx, db.QueueCockpitInputVerificationParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID}); err != nil {
		return out, err
	}
	v, err := q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputConvertError(err)
	}
	rows, err := s.inputVersions(ctx, q, p.CockpitInputRead, []db.CockpitInputVersion{v})
	if err != nil {
		return out, err
	}
	if len(rows) != 1 {
		return out, inputError("permission_revoked", "The selected fixed input is no longer readable.")
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, a.Principal)
	return rows[0], nil
}

// This maintenance path reads only an already fixed owned/borrowed object. It
// neither reopens a mutable NAS/attachment source nor grants the caller access
// to any bytes. Current readers still pass their own principal checks.
func (s *IssueService) ProcessNextCockpitInputVerification(ctx context.Context) (bool, error) {
	release, err := s.inputIOBudget.reserve(ctx, CockpitInputMaxFileBytes)
	if err != nil {
		return false, err
	}
	defer release()
	v, err := s.Queries.ClaimCockpitInputVerification(ctx, dbid.NewV7())
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ioctx, cancel := context.WithTimeout(ctx, cockpitInputIOTimeout)
	defer cancel()
	stop := s.inputMaintainVerificationLease(ioctx, v)
	defer stop()
	var file CockpitInputFile
	tx, q, probeErr := s.beginPlanningRead(ioctx)
	if probeErr == nil {
		_, probeErr = q.GetCockpitInput(ioctx, db.GetCockpitInputParams{WorkspaceID: v.WorkspaceID, ID: v.InputID})
		if probeErr == nil {
			current, e := q.GetCockpitInputVersion(ioctx, db.GetCockpitInputVersionParams{WorkspaceID: v.WorkspaceID, InputID: v.InputID, ID: v.ID})
			probeErr = e
			if e == nil && (current.VerificationGeneration != v.VerificationGeneration || current.VerificationLeaseToken != v.VerificationLeaseToken) {
				_ = tx.Rollback(ioctx)
				return true, nil
			}
		}
		if probeErr == nil {
			file, probeErr = s.inputFileDescriptor(ioctx, q, v)
		}
		if probeErr == nil {
			probeErr = tx.Commit(ioctx)
		} else {
			_ = tx.Rollback(ioctx)
		}
	}
	if probeErr == nil {
		reader, e := s.inputOpenFixedDescriptor(ioctx, file)
		probeErr = e
		if probeErr == nil {
			probeErr = reader.Close()
		}
	}
	availability, code := "available", ""
	if probeErr != nil {
		availability, code = "unavailable", inputErrorCode(probeErr)
		if errors.Is(probeErr, ErrCockpitWorkflowForbidden) || code == "input_io_busy" || code == "input_changed" || code == "verification_timeout" || code == "capture_spool_unavailable" {
			availability = "unknown"
		}
	}
	finish, cancelFinish := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancelFinish()
	updated, saveErr := s.Queries.FinishCockpitInputVerification(finish, db.FinishCockpitInputVerificationParams{WorkspaceID: v.WorkspaceID, InputID: v.InputID, ID: v.ID, Generation: v.VerificationGeneration, LeaseToken: v.VerificationLeaseToken, CurrentTransferID: v.CurrentTransferID, ContentHash: v.ContentHash.String, Availability: availability, ErrorCode: code})
	if saveErr != nil {
		return true, saveErr
	}
	if updated != 1 {
		return true, nil
	} // A newer copy/probe owns the current observation.
	s.inputChanged(v.WorkspaceID, v.InputID, CockpitInputPrincipal{ActorType: "system"})
	return true, probeErr
}

func (s *IssueService) inputMaintainVerificationLease(ctx context.Context, v db.CockpitInputVersion) func() {
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				lease, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				_, _ = s.Queries.RenewCockpitInputVerificationLease(lease, db.RenewCockpitInputVerificationLeaseParams{WorkspaceID: v.WorkspaceID, ID: v.ID, VerificationLeaseToken: v.VerificationLeaseToken, VerificationGeneration: v.VerificationGeneration})
				cancel()
			}
		}
	}()
	return func() { close(stop); <-done }
}
