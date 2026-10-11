package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func dispositionSlotID(kind string, id pgtype.UUID) string {
	h := sha256.Sum256([]byte("meeting-disposition-slot-v1:" + kind + ":" + util.UUIDToString(id)))
	var out pgtype.UUID
	copy(out.Bytes[:], h[:16])
	out.Bytes[6] = (out.Bytes[6] & 15) | 128
	out.Bytes[8] = (out.Bytes[8] & 63) | 128
	out.Valid = true
	return util.UUIDToString(out)
}

func normalizeCancellation(in *CockpitCancellationPreviewInput) error {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || !templateText(in.Reason, 16000) || len(in.Issues) > 50 || len(in.RunIDs) > 50 {
		return ErrCockpitWorkflowInput
	}
	seen := map[pgtype.UUID]bool{}
	effects := len(in.RunIDs)
	for i := range in.Issues {
		c := &in.Issues[i]
		id, e := util.ParseUUID(c.IssueID)
		if e != nil || seen[id] || c.ExpectedRevision < 1 {
			return ErrCockpitWorkflowInput
		}
		seen[id] = true
		c.IssueID = util.UUIDToString(id)
		switch c.Action {
		case "retain":
			if c.CancelStatus != nil || c.DueDate != nil || c.TargetMeetingID != nil || c.TargetAgendaID != nil {
				return ErrCockpitWorkflowInput
			}
		case "cancel":
			if c.CancelStatus == nil || *c.CancelStatus == "" || c.DueDate != nil || c.TargetMeetingID != nil || c.TargetAgendaID != nil {
				return ErrCockpitWorkflowInput
			}
			effects++
		case "change_due_date":
			if c.CancelStatus != nil || c.TargetMeetingID != nil || c.TargetAgendaID != nil {
				return ErrCockpitWorkflowInput
			}
			if c.DueDate != nil {
				if _, e := time.Parse("2006-01-02", *c.DueDate); e != nil {
					return ErrCockpitWorkflowInput
				}
			}
			effects++
		case "link_meeting":
			if c.CancelStatus != nil || c.DueDate != nil || c.TargetMeetingID == nil || c.TargetAgendaID == nil {
				return ErrCockpitWorkflowInput
			}
			if _, e := preparationUUID(c.TargetMeetingID); e != nil {
				return e
			}
			if _, e := preparationUUID(c.TargetAgendaID); e != nil {
				return e
			}
			effects++
		default:
			return ErrCockpitWorkflowInput
		}
	}
	seen = map[pgtype.UUID]bool{}
	for i, raw := range in.RunIDs {
		id, e := util.ParseUUID(raw)
		if e != nil || seen[id] {
			return ErrCockpitWorkflowInput
		}
		seen[id] = true
		in.RunIDs[i] = util.UUIDToString(id)
	}
	if effects > 50 {
		return ErrCockpitWorkflowInput
	}
	return nil
}

type cancellationPlan struct {
	View    CockpitCancellationPreview
	Intents []preparationEffectIntent
}

