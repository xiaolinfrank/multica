package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Projection reads only bounded scalar metadata, never frozen receipt bodies.
func inputManifestVersions(ctx context.Context, q *db.Queries, p CockpitInputRead, rows []db.CockpitIssueInputManifestVersion) ([]CockpitInputManifestVersionMetadata, error) {
	out := make([]CockpitInputManifestVersionMetadata, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	if len(rows) > CockpitInputMaxSelectedIDs {
		return nil, inputError("invalid_input", "The manifest version selection exceeds its limit.")
	}
	ids := make([]pgtype.UUID, 0, len(rows))
	for _, row := range rows {
		if row.WorkspaceID != p.WorkspaceID || !row.ID.Valid {
			return nil, inputError("permission_revoked", "The manifest belongs to another workspace.")
		}
		ids = append(ids, row.ID)
	}
	records, err := q.GetCockpitInputManifestVersionsByIDs(ctx, db.GetCockpitInputManifestVersionsByIDsParams{WorkspaceID: p.WorkspaceID, Ids: inputUniqueIDs(ids)})
	if err != nil {
		return nil, err
	}
	byID := map[pgtype.UUID]db.GetCockpitInputManifestVersionsByIDsRow{}
	users := []pgtype.UUID{}
	for _, row := range records {
		byID[row.ID] = row
		users = append(users, row.CreatedBy)
	}
	names := map[pgtype.UUID]string{}
	if len(users) > 0 {
		people, err := q.GetUsersByIDs(ctx, inputUniqueIDs(users))
		if err != nil {
			return nil, err
		}
		for _, u := range people {
			names[u.ID] = u.Name
		}
	}
	for _, id := range ids {
		row, ok := byID[id]
		if !ok {
			return nil, inputError("not_found", "The selected manifest version is unavailable.")
		}
		out = append(out, CockpitInputManifestVersionMetadata{WorkspaceID: util.UUIDToString(p.WorkspaceID), IssueID: util.UUIDToString(row.IssueID), ID: util.UUIDToString(row.ID), VersionNumber: row.VersionNumber, CommandKey: util.UUIDToString(row.CommandKey), ManifestHash: row.ManifestHash, ItemTotal: int64(row.ItemTotal), RequiredTotal: int64(row.RequiredTotal), CreatedBy: util.UUIDToString(row.CreatedBy), CreatedByName: names[row.CreatedBy], CreatedAt: inputTime(row.CreatedAt), HasNote: row.HasNote})
	}
	return out, nil
}
func inputManifestCounts(ctx context.Context, q *db.Queries, ws, manifest pgtype.UUID) (CockpitInputManifestCounts, error) {
	if !manifest.Valid {
		return CockpitInputManifestCounts{}, nil
	}
	row, err := q.ReadCockpitInputManifestCounts(ctx, db.ReadCockpitInputManifestCountsParams{WorkspaceID: ws, ManifestVersionID: manifest})
	if err != nil {
		return CockpitInputManifestCounts{}, err
	}
	return CockpitInputManifestCounts{Total: row.Total, Required: row.Required, AvailableRequired: row.AvailableRequired, UnavailableRequired: row.UnavailableRequired, UnknownRequired: row.UnknownRequired}, nil
}
func inputReadManifestVersion(ctx context.Context, q *db.Queries, p CockpitInputQuery, a cockpitInputAuthority) (db.CockpitIssueInputManifestVersion, error) {
	if _, err := inputReadIssue(ctx, q, p, a, false); err != nil {
		return db.CockpitIssueInputManifestVersion{}, err
	}
	if p.ActorSource != "human" && p.ManifestVersionID != a.Run.InputManifestVersionID {
		return db.CockpitIssueInputManifestVersion{}, inputError("permission_revoked", "A task can read only the exact manifest version pinned to its Run.")
	}
	row, err := q.GetCockpitInputManifestVersion(ctx, db.GetCockpitInputManifestVersionParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, ID: p.ManifestVersionID})
	return row, inputReadNotFound(err)
}
func (s *IssueService) GetCockpitInputManifest(ctx context.Context, p CockpitInputQuery) (CockpitInputManifestHeader, error) {
	out := CockpitInputManifestHeader{WorkspaceID: util.UUIDToString(p.WorkspaceID), BlockedReasons: []string{}}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out.Issue, err = inputReadIssue(ctx, q, p, a, true)
	if err != nil {
		return out, err
	}
	out.CanEdit = true
	head, err := q.GetCockpitInputManifest(ctx, db.GetCockpitInputManifestParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID})
	if errors.Is(err, pgx.ErrNoRows) {
		return out, tx.Commit(ctx)
	}
	if err != nil {
		return out, err
	}
	out.Revision = head.Revision
	versions, err := inputManifestVersions(ctx, q, p.CockpitInputRead, []db.CockpitIssueInputManifestVersion{{WorkspaceID: p.WorkspaceID, ID: head.CurrentVersionID}})
	if err != nil {
		return out, err
	}
	if versions[0].IssueID != util.UUIDToString(p.IssueID) {
		return out, inputError("input_integrity_error", "The current manifest does not belong to this Issue.")
	}
	out.CurrentVersion = &versions[0]
	out.Counts, err = inputManifestCounts(ctx, q, p.WorkspaceID, head.CurrentVersionID)
	if err != nil {
		return out, err
	}
	if out.Counts.Total != versions[0].ItemTotal || out.Counts.Required != versions[0].RequiredTotal {
		return out, inputError("input_integrity_error", "The manifest item set is incomplete.")
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputManifestVersions(ctx context.Context, p CockpitInputQuery) (CockpitInputManifestVersionPage, error) {
	out := CockpitInputManifestVersionPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), IssueID: util.UUIDToString(p.IssueID), Items: []CockpitInputManifestVersionMetadata{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	out.PageSize = p.PageSize
	after, err := inputSequenceCursor(p, "manifest_versions")
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputReadIssue(ctx, q, p, a, true); err != nil {
		return out, err
	}
	keys, err := q.ListCockpitInputManifestReadKeys(ctx, db.ListCockpitInputManifestReadKeysParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, AfterNumber: after, PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	out.Total, err = q.CountCockpitInputManifestReadKeys(ctx, db.CountCockpitInputManifestReadKeysParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID})
	if err != nil {
		return out, err
	}
	if len(keys) > int(p.PageSize) {
		keys = keys[:p.PageSize]
		last := keys[len(keys)-1]
		out.NextCursor = inputNumberCursor(p, "manifest_versions", last.ID, int64(last.ItemNumber))
	}
	rows := make([]db.CockpitIssueInputManifestVersion, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, db.CockpitIssueInputManifestVersion{ID: key.ID, WorkspaceID: p.WorkspaceID})
	}
	out.Items, err = inputManifestVersions(ctx, q, p.CockpitInputRead, rows)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitInputManifestVersion(ctx context.Context, p CockpitInputQuery) (CockpitInputManifestVersionDetail, error) {
	out := CockpitInputManifestVersionDetail{}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	row, err := inputReadManifestVersion(ctx, q, p, a)
	if err != nil {
		return out, err
	}
	items, err := inputManifestVersions(ctx, q, p.CockpitInputRead, []db.CockpitIssueInputManifestVersion{row})
	if err != nil {
		return out, err
	}
	out.CockpitInputManifestVersionMetadata = items[0]
	out.Note = row.Note
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputManifestItems(ctx context.Context, p CockpitInputQuery) (CockpitInputManifestItemPage, error) {
	out := CockpitInputManifestItemPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), IssueID: util.UUIDToString(p.IssueID), ManifestVersionID: util.UUIDToString(p.ManifestVersionID), Items: []CockpitInputManifestItem{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	out.PageSize = p.PageSize
	c, _, _, err := inputReadCursor(p, "manifest_items")
	if err != nil {
		return out, err
	}
	if p.Cursor != "" && (c.Order < 1 || c.Order >= CockpitInputManifestMaxItems || c.Time != "") {
		return out, inputError("invalid_input", "The manifest item cursor is outside the fixed selection.")
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	version, err := inputReadManifestVersion(ctx, q, p, a)
	if err != nil {
		return out, err
	}
	out.ManifestHash = version.ManifestHash
	out.Total = int64(version.ItemTotal)
	if version.ItemTotal < 0 || version.ItemTotal > CockpitInputManifestMaxItems {
		return out, inputError("input_integrity_error", "The fixed manifest exceeds its supported item count.")
	}
	rows, err := q.ListCockpitInputManifestReadItems(ctx, db.ListCockpitInputManifestReadItemsParams{WorkspaceID: p.WorkspaceID, ManifestVersionID: p.ManifestVersionID, AfterPosition: int32(c.Order), PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	// Position continuity detects missing joined records instead of returning an
	// apparently complete but silently shortened fixed manifest.
	remaining := version.ItemTotal - int32(c.Order)
	expected := remaining
	if expected > p.PageSize+1 {
		expected = p.PageSize + 1
	}
	if expected < 0 || len(rows) != int(expected) {
		return out, inputError("input_integrity_error", "The fixed manifest item set is incomplete.")
	}
	for i, row := range rows {
		if row.Position != int32(c.Order)+int32(i) || !row.PinnedSizeBytes.Valid || row.PinnedSizeBytes.Int64 < 0 || !row.ContentHash.Valid || len(row.ContentHash.String) != 64 {
			return out, inputError("input_integrity_error", "A fixed manifest item is missing its immutable content pin.")
		}
	}
	if len(rows) > int(p.PageSize) {
		rows = rows[:p.PageSize]
		last := rows[len(rows)-1]
		out.NextCursor = inputNumberCursor(p, "manifest_items", p.ManifestVersionID, int64(last.Position+1))
	}
	for _, row := range rows {
		out.Items = append(out.Items, CockpitInputManifestItem{Position: row.Position, InputID: util.UUIDToString(row.InputID), InputTitle: row.InputTitle, InputVersionID: util.UUIDToString(row.InputVersionID), InputVersionNumber: row.VersionNumber, PayloadKind: row.PayloadKind, Filename: row.Filename, ContentType: row.ContentType, SizeBytes: row.PinnedSizeBytes.Int64, ContentHash: row.ContentHash.String, Purpose: row.Purpose, Required: row.Required, Availability: row.Availability, UnavailableReason: row.VerificationErrorCode})
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputAttachments(ctx context.Context, p CockpitInputQuery) (CockpitInputAttachmentPage, error) {
	out := CockpitInputAttachmentPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), IssueID: util.UUIDToString(p.IssueID), Items: []CockpitInputAttachment{}, BlockedReasons: []string{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	out.PageSize = p.PageSize
	out.Query = p.Scope.Query
	if !inputCatalogAllowed(p.CockpitInputRead) {
		return out, inputError("permission_revoked", "Runtime claims cannot browse Issue attachments.")
	}
	afterID, afterTime, err := inputDatedCursor(p, "attachments")
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputReadIssue(ctx, q, p, a, false); err != nil {
		return out, err
	}
	out.CanCapture = inputLiveAuthority(p.CockpitInputRead, a) && s.inputFileCaptureAvailable()
	if !inputLiveAuthority(p.CockpitInputRead, a) {
		out.BlockedReasons = append(out.BlockedReasons, "source_run_unavailable")
	}
	if !s.inputFileCaptureAvailable() {
		out.BlockedReasons = append(out.BlockedReasons, "private_storage_required")
	}
	rows, err := q.ListCockpitInputAttachmentReadRows(ctx, db.ListCockpitInputAttachmentReadRowsParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, Query: p.Scope.Query, Prefix: inputPrefix(p.Scope.Query), AfterTime: afterTime, AfterID: afterID, PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	out.Total, err = q.CountCockpitInputAttachmentReadRows(ctx, db.CountCockpitInputAttachmentReadRowsParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, Query: p.Scope.Query, Prefix: inputPrefix(p.Scope.Query)})
	if err != nil {
		return out, err
	}
	if len(rows) > int(p.PageSize) {
		rows = rows[:p.PageSize]
		last := rows[len(rows)-1]
		out.NextCursor = inputTimeCursor(p, "attachments", last.ID, last.CreatedAt)
	}
	for _, row := range rows {
		out.Items = append(out.Items, CockpitInputAttachment{ID: util.UUIDToString(row.ID), IssueID: util.UUIDToString(row.IssueID), Filename: row.Filename, ContentType: row.ContentType, SizeBytes: row.SizeBytes, CreatedAt: inputTime(row.CreatedAt)})
	}
	return out, tx.Commit(ctx)
}
