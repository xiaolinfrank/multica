package service

import (
	"bytes"
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func inputMaySubmit(p CockpitInputRead, a cockpitInputAuthority, h db.CockpitInput) error {
	if !inputHumanManager(p, a.Member, h) && !(p.ActorSource == "task_token" && inputSameSource(h.SourceAgentID, h.SourceIssueID, h.AuthorizingUserID, a)) {
		return inputError("permission_revoked", "Only this input's current manager or exact delegated source may submit a version.")
	}
	if h.ArchivedAt.Valid {
		return inputError("input_archived", "Unarchive this input before submitting another content version.")
	}
	return nil
}

func (s *IssueService) inputVersionReplay(ctx context.Context, q *db.Queries, p CockpitInputQuery, row db.CockpitInputVersion, hash string) (CockpitInputVersionReceipt, error) {
	var receipt CockpitInputVersionReceipt
	if (hash != "" && hash != row.RequestHash) || !inputPrincipalMatches(p.CockpitInputRead, row.ActorType, row.ActorID, row.CredentialOwnerUserID, row.AuthorizingUserID, row.SourceRunID) {
		return receipt, inputError("command_conflict", "This key belongs to another version submission or principal.")
	}
	if err := inputReplayMembership(ctx, q, p.CockpitInputRead, row.AuthorizingUserID); err != nil {
		return receipt, err
	}
	return inputVersionReceipt(row)
}

func (s *IssueService) inputVersionResult(ctx context.Context, p CockpitInputQuery, receipt CockpitInputVersionReceipt, replay bool) (CockpitInputVersionResult, error) {
	out := CockpitInputVersionResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: receipt.InputID, CommandKey: receipt.CommandKey, Action: "input_version_submit", Replayed: replay, Receipt: receipt}
	var err error
	p.InputID, err = inputReceiptID(receipt.InputID)
	if err != nil {
		return out, err
	}
	p.VersionID, err = inputReceiptID(receipt.VersionID)
	if err != nil {
		return out, err
	}
	transferID, err := inputReceiptOptionalID(receipt.TransferID)
	if err != nil {
		return out, err
	}
	tx, q, _, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	rows, err := q.GetCockpitInputVersionsByIDs(ctx, db.GetCockpitInputVersionsByIDsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{p.VersionID}})
	if err != nil {
		return out, err
	}
	if len(rows) != 1 {
		return out, inputError("target_gone", "The original fixed version no longer exists; this command cannot recreate it.")
	}
	items, err := s.inputVersions(ctx, q, p.CockpitInputRead, []db.CockpitInputVersion{db.CockpitInputVersion(rows[0])})
	if errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if len(items) == 1 {
		out.Current = &items[0]
	}
	if receipt.TransferID != nil {
		t, e := q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: transferID})
		if e != nil {
			return out, inputConvertError(e)
		}
		transfers, e := s.inputTransfers(ctx, q, p.CockpitInputRead, []db.CockpitInputTransfer{t})
		if e != nil && !errors.Is(e, ErrCockpitWorkflowForbidden) {
			return out, e
		}
		if e == nil && len(transfers) == 1 {
			out.Transfer = &transfers[0]
		}
	}
	return out, tx.Commit(ctx)
}

