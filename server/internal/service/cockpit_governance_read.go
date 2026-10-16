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

type CockpitGovernanceQuery struct {
	CockpitSurfaceQuery
	Query, Status, Cursor string
	PageSize              int32
}
type CockpitChangePage struct {
	WorkspaceID string              `json:"workspace_id"`
	Scope       CockpitSurfaceScope `json:"scope"`
	Query       string              `json:"q"`
	Status      string              `json:"status"`
	Items       []json.RawMessage   `json:"items"`
	Total       int64               `json:"total"`
	NextCursor  *string             `json:"next_cursor"`
	Counts      struct {
		Pending int64 `json:"pending"`
		Decided int64 `json:"decided"`
	} `json:"counts"`
}
type CockpitSnapshotPage struct {
	WorkspaceID string            `json:"workspace_id"`
	Scope       string            `json:"scope"`
	Query       string            `json:"q"`
	Items       []json.RawMessage `json:"items"`
	Total       int64             `json:"total"`
	NextCursor  *string           `json:"next_cursor"`
}
type governanceCursor struct {
	ID       string `json:"id"`
	Time     string `json:"created_at"`
	Priority int32  `json:"cursor_priority"`
}

func normalizeGovernanceQuery(p CockpitGovernanceQuery, kind string) (CockpitGovernanceQuery, string, pgtype.UUID, pgtype.Timestamptz, int32, error) {
	var id pgtype.UUID
	var at pgtype.Timestamptz
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return p, "", id, at, 0, fmt.Errorf("%w: search exceeds supported length", ErrCockpitWorkflowInput)
	}
	if p.Status == "" {
		p.Status = "all"
	}
	if !slices.Contains([]string{"all", "pending", "decided", "applied", "rejected", "withdrawn"}, p.Status) {
		return p, "", id, at, 0, fmt.Errorf("%w: unknown change status", ErrCockpitWorkflowInput)
	}
	var err error
	p.PageSize, err = planningPageSize(p.PageSize)
	if err != nil {
		return p, "", id, at, 0, err
	}
	normalized := p
	normalized.Cursor = ""
	hash := planningHash(struct {
		Query CockpitGovernanceQuery
		Kind  string
	}{normalized, kind})
	key, err := readOverviewCursor(p.Cursor, hash)
	if err != nil {
		return p, "", id, at, 0, err
	}
	var c governanceCursor
	if key != "" {
		if err = json.Unmarshal([]byte(key), &c); err != nil || c.Priority < 0 || c.Priority > 1 {
			return p, "", id, at, 0, fmt.Errorf("%w: invalid governance cursor", ErrCockpitWorkflowInput)
		}
		id, err = util.ParseUUID(c.ID)
		if err != nil {
			return p, "", id, at, 0, fmt.Errorf("%w: invalid governance cursor", ErrCockpitWorkflowInput)
		}
		timestamp, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return p, "", id, at, 0, fmt.Errorf("%w: invalid governance cursor", ErrCockpitWorkflowInput)
		}
		at = pgtype.Timestamptz{Time: timestamp, Valid: true}
	}
	return p, hash, id, at, c.Priority, nil
}
func finishGovernancePage(items []json.RawMessage, size int32, hash string) ([]json.RawMessage, *string, error) {
	if len(items) <= int(size) {
		return items, nil, nil
	}
	var last governanceCursor
	if err := json.Unmarshal(items[size-1], &last); err != nil {
		return nil, nil, err
	}
	encoded, err := json.Marshal(last)
	if err != nil {
		return nil, nil, err
	}
	return items[:size], makeOverviewCursor(hash, string(encoded)), nil
}
func (s *IssueService) ListCockpitChangePage(ctx context.Context, p CockpitGovernanceQuery) (CockpitChangePage, error) {
	var out CockpitChangePage
	p, hash, id, at, priority, err := normalizeGovernanceQuery(p, "changes")
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
	payload, err := q.ListCockpitScopedChanges(ctx, db.ListCockpitScopedChangesParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID, Query: p.Query, Status: p.Status, CursorID: id, CursorTime: at, CursorPriority: priority, PageSize: p.PageSize})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = header.WorkspaceID
	out.Scope = header.Scope
	out.Query = p.Query
	out.Status = p.Status
	out.Items, out.NextCursor, err = finishGovernancePage(out.Items, p.PageSize, hash)
	if err != nil {
		return out, err
	}
	out.Items, err = s.composeChangeSourceRefs(ctx, p.WorkspaceID, out.Items)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// composeChangeSourceRefs folds the raw source columns the page SQL joined in
// (source_issue_id / _number / _title) into the wire source_issue shape, with
// the human-readable reference composed from the workspace prefix. Items with
// no source task — filed by hand, or written before attribution existed —
// simply lose the intermediate keys.
func (s *IssueService) composeChangeSourceRefs(ctx context.Context, workspaceID pgtype.UUID, items []json.RawMessage) ([]json.RawMessage, error) {
	if len(items) == 0 {
		return items, nil
	}
	ws, err := s.Queries.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := make([]json.RawMessage, 0, len(items))
	for _, item := range items {
		var m map[string]any
		if err := json.Unmarshal(item, &m); err != nil {
			return nil, err
		}
		rawID := m["source_issue_id"]
		delete(m, "source_issue_id")
		number, _ := m["source_issue_number"].(float64)
		delete(m, "source_issue_number")
		title, _ := m["source_issue_title"].(string)
		delete(m, "source_issue_title")
		if rawID != nil {
			m["source_issue"] = map[string]any{
				"id":    rawID,
				"ref":   IssueIdentifier(ws.IssuePrefix, int32(number)),
				"title": title,
			}
		}
		clean, err := json.Marshal(m)
		if err != nil {
			return nil, err
		}
		out = append(out, clean)
	}
	return out, nil
}
func (s *IssueService) ListCockpitSnapshotPage(ctx context.Context, p CockpitGovernanceQuery) (CockpitSnapshotPage, error) {
	var out CockpitSnapshotPage
	if p.ProjectID.Valid || p.ModuleID.Valid {
		return out, fmt.Errorf("%w: saved board history is workspace-wide", ErrCockpitWorkflowInput)
	}
	p, hash, id, at, _, err := normalizeGovernanceQuery(p, "snapshots")
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
	payload, err := q.ListCockpitSnapshotPage(ctx, db.ListCockpitSnapshotPageParams{WorkspaceID: p.WorkspaceID, Query: p.Query, CursorID: id, CursorTime: at, PageSize: p.PageSize})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = header.WorkspaceID
	out.Scope = "workspace"
	out.Query = p.Query
	out.Items, out.NextCursor, err = finishGovernancePage(out.Items, p.PageSize, hash)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
