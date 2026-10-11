package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func inputManifestIntent(in CockpitInputManifestSaveInput) ([]pgtype.UUID, error) {
	if in.ExpectedRevision < 0 || !utf8.ValidString(in.Note) || len(in.Note) > 16000 || in.Items == nil {
		return nil, inputError("invalid_input", "A complete ordered input selection and valid revision are required.")
	}
	values := make([]string, len(in.Items))
	for i, item := range in.Items {
		if item.Purpose != "material" && item.Purpose != "recording" && item.Purpose != "supporting" {
			return nil, inputError("invalid_input", "The input purpose is not supported.")
		}
		values[i] = item.InputVersionID
	}
	return inputUUIDs(values, CockpitInputManifestMaxItems)
}

func inputManifestReceipt(row db.CockpitIssueInputManifestVersion) (CockpitInputManifestReceipt, error) {
	var receipt CockpitInputManifestReceipt
	if err := json.Unmarshal(row.Receipt, &receipt); err != nil {
		return receipt, inputError("input_integrity_error", "The original input manifest receipt is unreadable.")
	}
	receiptKey, keyErr := util.ParseUUID(receipt.CommandKey)
	if keyErr != nil || receiptKey != row.CommandKey || receipt.ManifestVersionID != util.UUIDToString(row.ID) || receipt.IssueID != util.UUIDToString(row.IssueID) || receipt.RequestHash != row.RequestHash || receipt.ManifestHash != row.ManifestHash || receipt.VersionNumber != row.VersionNumber || receipt.CreatedBy != util.UUIDToString(row.CreatedBy) {
		return receipt, inputError("input_integrity_error", "The input manifest receipt does not match its fixed identity.")
	}
	return receipt, nil
}

func (s *IssueService) inputManifestResult(ctx context.Context, p CockpitInputQuery, receipt CockpitInputManifestReceipt, replayed bool) (CockpitInputManifestResult, error) {
	out := CockpitInputManifestResult{WorkspaceID: util.UUIDToString(p.WorkspaceID), CommandKey: receipt.CommandKey, Action: "input_manifest_save", Replayed: replayed, Receipt: receipt}
	current, err := s.GetCockpitInputManifest(ctx, p)
	if err != nil {
		// Revocation may happen after the command committed. An unavailable
		// database or corrupt current projection is not a permission change.
		if errors.Is(err, ErrCockpitWorkflowForbidden) {
			return out, nil
		}
		return out, err
	}
	out.Current = &current
	return out, nil
}

