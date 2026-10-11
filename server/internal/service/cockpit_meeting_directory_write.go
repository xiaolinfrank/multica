package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type directoryWrite struct {
	p            CockpitDirectoryRead
	key          pgtype.UUID
	action, hash string
}

func (s *IssueService) directoryReplay(ctx context.Context, q *db.Queries, c directoryWrite) (*CockpitDirectoryCommandResult, error) {
	old, err := q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: c.p.WorkspaceID, MeetingID: c.p.MeetingID, CommandKey: c.key})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	typ, actor := "member", c.p.CredentialOwnerID
	if c.p.ActorSource == "task_token" {
		typ, actor = "agent", c.p.AgentID
	}
	if old.ActorType != typ || old.ActorID != actor || old.Kind != c.action || old.RequestHash != c.hash {
		return nil, directoryError("command_conflict", "This command key belongs to a different principal or intent.")
	}
	var envelope CockpitLifecycleReceipt
	if err = json.Unmarshal(old.Receipt, &envelope); err != nil {
		return nil, err
	}
	if envelope.Directory == nil {
		return nil, directoryError("command_conflict", "This key is not a directory command.")
	}
	id, e := util.ParseUUID(envelope.Directory.DirectoryOperationID)
	if e != nil {
		return nil, e
	}
	m, err := q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: c.p.WorkspaceID, ID: c.p.MeetingID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCockpitLifecycleGone
	}
	if err != nil {
		return nil, err
	}
	o, err := q.GetCockpitDirectoryOperation(ctx, db.GetCockpitDirectoryOperationParams{WorkspaceID: c.p.WorkspaceID, MeetingID: c.p.MeetingID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCockpitLifecycleGone
	}
	if err != nil {
		return nil, err
	}
	headers, err := s.directoryHeaders(ctx, q, c.p, m, []db.CockpitMeetingDirectoryOperation{o})
	if err != nil {
		return nil, err
	}
	return &CockpitDirectoryCommandResult{WorkspaceID: util.UUIDToString(c.p.WorkspaceID), MeetingID: util.UUIDToString(c.p.MeetingID), CommandKey: util.UUIDToString(c.key), Action: c.action, Replayed: true, Receipt: *envelope.Directory, Current: headers[0]}, nil
}
func (s *IssueService) beginDirectoryWrite(ctx context.Context, c directoryWrite) (pgx.Tx, *db.Queries, db.CockpitMeeting, *CockpitDirectoryCommandResult, error) {
	if c.p.ActorSource == "cloud_pat" {
		return nil, nil, db.CockpitMeeting{}, nil, directoryError("task_context_required", "A task-specific delegation or human confirmation is required.")
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.CockpitMeeting{}, nil, err
	}
	q := s.Queries.WithTx(tx)
	fail := func(e error) (pgx.Tx, *db.Queries, db.CockpitMeeting, *CockpitDirectoryCommandResult, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, db.CockpitMeeting{}, nil, e
	}
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, c.p.WorkspaceID); err != nil {
		return fail(directoryConvertError(err))
	}
	if _, err = directoryMembership(ctx, q, c.p); err != nil {
		return fail(err)
	}
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: c.p.WorkspaceID, UserID: c.p.CredentialOwnerID}); err != nil {
		return fail(directoryConvertError(err))
	}
	if replay, e := s.directoryReplay(ctx, q, c); replay != nil || e != nil {
		if e != nil {
			return fail(e)
		}
		return tx, q, db.CockpitMeeting{}, replay, nil
	}
	// Acquire membership locks before board/runtime/Agent/task locks. Exact replay
	// above intentionally precedes admission of a new Run or a changed authority.
	if c.p.ActorSource == "task_token" {
		run, e := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: c.p.WorkspaceID, ID: c.p.RunID})
		if e != nil {
			return fail(directoryConvertError(e))
		}
		if !run.OriginatorUserID.Valid {
			return fail(directoryError("delegation_unavailable", "The run has no authorizing member."))
		}
		if _, e = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: c.p.WorkspaceID, UserID: run.OriginatorUserID}); e != nil {
			return fail(directoryError("permission_revoked", "The authorizing member is unavailable."))
		}
	}
	m, err := lockLifecycleMeeting(ctx, q, c.p.WorkspaceID, c.p.MeetingID)
	if err != nil {
		return fail(err)
	}
	if replay, e := s.directoryReplay(ctx, q, c); replay != nil || e != nil {
		if e != nil {
			return fail(e)
		}
		return tx, q, m, replay, nil
	}
	return tx, q, m, nil, nil
}
func (s *IssueService) directoryPreflightReplay(ctx context.Context, c directoryWrite) (*CockpitDirectoryCommandResult, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if c.p.ActorSource == "cloud_pat" {
		return nil, directoryError("task_context_required", "A task-specific delegation or human confirmation is required.")
	}
	if _, err = directoryMembership(ctx, q, c.p); err != nil {
		return nil, err
	}
	return s.directoryReplay(ctx, q, c)
}
func directoryUUID(s string) pgtype.UUID { v, _ := util.ParseUUID(s); return v }
func directoryOptionalUUID(s *string) pgtype.UUID {
	if s == nil {
		return pgtype.UUID{}
	}
	return directoryUUID(*s)
}
func directoryGrant(key pgtype.UUID, revision int64, p CockpitDirectoryPrincipal, b CockpitDirectoryBinding, t CockpitDirectoryTarget) CockpitDirectoryGrant {
	kind := "human"
	if p.Source == "task_token" {
		kind = "delegated_task"
	}
	return CockpitDirectoryGrant{Kind: kind, CommandKey: util.UUIDToString(key), Revision: revision, ResponsibleUserID: p.AuthorizingUserID, Principal: p, ObservedBinding: b, TargetHash: t.TargetHash, RootConfigHash: t.RootConfigHash, AcceptedAt: directoryTime()}
}
func directoryReceipt(c directoryWrite, o db.CockpitMeetingDirectoryOperation, principal CockpitDirectoryPrincipal, g CockpitDirectoryGrant, ids []string, token *string, reason string) CockpitDirectoryCommandReceipt {
	return CockpitDirectoryCommandReceipt{DirectoryOperationID: util.UUIDToString(o.ID), DirectoryStepIDs: ids, RequestHash: c.hash, ContextToken: token, PlanHash: o.PlanHash, Target: directoryRowTarget(o), ObservedBinding: g.ObservedBinding, BindAfterBase: o.BindAfterBase, OperationRevision: o.Revision, State: o.State, ResponsibleUserID: util.UUIDToString(o.ResponsibleUserID), AuthorizedAt: directoryTime(), Reason: reason, Principal: principal, Grant: g}
}
func (s *IssueService) finishDirectoryCommand(ctx context.Context, tx pgx.Tx, q *db.Queries, m db.CockpitMeeting, c directoryWrite, o db.CockpitMeetingDirectoryOperation, r CockpitDirectoryCommandReceipt) (CockpitDirectoryCommandResult, error) {
	envelope := CockpitLifecycleReceipt{Revision: m.LifecycleRevision, AgendaRevision: m.AgendaRevision, RequestHash: c.hash, Reason: r.Reason, Directory: &r}
	if len(directoryRaw(envelope)) > 65536 {
		return CockpitDirectoryCommandResult{}, directoryError("invalid_input", "The fixed directory receipt exceeds the supported size.")
	}
	err := q.CreateCockpitDirectoryCommand(ctx, db.CreateCockpitDirectoryCommandParams{WorkspaceID: c.p.WorkspaceID, MeetingID: c.p.MeetingID, CommandKey: c.key, Kind: c.action, ActorType: r.Principal.ActorType, ActorID: directoryUUID(r.Principal.ActorID), RequestHash: c.hash, Revision: m.LifecycleRevision, AgendaRevision: m.AgendaRevision, DirectoryOperationID: o.ID, Receipt: directoryRaw(envelope)})
	if err != nil {
		return CockpitDirectoryCommandResult{}, err
	}
	headers, err := s.directoryHeaders(ctx, q, c.p, m, []db.CockpitMeetingDirectoryOperation{o})
	if err != nil {
		return CockpitDirectoryCommandResult{}, err
	}
	out := CockpitDirectoryCommandResult{WorkspaceID: util.UUIDToString(c.p.WorkspaceID), MeetingID: util.UUIDToString(c.p.MeetingID), CommandKey: util.UUIDToString(c.key), Action: c.action, Receipt: r, Current: headers[0]}
	if err = tx.Commit(ctx); err != nil {
		return CockpitDirectoryCommandResult{}, err
	}
	s.directoryChanged(c.p.WorkspaceID, c.p.MeetingID, o.ID, directoryUUID(r.Principal.ActorID), r.Principal.ActorType)
	return out, nil
}
func (s *IssueService) directoryChanged(ws, meeting, operation, actor pgtype.UUID, actorType string) {
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(ws), ActorType: actorType, ActorID: util.UUIDToString(actor), Payload: map[string]any{"scope": "meeting_directory", "action": "updated", "entity": map[string]any{"meeting_id": util.UUIDToString(meeting), "directory_operation_id": util.UUIDToString(operation)}}})
	}
}

