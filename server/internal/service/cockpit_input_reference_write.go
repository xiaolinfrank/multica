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

func inputReferencePurpose(purpose string) error {
	switch purpose {
	case "material", "recording", "supporting":
		return nil
	}
	return inputError("invalid_input", "Choose material, recording or supporting for this exact reference.")
}
func inputReferenceCommand(ctx context.Context, q *db.Queries, p CockpitInputQuery) (db.CockpitInputReference, bool, error) {
	row, err := q.GetCockpitInputReferenceByCreationKey(ctx, db.GetCockpitInputReferenceByCreationKeyParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, CreationKey: p.CommandKey})
	if err == nil {
		return row, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, false, err
	}
	row, err = q.GetCockpitInputReferenceByRemovalKey(ctx, db.GetCockpitInputReferenceByRemovalKeyParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, RemovalKey: p.CommandKey})
	return row, true, err
}
func inputReferenceReceipt(row db.CockpitInputReference, removed bool) (CockpitInputReferenceReceipt, error) {
	var receipt CockpitInputReferenceReceipt
	data := row.CreationReceipt
	if removed {
		data = row.RemovalReceipt
	}
	if err := json.Unmarshal(data, &receipt); err != nil {
		return receipt, err
	}
	key, hash := row.CreationKey, row.RequestHash
	if removed {
		key, hash = row.RemovalKey, row.RemovalHash.String
	}
	for _, field := range []struct {
		value    string
		expected pgtype.UUID
	}{
		{receipt.CommandKey, key}, {receipt.ReferenceID, row.ID}, {receipt.MeetingID, row.MeetingID},
		{receipt.InputID, row.InputID}, {receipt.InputVersionID, row.InputVersionID},
	} {
		id, err := util.ParseUUID(field.value)
		if err != nil || !id.Valid || id != field.expected {
			return receipt, inputError("input_integrity_error", "The original input reference identity is inconsistent.")
		}
	}
	if (receipt.AgendaID == nil) != !row.AgendaID.Valid {
		return receipt, inputError("input_integrity_error", "The original input reference agenda is inconsistent.")
	}
	if receipt.AgendaID != nil {
		id, err := util.ParseUUID(*receipt.AgendaID)
		if err != nil || !id.Valid || id != row.AgendaID {
			return receipt, inputError("input_integrity_error", "The original input reference agenda is inconsistent.")
		}
	}
	if receipt.RequestHash != hash || receipt.Removed != removed {
		return receipt, inputError("input_integrity_error", "The original input reference receipt is inconsistent.")
	}
	return receipt, nil
}
func inputReferenceReplayPrincipal(ctx context.Context, q *db.Queries, p CockpitInputRead, r CockpitInputReferenceReceipt) error {
	a, err := inputParsePrincipalIDs(r.Principal)
	if err != nil {
		return err
	}
	if !inputPrincipalMatches(p, a.kind, a.actor, a.credential, a.authorizer, a.run) {
		return inputError("permission_revoked", "Only the original command principal can reconcile this reference change.")
	}
	return inputReplayMembership(ctx, q, p, a.authorizer)
}
func inputReferenceTargetExists(ctx context.Context, q *db.Queries, p CockpitInputRead, row db.CockpitInputReference) error {
	if _, err := inputReadMeeting(ctx, q, CockpitInputQuery{CockpitInputRead: p, MeetingID: row.MeetingID, AgendaID: row.AgendaID}); err != nil {
		if errors.Is(err, ErrCockpitWorkflowNotFound) {
			return inputError("target_gone", "The original meeting or agenda is no longer retained.")
		}
		return err
	}
	heads, err := q.ReadCockpitInputHeaders(ctx, db.ReadCockpitInputHeadersParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{row.InputID}})
	if err != nil {
		return err
	}
	versions, err := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{row.InputVersionID}})
	if err != nil {
		return err
	}
	if len(heads) != 1 || len(versions) != 1 || versions[0].InputID != row.InputID {
		return inputError("target_gone", "The original fixed input reference is no longer retained.")
	}
	return nil
}
func (s *IssueService) inputReferenceResult(ctx context.Context, p CockpitInputRead, row db.CockpitInputReference, receipt CockpitInputReferenceReceipt, replayed bool) (CockpitInputReferenceResult, error) {
	action := "input_reference_create"
	if receipt.Removed {
		action = "input_reference_remove"
	}
	out := CockpitInputReferenceResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: receipt.CommandKey, Action: action, Replayed: replayed, Receipt: receipt}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = inputReferenceReplayPrincipal(ctx, q, p, receipt); err != nil {
		return out, err
	}
	if err = inputReferenceTargetExists(ctx, q, p, row); err != nil {
		return out, err
	}
	current, err := s.inputReferences(ctx, q, p, []db.CockpitInputReference{row})
	if err != nil && !errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, err
	}
	if err == nil {
		out.Current = &current[0]
	}
	return out, tx.Commit(ctx)
}
func inputReferenceReady(ctx context.Context, q *db.Queries, p CockpitInputRead, versionID pgtype.UUID) (db.ReadCockpitInputVersionsRow, error) {
	rows, err := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{versionID}})
	if err != nil {
		return db.ReadCockpitInputVersionsRow{}, err
	}
	if len(rows) != 1 {
		return db.ReadCockpitInputVersionsRow{}, inputError("not_found", "The selected fixed version is unavailable.")
	}
	v := rows[0]
	if v.CaptureState != "ready" || !v.ReadyAt.Valid || !v.PinnedAt.Valid || !v.PinnedSizeBytes.Valid || !v.ContentHash.Valid || !inputHashValid(v.ContentHash.String) {
		return v, inputError("input_not_ready", "Wait for this version to finish fixing its content before adding a reference.")
	}
	heads, err := q.ReadCockpitInputHeaders(ctx, db.ReadCockpitInputHeadersParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{v.InputID}})
	if err != nil {
		return v, err
	}
	if len(heads) != 1 {
		return v, inputError("not_found", "The selected input is unavailable.")
	}
	return v, nil
}
func inputInsertReference(ctx context.Context, q *db.Queries, p CockpitInputRead, a cockpitInputAuthority, inputID, versionID pgtype.UUID, in CockpitInputInitialReference, now time.Time) (db.CockpitInputReference, CockpitInputReferenceReceipt, error) {
	var row db.CockpitInputReference
	var receipt CockpitInputReferenceReceipt
	key, err := inputKey(in.ReferenceKey)
	if err != nil {
		return row, receipt, err
	}
	meeting, err := inputKey(in.MeetingID)
	if err != nil {
		return row, receipt, err
	}
	agenda, err := inputOptionalID(in.AgendaID)
	if err != nil {
		return row, receipt, err
	}
	if err = inputReferencePurpose(in.Purpose); err != nil {
		return row, receipt, err
	}
	if !inputID.Valid || !versionID.Valid {
		return row, receipt, inputError("invalid_input", "The exact input and version identities are required.")
	}
	scope := CockpitInputQuery{CockpitInputRead: p, MeetingID: meeting, AgendaID: agenda, CommandKey: key}
	// The caller holds the board and meeting locks. Do not acquire a second
	// command advisory lock after those locks: version initialization owns its
	// own command key and must not invert ordinary reference-command lock order.
	if _, _, err = inputReferenceCommand(ctx, q, scope); err == nil {
		return row, receipt, inputError("command_conflict", "This reference command key already identifies another accepted operation.")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return row, receipt, err
	}
	reasons, err := inputReadMeeting(ctx, q, scope)
	if err != nil {
		return row, receipt, err
	}
	if len(reasons) > 0 {
		return row, receipt, inputError(reasons[0], "This meeting or agenda does not currently accept preparation inputs.")
	}
	duplicate, err := q.FindCockpitInputActiveReference(ctx, db.FindCockpitInputActiveReferenceParams{WorkspaceID: p.WorkspaceID, MeetingID: meeting, AgendaID: agenda, InputVersionID: versionID, Purpose: in.Purpose})
	if err == nil {
		conflict := inputError("reference_exists", "This fixed version already has this exact meeting or agenda reference.")
		conflict.ExistingReferenceID = util.UUIDToString(duplicate.ID)
		return row, receipt, conflict
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, receipt, err
	}
	intent := CockpitInputReferenceCreateInput{CommandKey: in.ReferenceKey, AgendaID: in.AgendaID, InputVersionID: util.UUIDToString(versionID), Purpose: in.Purpose}
	hash := inputWriteHash(p, "input_reference_create", meeting, intent)
	id := dbid.NewV7()
	now = now.UTC().Truncate(time.Microsecond)
	receipt = CockpitInputReferenceReceipt{CommandKey: in.ReferenceKey, RequestHash: hash, ReferenceID: util.UUIDToString(id), MeetingID: in.MeetingID, AgendaID: in.AgendaID, InputID: util.UUIDToString(inputID), InputVersionID: util.UUIDToString(versionID), Purpose: in.Purpose, Principal: a.Principal, AcceptedAt: now.Format(time.RFC3339Nano)}
	principal, err := inputParsePrincipalIDs(a.Principal)
	if err != nil {
		return row, receipt, err
	}
	row, err = q.CreateCockpitInputReference(ctx, db.CreateCockpitInputReferenceParams{ID: id, WorkspaceID: p.WorkspaceID, MeetingID: meeting, AgendaID: agenda, InputID: inputID, InputVersionID: versionID, Purpose: in.Purpose, CreationKey: key, RequestHash: hash, CreationReceipt: inputRaw(receipt), ActorType: principal.kind, ActorID: principal.actor, CredentialOwnerUserID: p.CredentialOwnerID, AuthorizingUserID: principal.authorizer, SourceAgentID: principal.agent, SourceRunID: principal.run, SourceIssueID: principal.issue, SourceRuntimeID: principal.runtime, CreatedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	return row, receipt, err
}

// Only version initialization calls this after validating the target and the
// exact preparation-task delegation. The new version is inserted in the same
// transaction immediately after its immutable receipt embeds this reference.
func inputCreateInitialReference(ctx context.Context, q *db.Queries, p CockpitInputRead, a cockpitInputAuthority, inputID, versionID pgtype.UUID, in CockpitInputInitialReference, now time.Time) (*CockpitInputReferenceReceipt, error) {
	_, receipt, err := inputInsertReference(ctx, q, p, a, inputID, versionID, in, now)
	if err != nil {
		return nil, err
	}
	return &receipt, nil
}
func (s *IssueService) CreateCockpitInputReference(ctx context.Context, p CockpitInputQuery, in CockpitInputReferenceCreateInput) (CockpitInputReferenceResult, error) {
	var out CockpitInputReferenceResult
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	version, err := inputKey(in.InputVersionID)
	if err != nil {
		return out, err
	}
	agenda, err := inputOptionalID(in.AgendaID)
	if err != nil {
		return out, err
	}
	if err = inputReferencePurpose(in.Purpose); err != nil {
		return out, err
	}
	p.CommandKey = key
	p.AgendaID = agenda
	hash := inputWriteHash(p.CockpitInputRead, "input_reference_create", p.MeetingID, in)
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	replay := func() (db.CockpitInputReference, *CockpitInputReferenceReceipt, error) {
		row, removed, e := inputReferenceCommand(ctx, q, p)
		if errors.Is(e, pgx.ErrNoRows) {
			return row, nil, nil
		}
		if e != nil {
			return row, nil, e
		}
		if removed || row.RequestHash != hash {
			return row, nil, inputError("command_conflict", "This key belongs to a different reference intent.")
		}
		receipt, e := inputReferenceReceipt(row, false)
		if e != nil {
			return row, nil, e
		}
		if e = inputReferenceReplayPrincipal(ctx, q, p.CockpitInputRead, receipt); e != nil {
			return row, nil, e
		}
		return row, &receipt, nil
	}
	row, receipt, err := replay()
	if err != nil {
		return out, err
	}
	if receipt != nil {
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return s.inputReferenceResult(ctx, p.CockpitInputRead, row, *receipt, true)
	}
	if p.ActorSource != "human" {
		return out, inputError("permission_revoked", "Only a human may add a new reference to an existing input version.")
	}
	a, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	if _, err = lockLifecycleMeeting(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return out, err
	}
	row, receipt, err = replay()
	if err != nil {
		return out, err
	}
	if receipt != nil {
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return s.inputReferenceResult(ctx, p.CockpitInputRead, row, *receipt, true)
	}
	fixed, err := inputReferenceReady(ctx, q, p.CockpitInputRead, version)
	if err != nil {
		return out, err
	}
	row, value, err := inputInsertReference(ctx, q, p.CockpitInputRead, a, fixed.InputID, version, CockpitInputInitialReference{ReferenceKey: in.CommandKey, MeetingID: util.UUIDToString(p.MeetingID), AgendaID: in.AgendaID, Purpose: in.Purpose}, time.Now())
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputReferenceChanged(p.WorkspaceID, fixed.InputID, p.MeetingID, a.Principal)
	return s.inputReferenceResult(ctx, p.CockpitInputRead, row, value, false)
}
func (s *IssueService) RemoveCockpitInputReference(ctx context.Context, p CockpitInputQuery, in CockpitInputReferenceRemoveInput) (CockpitInputReferenceResult, error) {
	var out CockpitInputReferenceResult
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	p.CommandKey = key
	hash := inputWriteHash(p.CockpitInputRead, "input_reference_remove", p.ReferenceID, in)
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	replay := func() (db.CockpitInputReference, *CockpitInputReferenceReceipt, error) {
		row, removed, e := inputReferenceCommand(ctx, q, p)
		if errors.Is(e, pgx.ErrNoRows) {
			return row, nil, nil
		}
		if e != nil {
			return row, nil, e
		}
		if !removed || row.ID != p.ReferenceID || row.RemovalHash.String != hash {
			return row, nil, inputError("command_conflict", "This key belongs to a different reference change.")
		}
		receipt, e := inputReferenceReceipt(row, true)
		if e != nil {
			return row, nil, e
		}
		if e = inputReferenceReplayPrincipal(ctx, q, p.CockpitInputRead, receipt); e != nil {
			return row, nil, e
		}
		return row, &receipt, nil
	}
	row, receipt, err := replay()
	if err != nil {
		return out, err
	}
	if receipt != nil {
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return s.inputReferenceResult(ctx, p.CockpitInputRead, row, *receipt, true)
	}
	if p.ActorSource != "human" {
		return out, inputError("permission_revoked", "Only a current human member may remove a meeting input reference.")
	}
	a, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	if _, err = lockLifecycleMeeting(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return out, err
	}
	row, receipt, err = replay()
	if err != nil {
		return out, err
	}
	if receipt != nil {
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return s.inputReferenceResult(ctx, p.CockpitInputRead, row, *receipt, true)
	}
	row, err = q.LockCockpitInputReference(ctx, db.LockCockpitInputReferenceParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ReferenceID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if row.RemovedAt.Valid {
		return out, inputError("reference_removed", "This exact reference was already removed by another command.")
	}
	if err = inputReferenceTargetExists(ctx, q, p.CockpitInputRead, row); err != nil {
		return out, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	value := CockpitInputReferenceReceipt{CommandKey: in.CommandKey, RequestHash: hash, ReferenceID: util.UUIDToString(row.ID), MeetingID: util.UUIDToString(row.MeetingID), AgendaID: planningUUID(row.AgendaID), InputID: util.UUIDToString(row.InputID), InputVersionID: util.UUIDToString(row.InputVersionID), Purpose: row.Purpose, Removed: true, Principal: a.Principal, AcceptedAt: now.Format(time.RFC3339Nano)}
	row, err = q.RemoveCockpitInputReference(ctx, db.RemoveCockpitInputReferenceParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ReferenceID, RemovedBy: p.CredentialOwnerID, RemovalKey: key, RemovalHash: pgtype.Text{String: hash, Valid: true}, RemovalReceipt: inputRaw(value)})
	if err != nil {
		return out, inputConvertError(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputReferenceChanged(p.WorkspaceID, row.InputID, p.MeetingID, a.Principal)
	return s.inputReferenceResult(ctx, p.CockpitInputRead, row, value, false)
}
func (s *IssueService) GetCockpitInputReferenceCommand(ctx context.Context, p CockpitInputQuery) (CockpitInputReferenceResult, error) {
	var out CockpitInputReferenceResult
	if _, err := inputMembership(ctx, s.Queries, p.CockpitInputRead); err != nil {
		return out, err
	}
	row, removed, err := inputReferenceCommand(ctx, s.Queries, p)
	if err != nil {
		return out, inputConvertError(err)
	}
	receipt, err := inputReferenceReceipt(row, removed)
	if err != nil {
		return out, err
	}
	return s.inputReferenceResult(ctx, p.CockpitInputRead, row, receipt, true)
}

func (s *IssueService) inputReferenceChanged(ws, inputID, meetingID pgtype.UUID, p CockpitInputPrincipal) {
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(ws), ActorType: p.ActorType, ActorID: p.ActorID, Payload: map[string]any{"scope": "inputs", "action": "reference_updated", "entity_id": util.UUIDToString(inputID), "entity": map[string]any{"input_id": util.UUIDToString(inputID), "meeting_id": util.UUIDToString(meetingID)}}})
	}
}

// Principal DTOs can come from retained receipts. Invalid identities are an
// integrity failure, never anonymous identities or a missing-object response.
func inputParsePrincipalIDs(p CockpitInputPrincipal) (inputProjectionActor, error) {
	out := inputProjectionActor{kind: p.ActorType}
	if p.ActorType != "member" && p.ActorType != "agent" {
		return out, inputError("input_integrity_error", "The retained input principal kind is invalid.")
	}
	for _, field := range []struct {
		value  string
		target *pgtype.UUID
	}{
		{p.ActorID, &out.actor}, {p.CredentialOwnerUserID, &out.credential}, {p.AuthorizingUserID, &out.authorizer},
	} {
		id, err := util.ParseUUID(field.value)
		if err != nil || !id.Valid {
			return out, inputError("input_integrity_error", "The retained input principal identity is invalid.")
		}
		*field.target = id
	}
	for _, field := range []struct {
		value  *string
		target *pgtype.UUID
	}{
		{p.AgentID, &out.agent}, {p.RunID, &out.run}, {p.IssueID, &out.issue}, {p.RuntimeID, &out.runtime},
	} {
		if field.value == nil {
			continue
		}
		id, err := util.ParseUUID(*field.value)
		if err != nil || !id.Valid {
			return out, inputError("input_integrity_error", "The retained input task identity is invalid.")
		}
		*field.target = id
	}
	return out, nil
}
