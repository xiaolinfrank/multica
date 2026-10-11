package service

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitMeetingNextCode struct {
	WorkspaceID string `json:"workspace_id"`
	Date        string `json:"date"`
	Code        string `json:"code"`
}

// Writers must hold the cockpit binding lock through insertion. A read preview
// reserves nothing and must never be echoed as an automatically assigned code.
func ReadCockpitMeetingNextCode(ctx context.Context, q *db.Queries, ws pgtype.UUID, date time.Time) (string, error) {
	seq, err := q.GetCockpitMeetingCodeSequence(ctx, db.GetCockpitMeetingCodeSequenceParams{WorkspaceID: ws, Date: pgtype.Date{Time: date, Valid: true}})
	if err != nil {
		return "", err
	}
	if seq.Unsupported {
		return "", fmt.Errorf("%w: meeting code sequence exceeds supported length", ErrCockpitWorkflowInput)
	}
	return fmt.Sprintf("%s-%02d", date.Format("20060102"), seq.Maximum+1), nil
}
func (s *IssueService) GetCockpitMeetingNextCode(ctx context.Context, p CockpitSurfaceQuery, dateValue string) (CockpitMeetingNextCode, error) {
	var out CockpitMeetingNextCode
	date, err := time.Parse("2006-01-02", dateValue)
	if err != nil {
		return out, fmt.Errorf("%w: date must use YYYY-MM-DD", ErrCockpitWorkflowInput)
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	code, err := ReadCockpitMeetingNextCode(ctx, q, p.WorkspaceID, date)
	if err != nil {
		return out, err
	}
	out = CockpitMeetingNextCode{WorkspaceID: header.WorkspaceID, Date: dateValue, Code: code}
	return out, tx.Commit(ctx)
}

type CockpitPlanMarkerRow struct {
	RowKey  string   `json:"row_key"`
	NodeIDs []string `json:"node_ids"`
}
type CockpitPlanMarkerQuery struct {
	CockpitSurfaceQuery
	Rows                              []CockpitPlanMarkerRow
	DateFrom, DateTo, Cursor, Archive string
}
type CockpitPlanMarkerPreview struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Code      string  `json:"code"`
	StartTime *string `json:"start_time"`
}
type CockpitPlanMarkerGroup struct {
	RowKey  string                     `json:"row_key"`
	Date    string                     `json:"date"`
	Total   int64                      `json:"total"`
	Items   []CockpitPlanMarkerPreview `json:"items"`
	SortKey string                     `json:"sort_key,omitempty"`
}
type CockpitPlanMarkerPage struct {
	Archive     string                   `json:"archive"`
	WorkspaceID string                   `json:"workspace_id"`
	Scope       CockpitSurfaceScope      `json:"scope"`
	Rows        []CockpitPlanMarkerRow   `json:"rows"`
	DateFrom    string                   `json:"date_from"`
	DateTo      string                   `json:"date_to"`
	Groups      []CockpitPlanMarkerGroup `json:"groups"`
	TotalGroups int64                    `json:"total_groups"`
	NextCursor  *string                  `json:"next_cursor"`
}

func (s *IssueService) GetCockpitPlanMeetingMarkers(ctx context.Context, p CockpitPlanMarkerQuery) (CockpitPlanMarkerPage, error) {
	var out CockpitPlanMarkerPage
	var archiveErr error
	p.Archive, archiveErr = normalizeMeetingArchive(p.Archive, "active")
	if archiveErr != nil {
		return out, archiveErr
	}
	from, err := time.Parse("2006-01-02", p.DateFrom)
	if err != nil {
		return out, fmt.Errorf("%w: date_from must use YYYY-MM-DD", ErrCockpitWorkflowInput)
	}
	to, err := time.Parse("2006-01-02", p.DateTo)
	if err != nil || to.Before(from) || to.Sub(from) > 92*24*time.Hour {
		return out, fmt.Errorf("%w: marker date range must contain 1–93 days", ErrCockpitWorkflowInput)
	}
	if len(p.Rows) > 100 {
		return out, fmt.Errorf("%w: at most 100 visible marker rows", ErrCockpitWorkflowInput)
	}
	p.Rows = append([]CockpitPlanMarkerRow{}, p.Rows...)
	seenRows := map[string]bool{}
	uniqueIDs := map[string]pgtype.UUID{}
	for i, row := range p.Rows {
		if row.RowKey == "" || len(row.RowKey) > 100 || seenRows[row.RowKey] || len(row.NodeIDs) == 0 || len(row.NodeIDs) > 20 {
			return out, fmt.Errorf("%w: marker rows require unique keys and 1–20 node IDs", ErrCockpitWorkflowInput)
		}
		seenRows[row.RowKey] = true
		row.NodeIDs = append([]string{}, row.NodeIDs...)
		slices.Sort(row.NodeIDs)
		row.NodeIDs = slices.Compact(row.NodeIDs)
		for _, value := range row.NodeIDs {
			id, e := util.ParseUUID(value)
			if e != nil {
				return out, fmt.Errorf("%w: marker node IDs must be UUIDs", ErrCockpitWorkflowInput)
			}
			uniqueIDs[value] = id
		}
		p.Rows[i] = row
	}
	if len(uniqueIDs) > 200 {
		return out, fmt.Errorf("%w: at most 200 unique nodes per marker query", ErrCockpitWorkflowInput)
	}
	slices.SortFunc(p.Rows, func(a, b CockpitPlanMarkerRow) int { return strings.Compare(a.RowKey, b.RowKey) })
	ids := make([]pgtype.UUID, 0, len(uniqueIDs))
	for _, id := range uniqueIDs {
		ids = append(ids, id)
	}
	rowDefs, err := json.Marshal(p.Rows)
	if err != nil {
		return out, err
	}
	scopeQuery := p
	scopeQuery.Cursor = ""
	scope := planningHash(scopeQuery)
	key, err := readOverviewCursor(p.Cursor, scope)
	if err != nil {
		return out, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p.CockpitSurfaceQuery)
	if err != nil {
		return out, err
	}
	payload, err := q.GetCockpitPlanMeetingMarkers(ctx, db.GetCockpitPlanMeetingMarkersParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID, Archive: p.Archive, NodeIds: ids, Rows: rowDefs, DateFrom: pgtype.Date{Time: from, Valid: true}, DateTo: pgtype.Date{Time: to, Valid: true}, CursorKey: key})
	if err != nil {
		return out, err
	}
	var raw struct {
		CockpitPlanMarkerPage
		RequestedNodes int `json:"requested_nodes"`
	}
	if err = json.Unmarshal(payload, &raw); err != nil {
		return out, err
	}
	if raw.RequestedNodes != len(ids) {
		return out, ErrCockpitWorkflowNotFound
	}
	out = raw.CockpitPlanMarkerPage
	out.WorkspaceID = header.WorkspaceID
	out.Archive = p.Archive
	out.Scope = header.Scope
	out.Rows = p.Rows
	out.DateFrom = p.DateFrom
	out.DateTo = p.DateTo
	if len(out.Groups) > 500 {
		out.Groups = out.Groups[:500]
		out.NextCursor = makeOverviewCursor(scope, out.Groups[499].SortKey)
	}
	for i := range out.Groups {
		out.Groups[i].SortKey = ""
	}
	return out, tx.Commit(ctx)
}
