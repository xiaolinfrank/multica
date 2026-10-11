package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type preparationAuthorizationFacts struct {
	CockpitPreparationAuthorization
	IssueRevision int64  `json:"issue_revision"`
	WakeupHash    string `json:"wakeup_hash"`
	TaskHash      string `json:"task_hash"`
	RunStatus     string `json:"run_status"`
}

type cockpitPreparationExecution struct {
	service          *IssueService
	query            CockpitPreparationQuery
	input            CockpitPreparationEffectApplyInput
	operation        db.CockpitMeetingPreparationOperation
	effect           db.CockpitMeetingPreparationEffect
	meeting          lifecycleState
	intent           preparationEffectIntent
	grant            preparationAuthorizationFacts
	agenda           pgtype.UUID
	checked          bool
	result           *CockpitPreparationEffectResult
	previousIssue    *db.Issue
	changedIssue     *db.Issue
	cancelledWakeups []db.AgentTaskQueue
}

func decodePreparationGrant(e db.CockpitMeetingPreparationEffect) (preparationAuthorizationFacts, error) {
	var grant preparationAuthorizationFacts
	if err := json.Unmarshal(e.AuthorizationSnapshot, &grant); err != nil {
		return grant, err
	}
	if grant.Key != util.UUIDToString(e.AuthorizationKey) || grant.Revision != e.AuthorizationRevision || grant.FactsHash != e.AuthorizationHash {
		return grant, fmt.Errorf("preparation grant does not match its persisted authorization")
	}
	return grant, nil
}

func validatePreparationApplyInput(in CockpitPreparationEffectApplyInput) error {
	if _, e := util.ParseUUID(in.CommandKey); e != nil {
		return ErrCockpitWorkflowInput
	}
	if _, e := util.ParseUUID(in.AuthorizationKey); e != nil || in.AuthorizationRevision < 1 {
		return ErrCockpitWorkflowInput
	}
	return nil
}

func (e *cockpitPreparationExecution) lock(ctx context.Context, q *db.Queries) error {
	p := e.query
	if !p.Human {
		return ErrCockpitWorkflowForbidden
	}
	c := lifecycleCommand{CockpitLifecycleRead: p.CockpitLifecycleRead}
	if err := lockLifecycleMember(ctx, q, c); err != nil {
		return err
	}
	if _, err := lockLifecycleMeeting(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return err
	}
	x, err := readLifecycleState(ctx, q, p.CockpitLifecycleRead)
	if err != nil {
		return err
	}
	e.meeting = x
	o, err := q.LockCockpitPreparationOperation(ctx, db.LockCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	r, err := q.LockCockpitPreparationEffect(ctx, db.LockCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if util.UUIDToString(r.CommandKey) != e.input.CommandKey || util.UUIDToString(r.AuthorizationKey) != e.input.AuthorizationKey || r.AuthorizationRevision != e.input.AuthorizationRevision {
		return ErrCockpitPreparationContextChanged
	}
	e.operation = o
	e.effect = r
	e.grant, err = decodePreparationGrant(r)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(r.Input, &e.intent); err != nil {
		return err
	}
	if r.State == "applied" {
		var receipt CockpitPreparationEffectReceipt
		if err = json.Unmarshal(r.Receipt, &receipt); err != nil {
			return err
		}
		if receipt.EffectID != util.UUIDToString(r.ID) || receipt.CommandKey != e.input.CommandKey || receipt.AuthorizationKey != e.input.AuthorizationKey || receipt.AuthorizationRevision != e.input.AuthorizationRevision {
			return ErrCockpitPreparationContextChanged
		}
		if err = verifyPreparationReceiptTargets(ctx, q, p.CockpitLifecycleRead, receipt); err != nil {
			return err
		}
		h, err := preparationHeader(ctx, q, p.CockpitLifecycleRead, o)
		if err != nil {
			return err
		}
		e.result = &CockpitPreparationEffectResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, OperationID: h.ID, EffectID: receipt.EffectID, CommandKey: receipt.CommandKey, Replayed: true, Receipt: receipt, Current: h}
		return nil
	}
	if o.ResponsibleUserID != p.ActorID {
		return ErrCockpitWorkflowForbidden
	}
	if o.State != "active" || r.State != "pending" {
		return ErrCockpitWorkflowConflict
	}
	e.checked = true
	if o.Kind == "apply_template" {
		if x.meeting.OccurrenceState == "cancelled" {
			return ErrCockpitWorkflowConflict
		}
		if x.meeting.ArchivedAt.Valid {
			confirmed, err := time.Parse(time.RFC3339Nano, e.grant.ConfirmedAt)
			if err != nil || o.CreatedAt.Time.After(x.meeting.ArchivedAt.Time) || confirmed.After(x.meeting.ArchivedAt.Time) {
				return ErrCockpitWorkflowConflict
			}
		}
	}
	if r.DependencyID.Valid {
		d, err := q.GetCockpitPreparationEffect(ctx, db.GetCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: o.ID, ID: r.DependencyID})
		if err != nil {
			return cockpitWorkflowError(err)
		}
		if d.State != "applied" || !d.AgendaID.Valid {
			return fmt.Errorf("%w: complete the prerequisite agenda first", ErrCockpitWorkflowConflict)
		}
		a, err := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: d.AgendaID})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && a.RemovedAt.Valid) {
			return ErrCockpitLifecycleGone
		}
		if err != nil {
			return err
		}
		e.agenda = a.ID
	}
	return nil
}

