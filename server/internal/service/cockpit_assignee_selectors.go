package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitAssigneeChoice struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Title        string `json:"title"`
	Email        string `json:"email"`
	AvatarURL    string `json:"avatar_url"`
	Status       string `json:"status"`
	RuntimeBound *bool  `json:"runtime_bound"`
	CanAssign    bool   `json:"can_assign"`
	Reason       string `json:"reason"`
}
type CockpitAssigneeChoicePage struct {
	WorkspaceID  string                  `json:"workspace_id"`
	Query        string                  `json:"q"`
	Kind         string                  `json:"kind"`
	SelectedType *string                 `json:"selected_type"`
	SelectedID   *string                 `json:"selected_id"`
	Items        []CockpitAssigneeChoice `json:"items"`
	Total        int64                   `json:"total"`
	NextCursor   *string                 `json:"next_cursor"`
}
type CockpitAssigneeSelectorQuery struct {
	CockpitSurfaceQuery
	Query, Kind, Cursor, SelectedType string
	SelectedID                        pgtype.UUID
	PageSize                          int32
}

func (s *IssueService) ListCockpitAssigneeChoices(ctx context.Context, p CockpitAssigneeSelectorQuery) (CockpitAssigneeChoicePage, error) {
	var out CockpitAssigneeChoicePage
	p.Query = strings.TrimSpace(p.Query)
	if p.Kind == "" {
		p.Kind = "all"
	}
	size, err := cockpitSelectorPageSize(p.PageSize)
	if err != nil {
		return out, err
	}
	validType := func(value string) bool { return value == "member" || value == "agent" || value == "squad" }
	if p.ProjectID.Valid || p.ModuleID.Valid || len(p.Query) > 512 || len(p.Cursor) > 4096 || (!validType(p.Kind) && p.Kind != "all") {
		return out, fmt.Errorf("%w: assignee choices require a workspace scope and a known kind", ErrCockpitWorkflowInput)
	}
	selected := p.SelectedType != "" || p.SelectedID.Valid
	if selected && (!validType(p.SelectedType) || !p.SelectedID.Valid || p.SelectedID.Bytes == [16]byte{} || p.Query != "" || p.Cursor != "" || p.Kind != "all") {
		return out, fmt.Errorf("%w: selected_type and selected_id must be supplied together without search, cursor or kind filters", ErrCockpitWorkflowInput)
	}
	scope := planningHash([]any{"assignees", p.WorkspaceID, p.ActorID, p.Query, p.Kind, p.SelectedType, p.SelectedID, size})
	key, err := readOverviewCursor(p.Cursor, scope)
	if err != nil {
		return out, err
	}
	if key != "" {
		parts := strings.Split(key, ":")
		if len(parts) != 2 || (parts[0] != "0" && parts[0] != "1" && parts[0] != "2") {
			return out, fmt.Errorf("%w: invalid assignee cursor", ErrCockpitWorkflowInput)
		}
		if _, err := util.ParseUUID(parts[1]); err != nil {
			return out, fmt.Errorf("%w: invalid assignee cursor", ErrCockpitWorkflowInput)
		}
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err := readCockpitSurfaceContext(ctx, q, p.CockpitSurfaceQuery); err != nil {
		return out, err
	}
	payload, err := q.ListCockpitAssigneeChoices(ctx, db.ListCockpitAssigneeChoicesParams{WorkspaceID: p.WorkspaceID, Query: p.Query, Kind: p.Kind, SelectedType: p.SelectedType, SelectedID: p.SelectedID, CursorKey: key, RowLimit: size + 1})
	if err != nil {
		return out, err
	}
	var raw struct {
		Items []struct {
			CockpitAssigneeChoice
			Archived        bool      `json:"archived"`
			LeaderMissing   bool      `json:"leader_missing"`
			LeaderArchived  bool      `json:"leader_archived"`
			PermissionAgent *db.Agent `json:"permission_agent"`
			SortKey         string    `json:"sort_key"`
		}
		Total int64
	}
	if err := json.Unmarshal(payload, &raw); err != nil {
		return out, err
	}
	out = CockpitAssigneeChoicePage{WorkspaceID: util.UUIDToString(p.WorkspaceID), Query: p.Query, Kind: p.Kind, Items: []CockpitAssigneeChoice{}, Total: raw.Total}
	if selected {
		out.SelectedType = &p.SelectedType
		out.SelectedID = planningUUID(p.SelectedID)
	}
	if len(raw.Items) > int(size) {
		raw.Items = raw.Items[:size]
		out.NextCursor = makeOverviewCursor(scope, raw.Items[len(raw.Items)-1].SortKey)
	}
	for _, row := range raw.Items {
		item := row.CockpitAssigneeChoice
		switch {
		case row.Archived:
			item.Reason = "archived"
		case item.Type == "member":
			item.CanAssign = true
		case row.LeaderMissing:
			item.Reason = "leader_missing"
		case row.LeaderArchived:
			item.Reason = "leader_archived"
		case item.RuntimeBound == nil || !*item.RuntimeBound:
			item.Reason = "runtime_unbound"
		case row.PermissionAgent != nil && !cockpitAssignableAgentStatus(row.PermissionAgent.Status):
			item.Reason = "unsupported_status"
		default:
			if row.PermissionAgent == nil || row.PermissionAgent.WorkspaceID != p.WorkspaceID {
				return out, fmt.Errorf("assignee permission projection is incomplete")
			}
			allowed, err := memberMayInvokeAgent(ctx, q, *row.PermissionAgent, p.ActorID, p.WorkspaceID)
			if err != nil {
				return out, err
			}
			item.CanAssign = allowed
			if !allowed {
				item.Reason = "invocation_denied"
			}
		}
		out.Items = append(out.Items, item)
	}
	return out, tx.Commit(ctx)
}
func cockpitAssignableAgentStatus(status string) bool {
	switch status {
	case "idle", "working", "blocked", "error", "offline":
		return true
	}
	return false
}
