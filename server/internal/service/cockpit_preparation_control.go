package service

import (
	"context"
	"strings"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) ControlCockpitPreparationOperation(ctx context.Context, p CockpitPreparationQuery, in CockpitPreparationControlInput) (CockpitPreparationCommandResult, error) {
	var out CockpitPreparationCommandResult
	in.Reason = strings.TrimSpace(in.Reason)
	if !preparationText(in.Reason, 16000) {
		return out, ErrCockpitWorkflowInput
	}
	switch in.Transition {
	case "pause", "resume", "skip", "claim":
	default:
		return out, ErrCockpitWorkflowInput
	}
	if (in.Transition == "skip" || in.Transition == "claim") && in.Reason == "" {
		return out, ErrCockpitWorkflowInput
	}
	effect, e := preparationUUID(in.EffectID)
	if e != nil {
		return out, e
	}
	if (in.Transition == "skip") != effect.Valid {
		return out, ErrCockpitWorkflowInput
	}
	c, e := newLifecycleCommand(p.CockpitLifecycleRead, in.CockpitLifecycleCommandInput, "preparation_"+in.Transition, []any{p.OperationID, in})
	if e != nil {
		return out, e
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return readPreparationCommandResult(ctx, q, p.CockpitLifecycleRead, c, *old)
	}
	o, e := q.LockCockpitPreparationOperation(ctx, db.LockCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	if o.Revision != in.ExpectedRevision || o.State == "completed" {
		return out, ErrCockpitWorkflowConflict
	}
	role, e := preparationRole(ctx, q, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	responsible := o.ResponsibleUserID == p.ActorID
	manager := preparationManager(p.Human, p.ActorID, o.CreatedBy, role)
	state := o.State
	actor := o.ResponsibleUserID
	switch in.Transition {
	case "pause":
		if (!responsible && !manager) || o.State != "active" {
			return out, ErrCockpitWorkflowForbidden
		}
		state = "paused"
	case "resume":
		if !responsible {
			return out, ErrCockpitWorkflowForbidden
		}
		if o.State != "paused" && o.State != "needs_attention" {
			return out, ErrCockpitWorkflowConflict
		}
		if e = q.ResetCockpitPreparationFailures(ctx, db.ResetCockpitPreparationFailuresParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID}); e != nil {
			return out, e
		}
		state = "active"
	case "claim":
		if !manager {
			return out, ErrCockpitWorkflowForbidden
		}
		if responsible {
			return out, ErrCockpitWorkflowConflict
		}
		actor = p.ActorID
		state = "paused"
	case "skip":
		if !responsible {
			return out, ErrCockpitWorkflowForbidden
		}
		r, e := q.LockCockpitPreparationEffect(ctx, db.LockCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: o.ID, ID: effect})
		if e != nil {
			return out, cockpitWorkflowError(e)
		}
		if r.State == "applied" || r.State == "skipped" {
			return out, ErrCockpitWorkflowConflict
		}
		if _, e = q.SetCockpitPreparationEffectState(ctx, db.SetCockpitPreparationEffectStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: o.ID, ID: effect, State: "skipped", Reason: in.Reason, Revision: r.Revision}); e != nil {
			return out, e
		}
		counts, e := q.CountCockpitPreparationEffects(ctx, db.CountCockpitPreparationEffectsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
		if e != nil {
			return out, e
		}
		if counts.Applied+counts.Skipped == counts.Total {
			state = "completed"
		} else if counts.NeedsAttention == 0 && state == "needs_attention" {
			state = "paused"
		}
	}
	o, e = q.UpdateCockpitPreparationOperationState(ctx, db.UpdateCockpitPreparationOperationStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: o.ID, State: state, ResponsibleUserID: actor, Revision: o.Revision})
	if e != nil {
		return out, e
	}
	receipt := CockpitPreparationCommandReceipt{OperationID: util.UUIDToString(o.ID), Kind: o.Kind, Revision: o.Revision, State: o.State, EffectIDs: []string{}, EffectID: planningUUID(effect), Reason: in.Reason, RequestHash: c.hash, ContextToken: o.ContextToken}
	if effect.Valid {
		receipt.EffectIDs = []string{util.UUIDToString(effect)}
	}
	if e = storeLifecycleReceipt(ctx, q, c, CockpitLifecycleReceipt{Revision: x.meeting.LifecycleRevision, RequestHash: c.hash, Reason: in.Reason, Preparation: &receipt}); e != nil {
		return out, e
	}
	h, e := preparationHeader(ctx, q, p.CockpitLifecycleRead, o)
	if e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return out, e
	}
	s.lifecycleChanged(c)
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: in.CommandKey, Action: c.action, Receipt: receipt, Current: h}, nil
}