func readCancellationPreview(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, x lifecycleState, in CockpitCancellationPreviewInput) (cancellationPlan, error) {
	var plan cancellationPlan
	if e := normalizeCancellation(&in); e != nil {
		return plan, e
	}
	intent := "cancel"
	if x.meeting.OccurrenceState == "cancelled" {
		intent = "append_disposition"
	}
	plan.View = CockpitCancellationPreview{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), LifecycleRevision: x.meeting.LifecycleRevision, Intent: intent, Occurrence: lifecycleOccurrence(x.meeting), Effects: []CockpitPreparationPreviewEffect{}, CanConfirm: lifecycleManager(ctx, q, x, p), BlockedReasons: []string{}}
	if !plan.View.CanConfirm {
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "workflow_manager_required")
	}
	if x.meeting.OccurrenceState != "unconfirmed" && x.meeting.OccurrenceState != "scheduled" && x.meeting.OccurrenceState != "cancelled" {
		plan.View.CanConfirm = false
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "meeting_already_started")
	}
	var e error
	plan.View.AffectedIssueTotal, e = q.CountCockpitDispositionIssues(ctx, db.CountCockpitDispositionIssuesParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return plan, e
	}
	plan.View.ActiveRunTotal, e = q.CountCockpitMeetingPreparationRuns(ctx, db.CountCockpitMeetingPreparationRunsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return plan, e
	}
	ids := []pgtype.UUID{}
	seen := map[pgtype.UUID]bool{}
	for _, c := range in.Issues {
		id, _ := util.ParseUUID(c.IssueID)
		ids = append(ids, id)
		seen[id] = true
	}
	runIDs := []pgtype.UUID{}
	for _, raw := range in.RunIDs {
		id, _ := util.ParseUUID(raw)
		runIDs = append(runIDs, id)
	}
	runs, e := q.GetCockpitDispositionRunsByIDs(ctx, db.GetCockpitDispositionRunsByIDsParams{WorkspaceID: p.WorkspaceID, ActorID: p.ActorID, RunIds: runIDs})
	if e != nil {
		return plan, e
	}
	if len(runs) != len(runIDs) {
		return plan, ErrCockpitWorkflowNotFound
	}
	for _, r := range runs {
		if !seen[r.IssueID] {
			ids = append(ids, r.IssueID)
			seen[r.IssueID] = true
		}
	}
	allowedIDs, e := q.FilterCockpitPreparationIssueIDs(ctx, db.FilterCockpitPreparationIssueIDsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IssueIds: ids})
	if e != nil {
		return plan, e
	}
	if len(allowedIDs) != len(ids) {
		return plan, ErrCockpitWorkflowNotFound
	}
	facts, e := readDispositionIssues(ctx, q, p, ids, runIDs)
	if e != nil {
		return plan, e
	}
	role, e := preparationRole(ctx, q, p)
	if e != nil {
		return plan, e
	}
	tokenFacts := []any{x.meeting.LifecycleRevision, x.meeting.AgendaRevision, plan.View.AffectedIssueTotal, plan.View.ActiveRunTotal}
	if intent == "cancel" {
		facts, err := q.ReadCockpitCancellationDirectoryFacts(ctx, db.ReadCockpitCancellationDirectoryFactsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
		if err != nil {
			return plan, err
		}
		var impact CockpitDirectoryCancellationImpact
		if err := json.Unmarshal(facts, &impact); err != nil {
			return plan, err
		}
		plan.View.DirectoryImpact = &impact
		tokenFacts = append(tokenFacts, impact)
	}
	selectedIssues := map[pgtype.UUID]bool{}
	selectedActiveRuns := int64(0)
	for _, choice := range in.Issues {
		id, _ := util.ParseUUID(choice.IssueID)
		f, ok := facts[id]
		if !ok {
			return plan, ErrCockpitWorkflowNotFound
		}
		tokenFacts = append(tokenFacts, []any{id, f.View.IssueRevision, f.Automation.WakeupHash, f.Automation.TaskHash})
		if choice.Action == "retain" {
			continue
		}
		selectedIssues[id] = true
		kind := choice.Action
		if kind == "cancel" {
			kind = "cancel_issue"
		}
		item := CockpitPreparationPreviewEffect{SlotID: dispositionSlotID(kind, id), Kind: kind, Label: f.View.Issue.Title, Selected: true, Allowed: choice.ExpectedRevision == f.View.IssueRevision, ReasonCodes: []string{}, Targets: []IssueOperationTarget{{Kind: "issue", IssueID: choice.IssueID, Label: f.View.Issue.Identifier, Purpose: "preparation"}}}
		impact := f.View
		impact.EvaluatesParentRules = choice.Action == "cancel" && impact.ParentIssueID != nil
		item.IssueImpact = &impact
		if !item.Allowed {
			item.ReasonCodes = append(item.ReasonCodes, "issue_revision_changed")
		}
		switch choice.Action {
		case "cancel":
			if !f.View.CanCancel || f.View.CancelStatus == nil || *choice.CancelStatus != *f.View.CancelStatus {
				item.Allowed = false
				item.ReasonCodes = append(item.ReasonCodes, "formal_or_status_restriction")
			}
		case "change_due_date":
			if !f.View.CanChangeDueDate {
				item.Allowed = false
				item.ReasonCodes = append(item.ReasonCodes, "target_forbidden")
			}
		case "link_meeting":
			target, _ := preparationUUID(choice.TargetMeetingID)
			agenda, _ := preparationUUID(choice.TargetAgendaID)
			if target == p.MeetingID {
				item.Allowed = false
				item.ReasonCodes = append(item.ReasonCodes, "choose_another_meeting")
			} else {
				m, err := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: target})
				if err != nil {
					return plan, cockpitWorkflowError(err)
				}
				a, err := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: target, ID: agenda})
				if err != nil {
					return plan, cockpitWorkflowError(err)
				}
				if a.RemovedAt.Valid || requireMeetingPreparationOpen(m) != nil {
					item.Allowed = false
					item.ReasonCodes = append(item.ReasonCodes, "target_meeting_preparation_closed")
				}
				tokenFacts = append(tokenFacts, []any{target, m.LifecycleRevision, agenda, a.Revision})
			}
		}
		if !item.Allowed {
			plan.View.CanConfirm = false
		}
		copyChoice := choice
		copyFacts := f
		step := preparationEffectIntent{Slot: CockpitMeetingTemplateSlot{SlotID: item.SlotID, Kind: kind, Label: item.Label}, Binding: CockpitMeetingTemplateBinding{SlotID: item.SlotID, Selected: true, IssueID: &copyChoice.IssueID}, ExpectedIssueRevision: f.View.IssueRevision, IssueChoice: &copyChoice, DispositionFacts: &copyFacts, SelectedRunIDs: append([]string{}, in.RunIDs...), FactsHash: planningHash([]any{f.View.IssueRevision, f.Automation.WakeupHash, f.Automation.TaskHash})}
		plan.Intents = append(plan.Intents, step)
		plan.View.Effects = append(plan.View.Effects, item)
	}
	for _, r := range runs {
		f, ok := facts[r.IssueID]
		if !ok {
			return plan, ErrCockpitWorkflowNotFound
		}
		active := r.Status == "queued" || r.Status == "deferred" || r.Status == "dispatched" || r.Status == "running" || r.Status == "waiting_local_directory"
		if active {
			selectedActiveRuns++
		}
		accessible := r.PermissionMode.Valid && memberMayViewAgentFacts(r.OwnerID, p.ActorID, role, r.PermissionMode.String, r.TargetMatches)
		issueID := util.UUIDToString(r.IssueID)
		runID := util.UUIDToString(r.ID)
		item := CockpitPreparationPreviewEffect{SlotID: dispositionSlotID("stop_run", r.ID), Kind: "stop_run", Label: f.View.Issue.Title, Selected: true, Allowed: p.Human && accessible && active, ReasonCodes: []string{}, Targets: []IssueOperationTarget{{Kind: "issue", IssueID: issueID, Label: f.View.Issue.Identifier, Purpose: "preparation"}}}
		impact := f.View
		impact.EvaluatesParentRules = false
		item.IssueImpact = &impact
		if !accessible {
			item.ReasonCodes = append(item.ReasonCodes, "task_not_accessible")
		}
		if !active {
			item.ReasonCodes = append(item.ReasonCodes, "run_already_ended")
		}
		if !item.Allowed {
			plan.View.CanConfirm = false
		}
		copyFacts := f
		selectedRun := &CockpitDispositionRun{ID: runID, IssueID: issueID, AgentID: util.UUIDToString(r.AgentID), Status: r.Status, StartedAt: lifecycleTime(r.StartedAt), IsWakeup: r.IsWakeup, CanStop: item.Allowed, BlockedReasons: append([]string{}, item.ReasonCodes...)}
		if accessible {
			selectedRun.AgentName = r.AgentName
		}
		plan.Intents = append(plan.Intents, preparationEffectIntent{Slot: CockpitMeetingTemplateSlot{SlotID: item.SlotID, Kind: "stop_run", Label: item.Label}, Binding: CockpitMeetingTemplateBinding{SlotID: item.SlotID, Selected: true, IssueID: &issueID}, RunID: &runID, ExpectedIssueRevision: f.View.IssueRevision, DispositionFacts: &copyFacts, SelectedRunIDs: append([]string{}, in.RunIDs...), ExpectedRunStatus: r.Status, SelectedRun: selectedRun, FactsHash: planningHash([]any{f.View.IssueRevision, f.Automation.WakeupHash, f.Automation.TaskHash, r.ID, r.Status})})
		plan.View.Effects = append(plan.View.Effects, item)
		tokenFacts = append(tokenFacts, []any{r.ID, r.Status, accessible, f.View.IssueRevision, f.Automation.TaskHash})
	}
	orderedIntents := make([]preparationEffectIntent, 0, len(plan.Intents))
	orderedViews := make([]CockpitPreparationPreviewEffect, 0, len(plan.View.Effects))
	for _, stop := range []bool{true, false} {
		for i, step := range plan.Intents {
			if (step.Slot.Kind == "stop_run") == stop {
				orderedIntents = append(orderedIntents, step)
				orderedViews = append(orderedViews, plan.View.Effects[i])
			}
		}
	}
	plan.Intents = orderedIntents
	plan.View.Effects = orderedViews
	plan.View.SelectedTotal = int32(len(plan.Intents))
	plan.View.UnselectedIssueTotal = plan.View.AffectedIssueTotal - int64(len(selectedIssues))
	plan.View.UnselectedRunTotal = plan.View.ActiveRunTotal - selectedActiveRuns
	if intent == "append_disposition" && len(plan.Intents) == 0 {
		plan.View.CanConfirm = false
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "select_preparation_effects")
	}
	plan.View.ContextToken = planningHash([]any{"meeting_cancellation_preview_v1", p.WorkspaceID, p.MeetingID, p.ActorID, in, tokenFacts})
	return plan, nil
}

