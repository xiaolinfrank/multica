package service

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) ListCockpitMinutesExportAttempts(ctx context.Context, p CockpitMinutesExportAttemptList) (CockpitMinutesExportAttemptPage, error) {
	size, err := planningPageSize(p.PageSize)
	if err != nil {
		return CockpitMinutesExportAttemptPage{}, err
	}
	scope := fmt.Sprintf("nas-attempts:%s:%s:%s:%d", util.UUIDToString(p.WorkspaceID), util.UUIDToString(p.MeetingID), util.UUIDToString(p.ExportID), size)
	id, number, err := decodePlanningCursor(p.Cursor, scope)
	if err != nil || (p.Cursor != "" && number < 1) {
		return CockpitMinutesExportAttemptPage{}, fmt.Errorf("%w: invalid export-attempt cursor", ErrCockpitWorkflowInput)
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitMinutesExportAttemptPage{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := q.GetCockpitMinutesExport(ctx, db.GetCockpitMinutesExportParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ExportID}); err != nil {
		return CockpitMinutesExportAttemptPage{}, cockpitWorkflowError(err)
	}
	if p.Cursor != "" {
		cursor, err := q.GetCockpitMinutesExportAttempt(ctx, db.GetCockpitMinutesExportAttemptParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ExportID: p.ExportID, ID: id})
		if err != nil || cursor.AttemptNumber != number {
			return CockpitMinutesExportAttemptPage{}, fmt.Errorf("%w: export-attempt cursor no longer identifies this page", ErrCockpitWorkflowInput)
		}
	}
	total, err := q.CountCockpitMinutesExportAttempts(ctx, db.CountCockpitMinutesExportAttemptsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ExportID: p.ExportID})
	if err != nil {
		return CockpitMinutesExportAttemptPage{}, err
	}
	rows, err := q.ListCockpitMinutesExportAttemptsPage(ctx, db.ListCockpitMinutesExportAttemptsPageParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ExportID: p.ExportID, BeforeAttempt: number, PageLimit: size + 1})
	if err != nil {
		return CockpitMinutesExportAttemptPage{}, err
	}
	out := CockpitMinutesExportAttemptPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), ExportID: util.UUIDToString(p.ExportID), Total: total, Items: []CockpitMinutesExportAttemptView{}}
	if len(rows) > int(size) {
		rows = rows[:size]
		last := rows[len(rows)-1]
		out.NextCursor = encodePlanningCursor(scope, last.ID, last.AttemptNumber)
	}
	for _, row := range rows {
		view := CockpitMinutesExportAttemptView{ID: util.UUIDToString(row.ID), AttemptNumber: row.AttemptNumber, Status: row.Status,
			TargetPath: row.TargetPath, ReceiptPath: row.ReceiptPath, ContentHash: row.ContentHash,
			VerifiedPath: exportTextPointer(row.VerifiedPath), VerifiedReceiptPath: exportTextPointer(row.VerifiedReceiptPath), ReceiptHash: exportTextPointer(row.ReceiptHash),
			LastErrorCode: row.LastErrorCode, LastError: row.LastError, CreatedAt: row.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: row.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)}
		if row.VerifiedAttemptID.Valid {
			value := util.UUIDToString(row.VerifiedAttemptID)
			view.VerifiedAttemptID = &value
		}
		if row.SizeBytes.Valid {
			value := row.SizeBytes.Int64
			view.SizeBytes = &value
		}
		if row.VerifiedAt.Valid {
			value := row.VerifiedAt.Time.UTC().Format(time.RFC3339Nano)
			view.VerifiedAt = &value
		}
		out.Items = append(out.Items, view)
	}
	if err := tx.Commit(ctx); err != nil {
		return CockpitMinutesExportAttemptPage{}, err
	}
	return out, nil
}

func exportTextPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
