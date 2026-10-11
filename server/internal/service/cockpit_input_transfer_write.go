package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func (s *IssueService) inputTransferResult(ctx context.Context, p CockpitInputQuery, r CockpitInputTransferReceipt, replay bool) (CockpitInputTransferResult, error) {
	out := CockpitInputTransferResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: r.InputID, VersionID: r.VersionID, CommandKey: r.CommandKey, Action: r.Action, Replayed: replay, Receipt: r}
	var err error
	p.InputID, err = inputReceiptID(r.InputID)
	if err != nil {
		return out, err
	}
	p.VersionID, err = inputReceiptID(r.VersionID)
	if err != nil {
		return out, err
	}
	p.TransferID, err = inputReceiptID(r.TransferID)
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
	t, err := q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, inputError("target_gone", "The original transfer no longer exists and cannot be recreated by this command.")
	}
	if err != nil {
		return out, err
	}
	versions, err := q.GetCockpitInputVersionsByIDs(ctx, db.GetCockpitInputVersionsByIDsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{p.VersionID}})
	if err != nil {
		return out, err
	}
	if len(versions) != 1 {
		return out, inputError("target_gone", "The original input version no longer exists.")
	}
	items, err := s.inputVersions(ctx, q, p.CockpitInputRead, []db.CockpitInputVersion{db.CockpitInputVersion(versions[0])})
	if err != nil && !errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, err
	}
	if err == nil && len(items) == 1 {
		out.Version = &items[0]
	}
	transfers, err := s.inputTransfers(ctx, q, p.CockpitInputRead, []db.CockpitInputTransfer{t})
	if err != nil && !errors.Is(err, ErrCockpitWorkflowForbidden) {
		return out, err
	}
	if err == nil && len(transfers) == 1 {
		out.Current = &transfers[0]
	}
	return out, tx.Commit(ctx)
}

func inputTransferReceiptReplay(ctx context.Context, q *db.Queries, p CockpitInputQuery, t db.CockpitInputTransfer, key pgtype.UUID, hash, action string) (CockpitInputTransferReceipt, error) {
	r, ids, err := inputStoredTransferReceipt(t, key)
	if err != nil {
		return r, err
	}
	if hash != "" && r.RequestHash != hash || action != "" && r.Action != action || !inputPrincipalMatches(p.CockpitInputRead, ids.kind, ids.actor, ids.credential, ids.authorizer, ids.run) {
		return r, inputError("command_conflict", "This transfer command key belongs to a different intent or principal.")
	}
	if err := inputReplayMembership(ctx, q, p.CockpitInputRead, ids.authorizer); err != nil {
		return r, err
	}
	return r, nil
}

func (s *IssueService) GetCockpitInputTransferCommand(ctx context.Context, p CockpitInputQuery) (CockpitInputTransferResult, error) {
	var out CockpitInputTransferResult
	if _, err := inputMembership(ctx, s.Queries, p.CockpitInputRead); err != nil {
		return out, err
	}
	var t db.CockpitInputTransfer
	var err error
	if p.TransferID.Valid {
		t, err = s.Queries.GetCockpitInputTransferCommandAnyKind(ctx, db.GetCockpitInputTransferCommandAnyKindParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID, CommandKey: p.CommandKey})
	} else {
		t, err = s.Queries.GetCockpitInputTransferByCommand(ctx, db.GetCockpitInputTransferByCommandParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, CommandKey: p.CommandKey})
	}
	if err != nil {
		return out, inputConvertError(err)
	}
	if t.InputID != p.InputID {
		return out, inputError("not_found", "The command is not part of this input.")
	}
	r, err := inputTransferReceiptReplay(ctx, s.Queries, p, t, p.CommandKey, "", "")
	if err != nil {
		return out, err
	}
	return s.inputTransferResult(ctx, p, r, true)
}

func inputTransferReceipt(p CockpitInputQuery, a CockpitInputPrincipal, t db.CockpitInputTransfer, key, hash, action, reason, state string, before, after int64) CockpitInputTransferReceipt {
	return CockpitInputTransferReceipt{CommandKey: key, RequestHash: hash, Action: action, InputID: util.UUIDToString(t.InputID), VersionID: util.UUIDToString(t.VersionID), TransferID: util.UUIDToString(t.ID), TransferNumber: t.TransferNumber, ReplacesTransferID: planningUUID(t.ReplacesTransferID), BeforeRevision: before, Revision: after, Mode: t.Mode, State: state, SizeBytes: inputInt(t.PinnedSizeBytes), ContentHash: inputText(t.ContentHash), Reason: reason, Principal: a, AcceptedAt: time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)}
}