func (s *IssueService) SaveCockpitInputManifest(ctx context.Context, p CockpitInputQuery, in CockpitInputManifestSaveInput) (CockpitInputManifestResult, error) {
	var out CockpitInputManifestResult
	if p.ActorSource != "human" || !p.IssueID.Valid {
		return out, inputError("permission_revoked", "Only a workspace member can save an Issue input manifest.")
	}
	key, err := inputKey(in.CommandKey)
	if err != nil {
		return out, err
	}
	ids, err := inputManifestIntent(in)
	if err != nil {
		return out, err
	}
	hash := inputWriteHash(p.CockpitInputRead, "input_manifest_save", p.IssueID, in)
	tx, q, err := s.beginInputCommand(ctx, p.CockpitInputRead, key)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	old, err := q.GetCockpitInputManifestVersionByCommand(ctx, db.GetCockpitInputManifestVersionByCommandParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, CommandKey: key})
	if err == nil {
		if old.RequestHash != hash || old.CreatedBy != p.CredentialOwnerID {
			return out, inputError("command_conflict", "This key belongs to another input manifest intent or principal.")
		}
		if err = inputReplayMembership(ctx, q, p.CockpitInputRead, old.CreatedBy); err != nil {
			return out, err
		}
		receipt, e := inputManifestReceipt(old)
		if e != nil {
			return out, e
		}
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return s.inputManifestResult(ctx, p, receipt, true)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	if _, err = inputNewPrincipal(ctx, q, p.CockpitInputRead, false); err != nil {
		return out, err
	}
	if _, err = q.LockCockpitInputManifestIssue(ctx, db.LockCockpitInputManifestIssueParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID}); err != nil {
		return out, inputConvertError(err)
	}
	// Also serializes the first head insert with explicit-null Run authorization.
	if err = q.LockCockpitInputManifestSelection(ctx, db.LockCockpitInputManifestSelectionParams{WorkspaceID: util.UUIDToString(p.WorkspaceID), IssueID: util.UUIDToString(p.IssueID)}); err != nil {
		return out, err
	}
	head, err := q.LockCockpitInputManifest(ctx, db.LockCockpitInputManifestParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID})
	missing := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !missing {
		return out, err
	}
	revision := int64(0)
	if !missing {
		revision = head.Revision
	}
	if revision != in.ExpectedRevision {
		return out, inputError("revision_conflict", "The Issue input selection changed. Review the current manifest before saving.")
	}
	if revision >= math.MaxInt32 {
		return out, inputError("invalid_input", "This Issue has reached the supported manifest version limit.")
	}
	// These are fixed metadata reads only; manifest confirmation never holds a
	// transaction open while retrieving or verifying remote bytes.
	versions := map[pgtype.UUID]db.ReadCockpitInputVersionsRow{}
	for start := 0; start < len(ids); start += CockpitInputMaxSelectedIDs {
		end := start + CockpitInputMaxSelectedIDs
		if end > len(ids) {
			end = len(ids)
		}
		rows, e := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: ids[start:end]})
		if e != nil {
			return out, e
		}
		for _, v := range rows {
			versions[v.ID] = v
		}
	}
	fixed := make([]protocol.FixedInputManifestHashItem, len(ids))
	required := int32(0)
	for i, id := range ids {
		v, ok := versions[id]
		if !ok {
			return out, inputError("not_found", "A selected fixed input version is unavailable in this workspace.")
		}
		if v.CaptureState != "ready" || !v.ContentHash.Valid || !v.PinnedSizeBytes.Valid || !v.PinnedAt.Valid {
			return out, inputError("input_not_ready", "Every selected input must already have a fixed ready version.")
		}
		fixed[i] = protocol.FixedInputManifestHashItem{InputVersionID: util.UUIDToString(id), ContentHash: v.ContentHash.String, SizeBytes: v.PinnedSizeBytes.Int64, Purpose: in.Items[i].Purpose, Required: in.Items[i].Required}
		if in.Items[i].Required {
			required++
		}
	}
	id := dbid.NewV7()
	now := time.Now().UTC()
	number := int32(revision + 1)
	receipt := CockpitInputManifestReceipt{CommandKey: in.CommandKey, RequestHash: hash, IssueID: util.UUIDToString(p.IssueID), ManifestVersionID: util.UUIDToString(id), VersionNumber: number, Revision: revision + 1, ManifestHash: protocol.FixedInputManifestHash(fixed), Items: in.Items, Note: in.Note, CreatedBy: util.UUIDToString(p.CredentialOwnerID), CreatedAt: now.Format(time.RFC3339Nano)}
	_, err = q.CreateCockpitInputManifestVersion(ctx, db.CreateCockpitInputManifestVersionParams{ID: id, WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, VersionNumber: number, CommandKey: key, RequestHash: hash, Receipt: inputRaw(receipt), ManifestHash: receipt.ManifestHash, Note: in.Note, ItemTotal: int32(len(ids)), RequiredTotal: required, CreatedBy: p.CredentialOwnerID, CreatedAt: pgtype.Timestamptz{Time: now, Valid: true}})
	if err != nil {
		return out, err
	}
	for i, idv := range ids {
		if err = q.InsertCockpitInputManifestItem(ctx, db.InsertCockpitInputManifestItemParams{WorkspaceID: p.WorkspaceID, ManifestVersionID: id, Position: int32(i), InputVersionID: idv, Purpose: in.Items[i].Purpose, Required: in.Items[i].Required}); err != nil {
			return out, err
		}
	}
	if missing {
		_, err = q.CreateCockpitInputManifestHead(ctx, db.CreateCockpitInputManifestHeadParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, CurrentVersionID: id, UpdatedBy: p.CredentialOwnerID})
	} else {
		_, err = q.AdvanceCockpitInputManifestHead(ctx, db.AdvanceCockpitInputManifestHeadParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, CurrentVersionID: id, UpdatedBy: p.CredentialOwnerID, Revision: revision})
	}
	if err != nil {
		return out, inputConvertError(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(p.WorkspaceID), ActorType: "member", ActorID: util.UUIDToString(p.CredentialOwnerID), Payload: map[string]any{"scope": "input_manifests", "action": "updated", "entity": map[string]any{"issue_id": util.UUIDToString(p.IssueID)}}})
	}
	return s.inputManifestResult(ctx, p, receipt, false)
}

func (s *IssueService) GetCockpitInputManifestCommand(ctx context.Context, p CockpitInputQuery) (CockpitInputManifestResult, error) {
	var out CockpitInputManifestResult
	if p.ActorSource != "human" || !p.CommandKey.Valid || !p.IssueID.Valid {
		return out, inputError("permission_revoked", "Only the original member can reconcile this manifest command.")
	}
	if _, err := inputMembership(ctx, s.Queries, p.CockpitInputRead); err != nil {
		return out, err
	}
	row, err := s.Queries.GetCockpitInputManifestVersionByCommand(ctx, db.GetCockpitInputManifestVersionByCommandParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, CommandKey: p.CommandKey})
	if err != nil {
		return out, inputConvertError(err)
	}
	if row.CreatedBy != p.CredentialOwnerID {
		return out, inputError("permission_revoked", "This manifest command belongs to another member.")
	}
	receipt, err := inputManifestReceipt(row)
	if err != nil {
		return out, err
	}
	return s.inputManifestResult(ctx, p, receipt, true)
}
