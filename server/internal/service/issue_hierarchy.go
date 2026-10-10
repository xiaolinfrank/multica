package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var ErrIssueParentCycle = errors.New("the selected parent would create an issue hierarchy cycle")
var ErrIssueParentHierarchyIncomplete = errors.New("the selected parent has an incomplete or cyclic hierarchy")

// LockIssueHierarchyMutation must run before catalog, cockpit or Issue row locks.
// Workspace KEY SHARE also fences teardown; the advisory lock is local to this
// one workspace's parent/filing mutations and is released with the transaction.
func LockIssueHierarchyMutation(ctx context.Context, q *db.Queries, workspace pgtype.UUID) error {
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, workspace); err != nil {
		return fmt.Errorf("lock issue hierarchy workspace: %w", err)
	}
	return q.LockIssueHierarchy(ctx, workspace)
}

// ValidateIssueParentChain checks the complete UUID chain. UNION in SQL ends
// malformed old cycles without accepting a depth-truncated partial traversal.
func ValidateIssueParentChain(ctx context.Context, q *db.Queries, workspace, issue, parent pgtype.UUID) error {
	if !parent.Valid {
		return nil
	}
	facts, err := q.GetIssueParentChainFacts(ctx, db.GetIssueParentChainFactsParams{WorkspaceID: workspace, IssueID: issue, ParentID: parent})
	if err != nil {
		return err
	}
	if !facts.ParentExists {
		return ErrParentIssueNotFound
	}
	if facts.WouldCycle {
		return ErrIssueParentCycle
	}
	if facts.ExistingCycle || facts.MissingAncestor {
		return ErrIssueParentHierarchyIncomplete
	}
	return nil
}