func (s *IssueService) RestartCockpitInputTransfer(ctx context.Context, p CockpitInputQuery, in CockpitInputRestartInput) (CockpitInputTransferResult, error) {
	var out CockpitInputTransferResult
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	previous, err := inputOptionalID(in.PreviousTransferID)
	if err != nil {
		return out, err
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if in.ExpectedRevision < 1 || !utf8.ValidString(in.Reason) || len(in.Reason) > 16000 || in.Mode != "retry_source" && in.Mode != "upload_matching_bytes" {
		return out, inputError("invalid_input", "The restart intent is invalid.")
	}
	hash := inputWriteHash(p.CockpitInputRead, "input_transfer_restart", p.VersionID, in)
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	old, err := q.GetCockpitInputTransferByCommand(ctx, db.GetCockpitInputTransferByCommandParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, CommandKey: key})
	if err == nil {
		if old.InputID != p.InputID {
			return out, inputError("command_conflict", "This key belongs to another input.")
		}
		r, e := inputTransferReceiptReplay(ctx, q, p, old, key, hash, "input_transfer_restart")
		if e != nil {
			return out, e
		}
		if e = tx.Commit(ctx); e != nil {
			return out, e
		}
		return s.inputTransferResult(ctx, p, r, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if _, e := q.GetCockpitInputTransferWorkspaceCommand(ctx, db.GetCockpitInputTransferWorkspaceCommandParams{WorkspaceID: p.WorkspaceID, CommandKey: key}); e == nil {
		return out, inputError("command_conflict", "This transfer key already belongs to another content intent.")
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	a, err := inputNewPrincipal(ctx, q, p.CockpitInputRead, true)
	if err != nil {
		return out, err
	}
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID}); err != nil {
		return out, inputConvertError(err)
	}
	v, err := q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if v.Revision != in.ExpectedRevision {
		return out, inputError("revision_conflict", "The fixed input changed. Read its latest transfer before restarting.")
	}
	projected, err := s.inputVersions(ctx, q, p.CockpitInputRead, []db.CockpitInputVersion{v})
	if err != nil {
		return out, err
	}
	if len(projected) != 1 || !slices.Contains(projected[0].AllowedRestartModes, in.Mode) {
		return out, inputError("permission_revoked", "This source or restart mode is not currently authorized.")
	}
	latest, err := q.ReadCockpitInputLatestTransfer(ctx, db.ReadCockpitInputLatestTransferParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if err == nil && latest.ID != previous || errors.Is(err, pgx.ErrNoRows) && previous.Valid {
		return out, inputError("transfer_changed", "The latest attempt changed. Recheck before creating a new attempt.")
	}
	if v.ActiveTransferID.Valid {
		return out, inputError("transfer_in_progress", "Reconcile or abandon the active attempt before restarting.")
	}
	number, err := q.NextCockpitInputTransferNumber(ctx, db.NextCockpitInputTransferNumberParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID})
	if err != nil {
		return out, err
	}
	kind := "source_capture"
	if in.Mode == "upload_matching_bytes" || v.SourceKind == "upload" {
		kind = "direct_upload"
	}
	size := v.DeclaredSizeBytes.Int64
	if v.PinnedSizeBytes.Valid {
		size = v.PinnedSizeBytes.Int64
	}
	stamp := pgtype.Timestamptz{Time: time.Now().UTC().Truncate(time.Microsecond), Valid: true}
	args, err := inputNewTransferParams(p.CockpitInputRead, a.Principal, v.ID, v.InputID, dbid.NewV7(), key, hash, in.Mode, kind, number, previous, size, v.Filename, v.ContentType, stamp)
	if err != nil {
		return out, err
	}
	t := db.CockpitInputTransfer{ID: args.ID, InputID: args.InputID, VersionID: args.VersionID, TransferNumber: number, ReplacesTransferID: previous, Mode: in.Mode}
	r := inputTransferReceipt(p, a.Principal, t, in.CommandKey, hash, "input_transfer_restart", in.Reason, args.State, v.Revision, 1)
	args.CommandReceipt = inputRaw(r)
	if _, err = q.CreateCockpitInputTransfer(ctx, args); err != nil {
		return out, err
	}
	capture := "queued"
	if kind == "direct_upload" {
		capture = "awaiting_upload"
	}
	if _, err = q.SetCockpitInputActiveTransfer(ctx, db.SetCockpitInputActiveTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: v.ID, ActiveTransferID: args.ID, CaptureState: capture, ExpectedRevision: v.Revision}); err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, a.Principal)
	return s.inputTransferResult(ctx, p, r, false)
}

func (s *IssueService) FinalizeCockpitInputTransfer(ctx context.Context, p CockpitInputQuery, in CockpitInputFinalizeInput) (CockpitInputTransferResult, error) {
	if in.ExpectedRevision < 1 || !inputHashValid(in.ExpectedContentHash) {
		return CockpitInputTransferResult{}, inputError("invalid_input", "Finalize requires the observed transfer revision and exact content fingerprint.")
	}
	return s.inputFinishTransfer(ctx, p, in.CommandKey, "input_transfer_finalize", in.ExpectedRevision, in.ExpectedContentHash, "", in)
}
func (s *IssueService) AbandonCockpitInputTransfer(ctx context.Context, p CockpitInputQuery, in CockpitInputAbandonInput) (CockpitInputTransferResult, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if in.ExpectedRevision < 1 || len(in.Reason) == 0 || len(in.Reason) > 16000 || !utf8.ValidString(in.Reason) {
		return CockpitInputTransferResult{}, inputError("invalid_input", "Abandon requires the observed revision and a reason.")
	}
	return s.inputFinishTransfer(ctx, p, in.CommandKey, "input_transfer_abandon", in.ExpectedRevision, "", in.Reason, in)
}

