package service

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
	case "link_meeting":
		if e.intent.IssueChoice == nil {
			return ErrCockpitWorkflowInput
		}
		choice := e.intent.IssueChoice
		target, err := preparationUUID(choice.TargetMeetingID)
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
		receipt, err = linkPreparationIssueToMeeting(ctx, q, p.WorkspaceID, target, issue, p.ActorID)
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

// linkPreparationIssueToMeeting files the retained preparation issue under the
// target meeting as an ordinary meeting link — the meeting-issue association
// is the only meeting↔issue binding after agenda references were removed.
// The caller holds the target meeting lock in this transaction, so the purpose
// merge is serialized with ordinary association and purpose edits.
func linkPreparationIssueToMeeting(ctx context.Context, q *db.Queries, workspace, meeting, issue pgtype.UUID, actor pgtype.UUID) (CockpitPreparationEffectReceipt, error) {
	if _, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: issue}); err != nil {
		return CockpitPreparationEffectReceipt{}, cockpitWorkflowError(err)
	}
	if err := q.AppendCockpitMeetingIssue(ctx, db.AppendCockpitMeetingIssueParams{WorkspaceID: workspace, MeetingID: meeting, IssueID: issue}); err != nil {
		return CockpitPreparationEffectReceipt{}, err
	}
	link, err := q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: workspace, MeetingID: meeting, IssueID: issue})
	if err != nil {
		return CockpitPreparationEffectReceipt{}, err
	}
	if !slices.Contains(link.Roles, "preparation") {
		if _, err := q.UpdateCockpitMeetingIssueRoles(ctx, db.UpdateCockpitMeetingIssueRolesParams{WorkspaceID: workspace, MeetingID: meeting, IssueID: issue, Roles: append(link.Roles, "preparation")}); err != nil {
			return CockpitPreparationEffectReceipt{}, err
		}
	}
	return CockpitPreparationEffectReceipt{IssueID: planningUUID(issue), Changed: true}, nil
}
