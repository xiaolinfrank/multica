package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitNodeSelectorQuery struct {
	CockpitSurfaceQuery
	Query, Cursor string
	EligibleOnly  bool
	PageSize      int32
}
type CockpitNodeChoice struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
	Code      string  `json:"code"`
	Eligible  bool    `json:"eligible"`
	Reason    string  `json:"reason"`
}
type CockpitNodeSelectorScope struct {
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
	Query     string  `json:"q"`
	Eligible  bool    `json:"eligible"`
}
type CockpitNodeChoicePage struct {
	WorkspaceID   string                   `json:"workspace_id"`
	Scope         CockpitNodeSelectorScope `json:"scope"`
	Items         []CockpitNodeChoice      `json:"items"`
	Total         int64                    `json:"total"`
	FilteredTotal int64                    `json:"filtered_total"`
	NextCursor    *string                  `json:"next_cursor"`
}
type CockpitMemberSelectorQuery struct {
	CockpitSurfaceQuery
	Query, Cursor string
	UserIDs       []pgtype.UUID
	PageSize      int32
}
type CockpitMemberChoice struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
	Role      string `json:"role"`
}
type CockpitMemberSelectorScope struct {
	Query string   `json:"q"`
	IDs   []string `json:"ids"`
}
type CockpitMemberChoicePage struct {
	WorkspaceID   string                     `json:"workspace_id"`
	Scope         CockpitMemberSelectorScope `json:"scope"`
	Items         []CockpitMemberChoice      `json:"items"`
	Total         int64                      `json:"total"`
	FilteredTotal int64                      `json:"filtered_total"`
	NextCursor    *string                    `json:"next_cursor"`
}

func cockpitSelectorPageSize(size int32) (int32, error) {
	if size == 0 {
		return 20, nil
	}
	if size < 1 || size > 100 {
		return 0, fmt.Errorf("%w: page_size must be between 1 and 100", ErrCockpitWorkflowInput)
	}
	return size, nil
}
func cockpitSelectorCursor(value, scope string) (string, error) {
	if len(value) > 4096 {
		return "", fmt.Errorf("%w: cursor is too long", ErrCockpitWorkflowInput)
	}
	key, err := readOverviewCursor(value, scope)
	if err != nil || key == "" {
		return key, err
	}
	id, err := util.ParseUUID(key)
	if err != nil {
		return "", fmt.Errorf("%w: invalid selector cursor", ErrCockpitWorkflowInput)
	}
	return util.UUIDToString(id), nil
}

func (s *IssueService) ListCockpitScopeNodes(ctx context.Context, p CockpitNodeSelectorQuery) (CockpitNodeChoicePage, error) {
	var out CockpitNodeChoicePage
	p.Query = strings.TrimSpace(p.Query)
	size, err := cockpitSelectorPageSize(p.PageSize)
	if err != nil {
		return out, err
	}
	if len(p.Query) > 512 {
		return out, fmt.Errorf("%w: query is limited to 512 bytes", ErrCockpitWorkflowInput)
	}
	scope := planningHash([]any{"scope_nodes", p.WorkspaceID, p.ProjectID, p.ModuleID, p.Query, p.EligibleOnly, size})
	key, err := cockpitSelectorCursor(p.Cursor, scope)
	if err != nil {
		return out, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = readCockpitSurfaceContext(ctx, q, p.CockpitSurfaceQuery); err != nil {
		return out, err
	}
	payload, err := q.ListCockpitScopeNodes(ctx, db.ListCockpitScopeNodesParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID,
		Query: p.Query, EligibleOnly: p.EligibleOnly, CursorKey: key, RowLimit: size + 1})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = util.UUIDToString(p.WorkspaceID)
	out.Scope = CockpitNodeSelectorScope{ProjectID: planningUUID(p.ProjectID), ModuleID: planningUUID(p.ModuleID), Query: p.Query, Eligible: p.EligibleOnly}
	if len(out.Items) > int(size) {
		out.Items = out.Items[:size]
		out.NextCursor = makeOverviewCursor(scope, out.Items[len(out.Items)-1].ID)
	}
	return out, tx.Commit(ctx)
}

func (s *IssueService) ListCockpitScopeMembers(ctx context.Context, p CockpitMemberSelectorQuery) (CockpitMemberChoicePage, error) {
	var out CockpitMemberChoicePage
	p.Query = strings.TrimSpace(p.Query)
	size, err := cockpitSelectorPageSize(p.PageSize)
	if err != nil {
		return out, err
	}
	if p.ProjectID.Valid || p.ModuleID.Valid || len(p.Query) > 512 || len(p.UserIDs) > 20 || (len(p.UserIDs) > 0 && (p.Query != "" || p.Cursor != "" || len(p.UserIDs) > int(size))) {
		return out, fmt.Errorf("%w: member choices are workspace-scoped; ids accepts at most 20 people and cannot be combined with search or cursor", ErrCockpitWorkflowInput)
	}
	ids := make([]string, 0, len(p.UserIDs))
	seen := make(map[pgtype.UUID]bool, len(p.UserIDs))
	for _, id := range p.UserIDs {
		if !id.Valid || id.Bytes == [16]byte{} || seen[id] {
			return out, fmt.Errorf("%w: member ids must be distinct nonzero UUIDs", ErrCockpitWorkflowInput)
		}
		seen[id] = true
		ids = append(ids, util.UUIDToString(id))
	}
	sort.Strings(ids)
	scope := planningHash([]any{"scope_members", p.WorkspaceID, p.Query, ids, size})
	key, err := cockpitSelectorCursor(p.Cursor, scope)
	if err != nil {
		return out, err
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err := readCockpitSurfaceContext(ctx, q, p.CockpitSurfaceQuery); err != nil {
		return out, err
	}
	payload, err := q.ListCockpitScopeMembers(ctx, db.ListCockpitScopeMembersParams{WorkspaceID: p.WorkspaceID, Query: p.Query, UserIds: p.UserIDs, CursorKey: key, RowLimit: size + 1})
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = util.UUIDToString(p.WorkspaceID)
	out.Scope = CockpitMemberSelectorScope{Query: p.Query, IDs: ids}
	if len(out.Items) > int(size) {
		out.Items = out.Items[:size]
		out.NextCursor = makeOverviewCursor(scope, out.Items[len(out.Items)-1].ID)
	}
	return out, tx.Commit(ctx)
}
