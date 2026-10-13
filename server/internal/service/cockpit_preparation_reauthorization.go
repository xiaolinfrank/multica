package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func preparationReauthorization(ctx context.Context, q *db.Queries, p CockpitPreparationQuery, x lifecycleState, o db.CockpitMeetingPreparationOperation, r db.CockpitMeetingPreparationEffect) (CockpitPreparationReauthorizationPreview, preparationAuthorizationFacts, bool, error) {
	var next preparationAuthorizationFacts
	var intent preparationEffectIntent
	old, err := decodePreparationGrant(r)
	if err != nil {
		return CockpitPreparationReauthorizationPreview{}, next, false, err
	}
	if err = json.Unmarshal(r.Input, &intent); err != nil {
		return CockpitPreparationReauthorizationPreview{}, next, false, err
	}
	out := CockpitPreparationReauthorizationPreview{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), OperationID: util.UUIDToString(o.ID), EffectID: util.UUIDToString(r.ID), EffectRevision: r.Revision, CommandKey: util.UUIDToString(r.CommandKey), FixedIntentHash: r.RequestHash, PreviousAuthorization: old.CockpitPreparationAuthorization, Targets: []IssueOperationTarget{}, CanConfirm: p.Human && o.ResponsibleUserID == p.ActorID && o.State != "completed" && r.State == "needs_attention" && r.Receipt == nil, BlockedReasons: []string{}}
	if !out.CanConfirm {
		out.BlockedReasons = append(out.BlockedReasons, "effect_reauthorization_unavailable")
	}
	missing := false
	deny := func(code string) { out.CanConfirm = false; out.BlockedReasons = append(out.BlockedReasons, code) }
	next = old
	switch r.Kind {
	case "cancel_issue", "change_due_date", "link_meeting", "stop_run":
		excluded := []pgtype.UUID{}
		for _, raw := range intent.SelectedRunIDs {
			id, err := util.ParseUUID(raw)
			if err != nil {
				return out, next, false, err
			}
			excluded = append(excluded, id)
		}
		facts, err := readDispositionIssues(ctx, q, p.CockpitLifecycleRead, []pgtype.UUID{r.IssueID}, excluded)
		if err != nil {
			return out, next, false, err
		}
		f, found := facts[r.IssueID]
		if !found {
			missing = true
			deny("target_unavailable")
		} else {
			impact := f.View
			impact.EvaluatesParentRules = r.Kind == "cancel_issue" && impact.ParentIssueID != nil
			out.CurrentImpact = &impact
			next.Impact = &impact
			next.IssueRevision = f.View.IssueRevision
			next.WakeupHash = f.Automation.WakeupHash
			next.TaskHash = f.Automation.TaskHash
			out.Targets = append(out.Targets, IssueOperationTarget{Kind: "issue", IssueID: util.UUIDToString(r.IssueID), Label: f.View.Issue.Identifier, Purpose: "preparation"})
			if r.Kind == "cancel_issue" && (!f.View.CanCancel || intent.IssueChoice == nil || intent.IssueChoice.CancelStatus == nil || f.View.CancelStatus == nil || *intent.IssueChoice.CancelStatus != *f.View.CancelStatus) {
				deny("formal_or_status_restriction")
			}
			if r.Kind == "link_meeting" && intent.IssueChoice != nil {
				target, _ := preparationUUID(intent.IssueChoice.TargetMeetingID)
				m, err := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: target})
				if errors.Is(err, pgx.ErrNoRows) {
					missing = true
					deny("target_unavailable")
				} else if err != nil {
					return out, next, false, err
				} else if requireMeetingPreparationOpen(m) != nil {
					deny("target_meeting_preparation_closed")
				}
				out.Targets = append(out.Targets, IssueOperationTarget{Kind: "meeting", MeetingID: util.UUIDToString(target), View: "preparation", Label: "Target meeting", Purpose: "preparation"})
			}
		}
		if r.Kind == "stop_run" {
			rows, err := q.GetCockpitDispositionRunsByIDs(ctx, db.GetCockpitDispositionRunsByIDsParams{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, RunIds: []pgtype.UUID{r.RunID}})
			if err != nil {
				return out, next, false, err
			}
			if len(rows) != 1 || rows[0].IssueID != r.IssueID {
				missing = true
				deny("target_unavailable")
			} else {
				row := rows[0]
				role, err := preparationRole(ctx, q, p.CockpitLifecycleRead)
				if err != nil {
					return out, next, false, err
				}
				accessible := row.PermissionMode.Valid && memberMayViewAgentFacts(row.OwnerID, p.ActorID, role, row.PermissionMode.String, row.TargetMatches)
				active := row.Status == "queued" || row.Status == "deferred" || row.Status == "dispatched" || row.Status == "running" || row.Status == "waiting_local_directory"
				current := CockpitDispositionRun{ID: util.UUIDToString(row.ID), IssueID: util.UUIDToString(row.IssueID), AgentID: util.UUIDToString(row.AgentID), Status: row.Status, StartedAt: lifecycleTime(row.StartedAt), IsWakeup: row.IsWakeup, CanStop: p.Human && accessible && active, BlockedReasons: []string{}}
				if accessible {
					current.AgentName = row.AgentName
				} else {
					current.BlockedReasons = append(current.BlockedReasons, "task_not_accessible")
					deny("task_not_accessible")
				}
				out.CurrentRun = &current
				next.SelectedRun = &current
				next.RunStatus = row.Status
			}
		}
		next.FactsHash = planningHash([]any{r.Kind, r.IssueID, next.IssueRevision, next.WakeupHash, next.TaskHash, r.RunID, next.RunStatus})
	default:
		deny("unknown_preparation_effect")
	}
	out.ContextToken = planningHash([]any{"preparation_reauthorization_v1", p.WorkspaceID, p.MeetingID, p.ActorID, o.ID, o.Revision, r.ID, r.Revision, r.RequestHash, next.FactsHash, out.CurrentImpact, out.CurrentRun, out.CurrentScope, out.CanConfirm, out.BlockedReasons})
	return out, next, missing, nil
}

