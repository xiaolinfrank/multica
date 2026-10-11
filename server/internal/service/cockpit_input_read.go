package service

import (
	"context"
	"io"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func inputReadPage(p *CockpitInputQuery) error {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return inputError("invalid_input", "Choose an input page size between 1 and 100.")
	}
	p.PageSize = size
	p.Scope.Query = strings.TrimSpace(p.Scope.Query)
	if !utf8.ValidString(p.Scope.Query) || len(p.Scope.Query) > 512 {
		return inputError("invalid_input", "The input search prefix exceeds its limit.")
	}
	return nil
}
func inputDatedCursor(p CockpitInputQuery, kind string) (pgtype.UUID, pgtype.Timestamptz, error) {
	_, id, stamp, err := inputReadCursor(p, kind)
	if err == nil && p.Cursor != "" && !stamp.Valid {
		err = inputError("invalid_input", "This page requires a dated input cursor.")
	}
	return id, stamp, err
}
func inputSequenceCursor(p CockpitInputQuery, kind string) (pgtype.Int4, error) {
	c, _, _, err := inputReadCursor(p, kind)
	if err != nil {
		return pgtype.Int4{}, err
	}
	if p.Cursor == "" {
		return pgtype.Int4{}, nil
	}
	if c.Order < 1 || c.Order > math.MaxInt32 || c.Time != "" {
		return pgtype.Int4{}, inputError("invalid_input", "This page requires a numbered input cursor.")
	}
	return pgtype.Int4{Int32: int32(c.Order), Valid: true}, nil
}
func inputCatalogHeader(ctx context.Context, q *db.Queries, p CockpitInputQuery, a cockpitInputAuthority) (db.CockpitInput, error) {
	if !inputCatalogAllowed(p.CockpitInputRead) {
		return db.CockpitInput{}, inputError("task_context_required", "This principal can read only the fixed versions selected for its Run.")
	}
	records, err := q.ReadCockpitInputHeaders(ctx, db.ReadCockpitInputHeadersParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{p.InputID}})
	if err != nil {
		return db.CockpitInput{}, err
	}
	if len(records) != 1 {
		return db.CockpitInput{}, inputError("not_found", "The selected input is unavailable in this workspace.")
	}
	h := records[0]
	row := db.CockpitInput{ID: h.ID, WorkspaceID: h.WorkspaceID, SourceAgentID: h.SourceAgentID, SourceIssueID: h.SourceIssueID, AuthorizingUserID: h.AuthorizingUserID}
	if p.ActorSource != "human" && !inputSameSource(row.SourceAgentID, row.SourceIssueID, row.AuthorizingUserID, a) {
		return row, inputError("permission_revoked", "This task may browse only inputs registered under its authorized Issue.")
	}
	return row, nil
}
func inputReadIssue(ctx context.Context, q *db.Queries, p CockpitInputQuery, a cockpitInputAuthority, humanOnly bool) (CockpitIssueSummary, error) {
	if p.ActorSource != "human" && (humanOnly || p.IssueID != a.Run.IssueID) {
		return CockpitIssueSummary{}, inputError("permission_revoked", "This input view requires access to the exact authorized Issue.")
	}
	rows, err := readPlanningIssueFacts(ctx, q, p.WorkspaceID, []pgtype.UUID{p.IssueID})
	if err != nil {
		return CockpitIssueSummary{}, err
	}
	row, ok := rows[p.IssueID]
	if !ok {
		return row, inputError("not_found", "The selected Issue is unavailable in this workspace.")
	}
	return row, nil
}
func inputReadMeeting(ctx context.Context, q *db.Queries, p CockpitInputQuery) ([]string, error) {
	reasons := []string{}
	meeting, err := q.GetCockpitMeetingLifecycle(ctx, db.GetCockpitMeetingLifecycleParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID})
	if err != nil {
		return nil, inputReadNotFound(err)
	}
	if meeting.ArchivedAt.Valid {
		reasons = append(reasons, "meeting_archived")
	}
	if meeting.OccurrenceState == "cancelled" {
		reasons = append(reasons, "meeting_cancelled")
	}
	if p.AgendaID.Valid {
		agenda, err := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.AgendaID})
		if err != nil {
			return nil, inputReadNotFound(err)
		}
		if agenda.RemovedAt.Valid {
			reasons = append(reasons, "agenda_removed")
		}
	}
	return reasons, nil
}
func (s *IssueService) GetCockpitInputCapabilities(ctx context.Context, p CockpitInputRead) (CockpitInputCapabilities, error) {
	out := CockpitInputCapabilities{WorkspaceID: util.UUIDToString(p.WorkspaceID), MaxFileBytes: CockpitInputMaxFileBytes, UploadSessionTTLSeconds: 24 * 60 * 60}
	tx, _, a, err := s.beginInputRead(ctx, p)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out.CanCreate = inputLiveAuthority(p, a)
	out.FileCaptureAvailable = s.inputFileCaptureAvailable()
	out.DirectUploadAvailable = out.FileCaptureAvailable
	if !out.FileCaptureAvailable {
		out.UnavailableReason = "private_storage_required"
	}
	if p.ActorSource == "human" && s.CockpitInputNAS != nil && s.CockpitInputConfigurationError == "" {
		root, e := s.CockpitInputNAS.InputRoot(out.WorkspaceID)
		out.CanBrowseNAS = e == nil && root != nil && len(root.Subpaths) > 0
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputs(ctx context.Context, p CockpitInputQuery) (CockpitInputPage, error) {
	out := CockpitInputPage{Items: []CockpitInputHeader{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	if !inputCatalogAllowed(p.CockpitInputRead) {
		return out, inputError("task_context_required", "This principal cannot browse the input catalog.")
	}
	if p.Scope.Archive == "" {
		p.Scope.Archive = "active"
	}
	if p.Scope.Archive != "active" && p.Scope.Archive != "archived" && p.Scope.Archive != "all" {
		return out, inputError("invalid_input", "The input archive filter is unsupported.")
	}
	switch p.Scope.SourceKind {
	case "", "upload", "nas_file", "attachment", "artifact_version":
	default:
		return out, inputError("invalid_input", "The input source filter is unsupported.")
	}
	ids, err := inputUUIDs(p.Scope.IDs, CockpitInputMaxSelectedIDs)
	if err != nil {
		return out, err
	}
	project, err := inputOptionalID(p.Scope.ProjectID)
	if err != nil {
		return out, err
	}
	issue, err := inputOptionalID(p.Scope.OriginIssueID)
	if err != nil {
		return out, err
	}
	meeting, err := inputOptionalID(p.Scope.MeetingID)
	if err != nil {
		return out, err
	}
	agenda, err := inputOptionalID(p.Scope.AgendaID)
	if err != nil {
		return out, err
	}
	if agenda.Valid && !meeting.Valid {
		return out, inputError("invalid_input", "An agenda filter requires its meeting.")
	}
	if p.Scope.IDs == nil {
		p.Scope.IDs = []string{}
	}
	afterID, afterTime, err := inputDatedCursor(p, "inputs")
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if project.Valid {
		if _, err = q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: project}); err != nil {
			return out, inputReadNotFound(err)
		}
	}
	if issue.Valid {
		if _, err = q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: issue}); err != nil {
			return out, inputReadNotFound(err)
		}
	}
	if meeting.Valid {
		scope := p
		scope.MeetingID = meeting
		scope.AgendaID = agenda
		if _, err = inputReadMeeting(ctx, q, scope); err != nil {
			return out, err
		}
	}
	params := db.ListCockpitInputReadKeysParams{WorkspaceID: p.WorkspaceID, Human: p.ActorSource == "human", SourceAgentID: a.Run.AgentID, SourceIssueID: a.Run.IssueID, AuthorizingUserID: a.Run.OriginatorUserID, Ids: ids, ProjectID: project, OriginIssueID: issue, Archive: p.Scope.Archive, Query: p.Scope.Query, Prefix: inputPrefix(p.Scope.Query), SourceKind: p.Scope.SourceKind, MeetingID: meeting, AgendaID: agenda, AfterTime: afterTime, AfterID: afterID, PageLimit: p.PageSize + 1}
	keys, err := q.ListCockpitInputReadKeys(ctx, params)
	if err != nil {
		return out, err
	}
	out = CockpitInputPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), Scope: p.Scope, PageSize: p.PageSize, Items: []CockpitInputHeader{}, CanCreate: inputLiveAuthority(p.CockpitInputRead, a)}
	out.Total, err = q.CountCockpitInputReadKeys(ctx, db.CountCockpitInputReadKeysParams{WorkspaceID: params.WorkspaceID, Human: params.Human, SourceAgentID: params.SourceAgentID, SourceIssueID: params.SourceIssueID, AuthorizingUserID: params.AuthorizingUserID, Ids: ids, ProjectID: project, OriginIssueID: issue, Archive: params.Archive, Query: params.Query, Prefix: params.Prefix, SourceKind: params.SourceKind, MeetingID: meeting, AgendaID: agenda})
	if err != nil {
		return out, err
	}
	if len(keys) > int(p.PageSize) {
		keys = keys[:p.PageSize]
		last := keys[len(keys)-1]
		out.NextCursor = inputTimeCursor(p, "inputs", last.ID, last.CreatedAt)
	}
	rows := make([]db.CockpitInput, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, db.CockpitInput{ID: key.ID, WorkspaceID: p.WorkspaceID})
	}
	out.Items, err = s.inputHeaders(ctx, q, p.CockpitInputRead, rows)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitInput(ctx context.Context, p CockpitInputQuery) (CockpitInputHeader, error) {
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return CockpitInputHeader{}, err
	}
	defer tx.Rollback(ctx)
	row, err := inputCatalogHeader(ctx, q, p, a)
	if err != nil {
		return CockpitInputHeader{}, err
	}
	items, err := s.inputHeaders(ctx, q, p.CockpitInputRead, []db.CockpitInput{row})
	if err != nil {
		return CockpitInputHeader{}, err
	}
	return items[0], tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputVersions(ctx context.Context, p CockpitInputQuery) (CockpitInputVersionPage, error) {
	out := CockpitInputVersionPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: util.UUIDToString(p.InputID), Items: []CockpitInputVersionMetadata{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	out.PageSize = p.PageSize
	after, err := inputSequenceCursor(p, "versions")
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputCatalogHeader(ctx, q, p, a); err != nil {
		return out, err
	}
	keys, err := q.ListCockpitInputVersionReadKeys(ctx, db.ListCockpitInputVersionReadKeysParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, AfterNumber: after, PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	out.Total, err = q.CountCockpitInputVersionReadKeys(ctx, db.CountCockpitInputVersionReadKeysParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID})
	if err != nil {
		return out, err
	}
	if len(keys) > int(p.PageSize) {
		keys = keys[:p.PageSize]
		last := keys[len(keys)-1]
		out.NextCursor = inputNumberCursor(p, "versions", last.ID, int64(last.ItemNumber))
	}
	rows := make([]db.CockpitInputVersion, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, db.CockpitInputVersion{ID: key.ID, WorkspaceID: p.WorkspaceID})
	}
	out.Items, err = s.inputVersions(ctx, q, p.CockpitInputRead, rows)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitInputVersion(ctx context.Context, p CockpitInputQuery) (CockpitInputVersionDetail, error) {
	out := CockpitInputVersionDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: util.UUIDToString(p.InputID)}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	row, err := q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, ID: p.VersionID})
	if err != nil {
		return out, inputReadNotFound(err)
	}
	allowed, err := inputReadableVersions(ctx, q, p.CockpitInputRead, a, []db.CockpitInputVersion{row})
	if err != nil {
		return out, err
	}
	if !allowed[row.ID] {
		return out, inputError("permission_revoked", "This fixed input version is not authorized for the current task.")
	}
	items, err := s.inputVersions(ctx, q, p.CockpitInputRead, []db.CockpitInputVersion{row})
	if err != nil {
		return out, err
	}
	out.Version = items[0]
	out.CaptureError = row.CaptureError
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	// Private bytes are verified outside the metadata transaction and returned
	// through the same descriptor whose identity and digest were checked.
	if row.PayloadKind == "text" && row.CaptureState == "ready" && out.Version.CanDownload {
		if !row.PinnedSizeBytes.Valid || row.PinnedSizeBytes.Int64 > CockpitArtifactMaxTextBytes {
			return out, inputError("invalid_input", "The fixed text input exceeds its supported size.")
		}
		_, stream, e := s.OpenCockpitInputFile(ctx, p)
		if e != nil {
			return out, e
		}
		body, e := io.ReadAll(io.LimitReader(stream, CockpitArtifactMaxTextBytes+1))
		closeErr := stream.Close()
		if e != nil {
			return out, e
		}
		if closeErr != nil {
			return out, closeErr
		}
		if int64(len(body)) != row.PinnedSizeBytes.Int64 || !utf8.Valid(body) {
			return out, inputError("input_content_mismatch", "The fixed text input no longer matches its declared bytes.")
		}
		text := string(body)
		out.Content = &text
	}
	return out, nil
}
func (s *IssueService) GetCockpitInputVersionBatch(ctx context.Context, p CockpitInputRead, requested []string) (CockpitInputVersionBatch, error) {
	out := CockpitInputVersionBatch{WorkspaceID: util.UUIDToString(p.WorkspaceID), RequestedIDs: append([]string{}, requested...), Items: []CockpitInputVersionMetadata{}, UnavailableIDs: []string{}}
	ids, err := inputUUIDs(requested, CockpitInputMaxSelectedIDs)
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	records, err := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: ids})
	if err != nil {
		return out, err
	}
	rows := make([]db.CockpitInputVersion, 0, len(records))
	byID := map[pgtype.UUID]db.CockpitInputVersion{}
	for _, v := range records {
		row := db.CockpitInputVersion{ID: v.ID, WorkspaceID: v.WorkspaceID, InputID: v.InputID}
		rows = append(rows, row)
		byID[v.ID] = row
	}
	allowed, err := inputReadableVersions(ctx, q, p, a, rows)
	if err != nil {
		return out, err
	}
	ordered := make([]db.CockpitInputVersion, 0, len(rows))
	for i, id := range ids {
		if allowed[id] {
			ordered = append(ordered, byID[id])
		} else {
			out.UnavailableIDs = append(out.UnavailableIDs, requested[i])
		}
	}
	out.Items, err = s.inputVersions(ctx, q, p, ordered)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputTransfers(ctx context.Context, p CockpitInputQuery) (CockpitInputTransferPage, error) {
	out := CockpitInputTransferPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), InputID: util.UUIDToString(p.InputID), VersionID: util.UUIDToString(p.VersionID), Items: []CockpitInputTransferMetadata{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	out.PageSize = p.PageSize
	after, err := inputSequenceCursor(p, "transfers")
	if err != nil {
		return out, err
	}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputCatalogHeader(ctx, q, p, a); err != nil {
		return out, err
	}
	versions, err := q.ReadCockpitInputVersions(ctx, db.ReadCockpitInputVersionsParams{WorkspaceID: p.WorkspaceID, Ids: []pgtype.UUID{p.VersionID}})
	if err != nil {
		return out, err
	}
	if len(versions) != 1 || versions[0].InputID != p.InputID {
		return out, inputError("not_found", "The selected input version is unavailable.")
	}
	keys, err := q.ListCockpitInputTransferReadKeys(ctx, db.ListCockpitInputTransferReadKeysParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID, AfterNumber: after, PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	out.Total, err = q.CountCockpitInputTransferReadKeys(ctx, db.CountCockpitInputTransferReadKeysParams{WorkspaceID: p.WorkspaceID, VersionID: p.VersionID})
	if err != nil {
		return out, err
	}
	if len(keys) > int(p.PageSize) {
		keys = keys[:p.PageSize]
		last := keys[len(keys)-1]
		out.NextCursor = inputNumberCursor(p, "transfers", last.ID, int64(last.ItemNumber))
	}
	rows := make([]db.CockpitInputTransfer, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, db.CockpitInputTransfer{ID: key.ID, WorkspaceID: p.WorkspaceID})
	}
	out.Items, err = s.inputTransfers(ctx, q, p.CockpitInputRead, rows)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitInputTransfer(ctx context.Context, p CockpitInputQuery) (CockpitInputTransferDetail, error) {
	out := CockpitInputTransferDetail{}
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = inputCatalogHeader(ctx, q, p, a); err != nil {
		return out, err
	}
	row, err := q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: p.InputID, VersionID: p.VersionID, ID: p.TransferID})
	if err != nil {
		return out, inputReadNotFound(err)
	}
	items, err := s.inputTransfers(ctx, q, p.CockpitInputRead, []db.CockpitInputTransfer{row})
	if err != nil {
		return out, err
	}
	out.CockpitInputTransferMetadata = items[0]
	out.ErrorMessage = row.ErrorMessage
	return out, tx.Commit(ctx)
}
func (s *IssueService) ListCockpitInputReferences(ctx context.Context, p CockpitInputQuery) (CockpitInputReferencePage, error) {
	out := CockpitInputReferencePage{Items: []CockpitInputReference{}, BlockedReasons: []string{}}
	if err := inputReadPage(&p); err != nil {
		return out, err
	}
	if p.ActorSource != "human" {
		return out, inputError("permission_revoked", "Meeting input browsing requires a human workspace member.")
	}
	switch p.Purpose {
	case "", "material", "recording", "supporting":
	default:
		return out, inputError("invalid_input", "The input reference purpose is unsupported.")
	}
	afterID, afterTime, err := inputDatedCursor(p, "references")
	if err != nil {
		return out, err
	}
	tx, q, _, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	reasons, err := inputReadMeeting(ctx, q, p)
	if err != nil {
		return out, err
	}
	out = CockpitInputReferencePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), AgendaID: planningUUID(p.AgendaID), Query: p.Scope.Query, Purpose: p.Purpose, IncludeRemoved: p.IncludeRemoved, PageSize: p.PageSize, Items: []CockpitInputReference{}, CanAdd: len(reasons) == 0, BlockedReasons: reasons}
	keys, err := q.ListCockpitInputReferenceReadKeys(ctx, db.ListCockpitInputReferenceReadKeysParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: p.AgendaID, IncludeRemoved: p.IncludeRemoved, Purpose: p.Purpose, Query: p.Scope.Query, Prefix: inputPrefix(p.Scope.Query), AfterTime: afterTime, AfterID: afterID, PageLimit: p.PageSize + 1})
	if err != nil {
		return out, err
	}
	out.Total, err = q.CountCockpitInputReferenceReadKeys(ctx, db.CountCockpitInputReferenceReadKeysParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: p.AgendaID, IncludeRemoved: p.IncludeRemoved, Purpose: p.Purpose, Query: p.Scope.Query, Prefix: inputPrefix(p.Scope.Query)})
	if err != nil {
		return out, err
	}
	summary, err := q.ReadCockpitInputReferenceSummary(ctx, db.ReadCockpitInputReferenceSummaryParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AgendaID: p.AgendaID})
	if err != nil {
		return out, err
	}
	out.Summary = CockpitInputReferenceSummary{Total: summary.Total, Ready: summary.Ready, Pending: summary.Pending, NeedsAttention: summary.NeedsAttention, AvailableReady: summary.AvailableReady, UnavailableReady: summary.UnavailableReady, UnknownReady: summary.UnknownReady}
	if len(keys) > int(p.PageSize) {
		keys = keys[:p.PageSize]
		last := keys[len(keys)-1]
		out.NextCursor = inputTimeCursor(p, "references", last.ID, last.CreatedAt)
	}
	rows := make([]db.CockpitInputReference, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, db.CockpitInputReference{ID: key.ID, WorkspaceID: p.WorkspaceID})
	}
	out.Items, err = s.inputReferences(ctx, q, p.CockpitInputRead, rows)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
