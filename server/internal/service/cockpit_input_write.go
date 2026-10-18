package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func inputKey(v string) (pgtype.UUID, error) {
	id, err := util.ParseUUID(v)
	if err != nil || !id.Valid {
		return pgtype.UUID{}, inputError("invalid_input", "A valid command UUID is required.")
	}
	return id, nil
}
func inputRaw(v any) []byte { b, _ := json.Marshal(v); return b }
func inputConvertError(err error) error {
	if err == nil {
		return nil
	}
	var nas *cockpitnas.Error
	if errors.As(err, &nas) {
		e := inputError(nas.Code, nas.Message)
		e.Retryable = nas.Retryable
		return e
	}
	var capture *artifactcapture.Error
	if errors.As(err, &capture) {
		e := inputError(capture.Code, capture.Message)
		e.Retryable = capture.Retryable
		return e
	}

	if errors.Is(err, pgx.ErrNoRows) {
		return inputError("not_found", "The requested input object is unavailable.")
	}
	return err
}
func inputWriteHash(p CockpitInputRead, action string, target pgtype.UUID, in any) string {
	return planningHash([]any{p.WorkspaceID, p.ActorSource, p.CredentialOwnerID, p.AgentID, p.RunID, action, target, in})
}
func inputPrincipalMatches(p CockpitInputRead, actorType string, actor, credential, authorizer, run pgtype.UUID) bool {
	if p.ActorSource == "human" {
		return actorType == "member" && actor == p.CredentialOwnerID && credential == p.CredentialOwnerID && authorizer == p.CredentialOwnerID
	}
	return p.ActorSource == "task_token" && actorType == "agent" && actor == p.AgentID && credential == p.CredentialOwnerID && run == p.RunID
}
func inputReplayMembership(ctx context.Context, q *db.Queries, p CockpitInputRead, authorizer pgtype.UUID) error {
	if p.ActorSource == "task_token" {
		token, err := q.ReadLiveCockpitDirectoryTaskToken(ctx, db.ReadLiveCockpitDirectoryTaskTokenParams{WorkspaceID: p.WorkspaceID, ID: p.TaskTokenID})
		if errors.Is(err, pgx.ErrNoRows) {
			return inputError("task_context_required", "The original task credential is unavailable.")
		}
		if err != nil {
			return err
		}
		if token.TaskID != p.RunID || token.AgentID != p.AgentID || token.UserID != p.CredentialOwnerID {
			return inputError("task_context_required", "This credential cannot reconcile the original task command.")
		}
	}

	if _, err := inputMembership(ctx, q, p); err != nil {
		return err
	}
	if authorizer != p.CredentialOwnerID {
		if _, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{WorkspaceID: p.WorkspaceID, UserID: authorizer}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return inputError("permission_revoked", "The original authorizing member is no longer in this workspace.")
			}
			return err
		}
	}
	return nil
}
func (s *IssueService) beginInputCommand(ctx context.Context, p CockpitInputRead, key pgtype.UUID) (pgx.Tx, *db.Queries, error) {
	if p.ActorSource != "human" && p.ActorSource != "task_token" {
		return nil, nil, inputError("task_context_required", "New input commands require a human or task-specific delegation.")
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	q := s.Queries.WithTx(tx)
	fail := func(err error) (pgx.Tx, *db.Queries, error) { _ = tx.Rollback(ctx); return nil, nil, err }
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, p.WorkspaceID); err != nil {
		return fail(inputConvertError(err))
	}
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: p.WorkspaceID, UserID: p.CredentialOwnerID}); err != nil {
		return fail(inputError("permission_revoked", "The credential owner is not a current workspace member."))
	}
	if err = q.LockCockpitInputCommand(ctx, db.LockCockpitInputCommandParams{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: util.UUIDToString(key)}); err != nil {
		return fail(err)
	}
	return tx, q, nil
}
func (s *IssueService) inputChanged(ws, id pgtype.UUID, p CockpitInputPrincipal) {
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(ws), ActorType: p.ActorType, ActorID: p.ActorID, Payload: map[string]any{"scope": "inputs", "action": "updated", "entity_id": util.UUIDToString(id), "entity": map[string]any{"input_id": util.UUIDToString(id)}}})
	}
}