func (s *IssueService) SubmitCockpitInputVersion(ctx context.Context, p CockpitInputQuery, in CockpitInputVersionSubmitInput) (CockpitInputVersionResult, error) {
	var out CockpitInputVersionResult
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	if in.ExpectedRevision < 1 {
		return out, inputError("invalid_input", "The observed input revision is required.")
	}
	if len(in.InitialReference) > 0 && !bytes.Equal(bytes.TrimSpace(in.InitialReference), []byte("null")) {
		return out, inputError("invalid_input", "Meeting input references are no longer supported; use the meeting directory or an Issue input manifest.")
	}
	if err = inputSourceValidate(in.Source); err != nil {
		return out, err
	}
	hash := inputWriteHash(p.CockpitInputRead, "input_version_submit", p.InputID, in)
	// Replays precede source inspection and mutable permission/configuration
	// checks. The short preflight also rejects unauthorized NAS observations.
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	old, err := q.GetCockpitInputVersionBySubmissionKey(ctx, db.GetCockpitInputVersionBySubmissionKeyParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, SubmissionKey: key})
	if err == nil {
		receipt, e := s.inputVersionReplay(ctx, q, p, old, hash)
		if e == nil {
			e = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
		if e != nil {
			return out, e
		}
		return s.inputVersionResult(ctx, p, receipt, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		return out, err
	}
	if in.Source.Kind != "artifact_version" {
		if _, e := q.GetCockpitInputTransferWorkspaceCommand(ctx, db.GetCockpitInputTransferWorkspaceCommandParams{WorkspaceID: p.WorkspaceID, CommandKey: key}); e == nil {
			_ = tx.Rollback(ctx)
			return out, inputError("command_conflict", "This transfer key already belongs to another content intent.")
		} else if !errors.Is(e, pgx.ErrNoRows) {
			_ = tx.Rollback(ctx)
			return out, e
		}
	}
	a, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, false)
	if err != nil {
		_ = tx.Rollback(ctx)
		return out, err
	}
	head, err := q.GetCockpitInput(ctx, db.GetCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID})
	if err == nil {
		err = inputMaySubmit(p.CockpitInputRead, a, head)
	}
	if err == nil && head.Revision != in.ExpectedRevision {
		err = inputError("revision_conflict", "The input changed. Read its current revision before submitting another version.")
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return out, inputConvertError(err)
	}
	id := dbid.NewV7()
	source, err := s.inputObserveSource(ctx, p.CockpitInputRead, in.Source, a, id)
	if err != nil {
		return out, err
	}

	tx, q, err = s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	old, err = q.GetCockpitInputVersionBySubmissionKey(ctx, db.GetCockpitInputVersionBySubmissionKeyParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, SubmissionKey: key})
	if err == nil {
		receipt, e := s.inputVersionReplay(ctx, q, p, old, hash)
		if e != nil {
			return out, e
		}
		if e = tx.Commit(ctx); e != nil {
			return out, e
		}
		return s.inputVersionResult(ctx, p, receipt, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if source.transferKind != "" {
		if _, e := q.GetCockpitInputTransferWorkspaceCommand(ctx, db.GetCockpitInputTransferWorkspaceCommandParams{WorkspaceID: p.WorkspaceID, CommandKey: key}); e == nil {
			return out, inputError("command_conflict", "This transfer key already belongs to another content intent.")
		} else if !errors.Is(e, pgx.ErrNoRows) {
			return out, e
		}
	}
	a, err = inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	head, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if err = inputMaySubmit(p.CockpitInputRead, a, head); err != nil {
		return out, err
	}
	if head.Revision != in.ExpectedRevision {
		return out, inputError("revision_conflict", "The input changed while its source was being observed.")
	}
	if source.version.SourceKind == "nas_file" {
		root, e := s.CockpitInputNAS.InputRoot(util.UUIDToString(p.WorkspaceID))
		if e != nil {
			return out, inputConvertError(e)
		}
		if root == nil || root.RootConfigHash != source.version.SourceRootConfigHash.String || root.Path != source.version.SourceRootPath.String {
			return out, inputError("source_changed", "The configured NAS source changed after observation.")
		}
	}
	number, err := q.NextCockpitInputVersionNumber(ctx, db.NextCockpitInputVersionNumberParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID})
	if err != nil {
		return out, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	stamp := pgtype.Timestamptz{Time: now, Valid: true}
	principal := a.Principal
	ids, err := inputParsePrincipalIDs(principal)
	if err != nil {
		return out, err
	}
	receipt := CockpitInputVersionReceipt{CommandKey: in.CommandKey, RequestHash: hash, InputID: util.UUIDToString(p.InputID), VersionID: util.UUIDToString(id), VersionNumber: number, InputRevision: head.Revision + 1, Source: in.Source, PayloadKind: source.version.PayloadKind, CaptureState: source.version.CaptureState, Principal: principal, AcceptedAt: inputTime(stamp)}
	v := source.version
	v.WorkspaceID, v.InputID, v.VersionNumber, v.SubmissionKey, v.RequestHash, v.Revision = p.WorkspaceID, p.InputID, number, key, hash, 1
	v.ActorType, v.ActorID, v.CredentialOwnerUserID, v.AuthorizingUserID = principal.ActorType, ids.actor, ids.credential, ids.authorizer
	v.SourceAgentID, v.SourceRunID, v.SourceIssueID, v.SourceRuntimeID = ids.agent, ids.run, ids.issue, ids.runtime
	v.CreatedAt, v.UpdatedAt = stamp, stamp
	var transfer db.CreateCockpitInputTransferParams
	if source.transferKind != "" {
		transferID := dbid.NewV7()
		receipt.TransferID, receipt.TransferRevision = planningUUID(transferID), inputInt(pgtype.Int8{Int64: 1, Valid: true})
		v.ActiveTransferID = transferID
		transfer, err = inputNewTransferParams(p.CockpitInputRead, principal, v.ID, p.InputID, transferID, key, hash, "initial", source.transferKind, 1, pgtype.UUID{}, v.DeclaredSizeBytes.Int64, v.Filename, v.ContentType, stamp)
		if err != nil {
			return out, err
		}
		transfer.CommandReceipt = inputRaw(receipt)
	}
	v.SubmissionReceipt = inputRaw(receipt)
	if _, err = q.CreateCockpitInputVersion(ctx, v); err != nil {
		return out, err
	}
	if source.transferKind != "" {
		if _, err = q.CreateCockpitInputTransfer(ctx, transfer); err != nil {
			return out, err
		}
	}
	if _, err = q.SetCockpitInputCurrentVersion(ctx, db.SetCockpitInputCurrentVersionParams{WorkspaceID: p.WorkspaceID, ID: p.InputID, CurrentVersionID: id, Revision: head.Revision}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, principal)
	return s.inputVersionResult(ctx, p, receipt, false)
}

func inputNewTransferParams(p CockpitInputRead, principal CockpitInputPrincipal, version, input, id, key pgtype.UUID, hash, mode, kind string, number int32, previous pgtype.UUID, size int64, filename, contentType string, now pgtype.Timestamptz) (db.CreateCockpitInputTransferParams, error) {
	storageKey, err := artifactcapture.InputTargetKey(artifactcapture.InputTarget{WorkspaceID: util.UUIDToString(p.WorkspaceID), VersionID: util.UUIDToString(version), TransferID: util.UUIDToString(id), Filename: filename, ContentType: contentType})
	if err != nil {
		return db.CreateCockpitInputTransferParams{}, err
	}
	ids, err := inputParsePrincipalIDs(principal)
	if err != nil {
		return db.CreateCockpitInputTransferParams{}, err
	}
	t := db.CreateCockpitInputTransferParams{ID: id, WorkspaceID: p.WorkspaceID, InputID: input, VersionID: version, TransferNumber: number, CommandKey: key, RequestHash: hash, ActorType: pgtype.Text{String: principal.ActorType, Valid: true}, ActorID: ids.actor, CredentialOwnerUserID: ids.credential, AuthorizingUserID: ids.authorizer, SourceAgentID: ids.agent, SourceRunID: ids.run, SourceIssueID: ids.issue, SourceRuntimeID: ids.runtime, Kind: kind, Mode: mode, State: "queued", Revision: 1, ReplacesTransferID: previous, OwnedStorageKey: storageKey, ExpectedBytes: size, NextAttemptAt: now, CreatedAt: now, UpdatedAt: now}
	if kind == "direct_upload" {
		t.State = "awaiting_bytes"
		t.SessionExpiresAt = pgtype.Timestamptz{Time: now.Time.Add(24 * time.Hour), Valid: true}
		t.NextAttemptAt = t.SessionExpiresAt
	}
	return t, nil
}

func (s *IssueService) GetCockpitInputVersionCommand(ctx context.Context, p CockpitInputQuery) (CockpitInputVersionResult, error) {
	var out CockpitInputVersionResult
	if _, err := inputMembership(ctx, s.Queries, p.CockpitInputRead); err != nil {
		return out, err
	}
	row, err := s.Queries.GetCockpitInputVersionBySubmissionKey(ctx, db.GetCockpitInputVersionBySubmissionKeyParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, SubmissionKey: p.CommandKey})
	if err != nil {
		return out, inputConvertError(err)
	}
	receipt, err := s.inputVersionReplay(ctx, s.Queries, p, row, "")
	if err != nil {
		return out, err
	}
	return s.inputVersionResult(ctx, p, receipt, true)
}
