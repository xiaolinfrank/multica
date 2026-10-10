package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitIndexLimit = errors.New("cockpit display index exceeds the supported limit; contact the workspace administrator")

type CockpitSurfacePage struct {
	WorkspaceID  string            `json:"workspace_id"`
	ObjectID     string            `json:"object_id"`
	Kind         string            `json:"kind"`
	Items        []json.RawMessage `json:"items"`
	Total        int64             `json:"total"`
	NextCursor   *string           `json:"next_cursor"`
	PaymentTotal float64           `json:"payment_total"`
}
type CockpitSurfaceBinding struct {
	ProjectID    *string `json:"project_id"`
	ModuleID     *string `json:"module_id"`
	ProjectTitle string  `json:"project_title"`
	ModuleTitle  string  `json:"module_title"`
	SourceNodeID *string `json:"source_node_id"`
	Eligible     bool    `json:"eligible"`
	Reason       string  `json:"reason"`
}
type CockpitSurfaceNodeDetail struct {
	CockpitSurfaceContext
	Node          db.CockpitNode             `json:"node"`
	Ancestors     []db.CockpitNode           `json:"ancestors"`
	ChildrenCount int64                      `json:"children_count"`
	ScopeMatch    bool                       `json:"scope_match"`
	Binding       CockpitSurfaceBinding      `json:"binding"`
	NodeIndex     json.RawMessage            `json:"node_index"`
	Payments      CockpitSurfacePage         `json:"payments"`
	PaymentTotal  float64                    `json:"payment_total"`
	Meetings      CockpitMeetingRegisterPage `json:"meetings"`
}
type CockpitSurfaceMeetingDetail struct {
	CockpitSurfaceContext
	Meeting      json.RawMessage    `json:"meeting"`
	ScopeMatch   bool               `json:"scope_match"`
	NodeIndex    json.RawMessage    `json:"node_index"`
	LinkedIssues CockpitSurfacePage `json:"linked_issues"`
	LinkedNodes  CockpitSurfacePage `json:"linked_nodes"`
}
type surfacePositionCursor struct {
	ID       string  `json:"id"`
	Position float64 `json:"position"`
}

