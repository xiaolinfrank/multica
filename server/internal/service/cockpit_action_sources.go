package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitIssueActionSource struct {
	ID            string `json:"id"`
	MeetingID     string `json:"meeting_id"`
	MeetingCode   string `json:"meeting_code"`
	MeetingTitle  string `json:"meeting_title"`
	VersionID     string `json:"version_id"`
	VersionNumber int32  `json:"version_number"`
	Title         string `json:"title"`
}

type CockpitIssueActionSourcePage struct {
	IssueID    string                     `json:"issue_id"`
	Items      []CockpitIssueActionSource `json:"items"`
	Total      int64                      `json:"total"`
	NextCursor *string                    `json:"next_cursor"`
}

// The issue's reverse links remain a bounded read projection of accepted
// actions. They are not copied into the board's mutable reference-link array.
func (s *IssueService) ListCockpitIssueActionSources(ctx context.Context, workspace, issue pgtype.UUID, cursor string, pageSize int32) (CockpitIssueActionSourcePage, error) {
	out := CockpitIssueActionSourcePage{IssueID: util.UUIDToString(issue), Items: []CockpitIssueActionSource{}}
	size, err := planningPageSize(pageSize)
	if err != nil {
		return out, err
	}
	scope := planningHash([]any{"issue_actions", workspace, issue, size})
	lastID, _, err := decodePlanningCursor(cursor, scope)
	if err != nil {
		return out, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: workspace, ID: issue}); err != nil {
		return out, planningError(err)
	}
	out.Total, err = q.CountCockpitIssueActionSources(ctx, db.CountCockpitIssueActionSourcesParams{WorkspaceID: workspace, IssueID: issue})
	if err != nil {
		return out, err
	}
	rows, err := q.ListCockpitIssueActionSources(ctx, db.ListCockpitIssueActionSourcesParams{WorkspaceID: workspace, IssueID: issue, CursorID: lastID, PageLimit: size + 1})
	if err != nil {
		return out, err
	}
	if len(rows) > int(size) {
		rows = rows[:size]
		out.NextCursor = encodePlanningCursor(scope, rows[len(rows)-1].ID, 0)
	}
	for _, row := range rows {
		out.Items = append(out.Items, CockpitIssueActionSource{ID: util.UUIDToString(row.ID), MeetingID: util.UUIDToString(row.MeetingID),
			MeetingCode: row.MeetingCode, MeetingTitle: row.MeetingTitle, VersionID: util.UUIDToString(row.VersionID), VersionNumber: row.VersionNumber, Title: row.Title})
	}
	return out, nil
}
