package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func nullableAgendaUUID(raw json.RawMessage, old pgtype.UUID) (pgtype.UUID, error) {
	if len(raw) == 0 {
		return old, nil
	}
	if string(raw) == "null" {
		return pgtype.UUID{}, nil
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		return old, ErrCockpitWorkflowInput
	}
	id, e := util.ParseUUID(v)
	if e != nil || !id.Valid {
		return old, fmt.Errorf("%w: selected identity must be a UUID or null", ErrCockpitWorkflowInput)
	}
	return id, nil
}
func normalizeAgendaInput(in *CockpitAgendaInput, create bool) error {
	if in.Title != nil {
		v := strings.TrimSpace(*in.Title)
		if len(v) == 0 || len(v) > 500 {
			return fmt.Errorf("%w: agenda title must be 1–500 bytes", ErrCockpitWorkflowInput)
		}
		in.Title = &v
	} else if create {
		return fmt.Errorf("%w: agenda title is required", ErrCockpitWorkflowInput)
	}
	if in.DesiredOutcome != nil && len(*in.DesiredOutcome) > 16000 || in.Notes != nil && len(*in.Notes) > 65536 {
		return fmt.Errorf("%w: agenda text exceeds the supported size", ErrCockpitWorkflowInput)
	}
	if in.SortOrder != nil && (*in.SortOrder < 0 || *in.SortOrder > 1<<53-1) {
		return ErrCockpitWorkflowInput
	}
	if in.Purposes != nil {
		seen := map[string]bool{}
		out := []string{}
		for _, v := range *in.Purposes {
			switch v {
			case "planning", "goal_review", "boundary_confirmation", "question_clarification", "solution_discussion", "direction_decision":
			default:
				return ErrCockpitWorkflowInput
			}
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
		sort.Strings(out)
		in.Purposes = &out
	}
	if !create && in.Title == nil && in.Purposes == nil && in.DesiredOutcome == nil && in.Notes == nil && len(in.FacilitatorUserID) == 0 && len(in.NodeID) == 0 && in.SortOrder == nil {
		return fmt.Errorf("%w: supply at least one agenda field", ErrCockpitWorkflowInput)
	}
	_, e := nullableAgendaUUID(in.FacilitatorUserID, pgtype.UUID{})
	if e != nil {
		return e
	}
	_, e = nullableAgendaUUID(in.NodeID, pgtype.UUID{})
	return e
}
func applyAgendaFields(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, a db.CockpitMeetingAgenda, in CockpitAgendaInput) (db.CockpitMeetingAgenda, error) {
	if in.Title != nil {
		a.Title = *in.Title
	}
	if in.Purposes != nil {
		a.Purposes = *in.Purposes
	}
	if a.Purposes == nil {
		a.Purposes = []string{}
	}
	if in.DesiredOutcome != nil {
		a.DesiredOutcome = *in.DesiredOutcome
	}
	if in.Notes != nil {
		a.Notes = *in.Notes
	}
	if in.SortOrder != nil {
		a.SortOrder = *in.SortOrder
	}
	var e error
	a.FacilitatorUserID, e = nullableAgendaUUID(in.FacilitatorUserID, a.FacilitatorUserID)
	if e != nil {
		return a, e
	}
	a.NodeID, e = nullableAgendaUUID(in.NodeID, a.NodeID)
	if e != nil {
		return a, e
	}
	if len(in.FacilitatorUserID) > 0 && a.FacilitatorUserID.Valid {
		if e = cockpitWorkflowMember(ctx, q, p.WorkspaceID, a.FacilitatorUserID); e != nil {
			return a, fmt.Errorf("%w: selected facilitator is not a current member", ErrCockpitWorkflowInput)
		}
	}
	if len(in.NodeID) > 0 && a.NodeID.Valid {
		if _, _, _, e = requireExecutionLeaf(ctx, q, p.WorkspaceID, a.NodeID); e != nil {
			return a, e
		}
	}
	return a, nil
}
func (s *IssueService) SaveCockpitMeetingAgenda(ctx context.Context, p CockpitLifecycleRead, id pgtype.UUID, in CockpitAgendaInput) (CockpitLifecycleCommandResult, error) {
	create := !id.Valid
	if e := normalizeAgendaInput(&in, create); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	action := "agenda_update"
	if create {
		action = "agenda_create"
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, action, id, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	var a db.CockpitMeetingAgenda
	if create {
		if x.meeting.AgendaRevision != in.ExpectedRevision {
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowConflict
		}
	} else {
		a, e = loadActiveAgenda(ctx, q, p, id, in.ExpectedRevision)
		if e != nil {
			return CockpitLifecycleCommandResult{}, e
		}
	}
	a, e = applyAgendaFields(ctx, q, p, a, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if create {
		var order pgtype.Int8
		if in.SortOrder != nil {
			order = pgtype.Int8{Int64: *in.SortOrder, Valid: true}
		}
		a, e = q.CreateCockpitMeetingAgenda(ctx, db.CreateCockpitMeetingAgendaParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Title: a.Title, Purposes: a.Purposes, DesiredOutcome: a.DesiredOutcome, Notes: a.Notes, FacilitatorUserID: a.FacilitatorUserID, NodeID: a.NodeID, SortOrder: order, ActorID: p.ActorID})
	} else {
		a, e = q.UpdateCockpitMeetingAgenda(ctx, db.UpdateCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id, Title: a.Title, Purposes: a.Purposes, DesiredOutcome: a.DesiredOutcome, Notes: a.Notes, FacilitatorUserID: a.FacilitatorUserID, NodeID: a.NodeID, SortOrder: a.SortOrder, ActorID: p.ActorID, ExpectedRevision: in.ExpectedRevision})
	}
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	rev, e := q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	d, e := agendaDetail(ctx, q, p, a)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	c.agenda = a.ID
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: a.Revision, AgendaRevision: rev, AgendaID: planningUUID(a.ID), Agenda: &d})
}
func (s *IssueService) RemoveCockpitMeetingAgenda(ctx context.Context, p CockpitLifecycleRead, id pgtype.UUID, in CockpitAgendaRemoveInput) (CockpitLifecycleCommandResult, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.Reason == "" || len(in.Reason) > 16000 {
		return CockpitLifecycleCommandResult{}, fmt.Errorf("%w: removal reason is required", ErrCockpitWorkflowInput)
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, "agenda_remove", id, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	tx, q, _, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	if _, e = loadActiveAgenda(ctx, q, p, id, in.ExpectedRevision); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	a, e := q.RemoveCockpitMeetingAgenda(ctx, db.RemoveCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id, ExpectedRevision: in.ExpectedRevision, ActorID: p.ActorID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	rev, e := q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	d, e := agendaDetail(ctx, q, p, a)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: a.Revision, AgendaRevision: rev, AgendaID: planningUUID(a.ID), Agenda: &d, Reason: in.Reason})
}
func (s *IssueService) AttachCockpitAgendaReference(ctx context.Context, p CockpitLifecycleRead, agenda pgtype.UUID, in CockpitAgendaReferenceInput) (CockpitLifecycleCommandResult, error) {
	target, e := util.ParseUUID(in.TargetID)
	if e != nil || !target.Valid || (in.Kind != "issue" && in.Kind != "artifact_reference") || (in.Purpose != "preparation" && in.Purpose != "material") || (in.Kind == "artifact_reference" && in.Purpose != "material") {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, "reference_attach", agenda, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	tx, q, _, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	if _, e = loadActiveAgenda(ctx, q, p, agenda, in.ExpectedRevision); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if in.Kind == "issue" {
		if _, e = q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: target}); e != nil {
			return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
		}
	}
	if e = validateAgendaReferenceTarget(ctx, q, p, in.Kind, target); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	existing, e := q.GetActiveCockpitAgendaReference(ctx, db.GetActiveCockpitAgendaReferenceParams{WorkspaceID: p.WorkspaceID, AgendaID: agenda, Kind: in.Kind, TargetID: target})
	if e == nil {
		return CockpitLifecycleCommandResult{}, &CockpitAgendaReferenceExistsError{ReferenceID: util.UUIDToString(existing.ID)}
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return CockpitLifecycleCommandResult{}, e
	}
	r, e := q.CreateCockpitAgendaReference(ctx, db.CreateCockpitAgendaReferenceParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: agenda, Kind: in.Kind, TargetID: target, Purpose: in.Purpose, ActorID: p.ActorID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	return s.finishAgendaReference(ctx, tx, q, c, r)
}
func (s *IssueService) RemoveCockpitAgendaReference(ctx context.Context, p CockpitLifecycleRead, agenda, reference pgtype.UUID, in CockpitLifecycleCommandInput) (CockpitLifecycleCommandResult, error) {
	c, e := newLifecycleCommand(p, in, "reference_remove", agenda, reference, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	tx, q, _, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return *old, nil
	}
	if _, e = loadActiveAgenda(ctx, q, p, agenda, in.ExpectedRevision); e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	r, e := q.RemoveCockpitAgendaReference(ctx, db.RemoveCockpitAgendaReferenceParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: agenda, ID: reference, RemovedBy: p.ActorID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	return s.finishAgendaReference(ctx, tx, q, c, r)
}
func (s *IssueService) finishAgendaReference(ctx context.Context, tx pgx.Tx, q *db.Queries, c lifecycleCommand, r db.CockpitMeetingAgendaReference) (CockpitLifecycleCommandResult, error) {
	a, e := q.BumpCockpitAgendaItemRevision(ctx, db.BumpCockpitAgendaItemRevisionParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, ID: c.agenda, ExpectedRevision: c.expected, ActorID: c.ActorID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, cockpitWorkflowError(e)
	}
	rev, e := q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: c.WorkspaceID, ID: c.MeetingID})
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	refs, e := readAgendaReferences(ctx, q, c.CockpitLifecycleRead, []db.CockpitMeetingAgendaReference{r}, false)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	return s.finishLifecycleWrite(ctx, tx, q, c, CockpitLifecycleReceipt{Revision: a.Revision, AgendaRevision: rev, AgendaID: planningUUID(a.ID), ReferenceID: planningUUID(r.ID), Reference: &refs[0]})
}
