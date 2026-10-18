package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrCockpitScopeLimit = errors.New("cockpit scope exceeds the complete plan limit; choose a project or module")

type CockpitSurfaceQuery struct {
	WorkspaceID, ProjectID, ModuleID, ActorID pgtype.UUID
	Human                                     bool
	ArtifactsAvailable                        bool `json:"-"`
	MeetingLifecycleAvailable                 bool `json:"-"`
	MeetingDispositionAvailable               bool `json:"-"`
	MeetingDirectoryAvailable                 bool `json:"-"`
	InputsAvailable                           bool `json:"-"`
	RunInputManifestsAvailable                bool `json:"-"`
}
type CockpitSurfaceScope struct {
	ProjectID    *string `json:"project_id"`
	ModuleID     *string `json:"module_id"`
	ProjectTitle string  `json:"project_title"`
	ModuleTitle  string  `json:"module_title"`
}

// Availability describes implemented services, not a user's write authority.
type CockpitSurfaceCapabilities struct {
	MeetingTemplates            bool `json:"meeting_templates"` // Retired; always false for installed clients.
	Inputs                      bool `json:"inputs"`
	RunInputManifests           bool `json:"run_input_manifests"`
	MeetingLifecycle            bool `json:"meeting_lifecycle"`
	MeetingDisposition          bool `json:"meeting_disposition"`
	MeetingDirectoryPreparation bool `json:"meeting_directory_preparation"`
	Artifacts                   bool `json:"artifacts"`
	Acceptance                  bool `json:"acceptance"`
}
type CockpitInputReferenceMeetingTarget struct {
	MeetingID string `json:"meeting_id"`
	Title     string `json:"title"`
}
type CockpitSurfaceContext struct {
	InputReferenceMeetings      []CockpitInputReferenceMeetingTarget `json:"input_reference_meetings"`
	InputReferenceMeetingsTotal int64                                `json:"input_reference_meetings_total"`
	WorkspaceID                 string                               `json:"workspace_id"`
	Scope                       CockpitSurfaceScope                  `json:"scope"`
	Cockpit                     *db.Cockpit                          `json:"cockpit"`
	Actor                       CockpitOverviewActor                 `json:"actor"`
	HasMeetingLifecycle         bool                                 `json:"has_meeting_lifecycle"`
	HasMeetingPreparation       bool                                 `json:"has_meeting_preparation"`
	HasDirectoryHistory         bool                                 `json:"has_directory_history"`
	HasInputReferences          bool                                 `json:"has_input_references"`
	HasMeetingWorkflows         bool                                 `json:"has_meeting_workflows"`
	HasStableBindings           bool                                 `json:"has_stable_bindings"`
	Capabilities                CockpitSurfaceCapabilities           `json:"capabilities"`
}
type CockpitSurfacePlan struct {
	CockpitSurfaceContext
	Complete       bool            `json:"complete"`
	Nodes          json.RawMessage `json:"nodes"`
	Payments       json.RawMessage `json:"payments"`
	Milestones     json.RawMessage `json:"milestones"`
	NodeIndex      json.RawMessage `json:"node_index"`
	ContextNodeIDs []string        `json:"context_node_ids"`
	TaskCounts     json.RawMessage `json:"task_counts"`
	Counts         struct {
		Nodes      int64 `json:"nodes"`
		Payments   int64 `json:"payments"`
		Milestones int64 `json:"milestones"`
		IndexNodes int64 `json:"index_nodes"`
	} `json:"counts"`
}
type CockpitScopeChoice struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	ProjectID *string `json:"project_id"`
}
type CockpitScopeChoicePage struct {
	WorkspaceID string               `json:"workspace_id"`
	ProjectID   *string              `json:"project_id"`
	Items       []CockpitScopeChoice `json:"items"`
	Total       int64                `json:"total"`
	NextCursor  *string              `json:"next_cursor"`
}

