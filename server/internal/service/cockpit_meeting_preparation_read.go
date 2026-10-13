package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitPreparationContextChanged = fmt.Errorf("%w: preparation facts changed; refresh the preview", ErrCockpitWorkflowConflict)

func preparationCapabilities(h *CockpitPreparationOperationHeader, p CockpitLifecycleRead, manager bool, meeting db.GetCockpitMeetingLifecycleRow) {
	responsible := p.Human && h.ResponsibleUserID == util.UUIDToString(p.ActorID)
	h.CanContinue = responsible && h.State == "active"
	h.CanResume = responsible && (h.State == "paused" || h.State == "needs_attention")
	h.CanPause = (responsible || manager) && h.State == "active"
	h.CanClaim = manager && !responsible && h.State != "completed"
	h.BlockedReasons = []string{}
	if !p.Human {
		h.BlockedReasons = append(h.BlockedReasons, "human_required")
	} else if !responsible {
		h.BlockedReasons = append(h.BlockedReasons, "preparation_responsible_required")
	}
	if h.State == "needs_attention" {
		h.BlockedReasons = append(h.BlockedReasons, "preparation_needs_attention")
	}
}

func preparationRole(ctx context.Context, q *db.Queries, p CockpitLifecycleRead) (string, error) {
	m, e := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: p.ActorID})
	return m.Role, e
}

func preparationHeader(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, o db.CockpitMeetingPreparationOperation, knownMeeting ...db.GetCockpitMeetingLifecycleRow) (CockpitPreparationOperationHeader, error) {
	var h CockpitPreparationOperationHeader
	c, e := q.CountCockpitPreparationEffects(ctx, db.CountCockpitPreparationEffectsParams{WorkspaceID: p.WorkspaceID, OperationID: o.ID})
	if e != nil {
		return h, e
	}
	role, e := preparationRole(ctx, q, p)
	if e != nil {
		return h, e
	}
	users, e := q.GetUsersByIDs(ctx, []pgtype.UUID{o.CreatedBy, o.ResponsibleUserID})
	if e != nil {
		return h, e
	}
	names := map[pgtype.UUID]string{}
	for _, user := range users {
		names[user.ID] = user.Name
	}
	var meeting db.GetCockpitMeetingLifecycleRow
	if len(knownMeeting) > 0 {
		meeting = knownMeeting[0]
	} else {
		meeting, e = q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
		if e != nil {
			return h, e
		}
	}
	h = CockpitPreparationOperationHeader{WorkspaceID: util.UUIDToString(o.WorkspaceID), MeetingID: util.UUIDToString(o.MeetingID), ID: util.UUIDToString(o.ID), Kind: o.Kind, Revision: o.Revision, State: o.State, CommandKey: util.UUIDToString(o.CommandKey), CreatedBy: util.UUIDToString(o.CreatedBy), CreatedByName: names[o.CreatedBy], ResponsibleUserName: names[o.ResponsibleUserID], ResponsibleUserID: util.UUIDToString(o.ResponsibleUserID), CreatedAt: o.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: o.UpdatedAt.Time.UTC().Format(time.RFC3339Nano), Counts: CockpitPreparationCounts{Total: c.Total, Pending: c.Pending, Applied: c.Applied, NeedsAttention: c.NeedsAttention, Skipped: c.Skipped}}
	preparationCapabilities(&h, p, preparationManager(p.Human, p.ActorID, o.CreatedBy, role), meeting)
	return h, nil
}

func (s *IssueService) GetCockpitPreparationOperation(ctx context.Context, p CockpitPreparationQuery) (CockpitPreparationOperationHeader, error) {
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return CockpitPreparationOperationHeader{}, e
	}
	defer tx.Rollback(ctx)
	o, e := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if e != nil {
		return CockpitPreparationOperationHeader{}, cockpitWorkflowError(e)
	}
	return preparationHeader(ctx, q, p.CockpitLifecycleRead, o, x.meeting)
}

func (s *IssueService) ListCockpitPreparationOperations(ctx context.Context, p CockpitPreparationQuery) (CockpitPreparationOperationPage, error) {
	var out CockpitPreparationOperationPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_preparation_operations", p.WorkspaceID, p.MeetingID, size})
	c, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	var after pgtype.Timestamptz
	if id.Valid {
		v, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return out, ErrCockpitWorkflowInput
		}
		after = pgtype.Timestamptz{Time: v, Valid: true}
	}
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	role, e := preparationRole(ctx, q, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	total, e := q.CountCockpitPreparationOperations(ctx, db.CountCockpitPreparationOperationsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitPreparationOperations(ctx, db.ListCockpitPreparationOperationsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AfterID: id, AfterTime: after, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitPreparationOperationPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), PageSize: size, Items: []CockpitPreparationOperationHeader{}, Total: total}
	if len(rows) > int(size) {
		rows = rows[:size]
		r := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(r.ID), Time: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
	}
	for _, r := range rows {
		h := CockpitPreparationOperationHeader{WorkspaceID: out.WorkspaceID, MeetingID: out.MeetingID, ID: util.UUIDToString(r.ID), Kind: r.Kind, Revision: r.Revision, State: r.State, CommandKey: util.UUIDToString(r.CommandKey), CreatedBy: util.UUIDToString(r.CreatedBy), CreatedByName: r.CreatedByName, ResponsibleUserName: r.ResponsibleUserName, ResponsibleUserID: util.UUIDToString(r.ResponsibleUserID), CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: r.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)}
		if e = json.Unmarshal(r.Counts, &h.Counts); e != nil {
			return out, e
		}
		preparationCapabilities(&h, p.CockpitLifecycleRead, preparationManager(p.Human, p.ActorID, r.CreatedBy, role), x.meeting)
		out.Items = append(out.Items, h)
	}
	return out, nil
}

