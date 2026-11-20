package handler

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Hierarchy rules for a reconciled board (S3). Once the plan is reconciled the
// tree has exactly three levels (I1) and a work item sits under a module row
// (I2). Before reconciliation the legacy shapes are still being migrated, so
// these rules stay off.

// requireReconciledPlan refuses a write that only makes sense after the plan is
// reconciled: codes and levels are fixed from then on.
func requireReconciledPlan(board db.Cockpit) error {
	if !board.PlanReconciledAt.Valid {
		return errors.New("the plan has not been reconciled yet; finish the reconcile before changing its structure")
	}
	return nil
}

// requireWorkItemMove checks a reparent is legal on a reconciled board:
//   - the moved row is a work item (it hangs from a module row),
//   - its new parent is a module row as well.
//
// A project row has no parent to change, and a module row's parent is its
// project — moving a module between projects is out of scope this round, so
// both are refused rather than half-applied.
func (h *Handler) requireWorkItemMove(ctx context.Context, q *db.Queries, cc cockpitContext, current, updated db.CockpitNode) error {
	board, err := q.GetCockpitByWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return err
	}
	if !board.PlanReconciledAt.Valid {
		return nil // legacy boards keep the pre-S3 behaviour
	}
	if _, ok, err := loadModuleRow(ctx, q, cc.workspaceID, current.ParentID); err != nil {
		return err
	} else if !ok {
		return errors.New("only a work item can change parent")
	}
	if _, ok, err := loadModuleRow(ctx, q, cc.workspaceID, updated.ParentID); err != nil {
		return err
	} else if !ok {
		return errors.New("a work item's parent must be a module row")
	}
	return nil
}

// loadModuleRow reports whether id names a module row (an L2: it binds a
// module and hangs from a project row).
func loadModuleRow(ctx context.Context, q *db.Queries, workspaceID, id pgtype.UUID) (db.CockpitNode, bool, error) {
	if !id.Valid {
		return db.CockpitNode{}, false, nil
	}
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspaceID, ID: id})
	if err != nil {
		return db.CockpitNode{}, false, err
	}
	return node, node.ModuleID.Valid && node.ProjectID.Valid && node.ParentID.Valid, nil
}

// movedWorkItemCode allocates the destination module's next number for a work
// item crossing modules (§0 item 19); the old number stays spent. Empty means
// "keep the current code" — a pre-reconcile board, where codes are provisional.
func movedWorkItemCode(ctx context.Context, q *db.Queries, cc cockpitContext, newParent pgtype.UUID) (string, error) {
	board, err := q.GetCockpitByWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return "", err
	}
	if !board.PlanReconciledAt.Valid || !newParent.Valid {
		return "", nil
	}
	code, err := service.ReadCockpitNextNodeCode(ctx, q, cc.workspaceID, newParent)
	if err != nil {
		return "", err
	}
	if _, err := q.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID, Code: code}); err != nil {
		return "", fmt.Errorf("record code %s: %w", code, err)
	}
	return code, nil
}