func (s *IssueService) CreateCockpitMeetingDirectory(ctx context.Context, p CockpitDirectoryRead, in CockpitDirectoryCreateInput) (CockpitDirectoryCommandResult, error) {
	var out CockpitDirectoryCommandResult
	key, err := directoryCommandKey(in.CommandKey, in.ExpectedRevision)
	if err != nil {
		return out, err
	}
	c := directoryWrite{p, key, "directory_prepare", directoryRequestHash(p, "directory_prepare", in)}
	if replay, e := s.directoryPreflightReplay(ctx, c); replay != nil || e != nil {
		if replay != nil {
			return *replay, e
		}
		return out, e
	}
	if in.ExpectedRevision != in.ObservedBindingRevision {
		return out, directoryError("binding_changed", "The binding revision does not match this command.")
	}
	preview, err := s.PreviewCockpitMeetingDirectory(ctx, p, in.CockpitDirectoryPreviewInput)
	if err != nil {
		return out, err
	}
	if !preview.CanConfirm || preview.ContextToken != in.ContextToken {
		return out, directoryError("context_changed", "Recheck the directory plan and confirm the current facts.")
	}
	tx, q, m, replay, err := s.beginDirectoryWrite(ctx, c)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if replay != nil {
		return *replay, nil
	}
	principal, err := directoryPrincipal(ctx, q, p, true)
	if err != nil {
		return out, err
	}
	if err = directoryNewPreparation(m); err != nil {
		return out, err
	}
	if directoryBinding(m) != preview.ObservedBinding {
		return out, directoryError("binding_changed", "The meeting directory binding changed.")
	}
	target, err := s.CockpitDirectoryPreparer.ResolvePreparation(util.UUIDToString(p.WorkspaceID), in.RootID, in.RelativeDirectory)
	if err != nil {
		return out, directoryConvertError(err)
	}
	check := preview
	check.Target = directoryTarget(target)
	check.Principal = &principal
	if directoryPreviewToken(check, nil) != in.ContextToken {
		return out, directoryError("context_changed", "The directory authority or root configuration changed.")
	}
	existing, e := q.FindOpenCockpitDirectoryTarget(ctx, db.FindOpenCockpitDirectoryTargetParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, RootID: directoryUUID(target.RootID), TargetHash: target.TargetHash})
	if e == nil {
		return out, &CockpitDirectoryError{Code: "directory_operation_exists", Message: "An unfinished plan already owns this exact directory target.", WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), RootID: target.RootID, OperationID: util.UUIDToString(existing.ID), CommandKey: in.CommandKey}
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	id := dbid.NewV7()
	g := directoryGrant(key, 1, principal, preview.ObservedBinding, preview.Target)
	steps := make([]pgtype.UUID, len(preview.Steps))
	ids := make([]string, len(steps))
	for i := range steps {
		steps[i] = dbid.NewV7()
		ids[i] = util.UUIDToString(steps[i])
	}
	provisional := db.CockpitMeetingDirectoryOperation{ID: id, Revision: 1, State: "active", RootID: directoryUUID(target.RootID), RootPath: target.RootPath, PrepareSubpath: target.PrepareSubpath, RelativeDirectory: target.RelativeDirectory, Directory: target.Directory, TargetHash: target.TargetHash, RootConfigHash: target.RootConfigHash, PlanHash: preview.PlanHash, ResponsibleUserID: directoryUUID(principal.AuthorizingUserID), BindAfterBase: in.BindAfterBase}
	r := directoryReceipt(c, provisional, principal, g, ids, &in.ContextToken, "")
	o, err := q.CreateCockpitDirectoryOperation(ctx, db.CreateCockpitDirectoryOperationParams{ID: id, WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, CreationCommandKey: key, RequestHash: c.hash, PlanHash: preview.PlanHash, State: "active", RootID: provisional.RootID, RootPath: target.RootPath, PrepareSubpath: target.PrepareSubpath, RelativeDirectory: target.RelativeDirectory, Directory: target.Directory, TargetHash: target.TargetHash, RootConfigHash: target.RootConfigHash, ObservedNasDir: m.NasDir, ObservedBindingRevision: m.NasDirRevision, BindAfterBase: in.BindAfterBase, CreatedByType: principal.ActorType, CreatedBy: directoryUUID(principal.ActorID), CredentialOwnerUserID: p.CredentialOwnerID, AuthorizingUserID: directoryUUID(principal.AuthorizingUserID), SourceRunID: directoryOptionalUUID(principal.RunID), SourceIssueID: directoryOptionalUUID(principal.IssueID), SourceAgentID: directoryOptionalUUID(principal.AgentID), SourceRuntimeID: directoryOptionalUUID(principal.RuntimeID), SourceTaskTokenID: p.TaskTokenID, SourceRelationKind: principal.RelationKind, SourceAgendaReferenceID: directoryOptionalUUID(principal.AgendaReferenceID), SourcePrincipal: directoryRaw(principal), LastGrantCommandKey: key, ResponsibleUserID: provisional.ResponsibleUserID, Input: directoryRaw(in), Receipt: directoryRaw(r)})
	if err != nil {
		return out, err
	}
	for i, x := range preview.Steps {
		var parent pgtype.UUID
		var next pgtype.Timestamptz
		if x.ParentPosition != nil {
			parent = steps[*x.ParentPosition]
		} else {
			next = pgtype.Timestamptz{Time: time.Now(), Valid: true}
		}
		_, err = q.CreateCockpitDirectoryStep(ctx, db.CreateCockpitDirectoryStepParams{ID: steps[i], WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: id, Position: x.Position, ParentStepID: parent, Kind: x.Kind, Label: x.Label, RelativePath: x.RelativePath, PathHash: x.PathHash, GrantCommandKey: key, GrantRevision: 1, NextAttemptAt: next})
		if err != nil {
			return out, err
		}
	}
	return s.finishDirectoryCommand(ctx, tx, q, m, c, o, r)
}
func directoryUpdateStep(x db.CockpitMeetingDirectoryStep) db.UpdateCockpitDirectoryStepParams {
	return db.UpdateCockpitDirectoryStepParams{WorkspaceID: x.WorkspaceID, OperationID: x.OperationID, ID: x.ID, ExpectedRevision: x.Revision, State: x.State, GrantCommandKey: x.GrantCommandKey, GrantRevision: x.GrantRevision, NextAttemptAt: x.NextAttemptAt, LeaseToken: x.LeaseToken, LeaseExpiresAt: x.LeaseExpiresAt, LastObservedAt: x.LastObservedAt, Outcome: x.Outcome, LastErrorCode: x.LastErrorCode}
}
func directoryUpdateOperation(o db.CockpitMeetingDirectoryOperation) db.UpdateCockpitDirectoryOperationParams {
	return db.UpdateCockpitDirectoryOperationParams{WorkspaceID: o.WorkspaceID, MeetingID: o.MeetingID, ID: o.ID, ExpectedRevision: o.Revision, State: o.State, ResponsibleUserID: o.ResponsibleUserID, LastGrantCommandKey: o.LastGrantCommandKey, BindingResult: o.BindingResult, AcceptedBindingRevision: o.AcceptedBindingRevision}
}
func directoryGrants(ctx context.Context, q *db.Queries, p CockpitDirectoryRead, steps []db.CockpitMeetingDirectoryStep) (map[pgtype.UUID]CockpitDirectoryGrant, error) {
	keys := []pgtype.UUID{}
	for _, st := range steps {
		keys = append(keys, st.GrantCommandKey)
	}
	rows, err := q.ReadCockpitDirectoryGrants(ctx, db.ReadCockpitDirectoryGrantsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Column3: keys})
	if err != nil {
		return nil, err
	}
	out := map[pgtype.UUID]CockpitDirectoryGrant{}
	for _, row := range rows {
		var g CockpitDirectoryGrant
		if err = json.Unmarshal(row.Grant, &g); err != nil {
			return nil, err
		}
		out[row.CommandKey] = g
	}
	return out, nil
}