func preparationEffectView(r db.CockpitMeetingPreparationEffect, h CockpitPreparationOperationHeader, p CockpitLifecycleRead, meeting db.GetCockpitMeetingLifecycleRow, dependencyApplied bool) (CockpitPreparationEffect, error) {
	o := CockpitPreparationEffect{ID: util.UUIDToString(r.ID), OperationID: util.UUIDToString(r.OperationID), SlotID: util.UUIDToString(r.SlotID), Position: r.Position, Kind: r.Kind, Label: r.Label, Revision: r.Revision, State: r.State, CommandKey: util.UUIDToString(r.CommandKey), DependencyID: planningUUID(r.DependencyID), ErrorCode: r.ErrorCode, Reason: r.Reason, Targets: []IssueOperationTarget{}, AuthorizationKey: util.UUIDToString(r.AuthorizationKey), AuthorizationRevision: r.AuthorizationRevision, CanReauthorize: p.Human && h.ResponsibleUserID == util.UUIDToString(p.ActorID) && r.State == "needs_attention", CanApply: h.CanContinue && r.State == "pending", CanSkip: (p.Human && h.ResponsibleUserID == util.UUIDToString(p.ActorID) && h.State != "completed") && r.State != "applied" && r.State != "skipped"}
	if !dependencyApplied {
		o.CanApply = false
	}
	if r.Receipt != nil {
		var receipt CockpitPreparationEffectReceipt
		if e := json.Unmarshal(r.Receipt, &receipt); e != nil {
			return o, e
		}
		if receipt.EffectID != o.ID || receipt.CommandKey != o.CommandKey {
			return o, errors.New("preparation receipt does not match its fixed effect")
		}
		o.Receipt = &receipt
	}
	if r.IssueID.Valid {
		o.Targets = append(o.Targets, IssueOperationTarget{Kind: "issue", IssueID: util.UUIDToString(r.IssueID), Label: r.Label, Purpose: "preparation"})
	}
	return o, nil
}

func (s *IssueService) GetCockpitPreparationEffect(ctx context.Context, p CockpitPreparationQuery) (CockpitPreparationEffectDetail, error) {
	var out CockpitPreparationEffectDetail
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	o, e := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	h, e := preparationHeader(ctx, q, p.CockpitLifecycleRead, o, x.meeting)
	if e != nil {
		return out, e
	}
	r, e := q.GetCockpitPreparationEffect(ctx, db.GetCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: p.EffectID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	dependencyApplied := !r.DependencyID.Valid
	if r.DependencyID.Valid {
		dep, err := q.GetCockpitPreparationEffect(ctx, db.GetCockpitPreparationEffectParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, ID: r.DependencyID})
		if err != nil {
			return out, cockpitWorkflowError(err)
		}
		dependencyApplied = dep.State == "applied"
	}
	v, e := preparationEffectView(r, h, p.CockpitLifecycleRead, x.meeting, dependencyApplied)
	if e != nil {
		return out, e
	}
	return CockpitPreparationEffectDetail{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, OperationID: h.ID, Effect: v, Current: h}, nil
}

func (s *IssueService) ListCockpitPreparationEffects(ctx context.Context, p CockpitPreparationQuery) (CockpitPreparationEffectPage, error) {
	var out CockpitPreparationEffectPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	scope := planningHash([]any{"meeting_preparation_effects", p.WorkspaceID, p.MeetingID, p.OperationID, size})
	c, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil || c.Order < 0 || c.Order > 49 {
		return out, ErrCockpitWorkflowInput
	}
	tx, q, x, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	o, e := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.OperationID})
	if e != nil {
		return out, cockpitWorkflowError(e)
	}
	h, e := preparationHeader(ctx, q, p.CockpitLifecycleRead, o, x.meeting)
	if e != nil {
		return out, e
	}
	rows, e := q.ListCockpitPreparationEffects(ctx, db.ListCockpitPreparationEffectsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: p.OperationID, AfterID: id, AfterPosition: int32(c.Order), PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	out = CockpitPreparationEffectPage{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, OperationID: h.ID, Revision: h.Revision, PageSize: size, Items: []CockpitPreparationEffect{}, Total: int64(h.Counts.Total)}
	if len(rows) > int(size) {
		rows = rows[:size]
		r := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(r.ID), Order: int64(r.Position)})
	}
	for _, r := range rows {
		v, e := preparationEffectView(db.CockpitMeetingPreparationEffect{ID: r.ID, WorkspaceID: r.WorkspaceID, MeetingID: r.MeetingID, OperationID: r.OperationID, SlotID: r.SlotID, Position: r.Position, Kind: r.Kind, Label: r.Label, CommandKey: r.CommandKey, DependencyID: r.DependencyID, Revision: r.Revision, State: r.State, ErrorCode: r.ErrorCode, Reason: r.Reason, IssueID: r.IssueID, RunID: r.RunID, TargetMeetingID: r.TargetMeetingID, Receipt: r.Receipt, AppliedBy: r.AppliedBy, AppliedAt: r.AppliedAt, AuthorizationKey: r.AuthorizationKey, AuthorizationRevision: r.AuthorizationRevision, AuthorizationHash: r.AuthorizationHash, AuthorizationSnapshot: r.AuthorizationSnapshot}, h, p.CockpitLifecycleRead, x.meeting, r.DependencyApplied)
		if e != nil {
			return out, e
		}
		out.Items = append(out.Items, v)
	}
	return out, nil
}