func (s *IssueService) PreviewCockpitMeetingCancellation(ctx context.Context, p CockpitLifecycleRead, in CockpitCancellationPreviewInput) (CockpitCancellationPreview, error) {
	tx, q, x, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return CockpitCancellationPreview{}, e
	}
	defer tx.Rollback(ctx)
	plan, e := readCancellationPreview(ctx, q, p, x, in)
	return plan.View, e
}

func (s *IssueService) CancelCockpitMeeting(ctx context.Context, p CockpitLifecycleRead, in CockpitCancellationInput) (CockpitPreparationCommandResult, error) {
	return s.saveMeetingCancellation(ctx, p, in, false)
}
func (s *IssueService) AppendCockpitMeetingDisposition(ctx context.Context, p CockpitLifecycleRead, in CockpitCancellationInput) (CockpitPreparationCommandResult, error) {
	return s.saveMeetingCancellation(ctx, p, in, true)
}

func (s *IssueService) saveMeetingCancellation(ctx context.Context, p CockpitLifecycleRead, in CockpitCancellationInput, appendPlan bool) (CockpitPreparationCommandResult, error) {
	var out CockpitPreparationCommandResult
	if e := normalizeCancellation(&in.CockpitCancellationPreviewInput); e != nil {
		return out, e
	}
	action := "cancel"
	if appendPlan {
		action = "preparation_dispose"
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, action, pgtype.UUID{}, pgtype.UUID{}, in)
	if e != nil {
		return out, e
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return readPreparationCommandResult(ctx, q, p, c, *old)
	}
	if appendPlan != (x.meeting.OccurrenceState == "cancelled") {
		return out, ErrCockpitWorkflowConflict
	}
	plan, e := readCancellationPreview(ctx, q, p, x, in.CockpitCancellationPreviewInput)
	if e != nil {
		return out, e
	}
	if !plan.View.CanConfirm || in.ExpectedRevision != x.meeting.LifecycleRevision || in.ContextToken != plan.View.ContextToken {
		return out, ErrCockpitPreparationContextChanged
	}
	previous := lifecycleOccurrence(x.meeting)
	if !appendPlan {
		m := x.meeting
		rev, e := q.SetCockpitMeetingDisposition(ctx, db.SetCockpitMeetingDispositionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ExpectedRevision: in.ExpectedRevision, ActorID: p.ActorID, State: "cancelled", CancelledAt: m.DatabaseNow, CancelledBy: p.ActorID, CancelledReason: in.Reason, ArchivedAt: m.ArchivedAt, ArchivedBy: m.ArchivedBy, ArchivedReason: m.ArchivedReason})
		if e != nil {
			return out, cockpitWorkflowError(e)
		}
		x.meeting.OccurrenceState = "cancelled"
		x.meeting.CancelledAt = m.DatabaseNow
		x.meeting.CancelledBy = p.ActorID
		x.meeting.CancelledReason = in.Reason
		x.meeting.LifecycleRevision = rev
	}
	o, receipt, e := createPreparationOperation(ctx, q, p, c, x, "cancel_preparation", pgtype.UUID{}, pgtype.UUID{}, in.ContextToken, in, plan.Intents)
	if e != nil {
		return out, e
	}
	occurrence := lifecycleOccurrence(x.meeting)
	receipt.Occurrence = &occurrence
	receipt.Reason = in.Reason
	if !appendPlan {
		facts, err := q.PauseCockpitDirectoriesForCancellation(ctx, db.PauseCockpitDirectoriesForCancellationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
		if err != nil {
			return out, err
		}
		var effect CockpitDirectoryCancellationEffect
		if err := json.Unmarshal(facts, &effect); err != nil {
			return out, err
		}
		receipt.DirectoryEffect = &effect
	}
	if e = storeLifecycleReceipt(ctx, q, c, CockpitLifecycleReceipt{Revision: x.meeting.LifecycleRevision, AgendaRevision: x.meeting.AgendaRevision, RequestHash: c.hash, Reason: in.Reason, PreviousOccurrence: &previous, Occurrence: &occurrence, Preparation: &receipt}); e != nil {
		return out, e
	}
	h, e := preparationHeader(ctx, q, p, o)
	if e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return out, e
	}
	s.lifecycleChanged(c)
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: in.CommandKey, Action: action, Receipt: receipt, Current: h}, nil
}