func readSurfaceIndex(ctx context.Context, q *db.Queries, ws pgtype.UUID) (json.RawMessage, error) {
	payload, err := q.GetCockpitSurfaceNodeIndex(ctx, ws)
	if err != nil {
		return nil, err
	}
	var out struct {
		Items json.RawMessage `json:"items"`
		Total int64           `json:"total"`
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}
	if out.Total > 20000 {
		return nil, ErrCockpitIndexLimit
	}
	return out.Items, nil
}
func readSurfaceObjectPage(ctx context.Context, q *db.Queries, p CockpitSurfaceQuery, id pgtype.UUID, kind, cursor string, size int32) (CockpitSurfacePage, error) {
	var out CockpitSurfacePage
	size, err := planningPageSize(size)
	if err != nil {
		return out, err
	}
	if !slices.Contains([]string{"payments", "meeting_issues", "meeting_nodes"}, kind) {
		return out, fmt.Errorf("%w: unsupported relation", ErrCockpitWorkflowInput)
	}
	scope := planningHash(struct {
		Query CockpitSurfaceQuery
		ID    pgtype.UUID
		Kind  string
		Size  int32
	}{p, id, kind, size})
	key, err := readOverviewCursor(cursor, scope)
	if err != nil {
		return out, err
	}
	var position surfacePositionCursor
	var cursorID pgtype.UUID
	if key != "" {
		if err = json.Unmarshal([]byte(key), &position); err != nil || math.IsNaN(position.Position) || math.IsInf(position.Position, 0) {
			return out, fmt.Errorf("%w: invalid relation cursor", ErrCockpitWorkflowInput)
		}
		cursorID, err = util.ParseUUID(position.ID)
		if err != nil {
			return out, fmt.Errorf("%w: invalid relation cursor", ErrCockpitWorkflowInput)
		}
	}
	payload, err := q.GetCockpitSurfaceObjectPage(ctx, db.GetCockpitSurfaceObjectPageParams{WorkspaceID: p.WorkspaceID, ObjectID: id, Kind: kind, CursorID: cursorID, CursorPosition: position.Position, PageSize: size})
	if err != nil {
		return out, err
	}
	var raw struct {
		CockpitSurfacePage
		CursorItems []surfacePositionCursor `json:"cursor_items"`
	}
	if err = json.Unmarshal(payload, &raw); err != nil {
		return out, err
	}
	out = raw.CockpitSurfacePage
	out.WorkspaceID = util.UUIDToString(p.WorkspaceID)
	out.ObjectID = util.UUIDToString(id)
	out.Kind = kind
	if len(out.Items) > int(size) {
		if len(raw.CursorItems) != len(out.Items) {
			return out, fmt.Errorf("relation cursor count does not match page")
		}
		out.Items = out.Items[:size]
		key, _ := json.Marshal(raw.CursorItems[size-1])
		out.NextCursor = makeOverviewCursor(scope, string(key))
	}
	return out, nil
}
func (s *IssueService) ListCockpitSurfaceObjectPage(ctx context.Context, p CockpitSurfaceQuery, id pgtype.UUID, kind, cursor string, size int32) (CockpitSurfacePage, error) {
	var out CockpitSurfacePage
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = readCockpitSurfaceContext(ctx, q, p); err != nil {
		return out, err
	}
	if kind == "payments" {
		_, err = q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: p.WorkspaceID, ID: id})
	} else {
		_, err = q.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{WorkspaceID: p.WorkspaceID, ID: id})
	}
	if err != nil {
		return out, planningError(err)
	}
	out, err = readSurfaceObjectPage(ctx, q, p, id, kind, cursor, size)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *IssueService) GetCockpitSurfaceNode(ctx context.Context, p CockpitSurfaceQuery, id pgtype.UUID) (CockpitSurfaceNodeDetail, error) {
	var out CockpitSurfaceNodeDetail
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out.CockpitSurfaceContext, err = readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	rows, err := q.ListCockpitSurfaceAncestors(ctx, db.ListCockpitSurfaceAncestorsParams{WorkspaceID: p.WorkspaceID, NodeID: id})
	if err != nil {
		return out, err
	}
	if len(rows) == 0 {
		return out, ErrCockpitWorkflowNotFound
	}
	out.Node = rows[0].CockpitNode
	out.Ancestors = []db.CockpitNode{}
	out.ChildrenCount, err = q.CountCockpitSurfaceChildren(ctx, db.CountCockpitSurfaceChildrenParams{WorkspaceID: p.WorkspaceID, NodeID: id})
	if err != nil {
		return out, err
	}
	var project, module, source pgtype.UUID
	reason := ""
	valid := true
	if rows[len(rows)-1].CockpitNode.ParentID.Valid {
		valid = false
		reason = "invalid_ancestry"
	}
	for index, row := range rows {
		node := row.CockpitNode
		if index > 0 {
			out.Ancestors = append(out.Ancestors, node)
		}
		if node.ModuleID.Valid {
			if module.Valid || !node.ProjectID.Valid {
				valid = false
				reason = "binding_conflict"
			}
			module = node.ModuleID
			source = node.ID
		}
		if node.ProjectID.Valid {
			if project.Valid && project != node.ProjectID {
				valid = false
				reason = "binding_conflict"
			}
			project = node.ProjectID
			if !source.Valid {
				source = node.ID
			}
		}
	}
	slices.Reverse(out.Ancestors)
	if project.Valid {
		record, e := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: project})
		if errors.Is(e, pgx.ErrNoRows) {
			valid = false
			reason = "binding_conflict"
		} else if e != nil {
			return out, e
		} else {
			out.Binding.ProjectTitle = record.Title
		}
	}
	if module.Valid {
		record, e := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: module})
		if errors.Is(e, pgx.ErrNoRows) || e == nil && record.ProjectID != project {
			valid = false
			reason = "binding_conflict"
		} else if e != nil {
			return out, e
		} else {
			out.Binding.ModuleTitle = record.Title
		}
	}
	out.Binding.ProjectID = planningUUID(project)
	out.Binding.ModuleID = planningUUID(module)
	out.Binding.SourceNodeID = planningUUID(source)
	out.ScopeMatch = (!p.ProjectID.Valid || valid && project == p.ProjectID) && (!p.ModuleID.Valid || valid && module == p.ModuleID)
	if valid {
		switch {
		case out.Node.ProjectID.Valid || out.Node.ModuleID.Valid:
			reason = "structural_node"
		case out.ChildrenCount > 0:
			reason = "not_leaf"
		case !project.Valid || !module.Valid:
			reason = "module_binding_required"
		default:
			out.Binding.Eligible = true
		}
	}
	out.Binding.Reason = reason
	out.NodeIndex, err = readSurfaceIndex(ctx, q, p.WorkspaceID)
	if err != nil {
		return out, err
	}
	// Object relations remain complete for that object even when opened outside the active scope.
	relationScope := p
	relationScope.ProjectID = pgtype.UUID{}
	relationScope.ModuleID = pgtype.UUID{}
	out.Payments, err = readSurfaceObjectPage(ctx, q, relationScope, id, "payments", "", 25)
	if err != nil {
		return out, err
	}
	out.PaymentTotal = out.Payments.PaymentTotal
	relationHeader := out.CockpitSurfaceContext
	relationHeader.Scope = CockpitSurfaceScope{}
	out.Meetings, err = readCockpitMeetingRegister(ctx, q, relationHeader, CockpitMeetingRegisterQuery{CockpitSurfaceQuery: relationScope, NodeID: id, PageSize: 25})
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitSurfaceMeeting(ctx context.Context, p CockpitSurfaceQuery, id pgtype.UUID) (CockpitSurfaceMeetingDetail, error) {
	var out CockpitSurfaceMeetingDetail
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	out.CockpitSurfaceContext, err = readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	out.Meeting, err = q.GetCockpitSurfaceMeeting(ctx, db.GetCockpitSurfaceMeetingParams{WorkspaceID: p.WorkspaceID, MeetingID: id})
	if err != nil {
		return out, planningError(err)
	}
	out.ScopeMatch, err = q.CockpitMeetingMatchesSurfaceScope(ctx, db.CockpitMeetingMatchesSurfaceScopeParams{WorkspaceID: p.WorkspaceID, MeetingID: id, ProjectID: p.ProjectID, ModuleID: p.ModuleID})
	if err != nil {
		return out, err
	}
	out.NodeIndex, err = readSurfaceIndex(ctx, q, p.WorkspaceID)
	if err != nil {
		return out, err
	}
	relationScope := p
	relationScope.ProjectID = pgtype.UUID{}
	relationScope.ModuleID = pgtype.UUID{}
	out.LinkedIssues, err = readSurfaceObjectPage(ctx, q, relationScope, id, "meeting_issues", "", 25)
	if err != nil {
		return out, err
	}
	out.LinkedNodes, err = readSurfaceObjectPage(ctx, q, relationScope, id, "meeting_nodes", "", 25)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