func verifyPreparationReceiptTargets(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, r CockpitPreparationEffectReceipt) error {
	if r.TargetMeetingID != nil {
		id, err := preparationUUID(r.TargetMeetingID)
		if err != nil {
			return err
		}
		p.MeetingID = id
	}
	if r.AgendaID != nil {
		id, _ := preparationUUID(r.AgendaID)
		a, err := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && a.RemovedAt.Valid) {
			return ErrCockpitLifecycleGone
		}
		if err != nil {
			return err
		}
	}
	if r.ReferenceID != nil {
		agenda, _ := preparationUUID(r.AgendaID)
		id, _ := preparationUUID(r.ReferenceID)
		ref, err := q.GetCockpitAgendaReference(ctx, db.GetCockpitAgendaReferenceParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: agenda, ID: id})
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && ref.RemovedAt.Valid) {
			return ErrCockpitLifecycleGone
		}
		if err != nil {
			return err
		}
		if err = validateAgendaReferenceTarget(ctx, q, p, ref.Kind, ref.TargetID); err != nil {
			if errors.Is(err, ErrCockpitWorkflowNotFound) || errors.Is(err, ErrCockpitWorkflowConflict) {
				return ErrCockpitLifecycleGone
			}
			return err
		}
	}
	if r.IssueID != nil {
		id, _ := preparationUUID(r.IssueID)
		if _, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: id}); errors.Is(err, pgx.ErrNoRows) {
			return ErrCockpitLifecycleGone
		} else if err != nil {
			return err
		}
	}
	if r.RunID != nil {
		id, _ := preparationUUID(r.RunID)
		if _, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: id}); errors.Is(err, pgx.ErrNoRows) {
			return ErrCockpitLifecycleGone
		} else if err != nil {
			return err
		}
	}
	return nil
}

func (e *cockpitPreparationExecution) finish(ctx context.Context, q *db.Queries, r CockpitPreparationEffectReceipt) error {
	p := e.query
	r.EffectID = util.UUIDToString(e.effect.ID)
	r.CommandKey = util.UUIDToString(e.effect.CommandKey)
	r.RequestHash = e.effect.RequestHash
	r.Kind = e.effect.Kind
	r.AuthorizationKey = util.UUIDToString(e.effect.AuthorizationKey)
	r.AuthorizationRevision = e.effect.AuthorizationRevision
	r.AppliedAt = time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	if r.StoppedWakeupIDs == nil {
		r.StoppedWakeupIDs = []string{}
	}
	if r.CancelledQueueIDs == nil {
		r.CancelledQueueIDs = []string{}
	}
	if r.FactsHash == "" {
		if r.StoppedWakeupTotal > int64(len(r.StoppedWakeupIDs)) || r.CancelledQueueTotal > int64(len(r.CancelledQueueIDs)) {
			return fmt.Errorf("an effect with sampled identities requires its complete effects hash")
		}
		r.FactsHash = planningHash([]any{r.Kind, r.Changed, r.TargetMeetingID, r.AgendaID, r.ReferenceID, r.IssueID, r.RunID, r.RunStatus, r.Issue, r.StoppedWakeupIDs, r.CancelledQueueIDs})
	}
	if len(r.StoppedWakeupIDs) > 100 {
		r.StoppedWakeupIDs = r.StoppedWakeupIDs[:100]
	}
	if len(r.CancelledQueueIDs) > 100 {
		r.CancelledQueueIDs = r.CancelledQueueIDs[:100]
	}
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	agenda, _ := preparationUUID(r.AgendaID)
	ref, _ := preparationUUID(r.ReferenceID)
	issue, _ := preparationUUID(r.IssueID)
	run, _ := preparationUUID(r.RunID)
	_, err = q.ApplyCockpitPreparationEffect(ctx, db.ApplyCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID, AgendaID: agenda, ReferenceID: ref, IssueID: issue, RunID: run, Receipt: body, AppliedBy: p.ActorID})
	if err != nil {
		return err
	}
	counts, err := q.CountCockpitPreparationEffects(ctx, db.CountCockpitPreparationEffectsParams{WorkspaceID: p.WorkspaceID, OperationID: p.OperationID})
	if err != nil {
		return err
	}
	state := e.operation.State
	if counts.Applied+counts.Skipped == counts.Total {
		state = "completed"
	}
	o, err := q.UpdateCockpitPreparationOperationState(ctx, db.UpdateCockpitPreparationOperationStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID, State: state, ResponsibleUserID: e.operation.ResponsibleUserID, Revision: e.operation.Revision})
	if err != nil {
		return err
	}
	h, err := preparationHeader(ctx, q, p.CockpitLifecycleRead, o)
	if err != nil {
		return err
	}
	e.result = &CockpitPreparationEffectResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, OperationID: h.ID, EffectID: r.EffectID, CommandKey: r.CommandKey, Receipt: r, Current: h}
	return nil
}

