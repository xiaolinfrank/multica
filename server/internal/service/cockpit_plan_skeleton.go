package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/collabfs"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// EnsureCockpitPlanSkeleton gives every project and module the L1/L2 row the
// plan tree promises (I1), appending new rows at the end of their level. It is
// the safety net behind the reconcile pass: a project or module created after
// reconciliation still shows up in the tree without a separate write path.
//
// Skipped entirely until cockpit.plan_reconciled_at is set (R2–R4 window, see
// the implementation plan): before reconciliation the legacy tree is the
// source of truth and synthesizing rows would double it. The common read path
// only pays one gap-count query; the board lock and inserts happen when rows
// are actually missing.
func (s *IssueService) EnsureCockpitPlanSkeleton(ctx context.Context, workspaceID pgtype.UUID) (int, error) {
	board, err := s.Queries.GetCockpitByWorkspace(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !board.PlanReconciledAt.Valid {
		return 0, nil
	}
	gaps, err := s.Queries.CountCockpitPlanSkeletonGaps(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	if gaps == 0 {
		return 0, nil
	}
	if s.TxStarter == nil {
		return 0, errors.New("plan skeleton requires a transaction starter")
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	// One writer at a time: two pods serving the same first visit must not mint
	// the same code for two rows. Re-read under the lock — the board may have
	// been reconciled by the writer we waited on.
	if _, err = qtx.LockCockpitForWorkspaceChanges(ctx, workspaceID); err != nil {
		return 0, err
	}
	board, err = qtx.GetCockpitByWorkspace(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	created, err := ensureCockpitPlanSkeletonTx(ctx, qtx, workspaceID, board)
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return created, nil
}

func ensureCockpitPlanSkeletonTx(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, board db.Cockpit) (int, error) {
	nodes, err := q.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		return 0, err
	}
	ledger, err := q.ListCockpitUsedCodes(ctx, board.ID)
	if err != nil {
		return 0, err
	}
	used := make([]string, 0, len(nodes)+len(ledger))
	used = append(used, ledger...)
	rootByProject := make(map[pgtype.UUID]db.CockpitNode, 16)
	childCount := make(map[pgtype.UUID]int, 16)
	childMaxPosition := make(map[pgtype.UUID]float64, 16)
	rootCount := 0
	rootMaxPosition := -1.0
	for _, node := range nodes {
		used = append(used, node.Code)
		if !node.ParentID.Valid {
			rootCount++
			rootByProject[node.ProjectID] = node
			if node.Position > rootMaxPosition {
				rootMaxPosition = node.Position
			}
			continue
		}
		childCount[node.ParentID]++
		if node.Position > childMaxPosition[node.ParentID] {
			childMaxPosition[node.ParentID] = node.Position
		}
	}

	projects, err := q.ListProjectsMissingCockpitRoot(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	modules, err := q.ListModulesMissingCockpitNode(ctx, workspaceID)
	if err != nil {
		return 0, err
	}
	if len(projects) == 0 && len(modules) == 0 {
		return 0, nil
	}
	created := 0
	newCodes := make([]string, 0, len(projects)+len(modules))
	for _, project := range projects {
		code := nextOutlineCode("", used, rootCount)
		rootMaxPosition++
		node, err := q.CreateCockpitSkeletonNode(ctx, db.CreateCockpitSkeletonNodeParams{
			WorkspaceID: workspaceID,
			CockpitID:   board.ID,
			ProjectID:   project.ID,
			Code:        code,
			Name:        project.Title,
			Position:    rootMaxPosition,
		})
		if err != nil {
			return 0, err
		}
		created++
		newCodes = append(newCodes, code)
		used = append(used, code)
		rootCount++
		rootByProject[project.ID] = node
	}
	// Folder names already taken under each project root: a module's L2 row
	// and its module record are the same folder, so a sibling that already
	// uses the name pushes the next one to "(2)".
	takenByRoot := make(map[pgtype.UUID]map[string]bool, len(rootByProject))
	for _, node := range nodes {
		if !node.ParentID.Valid || node.ParentID != rootByProject[node.ProjectID].ID {
			continue
		}
		if takenByRoot[node.ParentID] == nil {
			takenByRoot[node.ParentID] = map[string]bool{}
		}
		if node.DirectoryName.Valid {
			takenByRoot[node.ParentID][strings.ToLower(node.DirectoryName.String)] = true
		}
	}
	for _, module := range modules {
		root, ok := rootByProject[module.ProjectID]
		if !ok {
			return 0, fmt.Errorf("module %s has no project root to attach to", module.ID)
		}
		code := nextOutlineCode(root.Code, used, childCount[root.ID])
		position := childMaxPosition[root.ID] + 1
		if takenByRoot[root.ID] == nil {
			takenByRoot[root.ID] = map[string]bool{}
		}
		// A module that already names a folder keeps that name: it may be a
		// folder people are working in. Only a module with no name gets the
		// address-plus-title one, cleaned to a single path segment.
		directoryName := strings.TrimSpace(module.DirectoryName.String)
		if !module.DirectoryName.Valid || directoryName == "" {
			directoryName = collabfs.UniqueName(
				collabfs.SanitizeFolderName(code+module.Title, 0),
				func(candidate string) bool { return takenByRoot[root.ID][strings.ToLower(candidate)] },
			)
		}
		takenByRoot[root.ID][strings.ToLower(directoryName)] = true
		if _, err := q.CreateCockpitSkeletonNode(ctx, db.CreateCockpitSkeletonNodeParams{
			WorkspaceID: workspaceID,
			CockpitID:   board.ID,
			ParentID:    root.ID,
			ProjectID:   module.ProjectID,
			ModuleID:    module.ID,
			Code:        code,
			Name:        module.Title,
			Position:    position,
			// S7: the row's folder name IS the module's; the module row is
			// updated here too so the two cannot drift while nobody looks.
			DirectoryName: pgtype.Text{String: directoryName, Valid: true},
		}); err != nil {
			return 0, err
		}
		if module.DirectoryName.String != directoryName || !module.DirectoryName.Valid {
			if err := q.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{
				WorkspaceID: workspaceID, ID: module.ID, DirectoryName: directoryName,
			}); err != nil {
				return 0, err
			}
		}
		created++
		newCodes = append(newCodes, code)
		used = append(used, code)
		childCount[root.ID]++
		childMaxPosition[root.ID] = position
	}
	for _, code := range newCodes {
		if _, err := q.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{
			WorkspaceID: workspaceID,
			CockpitID:   board.ID,
			Code:        code,
		}); err != nil {
			return 0, err
		}
	}
	return created, nil
}

// nextOutlineCode picks the next outline number under parent: "" for the L1
// family, otherwise the parent's code. Codes are handed out once (the ledger
// outlives deleted rows), two digits at a time, so a fresh level starts at 01
// and a board that already spent 01…06 continues at 07.
func nextOutlineCode(parent string, used []string, fallback int) string {
	prefix := ""
	if parent != "" {
		prefix = parent + "."
	}
	highest := fallback
	for _, code := range used {
		if !strings.HasPrefix(code, prefix) {
			continue
		}
		tail := code[len(prefix):]
		if len(tail) != 2 {
			continue
		}
		n, err := strconv.Atoi(tail)
		if err != nil || n <= 0 {
			continue
		}
		if n > highest {
			highest = n
		}
	}
	return prefix + fmt.Sprintf("%02d", highest+1)
}
