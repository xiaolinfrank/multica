package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func readPreparationScope(ctx context.Context, q *db.Queries, ws pgtype.UUID, nodeID, projectID, moduleID *string) (*CockpitPreparationResolvedScope, error) {
	if nodeID == nil && projectID == nil && moduleID == nil {
		return nil, nil
	}
	out := &CockpitPreparationResolvedScope{NodeID: nodeID, ProjectID: projectID, ModuleID: moduleID}
	if nodeID != nil {
		id, e := preparationUUID(nodeID)
		if e != nil {
			return nil, e
		}
		n, e := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: ws, ID: id})
		if e != nil {
			return nil, cockpitWorkflowError(e)
		}
		out.NodeTitle = n.Name
	}
	if projectID != nil {
		id, e := preparationUUID(projectID)
		if e != nil {
			return nil, e
		}
		p, e := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: ws, ID: id})
		if e != nil {
			return nil, cockpitWorkflowError(e)
		}
		out.ProjectTitle = p.Title
	}
	if moduleID != nil {
		id, e := preparationUUID(moduleID)
		if e != nil {
			return nil, e
		}
		m, e := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: ws, ID: id})
		if e != nil {
			return nil, cockpitWorkflowError(e)
		}
		out.ModuleTitle = m.Title
	}
	return out, nil
}
