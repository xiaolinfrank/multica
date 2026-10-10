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

type CockpitMeetingRegisterQuery struct {
	CockpitSurfaceQuery
	NodeID                                         pgtype.UUID
	NodeIDs                                        []pgtype.UUID
	Query, WorkflowStage, DateFrom, DateTo, Cursor string
	Tracks, Kinds, Statuses, Parties, Only         []string
	PageSize                                       int32
}
type CockpitMeetingRegisterPage struct {
	WorkspaceID string                   `json:"workspace_id"`
	Scope       CockpitSurfaceScope      `json:"scope"`
	NodeID      *string                  `json:"node_id"`
	NodeIDs     []string                 `json:"node_ids"`
	Items       []json.RawMessage        `json:"items"`
	Total       int64                    `json:"total"`
	NextCursor  *string                  `json:"next_cursor"`
	DayCounts   []CockpitMeetingDayCount `json:"day_counts"`
	DateFrom    *string                  `json:"date_from"`
	DateTo      *string                  `json:"date_to"`
}
type CockpitMeetingDayCount struct {
	Date  string `json:"date"`
	Total int64  `json:"total"`
}

func normalizeMeetingRegister(p CockpitMeetingRegisterQuery) (CockpitMeetingRegisterQuery, pgtype.Date, pgtype.Date, error) {
	var from, to pgtype.Date
	if len(p.NodeIDs) > 200 || p.NodeID.Valid && len(p.NodeIDs) > 0 {
		return p, from, to, fmt.Errorf("%w: node_id and node_ids are exclusive; at most 200 node IDs", ErrCockpitWorkflowInput)
	}
	p.NodeIDs = append([]pgtype.UUID{}, p.NodeIDs...)
	for _, id := range p.NodeIDs {
		if !id.Valid {
			return p, from, to, fmt.Errorf("%w: node_ids must be UUIDs", ErrCockpitWorkflowInput)
		}
	}
	slices.SortFunc(p.NodeIDs, func(a, b pgtype.UUID) int { return strings.Compare(util.UUIDToString(a), util.UUIDToString(b)) })
	p.NodeIDs = slices.Compact(p.NodeIDs)
	p.Query = strings.TrimSpace(p.Query)
	if len(p.Query) > 512 {
		return p, from, to, fmt.Errorf("%w: search exceeds the supported length", ErrCockpitWorkflowInput)
	}
	var err error
	p.PageSize, err = planningPageSize(p.PageSize)
	if err != nil {
		return p, from, to, err
	}
	for _, field := range []*[]string{&p.Tracks, &p.Kinds, &p.Statuses, &p.Parties, &p.Only} {
		if len(*field) > 30 {
			return p, from, to, fmt.Errorf("%w: at most 30 values per filter", ErrCockpitWorkflowInput)
		}
		values := append([]string{}, (*field)...)
		for i, value := range values {
			if len(value) > 200 {
				return p, from, to, fmt.Errorf("%w: filter value exceeds supported length", ErrCockpitWorkflowInput)
			}
			values[i] = strings.TrimSpace(value)
		}
		slices.Sort(values)
		*field = slices.Compact(values)
	}
	for _, flag := range p.Only {
		if !slices.Contains([]string{"consensus", "folder", "links", "detected"}, flag) {
			return p, from, to, fmt.Errorf("%w: unsupported meeting filter", ErrCockpitWorkflowInput)
		}
	}
	if !slices.Contains([]string{"", "not_enabled", "waiting_meeting", "release_ready", "restore_backlog", "materials_needed", "review_pending", "reviewer_missing", "publish_ready", "published", "minutes_rework", "minutes_needed"}, p.WorkflowStage) {
		return p, from, to, fmt.Errorf("%w: unsupported meeting workflow stage", ErrCockpitWorkflowInput)
	}
	for _, pair := range []struct {
		value  string
		target *pgtype.Date
	}{{p.DateFrom, &from}, {p.DateTo, &to}} {
		if pair.value == "" {
			continue
		}
		date, err := time.Parse("2006-01-02", pair.value)
		if err != nil {
			return p, from, to, fmt.Errorf("%w: dates must use YYYY-MM-DD", ErrCockpitWorkflowInput)
		}
		*pair.target = pgtype.Date{Time: date, Valid: true}
	}
	if from.Valid && to.Valid && to.Time.Before(from.Time) {
		return p, from, to, fmt.Errorf("%w: date_to precedes date_from", ErrCockpitWorkflowInput)
	}
	return p, from, to, nil
}
func (s *IssueService) ListCockpitMeetingRegister(ctx context.Context, p CockpitMeetingRegisterQuery) (CockpitMeetingRegisterPage, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitMeetingRegisterPage{}, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p.CockpitSurfaceQuery)
	if err != nil {
		return CockpitMeetingRegisterPage{}, err
	}
	out, err := readCockpitMeetingRegister(ctx, q, header, p)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func readCockpitMeetingRegister(ctx context.Context, q *db.Queries, header CockpitSurfaceContext, p CockpitMeetingRegisterQuery) (CockpitMeetingRegisterPage, error) {
	var out CockpitMeetingRegisterPage
	p, from, to, err := normalizeMeetingRegister(p)
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
	nodeIDs := p.NodeIDs
	if p.NodeID.Valid {
		nodeIDs = []pgtype.UUID{p.NodeID}
	}
	if len(nodeIDs) > 0 {
		count, e := q.CountCockpitSurfaceNodesInWorkspace(ctx, db.CountCockpitSurfaceNodesInWorkspaceParams{WorkspaceID: p.WorkspaceID, NodeIds: nodeIDs})
		if e != nil {
			return out, e
		}
		if count != int64(len(nodeIDs)) {
			return out, ErrCockpitWorkflowNotFound
		}
	}
	payload, err := q.ListCockpitMeetingRegister(ctx, db.ListCockpitMeetingRegisterParams{
		WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID, NodeIds: nodeIDs,
		Words: strings.Fields(strings.ToLower(p.Query)), Tracks: p.Tracks, Kinds: p.Kinds, Statuses: p.Statuses, Parties: p.Parties, OnlyFlags: p.Only, WorkflowStage: p.WorkflowStage,
		DateFrom: from, DateTo: to, CalendarCounts: from.Valid && to.Valid && to.Time.Sub(from.Time) <= 92*24*time.Hour, CursorKey: key, PageSize: p.PageSize,
	})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = header.WorkspaceID
	out.Scope = header.Scope
	out.NodeID = planningUUID(p.NodeID)
	out.NodeIDs = []string{}
	for _, id := range p.NodeIDs {
		out.NodeIDs = append(out.NodeIDs, util.UUIDToString(id))
	}
	if from.Valid {
		out.DateFrom = &p.DateFrom
	}
	if to.Valid {
		out.DateTo = &p.DateTo
	}
	if len(out.Items) > int(p.PageSize) {
		out.Items = out.Items[:p.PageSize]
		var item struct {
			SortKey string `json:"sort_key"`
		}
		if err = json.Unmarshal(out.Items[len(out.Items)-1], &item); err != nil {
			return out, err
		}
		if item.SortKey == "" {
			return out, fmt.Errorf("meeting register returned an empty cursor key")
		}
		out.NextCursor = makeOverviewCursor(scope, item.SortKey)
	}
	return out, nil
}
