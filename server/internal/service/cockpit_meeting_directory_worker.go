package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type directoryLease struct {
	operation db.CockpitMeetingDirectoryOperation
	step      db.CockpitMeetingDirectoryStep
	grant     CockpitDirectoryGrant
	target    cockpitnas.PreparationTarget
	denied    error
}

func (s *IssueService) beginDirectoryWorker(ctx context.Context, ws, meeting, operation pgtype.UUID) (pgx.Tx, *db.Queries, db.CockpitMeeting, db.CockpitMeetingDirectoryOperation, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.CockpitMeeting{}, db.CockpitMeetingDirectoryOperation{}, err
	}
	q := s.Queries.WithTx(tx)
	fail := func(e error) (pgx.Tx, *db.Queries, db.CockpitMeeting, db.CockpitMeetingDirectoryOperation, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, db.CockpitMeeting{}, db.CockpitMeetingDirectoryOperation{}, e
	}
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, ws); err != nil {
		return fail(err)
	}
	observed, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: ws, MeetingID: meeting, ID: operation})
	if err != nil {
		return fail(err)
	}
	// Lock an existing member before board/meeting. Missing membership is then a
	// blocked grant that the worker records, not a permanently spinning queue row.
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: ws, UserID: observed.ResponsibleUserID}); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fail(err)
	}
	m, err := lockLifecycleMeeting(ctx, q, ws, meeting)
	if err != nil {
		return fail(err)
	}
	o, err := q.LockCockpitDirectoryOperation(ctx, db.LockCockpitDirectoryOperationParams{WorkspaceID: ws, MeetingID: meeting, ID: operation})
	if err != nil {
		return fail(err)
	}
	if observed.ResponsibleUserID != o.ResponsibleUserID {
		return fail(directoryError("context_changed", "Directory responsibility changed while acquiring its locks."))
	}
	return tx, q, m, o, nil
}
func (s *IssueService) claimDirectoryStep(ctx context.Context, ws, meeting, operation pgtype.UUID) (*directoryLease, error) {
	tx, q, m, o, err := s.beginDirectoryWorker(ctx, ws, meeting, operation)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if o.State != "active" {
		return nil, nil
	}
	step, err := q.ClaimOneCockpitDirectoryStep(ctx, db.ClaimOneCockpitDirectoryStepParams{WorkspaceID: ws, OperationID: operation, AttemptID: dbid.NewV7(), LeaseToken: dbid.NewV7(), LeaseExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(30 * time.Second), Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_, err = q.CreateCockpitDirectoryAttempt(ctx, db.CreateCockpitDirectoryAttemptParams{ID: step.LastAttemptID, WorkspaceID: ws, MeetingID: meeting, OperationID: operation, StepID: step.ID, AttemptNumber: step.AttemptCount, GrantCommandKey: step.GrantCommandKey, GrantRevision: step.GrantRevision, LeaseToken: step.LeaseToken})
	if err != nil {
		return nil, err
	}
	grants, err := directoryGrants(ctx, q, CockpitDirectoryRead{WorkspaceID: ws, MeetingID: meeting}, []db.CockpitMeetingDirectoryStep{step})
	if err != nil {
		return nil, err
	}
	g, ok := grants[step.GrantCommandKey]
	if !ok {
		return nil, fmt.Errorf("missing fixed directory grant")
	}
	if g.Kind == "delegated_task" && g.Principal.AgentID != nil {
		if _, e := q.GetAgentForUpdate(ctx, directoryUUID(*g.Principal.AgentID)); e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
	}
	problems, err := s.ValidateCockpitDirectoryGrants(ctx, q, CockpitDirectoryRead{WorkspaceID: ws, MeetingID: meeting}, m, []db.CockpitMeetingDirectoryOperation{o}, []db.CockpitMeetingDirectoryStep{step}, grants)
	if err != nil {
		return nil, err
	}
	lease := &directoryLease{operation: o, step: step, grant: g}
	if len(problems[o.ID]) > 0 {
		lease.denied = directoryError(problems[o.ID][0], "The fixed grant no longer permits this step. Recheck that step explicitly.")
	} else {
		lease.target, err = s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(ws), util.UUIDToString(o.RootID), o.RelativeDirectory)
		if err != nil {
			lease.denied = directoryConvertError(err)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return lease, nil
}
func directoryObservation(o cockpitnas.PreparationObservation) *CockpitDirectoryObservation {
	if o.Directory == "" || o.ObservedAt == "" {
		return nil
	}
	return &CockpitDirectoryObservation{Directory: o.Directory, DirectoryIdentity: o.DirectoryIdentity, RootIdentity: o.RootIdentity, Outcome: o.Outcome, ObservedAt: o.ObservedAt}
}
func directoryTruncateError(s string) string {
	if len(s) <= 16000 {
		return s
	}
	b := []rune(s)
	for len(string(b)) > 16000 {
		b = b[:len(b)-1]
	}
	return string(b)
}
func (s *IssueService) finalizeDirectoryStep(ctx context.Context, lease *directoryLease, observation cockpitnas.PreparationObservation, ioErr error) error {
	ws, meeting, id := lease.operation.WorkspaceID, lease.operation.MeetingID, lease.operation.ID
	tx, q, m, o, err := s.beginDirectoryWorker(ctx, ws, meeting, id)
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrCockpitWorkflowNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	step, err := q.LockCockpitDirectoryStep(ctx, db.LockCockpitDirectoryStepParams{WorkspaceID: ws, MeetingID: meeting, OperationID: id, ID: lease.step.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	observed := directoryObservation(observation)
	var raw []byte
	if observed != nil {
		raw = directoryRaw(observed)
		if len(raw) > 16384 {
			return fmt.Errorf("directory observation exceeds its fixed receipt bound")
		}
	}
	live := step.State == "running" && step.LeaseToken == lease.step.LeaseToken && step.GrantCommandKey == lease.step.GrantCommandKey && step.GrantRevision == lease.step.GrantRevision && !o.FinishedAt.Valid
	if !live {
		if observed != nil {
			_, err = q.RecordLateCockpitDirectoryObservation(ctx, db.RecordLateCockpitDirectoryObservationParams{WorkspaceID: ws, ID: lease.step.LastAttemptID, LateReceipt: raw})
			if err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	var observedAt pgtype.Timestamptz
	var outcome pgtype.Text
	if observed != nil {
		t, e := time.Parse(time.RFC3339Nano, observed.ObservedAt)
		if e != nil {
			return e
		}
		observedAt = pgtype.Timestamptz{Time: t, Valid: true}
		outcome = pgtype.Text{String: observed.Outcome, Valid: true}
	}
	// Preserve an I/O observation when authority changes in flight, but never use
	// that observation to authorize a binding or revive an abandoned operation.
	problems, e := s.ValidateCockpitDirectoryGrants(ctx, q, CockpitDirectoryRead{WorkspaceID: ws, MeetingID: meeting}, m, []db.CockpitMeetingDirectoryOperation{o}, []db.CockpitMeetingDirectoryStep{step}, map[pgtype.UUID]CockpitDirectoryGrant{step.GrantCommandKey: lease.grant})
	if e != nil {
		return e
	}
	if ioErr == nil && len(problems[o.ID]) > 0 {
		ioErr = directoryError(problems[o.ID][0], "The directory was observed, but its authorization changed before confirmation.")
	}
	opUpdate := directoryUpdateOperation(o)
	if ioErr == nil && step.Kind == "base" {
		if m.NasDir == o.Directory {
			opUpdate.BindingResult = "unchanged"
		} else if !o.BindAfterBase {
			ioErr = directoryError("binding_changed", "The current directory differs from this fixed plan.")
		} else {
			expected := directoryEffectiveBinding(o, lease.grant, nil)
			bound, e := q.UpdateCockpitDirectoryBinding(ctx, db.UpdateCockpitDirectoryBindingParams{WorkspaceID: ws, MeetingID: meeting, NasDir: o.Directory, ExpectedRevision: expected.Revision, ObservedNasDir: expected.NASDir})
			if errors.Is(e, pgx.ErrNoRows) {
				ioErr = directoryError("binding_changed", "The meeting binding changed before the base was confirmed.")
				opUpdate.BindingResult = "conflict"
			} else if e != nil {
				return e
			} else {
				opUpdate.BindingResult = "updated"
				m.NasDir = bound.NasDir
				m.NasDirRevision = bound.NasDirRevision
				if !o.AcceptedBindingRevision.Valid && bound.NasDirRevision == lease.grant.ObservedBinding.Revision+1 {
					opUpdate.AcceptedBindingRevision = pgtype.Int8{Int64: bound.NasDirRevision, Valid: true}
				}
			}
		}
	}
	finish := db.FinishCockpitDirectoryAttemptParams{WorkspaceID: ws, ID: step.LastAttemptID, LeaseToken: step.LeaseToken, State: "succeeded", ObservedAt: observedAt, Outcome: outcome, Receipt: raw}
	su := directoryUpdateStep(step)
	su.LeaseToken = pgtype.UUID{}
	su.LeaseExpiresAt = pgtype.Timestamptz{}
	su.NextAttemptAt = pgtype.Timestamptz{}
	su.State = "satisfied"
	su.LastObservedAt = observedAt
	su.Outcome = outcome
	su.LastErrorCode = ""
	if ioErr != nil {
		converted := directoryConvertError(ioErr)
		finish.State = "failed"
		finish.ErrorCode = directoryCode(converted)
		finish.ErrorMessage = directoryTruncateError(converted.Error())
		su.State = "needs_attention"
		su.LastErrorCode = finish.ErrorCode
		attempts, e := q.CountCockpitDirectoryGrantAttempts(ctx, db.CountCockpitDirectoryGrantAttemptsParams{WorkspaceID: ws, StepID: step.ID, GrantCommandKey: step.GrantCommandKey})
		if e != nil {
			return e
		}
		var typed *CockpitDirectoryError
		if errors.As(converted, &typed) && typed.Retryable && attempts < 3 && o.State == "active" {
			su.State = "retry_wait"
			su.NextAttemptAt = pgtype.Timestamptz{Time: time.Now().Add(time.Duration(attempts) * time.Second), Valid: true}
		}
	}
	if _, err = q.FinishCockpitDirectoryAttempt(ctx, finish); err != nil {
		return err
	}
	if _, err = q.UpdateCockpitDirectoryStep(ctx, su); err != nil {
		return err
	}
	if o.State == "active" {
		if err = q.ScheduleCockpitDirectorySteps(ctx, db.ScheduleCockpitDirectoryStepsParams{WorkspaceID: ws, OperationID: id}); err != nil {
			return err
		}
	}
	counts, err := q.CountCockpitDirectoryStepStates(ctx, db.CountCockpitDirectoryStepStatesParams{WorkspaceID: ws, OperationID: id})
	if err != nil {
		return err
	}
	runnable, err := q.CountCockpitDirectoryRunnableSteps(ctx, db.CountCockpitDirectoryRunnableStepsParams{WorkspaceID: ws, OperationID: id})
	if err != nil {
		return err
	}
	if counts.Satisfied == counts.Total {
		opUpdate.State = "completed"
	} else if o.State == "active" && counts.Running == 0 && counts.RetryWait == 0 && counts.NeedsAttention > 0 && runnable == 0 {
		opUpdate.State = "needs_attention"
	}
	_, err = q.UpdateCockpitDirectoryOperation(ctx, opUpdate)
	if err != nil {
		return err
	}
	if opUpdate.State != "active" {
		if err = q.UnscheduleCockpitDirectorySteps(ctx, db.UnscheduleCockpitDirectoryStepsParams{WorkspaceID: ws, OperationID: id}); err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	s.directoryChanged(ws, meeting, id, directoryUUID(lease.grant.Principal.ActorID), lease.grant.Principal.ActorType)
	return nil
}
func (s *IssueService) DriveCockpitDirectoryOperation(ctx context.Context, ws, meeting, operation pgtype.UUID) error {
	for n := 0; n < 32; n++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		lease, err := s.claimDirectoryStep(ctx, ws, meeting, operation)
		if err != nil {
			return err
		}
		if lease == nil {
			return nil
		}
		ioErr := lease.denied
		var observation cockpitnas.PreparationObservation
		if ioErr == nil {
			ioCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			observation, ioErr = s.CockpitDirectoryPreparer.EnsurePreparedDirectory(ioCtx, lease.target, lease.step.RelativePath)
			cancel()
		}
		// Cancellation must not discard an observation. This bounded finalizer only
		// touches DB; it never starts another filesystem operation.
		finalCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		err = s.finalizeDirectoryStep(finalCtx, lease, observation, ioErr)
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}
func (s *IssueService) recoverDirectoryLeases(ctx context.Context) error {
	expired, err := s.Queries.ListExpiredCockpitDirectorySteps(ctx)
	if err != nil {
		return err
	}
	for _, r := range expired {
		if err = ctx.Err(); err != nil {
			return err
		}
		tx, q, _, o, e := s.beginDirectoryWorker(ctx, r.WorkspaceID, r.MeetingID, r.OperationID)
		if errors.Is(e, pgx.ErrNoRows) || errors.Is(e, ErrCockpitWorkflowNotFound) {
			continue
		}
		if e != nil {
			return e
		}
		e = func() error {
			defer tx.Rollback(ctx)
			st, e := q.LockCockpitDirectoryStep(ctx, db.LockCockpitDirectoryStepParams{WorkspaceID: r.WorkspaceID, MeetingID: r.MeetingID, OperationID: r.OperationID, ID: r.ID})
			if e != nil {
				return e
			}
			if st.State != "running" || st.LeaseExpiresAt.Time.After(time.Now()) {
				return nil
			}
			if e = directoryEndLease(ctx, q, st, "expired", "attempt_expired"); e != nil {
				return e
			}
			u := directoryUpdateStep(st)
			u.State = "needs_attention"
			u.LeaseToken = pgtype.UUID{}
			u.LeaseExpiresAt = pgtype.Timestamptz{}
			u.LastErrorCode = "attempt_expired"
			u.NextAttemptAt = pgtype.Timestamptz{}
			attempts, e := q.CountCockpitDirectoryGrantAttempts(ctx, db.CountCockpitDirectoryGrantAttemptsParams{WorkspaceID: r.WorkspaceID, StepID: st.ID, GrantCommandKey: st.GrantCommandKey})
			if e != nil {
				return e
			}
			if attempts < 3 && o.State == "active" {
				u.State = "retry_wait"
				u.NextAttemptAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
			}
			if _, e = q.UpdateCockpitDirectoryStep(ctx, u); e != nil {
				return e
			}
			if u.State == "needs_attention" && o.State == "active" {
				op := directoryUpdateOperation(o)
				op.State = "needs_attention"
				if _, e = q.UpdateCockpitDirectoryOperation(ctx, op); e != nil {
					return e
				}
				if e = q.UnscheduleCockpitDirectorySteps(ctx, db.UnscheduleCockpitDirectoryStepsParams{WorkspaceID: r.WorkspaceID, OperationID: o.ID}); e != nil {
					return e
				}
			}
			return tx.Commit(ctx)
		}()
		if e != nil {
			return e
		}
	}
	return nil
}
func directoryWorkerError(ctx context.Context, phase string, err error) {
	if err != nil && ctx.Err() == nil && !errors.Is(err, pgx.ErrNoRows) && !errors.Is(err, ErrCockpitWorkflowNotFound) {
		slog.WarnContext(ctx, "meeting directory worker could not confirm progress", "phase", phase, "error", err)
	}
}
func (s *IssueService) runDirectoryExecutor(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if s.CockpitMeetingDirectoryBackendReady {
			candidates, err := s.Queries.ListCockpitDirectoryDueCandidates(ctx)
			directoryWorkerError(ctx, "read_due", err)
			if err == nil {
				seen := map[pgtype.UUID]bool{}
				for _, c := range candidates {
					if seen[c.OperationID] {
						continue
					}
					seen[c.OperationID] = true
					if ctx.Err() != nil {
						return
					}
					directoryWorkerError(ctx, "execute", s.DriveCockpitDirectoryOperation(ctx, c.WorkspaceID, c.MeetingID, c.OperationID))
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *IssueService) RunCockpitDirectoryWorker(ctx context.Context) {
	// These are fixed process-lifetime executors, not per-attempt goroutines
	// abandoned on timeout. A kernel call may retain one slot until it returns;
	// its original executor still owns finalization of that exact attempt.
	for range 2 {
		go s.runDirectoryExecutor(ctx)
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if s.CockpitMeetingDirectoryBackendReady {
			directoryWorkerError(ctx, "recover_lease", s.recoverDirectoryLeases(ctx))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