func (s *IssueService) PreviewCockpitPreparationReauthorization(ctx context.Context, p CockpitPreparationQuery) (CockpitPreparationReauthorizationPreview, error) {
	var out CockpitPreparationReauthorizationPreview
	tx, q, x, err := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	o, err := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	r, err := q.GetCockpitPreparationEffect(ctx, db.GetCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	out, _, _, err = preparationReauthorization(ctx, q, p, x, o, r)
	return out, err
}

func (s *IssueService) ReauthorizeCockpitPreparationEffect(ctx context.Context, p CockpitPreparationQuery, in CockpitPreparationReauthorizationInput) (CockpitPreparationCommandResult, error) {
	var out CockpitPreparationCommandResult
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || !preparationText(in.Reason, 16000) {
		return out, ErrCockpitWorkflowInput
	}
	c, err := newLifecycleCommand(p.CockpitLifecycleRead, in.CockpitLifecycleCommandInput, "preparation_reauthorize", []any{p.OperationID, p.EffectID, in})
	if err != nil {
		return out, err
	}
	tx, q, x, old, err := s.beginLifecycleWrite(ctx, c)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return readPreparationCommandResult(ctx, q, p.CockpitLifecycleRead, c, *old)
	}
	o, err := q.LockCockpitPreparationOperation(ctx, db.LockCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	r, err := q.LockCockpitPreparationEffect(ctx, db.LockCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	preview, next, missing, err := preparationReauthorization(ctx, q, p, x, o, r)
	if err != nil {
		return out, err
	}
	if missing {
		return out, ErrCockpitLifecycleGone
	}
	if !preview.CanConfirm || in.ExpectedRevision != r.Revision || in.ContextToken != preview.ContextToken {
		return out, ErrCockpitPreparationContextChanged
	}
	next.Key = in.CommandKey
	next.Revision = r.AuthorizationRevision + 1
	next.ContextToken = in.ContextToken
	next.ConfirmedBy = util.UUIDToString(p.ActorID)
	next.ConfirmedAt = x.meeting.DatabaseNow.Time.UTC().Format(time.RFC3339Nano)
	body, err := json.Marshal(next)
	if err != nil {
		return out, err
	}
	if _, err = q.ReauthorizeCockpitPreparationEffect(ctx, db.ReauthorizeCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID, AuthorizationKey: c.key, AuthorizationHash: next.FactsHash, AuthorizationSnapshot: body, Revision: r.Revision}); err != nil {
		return out, err
	}
	counts, err := q.CountCockpitPreparationEffects(ctx, db.CountCockpitPreparationEffectsParams{WorkspaceID: p.WorkspaceID, OperationID: p.OperationID})
	if err != nil {
		return out, err
	}
	state := o.State
	if state == "needs_attention" && counts.NeedsAttention == 0 {
		state = "active"
	}
	o, err = q.UpdateCockpitPreparationOperationState(ctx, db.UpdateCockpitPreparationOperationStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: o.ID, State: state, ResponsibleUserID: o.ResponsibleUserID, Revision: o.Revision})
	if err != nil {
		return out, err
	}
	receipt := CockpitPreparationCommandReceipt{OperationID: util.UUIDToString(o.ID), Kind: o.Kind, Revision: o.Revision, State: o.State, EffectIDs: []string{util.UUIDToString(r.ID)}, EffectID: planningUUID(r.ID), Reason: in.Reason, RequestHash: c.hash, ContextToken: in.ContextToken, Authorization: &next.CockpitPreparationAuthorization, PreviousAuthorization: &preview.PreviousAuthorization}
	if err = storeLifecycleReceipt(ctx, q, c, CockpitLifecycleReceipt{Revision: x.meeting.LifecycleRevision, RequestHash: c.hash, Reason: in.Reason, Preparation: &receipt}); err != nil {
		return out, err
	}
	h, err := preparationHeader(ctx, q, p.CockpitLifecycleRead, o)
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.lifecycleChanged(c)
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: in.CommandKey, Action: c.action, Receipt: receipt, Current: h}, nil
}
