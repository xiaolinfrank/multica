package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func (s *IssueService) ApplyCockpitPreparationEffect(ctx context.Context, p CockpitPreparationQuery, in CockpitPreparationEffectApplyInput, opts IssueCreateOpts) (CockpitPreparationEffectResult, error) {
	var empty CockpitPreparationEffectResult
	if !p.Human {
		return empty, ErrCockpitWorkflowForbidden
	}
	if err := validatePreparationApplyInput(in); err != nil {
		return empty, err
	}
	if err := cockpitWorkflowMember(ctx, s.Queries, p.WorkspaceID, p.ActorID); err != nil {
		return empty, err
	}
	r, err := s.Queries.GetCockpitPreparationEffect(ctx, db.GetCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if err != nil {
		return empty, cockpitWorkflowError(err)
	}
	e := &cockpitPreparationExecution{service: s, query: p, input: in}
	switch r.Kind {
	case "preparation_issue":
		var intent preparationEffectIntent
		if err = json.Unmarshal(r.Input, &intent); err != nil {
			return empty, err
		}
		if intent.Slot.NewIssue == nil {
			return empty, ErrCockpitWorkflowInput
		}
		fields := intent.Slot.NewIssue
		b := intent.Binding
		_, err = s.createCockpitPreparationIssue(ctx, p.CockpitLifecycleRead, pgtype.UUID{}, CockpitPreparationIssueInput{CockpitLifecycleCommandInput: CockpitLifecycleCommandInput{CommandKey: in.CommandKey, ExpectedRevision: 1}, PrimaryNodeID: intent.NodeID, NewIssue: CockpitPreparationIssueFields{Title: fields.Title, Description: fields.Description, Priority: fields.Priority, AssigneeType: b.AssigneeType, AssigneeID: b.AssigneeID, DueDate: b.DueDate, ProjectID: intent.ProjectID, ModuleID: intent.ModuleID}}, opts, e)
	case "stop_run":
		if s.TaskService == nil {
			return empty, fmt.Errorf("task cancellation service is unavailable")
		}
		users, readErr := s.Queries.GetUsersByIDs(ctx, []pgtype.UUID{p.ActorID})
		if readErr != nil {
			return empty, readErr
		}
		if len(users) != 1 {
			return empty, ErrCockpitWorkflowForbidden
		}
		_, err = s.TaskService.CancelTaskWithResult(ctx, r.RunID, CancelTaskOptions{ClientSupportsDraftRestore: true, UserInitiated: true, CancelledBy: TaskCancellationActor{Type: "member", ID: p.ActorID, Name: users[0].Name}, CockpitPreparation: &cockpitPreparationTaskCancel{execution: e}})
	default:
		err = s.applyPreparationDatabaseEffect(ctx, e)
	}
	if err != nil {
		e.failed(err)
		return empty, err
	}
	if e.result == nil {
		return empty, fmt.Errorf("preparation effect committed without its fixed receipt")
	}
	if !e.result.Replayed {
		s.lifecycleChanged(lifecycleCommand{CockpitLifecycleRead: p.CockpitLifecycleRead})
		if e.changedIssue != nil {
			previous := ""
			if e.previousIssue != nil {
				previous = e.previousIssue.Status
			}
			s.publishCockpitWorkflowIssueUpdate(ctx, *e.changedIssue, p.ActorID, previous)
			if s.TaskService != nil {
				if len(e.cancelledWakeups) > 0 {
					s.TaskService.BroadcastCancelledTasks(ctx, util.UUIDToString(p.WorkspaceID), e.cancelledWakeups)
				}
				if e.previousIssue != nil && e.previousIssue.Status != e.changedIssue.Status {
					_ = (&IssueWakeupService{Tasks: s.TaskService}).ProcessChildEvents(ctx, e.changedIssue.ParentIssueID)
				}
			}
		}
	}
	return *e.result, nil
}

func (s *IssueService) applyPreparationDatabaseEffect(ctx context.Context, e *cockpitPreparationExecution) error {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if err = e.lock(ctx, q); err != nil {
		return err
	}
	if e.result != nil {
		return nil
	}
	p := e.query
	var receipt CockpitPreparationEffectReceipt
	switch e.effect.Kind {
	case "agenda":
		slot := e.intent.Slot
		if slot.Agenda == nil {
			return ErrCockpitWorkflowInput
		}
		if err = e.validateTemplateScope(ctx, q); err != nil {
			return err
		}
		b := e.intent.Binding
		facilitator, _ := json.Marshal(b.FacilitatorUserID)
		node, _ := json.Marshal(e.intent.NodeID)
		in := CockpitAgendaInput{Title: &slot.Agenda.Title, Purposes: &slot.Agenda.Purposes, DesiredOutcome: &slot.Agenda.DesiredOutcome, Notes: &slot.Agenda.Notes, FacilitatorUserID: facilitator, NodeID: node}
		a, err := applyAgendaFields(ctx, q, p.CockpitLifecycleRead, db.CockpitMeetingAgenda{}, in)
		if err != nil {
			return err
		}
		a, err = q.CreateCockpitMeetingAgenda(ctx, db.CreateCockpitMeetingAgendaParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Title: a.Title, Purposes: a.Purposes, DesiredOutcome: a.DesiredOutcome, Notes: a.Notes, FacilitatorUserID: a.FacilitatorUserID, NodeID: a.NodeID, ActorID: p.ActorID})
		if err != nil {
			return err
		}
		if _, err = q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID}); err != nil {
			return err
		}
		receipt = CockpitPreparationEffectReceipt{AgendaID: planningUUID(a.ID), Changed: true}
	case "issue_reference", "material_reference":
		kind := "issue"
		target, err := preparationUUID(e.intent.Binding.IssueID)
		if err != nil {
			return err
		}
		if e.effect.Kind == "material_reference" {
			kind = "artifact_reference"
			target, err = preparationUUID(e.intent.Binding.MaterialReferenceID)
			if err != nil {
				return err
			}
		}
		receipt, err = e.attachReference(ctx, q, p.MeetingID, e.agenda, kind, target, e.intent.Slot.Purpose)
		if err != nil {
			return err
		}
	case "link_meeting":
		if e.intent.IssueChoice == nil {
			return ErrCockpitWorkflowInput
		}
		choice := e.intent.IssueChoice
		target, err := preparationUUID(choice.TargetMeetingID)
		if err != nil {
			return err
		}
		agenda, err := preparationUUID(choice.TargetAgendaID)
		if err != nil {
			return err
		}
		issue, err := preparationUUID(e.intent.Binding.IssueID)
		if err != nil {
			return err
		}
		if _, err = lockLifecycleMeeting(ctx, q, p.WorkspaceID, target); err != nil {
			return err
		}
		if err = RequireCockpitMeetingPreparationOpen(ctx, q, p.WorkspaceID, target); err != nil {
			return err
		}
		receipt, err = e.attachReference(ctx, q, target, agenda, "issue", issue, "preparation")
		if err != nil {
			return err
		}
		// The receipt identifies the new reference's actual meeting through its fixed target.
		receipt.TargetMeetingID = planningUUID(target)
	case "cancel_issue", "change_due_date":
		receipt, err = e.changeIssue(ctx, q)
		if err != nil {
			return err
		}
	default:
		return ErrCockpitWorkflowInput
	}
	if err = e.finish(ctx, q, receipt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (e *cockpitPreparationExecution) validateTemplateScope(ctx context.Context, q *db.Queries) error {
	if e.intent.NodeID == nil {
		return nil
	}
	id, err := preparationUUID(e.intent.NodeID)
	if err != nil {
		return err
	}
	_, project, module, err := requireExecutionLeaf(ctx, q, e.query.WorkspaceID, id)
	if err != nil {
		return err
	}
	if e.grant.Scope == nil || e.grant.Scope.NodeID == nil || *e.grant.Scope.NodeID != *e.intent.NodeID {
		return ErrCockpitPreparationContextChanged
	}
	expectedProject, _ := preparationUUID(e.grant.Scope.ProjectID)
	expectedModule, _ := preparationUUID(e.grant.Scope.ModuleID)
	if project != expectedProject || module != expectedModule {
		return ErrCockpitPreparationContextChanged
	}
	return nil
}

func (e *cockpitPreparationExecution) attachReference(ctx context.Context, q *db.Queries, meeting, agenda pgtype.UUID, kind string, target pgtype.UUID, purpose string) (CockpitPreparationEffectReceipt, error) {
	var out CockpitPreparationEffectReceipt
	p := e.query.CockpitLifecycleRead
	p.MeetingID = meeting
	a, err := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: meeting, ID: agenda})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	if a.RemovedAt.Valid {
		return out, ErrCockpitLifecycleGone
	}
	if kind == "issue" {
		if _, err = q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: target}); err != nil {
			return out, cockpitWorkflowError(err)
		}
	}
	if err = validateAgendaReferenceTarget(ctx, q, p, kind, target); err != nil {
		return out, err
	}
	if _, err = q.GetActiveCockpitAgendaReference(ctx, db.GetActiveCockpitAgendaReferenceParams{WorkspaceID: p.WorkspaceID, AgendaID: agenda, Kind: kind, TargetID: target}); err == nil {
		return out, ErrCockpitWorkflowConflict
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	r, err := q.CreateCockpitAgendaReference(ctx, db.CreateCockpitAgendaReferenceParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: meeting, AgendaID: agenda, Kind: kind, TargetID: target, Purpose: purpose, ActorID: p.ActorID})
	if err != nil {
		return out, err
	}
	if _, err = q.BumpCockpitAgendaItemRevision(ctx, db.BumpCockpitAgendaItemRevisionParams{WorkspaceID: p.WorkspaceID, MeetingID: meeting, ID: agenda, ExpectedRevision: a.Revision, ActorID: p.ActorID}); err != nil {
		return out, err
	}
	if _, err = q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: p.WorkspaceID, ID: meeting}); err != nil {
		return out, err
	}
	out = CockpitPreparationEffectReceipt{AgendaID: planningUUID(agenda), ReferenceID: planningUUID(r.ID), Changed: true}
	if kind == "issue" {
		out.IssueID = planningUUID(target)
	}
	return out, nil
}

