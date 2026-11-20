package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// RefileWorkItemScope rewrites the filing scope of every issue filed under a
// work item the caller has just moved. A work item's module and project are
// derived from the tree (I3), so issues filed under it cannot keep the old
// ones; when the move crosses projects, the status is mapped by the same
// function the issue detail path uses (issueworkflow.MappedStatusForMove), so
// the two entry points cannot disagree.
//
// Runs inside the caller's transaction: the node update and the issue rewrite
// commit together. Returns the changed rows for event publishing.
func (s *IssueService) RefileWorkItemScope(ctx context.Context, q *db.Queries, workspaceID, nodeID pgtype.UUID) ([]db.MoveFilingScopeRow, error) {
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: nodeID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// Only a work item (a child of an L2 row) carries a filing scope of its
	// own. Structural rows are the tree itself, not a place issues sit.
	if !node.ParentID.Valid {
		return nil, nil
	}
	parent, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: node.ParentID})
	if err != nil {
		return nil, err
	}
	if !parent.ModuleID.Valid || !parent.ProjectID.Valid {
		return nil, nil
	}
	ids, err := q.ListIssueIDsFiledAtNode(ctx, db.ListIssueIDsFiledAtNodeParams{WorkspaceID: workspaceID, WorkItemID: node.ID})
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	issues, err := q.ListCockpitReconcileIssues(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	current := make(map[pgtype.UUID]db.ListCockpitReconcileIssuesRow, len(issues))
	for _, issue := range issues {
		current[issue.ID] = issue
	}
	changed := make([]db.MoveFilingScopeRow, 0, len(ids))
	for _, id := range ids {
		issue, ok := current[id]
		if !ok {
			continue
		}
		status := issue.Status
		if issue.ProjectID != parent.ProjectID {
			def, _, err := issueworkflow.ForProject(ctx, q, workspaceID, parent.ProjectID)
			if err != nil {
				return nil, err
			}
			mapped, ok := issueworkflow.MappedStatusForMove(def, issue.Status, func(key string) string {
				return issuestatus.Category(ctx, q, workspaceID, key)
			})
			if ok {
				// A named workflow that has no step for this lifecycle still
				// has to accept what lands on it; the issue detail path rejects
				// the same case, so a move cannot do better than refuse.
				if err := issueworkflow.CheckStatus(def, mapped); err != nil {
					return nil, fmt.Errorf("issue %s: %w", util.UUIDToString(issue.ID), err)
				}
				status = mapped
			}
		}
		if issue.ProjectID == parent.ProjectID && issue.ModuleID == parent.ModuleID && status == issue.Status {
			continue
		}
		row, err := q.MoveFilingScope(ctx, db.MoveFilingScopeParams{
			WorkspaceID: workspaceID, IssueID: id,
			ProjectID: parent.ProjectID, ModuleID: parent.ModuleID, Status: status,
		})
		if err != nil {
			return nil, fmt.Errorf("refile issue %s: %w", util.UUIDToString(id), err)
		}
		changed = append(changed, row)
	}
	return changed, nil
}
