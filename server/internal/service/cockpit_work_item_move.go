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

// MoveWorkItemScope is where a work item's filing scope comes from: its parent
// must be a module row (L2), and the issues filed under it take that module and
// project. A parent that is not a module row is an error, not a no-op — a
// silent nil would leave the issues pointing at the module they just left (I2,
// I3).
func (s *IssueService) workItemScope(ctx context.Context, q *db.Queries, workspaceID, nodeID pgtype.UUID) (pgtype.UUID, pgtype.UUID, error) {
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: nodeID})
	if errors.Is(err, pgx.ErrNoRows) {
		return pgtype.UUID{}, pgtype.UUID{}, ErrCockpitWorkflowNotFound
	}
	if err != nil {
		return pgtype.UUID{}, pgtype.UUID{}, err
	}
	if !node.ParentID.Valid {
		return pgtype.UUID{}, pgtype.UUID{}, fmt.Errorf("%w: a work item must sit under a module", ErrCockpitWorkflowInput)
	}
	parent, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: node.ParentID})
	if err != nil {
		return pgtype.UUID{}, pgtype.UUID{}, err
	}
	// The parent must be a module row: L2 binds a module, L1 binds a project.
	if !parent.ModuleID.Valid || !parent.ProjectID.Valid {
		return pgtype.UUID{}, pgtype.UUID{}, fmt.Errorf("%w: a work item's parent must be a module row", ErrCockpitWorkflowInput)
	}
	return parent.ProjectID, parent.ModuleID, nil
}

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
	projectID, moduleID, err := s.workItemScope(ctx, q, workspaceID, nodeID)
	if err != nil {
		return nil, err
	}
	ids, err := q.ListIssueIDsFiledAtNode(ctx, db.ListIssueIDsFiledAtNodeParams{WorkspaceID: workspaceID, WorkItemID: nodeID})
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	// Only the rows this write touches, and one workflow lookup per distinct
	// destination — not the whole workspace's issue list per issue.
	issues, err := q.ListCockpitNodesByIDs(ctx, db.ListCockpitNodesByIDsParams{WorkspaceID: workspaceID, Ids: ids})
	if err != nil {
		return nil, err
	}
	var def *issueworkflow.Definition
	changed := make([]db.MoveFilingScopeRow, 0, len(issues))
	for _, issue := range issues {
		status := issue.Status
		if issue.ProjectID != projectID {
			if def == nil {
				loaded, _, err := issueworkflow.ForProject(ctx, q, workspaceID, projectID)
				if err != nil {
					return nil, err
				}
				def = loaded
				if def == nil {
					def = &issueworkflow.Definition{}
				}
			}
			mapped, ok := issueworkflow.MappedStatusForMove(def, issue.Status, func(key string) string {
				return issuestatus.Category(ctx, q, workspaceID, key)
			})
			if ok {
				// A named workflow that has no step for this lifecycle still
				// has to accept what lands on it; the issue detail path rejects
				// the same case, so a move cannot do better than refuse.
				if err := issueworkflow.CheckStatus(def, mapped); err != nil {
					return nil, &IssueStatusNotInWorkflowError{IssueNumber: issue.Number, Err: err}
				}
				status = mapped
			}
		}
		if issue.ProjectID == projectID && issue.ModuleID == moduleID && status == issue.Status {
			continue
		}
		row, err := q.MoveFilingScope(ctx, db.MoveFilingScopeParams{
			WorkspaceID: workspaceID, IssueID: issue.ID,
			ProjectID: projectID, ModuleID: moduleID, Status: status,
		})
		if err != nil {
			return nil, fmt.Errorf("refile issue %s: %w", util.UUIDToString(issue.ID), err)
		}
		changed = append(changed, row)
	}
	return changed, nil
}

// IssueStatusNotInWorkflowError carries the issue a refused move was about, so
// the HTTP layer can answer exactly like the issue detail path and name the
// issue in the message.
type IssueStatusNotInWorkflowError struct {
	IssueNumber int32
	Err         error
}

func (e *IssueStatusNotInWorkflowError) Error() string {
	return fmt.Sprintf("issue #%d: %v", e.IssueNumber, e.Err)
}

func (e *IssueStatusNotInWorkflowError) Unwrap() error { return e.Err }