func (e *cockpitPreparationExecution) currentDispositionFacts(ctx context.Context, q *db.Queries) (dispositionIssueFacts, error) {
	var empty dispositionIssueFacts
	ids := []pgtype.UUID{}
	for _, raw := range e.intent.SelectedRunIDs {
		id, err := util.ParseUUID(raw)
		if err != nil {
			return empty, err
		}
		ids = append(ids, id)
	}
	facts, err := readDispositionIssues(ctx, q, e.query.CockpitLifecycleRead, []pgtype.UUID{e.effect.IssueID}, ids)
	if err != nil {
		return empty, err
	}
	f, ok := facts[e.effect.IssueID]
	if !ok {
		return empty, ErrCockpitLifecycleGone
	}
	return f, nil
}

func (e *cockpitPreparationExecution) changeIssue(ctx context.Context, q *db.Queries) (CockpitPreparationEffectReceipt, error) {
	var out CockpitPreparationEffectReceipt
	if e.intent.IssueChoice == nil {
		return out, ErrCockpitWorkflowInput
	}
	choice := e.intent.IssueChoice
	p := e.query
	if err := q.LockIssueStatusCatalogShared(ctx, p.WorkspaceID); err != nil {
		return out, err
	}
	old, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: e.effect.IssueID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	f, err := e.currentDispositionFacts(ctx, q)
	if err != nil {
		return out, err
	}
	if old.Revision != e.grant.IssueRevision {
		return out, ErrCockpitPreparationContextChanged
	}
	params := RetainedIssueUpdateFields(old)
	params.ExpectedRevision = pgtype.Int8{Int64: old.Revision, Valid: true}
	if e.effect.Kind == "cancel_issue" {
		if !f.View.CanCancel || choice.CancelStatus == nil {
			return out, ErrCockpitWorkflowForbidden
		}
		status, err := issuestatus.Resolve(ctx, q, p.WorkspaceID, *choice.CancelStatus)
		if err != nil {
			return out, err
		}
		if status.Category != "closed" {
			return out, ErrCockpitWorkflowInput
		}
		if f.Automation.WakeupHash != e.grant.WakeupHash || f.Automation.TaskHash != e.grant.TaskHash {
			return out, ErrCockpitPreparationContextChanged
		}
		params.Status = pgtype.Text{String: status.Key, Valid: true}
		if err = json.Unmarshal(f.Automation.OrdinaryWakeupIds, &out.StoppedWakeupIDs); err != nil {
			return out, err
		}
		out.StoppedWakeupTotal = f.Automation.OrdinaryWakeupCount
	} else {
		if !f.View.CanChangeDueDate {
			return out, ErrCockpitWorkflowForbidden
		}
		params.DueDate = pgtype.Date{}
		if choice.DueDate != nil {
			v, err := time.Parse("2006-01-02", *choice.DueDate)
			if err != nil {
				return out, ErrCockpitWorkflowInput
			}
			params.DueDate = pgtype.Date{Time: v, Valid: true}
		}
	}
	updated, cancelled, err := UpdateIssueStoppingWakeups(ctx, q, params)
	if err != nil {
		return out, err
	}
	e.previousIssue = &old
	e.changedIssue = &updated
	e.cancelledWakeups = cancelled
	queueIDs := make([]string, 0, len(cancelled))
	for _, t := range cancelled {
		queueIDs = append(queueIDs, util.UUIDToString(t.ID))
	}
	sort.Strings(queueIDs)
	out.CancelledQueueTotal = int64(len(queueIDs))
	out.CancelledQueueIDs = queueIDs
	if len(out.CancelledQueueIDs) > 100 {
		out.CancelledQueueIDs = out.CancelledQueueIDs[:100]
	}
	out.IssueID = planningUUID(updated.ID)
	out.Changed = updated.Revision != old.Revision || len(cancelled) > 0 || out.StoppedWakeupTotal > 0
	facts, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, []pgtype.UUID{updated.ID})
	if err != nil {
		return out, err
	}
	issue, ok := facts[updated.ID]
	if !ok {
		return out, ErrCockpitWorkflowNotFound
	}
	out.Issue = &issue
	out.FactsHash = planningHash([]any{"issue_disposition_effect_v1", out.IssueID, old.Revision, updated.Revision, out.Issue, out.TargetMeetingID, f.Automation.OrdinaryWakeupIdsHash, queueIDs})
	return out, nil
}