func (s *IssueService) inputFinishTransfer(ctx context.Context, p CockpitInputQuery, command, action string, revision int64, expectedHash, reason string, in any) (CockpitInputTransferResult, error) {
	var out CockpitInputTransferResult
	key, err := inputKey(command)
	if err != nil {
		return out, err
	}
	hash := inputWriteHash(p.CockpitInputRead, action, p.TransferID, in)
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	old, err := q.GetCockpitInputTransferCommandAnyKind(ctx, db.GetCockpitInputTransferCommandAnyKindParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID, CommandKey: key})
	if err == nil {
		r, e := inputTransferReceiptReplay(ctx, q, p, old, key, hash, action)
		if e != nil {
			return out, e
		}
		if e = tx.Commit(ctx); e != nil {
			return out, e
		}
		return s.inputTransferResult(ctx, p, r, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	// Finalizing already accepted, verified bytes permits the original terminal
	// task. It still rechecks current membership and INVOKE through this read.
	a, err := inputPrincipal(ctx, q, p.CockpitInputRead, true, action != "input_transfer_finalize")
	if err != nil {
		return out, err
	}
	if _, err = q.LockCockpitInput(ctx, db.LockCockpitInputParams{WorkspaceID: p.WorkspaceID, ID: p.InputID}); err != nil {
		return out, inputConvertError(err)
	}
	v, err := q.LockCockpitInputVersion(ctx, db.LockCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputConvertError(err)
	}
	t, err := q.LockCockpitInputTransfer(ctx, db.LockCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID})
	if err != nil {
		return out, inputConvertError(err)
	}
	if t.Revision != revision {
		return out, inputError("revision_conflict", "This transfer changed. Reconcile its current result first.")
	}
	items, err := s.inputTransfers(ctx, q, p.CockpitInputRead, []db.CockpitInputTransfer{t})
	if err != nil {
		return out, err
	}
	if len(items) != 1 || action == "input_transfer_finalize" && !items[0].CanFinalize || action == "input_transfer_abandon" && !items[0].CanAbandon {
		return out, inputError("permission_revoked", "This transfer action is not currently available to this principal.")
	}
	state := "abandoned"
	if action == "input_transfer_finalize" {
		state = "verified"
	}
	r := inputTransferReceipt(p, a.Principal, t, command, hash, action, reason, state, t.Revision, t.Revision+1)
	if action == "input_transfer_finalize" {
		if !t.ContentHash.Valid || t.ContentHash.String != expectedHash || !v.ContentHash.Valid || v.ContentHash.String != expectedHash || !t.PinnedSizeBytes.Valid || v.PinnedSizeBytes != t.PinnedSizeBytes {
			return out, inputError("input_content_mismatch", "This transfer does not match the fixed version fingerprint.")
		}
		if _, err = q.FinalizeCockpitInputTransfer(ctx, db.FinalizeCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, ID: p.TransferID, FinalizeKey: key, FinalizeHash: pgtype.Text{String: hash, Valid: true}, FinalizeReceipt: inputRaw(r)}); err != nil {
			return out, err
		}
		if _, err = q.PublishCockpitInputCopy(ctx, db.PublishCockpitInputCopyParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID, CurrentTransferID: p.TransferID, ContentHash: v.ContentHash, PinnedSizeBytes: v.PinnedSizeBytes}); err != nil {
			return out, err
		}
		if v.CurrentTransferID.Valid && v.CurrentTransferID != p.TransferID {
			if _, err = q.QueueSupersededCockpitInputCopy(ctx, db.QueueSupersededCockpitInputCopyParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, ID: v.CurrentTransferID}); err != nil {
				return out, err
			}
		}
	} else {
		if _, err = q.AbandonCockpitInputTransfer(ctx, db.AbandonCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, ID: p.TransferID, AbortKey: key, AbortHash: pgtype.Text{String: hash, Valid: true}, AbortReceipt: inputRaw(r)}); err != nil {
			return out, err
		}
		if _, err = q.ClearCockpitInputActiveTransfer(ctx, db.ClearCockpitInputActiveTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID, ActiveTransferID: p.TransferID, CaptureErrorCode: "transfer_abandoned", CaptureError: reason}); err != nil {
			return out, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	s.inputChanged(p.WorkspaceID, p.InputID, a.Principal)
	return s.inputTransferResult(ctx, p, r, false)
}
