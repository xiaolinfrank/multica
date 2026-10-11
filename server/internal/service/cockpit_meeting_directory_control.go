package service

import (
	"context"
	"errors"
	"path/filepath"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) RetryCockpitDirectoryOperation(ctx context.Context, p CockpitDirectoryQuery, in CockpitDirectoryRetryInput) (CockpitDirectoryCommandResult, error) {
	var out CockpitDirectoryCommandResult
	key, err := directoryCommandKey(in.CommandKey, in.ExpectedRevision)
	if err != nil {
		return out, err
	}
	in.Reason, err = directoryTrimReason(in.Reason)
	if err != nil {
		return out, err
	}
	c := directoryWrite{p.CockpitDirectoryRead, key, "directory_retry", directoryRequestHash(p.CockpitDirectoryRead, "directory_retry", []any{p.OperationID, in})}
	if replay, e := s.directoryPreflightReplay(ctx, c); replay != nil || e != nil {
		if replay != nil {
			return *replay, e
		}
		return out, e
	}
	preview, err := s.PreviewCockpitDirectoryRetry(ctx, p, CockpitDirectoryRetryPreviewInput{StepIDs: in.StepIDs})
	if err != nil {
		return out, err
	}
	if !preview.CanConfirm || preview.ContextToken != in.ContextToken || preview.OperationRevision != in.ExpectedRevision {
		return out, directoryError("context_changed", "Recheck these exact steps before authorizing another attempt.")
	}
	tx, q, m, replay, err := s.beginDirectoryWrite(ctx, c)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if replay != nil {
		return *replay, nil
	}
	principal, err := directoryPrincipal(ctx, q, p.CockpitDirectoryRead, true)
	if err != nil {
		return out, err
	}
	o, err := q.LockCockpitDirectoryOperation(ctx, db.LockCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, directoryConvertError(err)
	}
	if o.FinishedAt.Valid || o.Revision != in.ExpectedRevision {
		return out, directoryError("context_changed", "The directory plan changed.")
	}
	if err = directoryExistingPreparation(m, o); err != nil {
		return out, err
	}
	member, err := directoryMembership(ctx, q, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	responsible, _ := directoryControlAuthority(member, principal, o)
	if !responsible {
		return out, directoryError("permission_revoked", "Only the current responsible principal can retry these steps.")
	}
	all, err := q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	if err != nil {
		return out, err
	}
	steps, err := directorySelectedSteps(all, in.StepIDs)
	if err != nil {
		return out, err
	}
	if err = directoryRetryBaseGrant(ctx, q, p.CockpitDirectoryRead, m, o, all, steps); err != nil {
		return out, err
	}
	target, err := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(p.WorkspaceID), util.UUIDToString(o.RootID), o.RelativeDirectory)
	if err != nil {
		return out, directoryConvertError(err)
	}
	check := preview.CockpitDirectoryPreview
	check.Principal = &principal
	check.Target = directoryTarget(target)
	check.ObservedBinding = directoryBinding(m)
	if target.RootPath != o.RootPath || target.Directory != o.Directory || directoryPreviewToken(check, directoryRetryExtra(o, steps)) != in.ContextToken {
		return out, directoryError("context_changed", "The exact target, authorization or directory binding changed.")
	}
	g := directoryGrant(key, o.Revision+1, principal, directoryBinding(m), directoryTarget(target))
	for _, step := range steps {
		u := directoryUpdateStep(step)
		u.State = "pending"
		u.GrantCommandKey = key
		u.GrantRevision = g.Revision
		u.LastErrorCode = ""
		u.NextAttemptAt = pgtype.Timestamptz{}
		if _, err = q.UpdateCockpitDirectoryStep(ctx, u); err != nil {
			return out, err
		}
	}
	u := directoryUpdateOperation(o)
	u.State = "active"
	u.LastGrantCommandKey = key
	o, err = q.UpdateCockpitDirectoryOperation(ctx, u)
	if err != nil {
		return out, err
	}
	if err = q.ScheduleCockpitDirectorySteps(ctx, db.ScheduleCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID}); err != nil {
		return out, err
	}
	r := directoryReceipt(c, o, principal, g, append([]string{}, in.StepIDs...), &in.ContextToken, in.Reason)
	return s.finishDirectoryCommand(ctx, tx, q, m, c, o, r)
}
func (s *IssueService) ControlCockpitDirectoryOperation(ctx context.Context, p CockpitDirectoryQuery, in CockpitDirectoryControlInput) (CockpitDirectoryCommandResult, error) {
	var out CockpitDirectoryCommandResult
	key, err := directoryCommandKey(in.CommandKey, in.ExpectedRevision)
	if err != nil {
		return out, err
	}
	in.Reason, err = directoryTrimReason(in.Reason)
	if err != nil {
		return out, err
	}
	switch in.Transition {
	case "pause", "resume", "claim", "abandon":
	default:
		return out, directoryError("invalid_input", "Choose a supported directory control action.")
	}
	if (in.Transition == "claim" || in.Transition == "abandon") && in.Reason == "" {
		return out, directoryError("invalid_input", "Explain why this directory responsibility is changing or being abandoned.")
	}
	c := directoryWrite{p.CockpitDirectoryRead, key, "directory_" + in.Transition, directoryRequestHash(p.CockpitDirectoryRead, "directory_"+in.Transition, []any{p.OperationID, in})}
	tx, q, m, replay, err := s.beginDirectoryWrite(ctx, c)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if replay != nil {
		return *replay, nil
	}
	principal, err := directoryPrincipal(ctx, q, p.CockpitDirectoryRead, true)
	if err != nil {
		return out, err
	}
	member, err := directoryMembership(ctx, q, p.CockpitDirectoryRead)
	if err != nil {
		return out, err
	}
	o, err := q.LockCockpitDirectoryOperation(ctx, db.LockCockpitDirectoryOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, directoryConvertError(err)
	}
	if o.FinishedAt.Valid || o.Revision != in.ExpectedRevision {
		return out, directoryError("context_changed", "The directory plan changed or is already finished.")
	}
	responsible, manager := directoryControlAuthority(member, principal, o)
	all, err := q.ListCockpitDirectorySteps(ctx, db.ListCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	if err != nil {
		return out, err
	}
	grants, err := directoryGrants(ctx, q, p.CockpitDirectoryRead, all)
	if err != nil {
		return out, err
	}
	grant, ok := grants[o.LastGrantCommandKey]
	if !ok {
		return out, directoryError("context_changed", "The retained directory authorization is unavailable.")
	}
	u := directoryUpdateOperation(o)
	ids := []string{}
	switch in.Transition {
	case "pause":
		if (!responsible && !manager) || o.State != "active" {
			return out, directoryError("permission_revoked", "This plan cannot be paused by the current principal.")
		}
		u.State = "paused"
	case "abandon":
		if !responsible && !manager {
			return out, directoryError("permission_revoked", "This plan cannot be abandoned by the current principal.")
		}
		u.State = "abandoned"
		for _, step := range all {
			if step.State == "satisfied" || step.State == "abandoned" {
				continue
			}
			if err = directoryEndLease(ctx, q, step, "abandoned", "operation_abandoned"); err != nil {
				return out, err
			}
			su := directoryUpdateStep(step)
			su.State = "abandoned"
			su.LeaseToken = pgtype.UUID{}
			su.LeaseExpiresAt = pgtype.Timestamptz{}
			su.NextAttemptAt = pgtype.Timestamptz{}
			if _, err = q.UpdateCockpitDirectoryStep(ctx, su); err != nil {
				return out, err
			}
		}
	case "resume":
		if !responsible || o.State != "paused" {
			return out, directoryError("permission_revoked", "Only the responsible principal can resume a paused plan.")
		}
		if !directoryCanResumeSteps(all, o.ID) {
			return out, directoryError("directory_retry_required", "Recheck a failed step before resuming its dependent directories.")
		}
		problems, e := s.ValidateCockpitDirectoryGrants(ctx, q, p.CockpitDirectoryRead, m, []db.CockpitMeetingDirectoryOperation{o}, all, grants)
		if e != nil {
			return out, e
		}
		if len(problems[o.ID]) > 0 {
			return out, directoryError(problems[o.ID][0], "Recheck the affected steps before resuming this directory plan.")
		}
		u.State = "active"
	case "claim":
		hasDelegated := false
		for _, step := range all {
			if step.State != "satisfied" && step.State != "abandoned" && grants[step.GrantCommandKey].Kind == "delegated_task" {
				hasDelegated = true
			}
		}
		if responsible && !hasDelegated {
			return out, directoryError("already_responsible", "The remaining steps already carry this member's responsibility. Recheck selected steps if their facts changed.")
		}
		if err = directoryRegrantBinding(m, o, all); err != nil {
			return out, err
		}
		if principal.Source != "human" || !manager {
			return out, directoryError("permission_revoked", "A responsible member or workspace administrator must explicitly take responsibility.")
		}
		if err = directoryExistingPreparation(m, o); err != nil {
			return out, err
		}
		if s.CockpitDirectoryConfigurationError != "" {
			return out, directoryError("prepare_configuration_invalid", "Correct the directory configuration first.")
		}
		if s.CockpitDirectoryPreparer == nil {
			return out, directoryError("prepare_not_configured", "Configure directory preparation first.")
		}
		target, e := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(p.WorkspaceID), util.UUIDToString(o.RootID), o.RelativeDirectory)
		if e != nil {
			return out, directoryConvertError(e)
		}
		if target.RootPath != o.RootPath || target.Directory != o.Directory {
			return out, directoryError("root_target_changed", "A moved root requires a new directory plan.")
		}
		for _, step := range all {
			if step.State == "satisfied" || step.State == "abandoned" {
				continue
			}
			rel, err := filepath.Rel(filepath.Join(target.RootPath, target.PrepareSubpath), filepath.Join(target.RootPath, step.RelativePath))
			if err != nil || !filepath.IsLocal(rel) {
				return out, directoryError("prepare_path_outside_scope", "An unfinished fixed step is outside the current preparation scope. Use a new plan for the currently permitted target.")
			}
		}
		grant = directoryGrant(key, o.Revision+1, principal, directoryBinding(m), directoryTarget(target))
		u.LastGrantCommandKey = key
		u.ResponsibleUserID = p.CredentialOwnerID
		// Claim is an explicit new human grant. It does not impersonate the source
		// Agent or transfer its Run, and it invalidates every old unfinished lease.
		for _, step := range all {
			if step.State == "satisfied" || step.State == "abandoned" {
				continue
			}
			if err = directoryEndLease(ctx, q, step, "abandoned", "responsibility_changed"); err != nil {
				return out, err
			}
			su := directoryUpdateStep(step)
			su.GrantCommandKey = key
			su.GrantRevision = grant.Revision
			su.State = "pending"
			su.LeaseToken = pgtype.UUID{}
			su.LeaseExpiresAt = pgtype.Timestamptz{}
			su.NextAttemptAt = pgtype.Timestamptz{}
			su.LastErrorCode = ""
			if _, err = q.UpdateCockpitDirectoryStep(ctx, su); err != nil {
				return out, err
			}
			ids = append(ids, util.UUIDToString(step.ID))
		}
		// Preserve an explicit pause; taking responsibility is not a resume action.
		if o.State != "paused" {
			u.State = "active"
		}
	}
	o, err = q.UpdateCockpitDirectoryOperation(ctx, u)
	if err != nil {
		return out, err
	}
	if o.State == "active" {
		err = q.ScheduleCockpitDirectorySteps(ctx, db.ScheduleCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	} else {
		err = q.UnscheduleCockpitDirectorySteps(ctx, db.UnscheduleCockpitDirectoryStepsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	}
	if err != nil {
		return out, err
	}
	r := directoryReceipt(c, o, principal, grant, ids, nil, in.Reason)
	return s.finishDirectoryCommand(ctx, tx, q, m, c, o, r)
}
func directoryEndLease(ctx context.Context, q *db.Queries, step db.CockpitMeetingDirectoryStep, state, code string) error {
	if step.State != "running" || !step.LastAttemptID.Valid {
		return nil
	}
	_, err := q.FinishCockpitDirectoryAttempt(ctx, db.FinishCockpitDirectoryAttemptParams{WorkspaceID: step.WorkspaceID, ID: step.LastAttemptID, LeaseToken: step.LeaseToken, State: state, ErrorCode: code})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
