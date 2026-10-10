package service

import (
	"context"
	"encoding/json"
	"fmt"
)

type CockpitNodeIndexEntry struct {
	ID       string  `json:"id"`
	ParentID *string `json:"parent_id"`
	Code     string  `json:"code"`
	Position float64 `json:"position"`
}
type CockpitNodeIndexPage struct {
	WorkspaceID string                  `json:"workspace_id"`
	Items       []CockpitNodeIndexEntry `json:"items"`
	Total       int                     `json:"total"`
}

func (s *IssueService) GetCockpitNodeIndex(ctx context.Context, p CockpitSurfaceQuery) (CockpitNodeIndexPage, error) {
	var out CockpitNodeIndexPage
	if p.ProjectID.Valid || p.ModuleID.Valid {
		return out, fmt.Errorf("%w: the display index is workspace-wide", ErrCockpitWorkflowInput)
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
	items, err := readSurfaceIndex(ctx, q, p.WorkspaceID)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(items, &out.Items); err != nil {
		return out, err
	}
	out.WorkspaceID = header.WorkspaceID
	out.Total = len(out.Items)
	return out, tx.Commit(ctx)
}