func readCockpitSurfaceContext(ctx context.Context, q *db.Queries, p CockpitSurfaceQuery) (CockpitSurfaceContext, error) {
	out := CockpitSurfaceContext{InputReferenceMeetings: []CockpitInputReferenceMeetingTarget{}}
	if p.ModuleID.Valid && !p.ProjectID.Valid {
		return out, fmt.Errorf("%w: module_id requires project_id", ErrCockpitWorkflowInput)
	}
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: p.ActorID, WorkspaceID: p.WorkspaceID})
	if err != nil {
		return out, planningError(err)
	}
	out.WorkspaceID = util.UUIDToString(p.WorkspaceID)
	out.Scope = CockpitSurfaceScope{ProjectID: planningUUID(p.ProjectID), ModuleID: planningUUID(p.ModuleID)}
	out.Actor = CockpitOverviewActor{UserID: util.UUIDToString(p.ActorID), Role: member.Role, IsHuman: p.Human}
	out.Capabilities = CockpitSurfaceCapabilities{Inputs: p.InputsAvailable, RunInputManifests: p.RunInputManifestsAvailable, Artifacts: p.ArtifactsAvailable, Acceptance: p.ArtifactsAvailable, MeetingLifecycle: p.MeetingLifecycleAvailable, MeetingDisposition: p.MeetingDispositionAvailable, MeetingDirectoryPreparation: p.MeetingDirectoryAvailable}
	out.HasMeetingPreparation, err = q.HasCockpitMeetingPreparation(ctx, p.WorkspaceID)
	if err != nil {
		return out, err
	}
	directoryHistory, err := q.HasCockpitDirectoryWorkspaceHistory(ctx, p.WorkspaceID)
	if err != nil {
		return out, err
	}
	if !directoryHistory.Valid {
		return out, fmt.Errorf("directory history could not be confirmed")
	}
	out.HasDirectoryHistory = directoryHistory.Bool
	if p.ProjectID.Valid {
		project, err := q.GetCockpitOverviewProject(ctx, db.GetCockpitOverviewProjectParams{WorkspaceID: p.WorkspaceID, ID: p.ProjectID})
		if err != nil {
			return out, planningError(err)
		}
		out.Scope.ProjectTitle = project.Title
	}
	if p.ModuleID.Valid {
		module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.ModuleID})
		if err != nil {
			return out, planningError(err)
		}
		if module.ProjectID != p.ProjectID {
			return out, fmt.Errorf("%w: module_id does not belong to project_id", ErrCockpitWorkflowInput)
		}
		out.Scope.ModuleTitle = module.Title
	}
	board, err := q.GetCockpitByWorkspace(ctx, p.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	out.Cockpit = &board
	out.HasMeetingWorkflows, err = q.HasCockpitMinutesLinksForBoard(ctx, db.HasCockpitMinutesLinksForBoardParams{WorkspaceID: p.WorkspaceID, CockpitID: board.ID})
	if err != nil {
		return out, err
	}
	out.HasMeetingLifecycle, err = q.HasCockpitLifecycleForBoard(ctx, db.HasCockpitLifecycleForBoardParams{WorkspaceID: p.WorkspaceID, CockpitID: board.ID})
	if err != nil {
		return out, err
	}
	inputMeetings, err := q.ReadCockpitInputReferencedMeetings(ctx, db.ReadCockpitInputReferencedMeetingsParams{WorkspaceID: p.WorkspaceID, CockpitID: board.ID})
	if err != nil {
		return out, err
	}
	for _, m := range inputMeetings {
		out.InputReferenceMeetings = append(out.InputReferenceMeetings, CockpitInputReferenceMeetingTarget{MeetingID: util.UUIDToString(m.ID), Title: m.Title})
		out.InputReferenceMeetingsTotal = m.Total
	}
	out.HasInputReferences = out.InputReferenceMeetingsTotal > 0
	out.HasStableBindings, err = q.CockpitHasBoundNodes(ctx, db.CockpitHasBoundNodesParams{WorkspaceID: p.WorkspaceID, CockpitID: board.ID})
	return out, err
}
func (s *IssueService) GetCockpitSurfaceContext(ctx context.Context, p CockpitSurfaceQuery) (CockpitSurfaceContext, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return CockpitSurfaceContext{}, err
	}
	defer tx.Rollback(ctx)
	out, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
func (s *IssueService) GetCockpitPlanSurface(ctx context.Context, p CockpitSurfaceQuery) (CockpitSurfacePlan, error) {
	var out CockpitSurfacePlan
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	out, err = readCockpitPlanSurface(ctx, q, header, p)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func readCockpitPlanSurface(ctx context.Context, q *db.Queries, header CockpitSurfaceContext, p CockpitSurfaceQuery) (CockpitSurfacePlan, error) {
	var out CockpitSurfacePlan
	payload, err := q.GetCockpitPlanSurface(ctx, db.GetCockpitPlanSurfaceParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, ModuleID: p.ModuleID})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, fmt.Errorf("decode cockpit plan: %w", err)
	}
	out.CockpitSurfaceContext = header
	if out.Counts.IndexNodes > 20000 {
		return CockpitSurfacePlan{}, ErrCockpitIndexLimit
	}
	if out.Counts.Nodes > 5000 || out.Counts.Payments > 25000 || out.Counts.Milestones > 2000 {
		return CockpitSurfacePlan{}, ErrCockpitScopeLimit
	}
	return out, nil
}
func (s *IssueService) ListCockpitScopeChoices(ctx context.Context, p CockpitSurfaceQuery, kind, search, cursor string) (CockpitScopeChoicePage, error) {
	var out CockpitScopeChoicePage
	search = strings.TrimSpace(search)
	if (kind != "projects" && kind != "modules") || (kind == "modules" && !p.ProjectID.Valid) || len(search) > 512 || p.ModuleID.Valid {
		return out, fmt.Errorf("%w: invalid scope selector", ErrCockpitWorkflowInput)
	}
	scope := planningHash(struct {
		Query        CockpitSurfaceQuery
		Kind, Search string
	}{p, kind, search})
	key, err := readOverviewCursor(cursor, scope)
	if err != nil {
		return out, err
	}
	if key != "" {
		if _, err = util.ParseUUID(key); err != nil {
			return out, fmt.Errorf("%w: invalid scope cursor", ErrCockpitWorkflowInput)
		}
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = readCockpitSurfaceContext(ctx, q, p); err != nil {
		return out, err
	}
	payload, err := q.ListCockpitScopeChoices(ctx, db.ListCockpitScopeChoicesParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ProjectID, Kind: kind, Query: search, CursorKey: key})
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(payload, &out); err != nil {
		return out, err
	}
	out.WorkspaceID = util.UUIDToString(p.WorkspaceID)
	out.ProjectID = planningUUID(p.ProjectID)
	if len(out.Items) > 20 {
		out.Items = out.Items[:20]
		out.NextCursor = makeOverviewCursor(scope, out.Items[19].ID)
	}
	return out, tx.Commit(ctx)
}