// Failure recording cannot overwrite a new grant or another actor's takeover.
func (e *cockpitPreparationExecution) failed(cause error) {
	if !e.checked {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := e.service.TxStarter.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	q := e.service.Queries.WithTx(tx)
	p := e.query
	if err = lockLifecycleMember(ctx, q, lifecycleCommand{CockpitLifecycleRead: p.CockpitLifecycleRead}); err != nil {
		return
	}
	if _, err = lockLifecycleMeeting(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return
	}
	o, err := q.LockCockpitPreparationOperation(ctx, db.LockCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if err != nil || o.State == "completed" || o.ResponsibleUserID != p.ActorID {
		return
	}
	r, err := q.LockCockpitPreparationEffect(ctx, db.LockCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if err != nil || r.State != "pending" || r.AuthorizationRevision != e.input.AuthorizationRevision || util.UUIDToString(r.AuthorizationKey) != e.input.AuthorizationKey {
		return
	}
	code := "preparation_failed"
	if errors.Is(cause, ErrCockpitWorkflowConflict) {
		code = "context_changed"
	}
	if errors.Is(cause, ErrCockpitWorkflowForbidden) {
		code = "target_forbidden"
	}
	if errors.Is(cause, ErrCockpitLifecycleGone) || errors.Is(cause, ErrCockpitWorkflowNotFound) {
		code = "target_unavailable"
	}
	if _, err = q.SetCockpitPreparationEffectState(ctx, db.SetCockpitPreparationEffectStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID, State: "needs_attention", ErrorCode: code, Revision: r.Revision}); err != nil {
		return
	}
	if _, err = q.UpdateCockpitPreparationOperationState(ctx, db.UpdateCockpitPreparationOperationStateParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID, State: "needs_attention", ResponsibleUserID: o.ResponsibleUserID, Revision: o.Revision}); err != nil {
		return
	}
	if tx.Commit(ctx) == nil {
		e.service.lifecycleChanged(lifecycleCommand{CockpitLifecycleRead: p.CockpitLifecycleRead})
	}
}

type cockpitPreparationTaskCancel struct {
	execution  *cockpitPreparationExecution
	testBefore func(context.Context, *db.Queries, pgtype.UUID) (*db.AgentTaskQueue, error)
	testAfter  func(context.Context, *db.Queries, db.AgentTaskQueue, bool) error
}

func (h *cockpitPreparationTaskCancel) Before(ctx context.Context, q *db.Queries, taskID pgtype.UUID) (*db.AgentTaskQueue, error) {
	if h.testBefore != nil {
		return h.testBefore(ctx, q, taskID)
	}
	if h.execution == nil {
		return nil, ErrCockpitWorkflowInput
	}
	e := h.execution
	if err := e.lock(ctx, q); err != nil {
		return nil, err
	}
	if e.effect.Kind != "stop_run" || e.effect.RunID != taskID {
		return nil, ErrCockpitWorkflowInput
	}
	t, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: e.query.WorkspaceID, ID: taskID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	if t.ChatSessionID.Valid || !t.IssueID.Valid || t.IssueID != e.effect.IssueID {
		return nil, ErrCockpitWorkflowForbidden
	}
	if e.result != nil {
		return &t, nil
	}
	a, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: e.query.WorkspaceID, ID: t.AgentID})
	if err != nil {
		return nil, cockpitWorkflowError(err)
	}
	allowed, err := MemberMayViewAgent(ctx, q, a, e.query.ActorID, e.query.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrCockpitWorkflowForbidden
	}
	// The explicitly selected run IDs are excluded from this digest so this
	// operation's earlier stops do not invalidate its remaining exact targets.
	// A newly queued, unselected run is still a material change to the preview.
	active := t.Status == "queued" || t.Status == "deferred" || t.Status == "dispatched" || t.Status == "running" || t.Status == "waiting_local_directory"
	if active {
		facts, err := e.currentDispositionFacts(ctx, q)
		if err != nil {
			return nil, err
		}
		if facts.Automation.TaskHash != e.grant.TaskHash {
			return nil, ErrCockpitPreparationContextChanged
		}
	}
	return nil, nil
}

func (h *cockpitPreparationTaskCancel) After(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, changed bool) error {
	if h.testAfter != nil {
		return h.testAfter(ctx, q, task, changed)
	}
	if h.execution == nil {
		return ErrCockpitWorkflowInput
	}
	status := task.Status
	return h.execution.finish(ctx, q, CockpitPreparationEffectReceipt{IssueID: planningUUID(task.IssueID), RunID: planningUUID(task.ID), RunStatus: &status, Changed: changed})
}