func (s *IssueService) CreateCockpitInput(ctx context.Context, p CockpitInputRead, in CockpitInputCreateInput) (CockpitInputCreateResult, error) {
	var out CockpitInputCreateResult
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	in.Title = strings.TrimSpace(in.Title)
	if !utf8.ValidString(in.Title) || len(in.Title) == 0 || len(in.Title) > CockpitInputMaxTitleBytes || !utf8.ValidString(in.Description) || len(in.Description) > CockpitInputMaxDescriptionBytes {
		return out, inputError("invalid_input", "Input title or description exceeds its supported size.")
	}
	project, err := inputOptionalID(in.ProjectID)
	if err != nil {
		return out, err
	}
	origin, err := inputOptionalID(in.OriginIssueID)
	if err != nil {
		return out, err
	}
	hash := inputWriteHash(p, "input_create", pgtype.UUID{}, in)
	tx, q, err := s.beginInputCommand(ctx, p, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	old, err := q.GetCockpitInputByCreationKey(ctx, db.GetCockpitInputByCreationKeyParams{WorkspaceID: p.WorkspaceID, CreationKey: key})
	if err == nil {
		if old.RequestHash != hash || !inputPrincipalMatches(p, old.ActorType, old.ActorID, old.CredentialOwnerUserID, old.AuthorizingUserID, old.SourceRunID) {
			return out, inputError("command_conflict", "This key belongs to a different input registration intent or principal.")
		}
		if err = inputReplayMembership(ctx, q, p, old.AuthorizingUserID); err != nil {
			return out, err
		}
		receipt, err := inputCreateReceipt(old)
		if err != nil {
			return out, err
		}
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		current, err := s.inputCommandCurrent(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: old.ID})
		if err != nil {
			return out, err
		}
		return CockpitInputCreateResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: in.CommandKey, Action: "input_create", Replayed: true, Receipt: receipt, Current: current}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	authority, err := inputNewPrincipal(ctx, q, p, true)
	if err != nil {
		return out, err
	}
	if origin.Valid {
		if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: origin}); err != nil {
			return out, inputConvertError(err)
		}
		if authority.Principal.ActorType == "agent" && origin != authority.Run.IssueID {
			return out, inputError("permission_revoked", "A task may register input only for its own precise source Issue.")
		}
	}
	if project.Valid {
		if _, err = q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: project}); err != nil {
			return out, inputConvertError(err)
		}
		if authority.Principal.ActorType == "agent" {
			source, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: authority.Run.IssueID})
			if err != nil {
				return out, err
			}
			if source.ProjectID != project {
				return out, inputError("permission_revoked", "A delegated registration cannot expand to another project.")
			}
		}
	}
	id := dbid.NewV7()
	now := time.Now().UTC().Truncate(time.Microsecond)
	receipt := CockpitInputCreateReceipt{InputRevision: 1, CommandKey: in.CommandKey, RequestHash: hash, InputID: util.UUIDToString(id), Title: in.Title, Description: in.Description, ProjectID: in.ProjectID, OriginIssueID: in.OriginIssueID, Principal: authority.Principal, CreatedAt: now.Format(time.RFC3339Nano)}
	a := authority.Principal
	ids, err := inputParsePrincipalIDs(a)
	if err != nil {
		return out, err
	}
	_, err = q.CreateCockpitInput(ctx, db.CreateCockpitInputParams{ID: id, WorkspaceID: p.WorkspaceID, CreationKey: key, RequestHash: hash, CreationReceipt: inputRaw(receipt), Title: in.Title, Description: in.Description, ProjectID: project, OriginIssueID: origin, ActorType: a.ActorType, ActorID: ids.actor, CredentialOwnerUserID: ids.credential, AuthorizingUserID: ids.authorizer, SourceAgentID: ids.agent, SourceRunID: ids.run, SourceIssueID: ids.issue, SourceRuntimeID: ids.runtime, CreatedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, id, a)
	current, err := s.inputCommandCurrent(ctx, CockpitInputQuery{CockpitInputRead: p, InputID: id})
	if err != nil {
		return out, err
	}
	return CockpitInputCreateResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: in.CommandKey, Action: "input_create", Receipt: receipt, Current: current}, nil
}
func (s *IssueService) GetCockpitInputCreateCommand(ctx context.Context, p CockpitInputQuery) (CockpitInputCreateResult, error) {
	var out CockpitInputCreateResult
	if _, err := inputMembership(ctx, s.Queries, p.CockpitInputRead); err != nil {
		return out, err
	}
	row, err := s.Queries.GetCockpitInputByCreationKey(ctx, db.GetCockpitInputByCreationKeyParams{WorkspaceID: p.WorkspaceID, CreationKey: p.CommandKey})
	if err != nil {
		return out, inputConvertError(err)
	}
	if !inputPrincipalMatches(p.CockpitInputRead, row.ActorType, row.ActorID, row.CredentialOwnerUserID, row.AuthorizingUserID, row.SourceRunID) {
		return out, inputError("permission_revoked", "Only the original command principal can reconcile this registration.")
	}
	if err = inputReplayMembership(ctx, s.Queries, p.CockpitInputRead, row.AuthorizingUserID); err != nil {
		return out, err
	}
	receipt, err := inputCreateReceipt(row)
	if err != nil {
		return out, err
	}
	p.InputID = row.ID
	current, err := s.inputCommandCurrent(ctx, p)
	if err != nil {
		return out, err
	}
	return CockpitInputCreateResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: receipt.CommandKey, Action: "input_create", Replayed: true, Receipt: receipt, Current: current}, nil
}
func (s *IssueService) EditCockpitInput(ctx context.Context, p CockpitInputQuery, in CockpitInputEditInput) (CockpitInputHeader, error) {
	var out CockpitInputHeader
	in.Title = strings.TrimSpace(in.Title)
	if in.ExpectedRevision < 1 || !utf8.ValidString(in.Title) || len(in.Title) == 0 || len(in.Title) > CockpitInputMaxTitleBytes || !utf8.ValidString(in.Description) || len(in.Description) > CockpitInputMaxDescriptionBytes {
		return out, inputError("invalid_input", "Input revision, title or description is invalid.")
	}
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, p.InputID)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	authority, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	row, err := q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if !inputHumanManager(p.CockpitInputRead, authority.Member, row) {
		return out, inputError("permission_revoked", "Only a current human input manager can edit its metadata.")
	}
	if row.Revision != in.ExpectedRevision {
		return out, inputError("input_changed", "The input changed. Reload it before confirming this edit.")
	}
	if _, err = q.EditCockpitInput(ctx, db.EditCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID, Title: in.Title, Description: in.Description, Revision: in.ExpectedRevision}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, authority.Principal)
	return s.GetCockpitInput(ctx, p)
}
func (s *IssueService) ArchiveCockpitInput(ctx context.Context, p CockpitInputQuery, in CockpitInputArchiveInput) (CockpitInputHeader, error) {
	var out CockpitInputHeader
	if in.ExpectedRevision < 1 {
		return out, inputError("invalid_input", "A current input revision is required.")
	}
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, p.InputID)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	authority, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	row, err := q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if !inputHumanManager(p.CockpitInputRead, authority.Member, row) {
		return out, inputError("permission_revoked", "Only a current human input manager can archive or restore it.")
	}
	if row.Revision != in.ExpectedRevision {
		return out, inputError("input_changed", "The input changed. Reload it before confirming archive status.")
	}
	if row.ArchivedAt.Valid != in.Archived {
		if _, err = q.ArchiveCockpitInput(ctx, db.ArchiveCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID, Archived: in.Archived, ActorID: p.CredentialOwnerID, ExpectedRevision: in.ExpectedRevision}); err != nil {
			return out, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, authority.Principal)
	return s.GetCockpitInput(ctx, p)
}

func (s *IssueService) inputCommandCurrent(ctx context.Context, p CockpitInputQuery) (*CockpitInputHeader, error) {
	current, err := s.GetCockpitInput(ctx, p)
	if errors.Is(err, ErrCockpitWorkflowForbidden) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &current, nil
}
