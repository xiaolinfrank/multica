package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Work item writes (S3). A work item is the third level of the plan: a row
// under a module's L2, where issues are filed. Creating one here rather than
// through the generic node create is what the plan fixes: the caller names a
// module and a title, and the server owns the code, the parent and the
// directory name.

type CockpitWorkItemCreateRequest struct {
	ModuleID string  `json:"module_id"`
	Name     string  `json:"name"`
	AfterID  *string `json:"after_id"`
}

// CreateCockpitWorkItem writes a work item under a module's plan row.
func (h *Handler) CreateCockpitWorkItem(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CockpitWorkItemCreateRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	moduleID, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(req.ModuleID), "module_id")
	if !ok {
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 200 {
		writeError(w, http.StatusBadRequest, "name must be 1-200 characters")
		return
	}
	var afterID pgtype.UUID
	if req.AfterID != nil && strings.TrimSpace(*req.AfterID) != "" {
		afterID, ok = parseUUIDOrBadRequest(w, strings.TrimSpace(*req.AfterID), "after_id")
		if !ok {
			return
		}
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create work item")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	// Same serialization the reconcile and the skeleton use: code allocation
	// must not interleave with another writer handing out the same number.
	if _, err := qtx.LockCockpitForWorkspaceChanges(ctx, cc.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock the plan board")
		return
	}
	board, err := qtx.GetCockpitByWorkspace(ctx, cc.workspaceID)
	if err != nil {
		writeError(w, http.StatusConflict, "workspace has no plan board")
		return
	}
	// The module's L2 row: the only place a work item can hang from.
	l2ID, err := qtx.GetCockpitNodeBindingConflict(ctx, db.GetCockpitNodeBindingConflictParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID, ModuleID: moduleID})
	if err != nil {
		writeError(w, http.StatusBadRequest, "module has no row on the plan board yet")
		return
	}
	l2, err := qtx.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: cc.workspaceID, ID: l2ID})
	if err != nil || l2.CockpitID != board.ID {
		writeError(w, http.StatusBadRequest, "module row no longer exists on this board")
		return
	}
	code, err := service.ReadCockpitNextNodeCode(ctx, qtx, cc.workspaceID, l2.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to allocate a code")
		return
	}
	// A code is spent the moment it is handed out (migration 948): the ledger
	// row and the node land together, so a deleted row never frees its number.
	if spent, err := qtx.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID, Code: code}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to record the code")
		return
	} else if spent == 0 {
		writeError(w, http.StatusConflict, "this code has been used before and stays spent")
		return
	}
	position, err := cockpitWorkItemPosition(ctx, qtx, cc.workspaceID, l2.ID, afterID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "after_id does not name a work item of this module")
		return
	}
	// The row binds neither project nor module: both come from the module row
	// it hangs from, and a project-only binding here would collide with the L1
	// row that owns that project (cockpit_node_project_binding_unique).
	node, err := qtx.CreateCockpitNode(ctx, db.CreateCockpitNodeParams{
		WorkspaceID: cc.workspaceID, CockpitID: board.ID, ParentID: l2.ID,
		Code: code, Name: name, Position: position,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a row with this code already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create work item")
		return
	}
	// The directory name is the row's address plus its title, the shape the
	// reconcile writes; S7 creates the folder from it.
	if err := qtx.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{
		WorkspaceID: cc.workspaceID, ID: node.ID, DirectoryName: code + name,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set the directory name")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create work item")
		return
	}
	resp := cockpitNodeToResponse(node)
	h.publishCockpit(r, cc, "node", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

// cockpitWorkItemPosition places a new row after the named sibling, or at the
// end. The name must belong to the same parent — a stale id from another
// module would otherwise silently append instead of reordering.
func cockpitWorkItemPosition(ctx context.Context, q *db.Queries, workspaceID, parentID, afterID pgtype.UUID) (float64, error) {
	children, err := q.ListCockpitDirectChildren(ctx, db.ListCockpitDirectChildrenParams{WorkspaceID: workspaceID, ParentID: parentID})
	if err != nil {
		return 0, err
	}
	if len(children) == 0 {
		return 0, nil
	}
	max := children[len(children)-1].Position
	if !afterID.Valid {
		return max + 1, nil
	}
	for _, child := range children {
		if child.ID == afterID {
			return child.Position + 0.5, nil
		}
	}
	return 0, fmt.Errorf("after_id %s is not a child of %s", uuidToString(afterID), uuidToString(parentID))
}

// RenumberCockpitChildren rewrites the children's codes to the order they are
// shown in. Codes are unique per board, so the write is two-phase: every row
// that changes takes a temporary code first, then its final one, otherwise a
// swap collides with the unique index. The first child keeps a "…00" code —
// the governance row that occupies no number in the parent's sequence.
func (h *Handler) RenumberCockpitChildren(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to renumber")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)
	if _, err := qtx.LockCockpitForWorkspaceChanges(ctx, cc.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock the plan board")
		return
	}
	children, err := qtx.ListCockpitDirectChildren(ctx, db.ListCockpitDirectChildrenParams{WorkspaceID: cc.workspaceID, ParentID: node.ID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the children")
		return
	}
	type change struct {
		id       pgtype.UUID
		from, to string
	}
	changes := make([]change, 0, len(children))
	ordinal := 0
	for _, child := range children {
		ordinal++
		code := fmt.Sprintf("%s.%02d", node.Code, ordinal)
		if ordinal == 1 && strings.HasSuffix(child.Code, ".00") {
			// The zero-segment row keeps its published code and the siblings
			// after it number from 01, as the display layer has always shown.
			code = child.Code
			ordinal = 0
		}
		if code != child.Code {
			changes = append(changes, change{id: child.ID, from: child.Code, to: code})
		}
	}
	for _, c := range changes {
		if err := setCockpitNodeCode(ctx, qtx, cc.workspaceID, c.id, "~"+uuidToString(c.id), c.from); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to renumber")
			return
		}
	}
	for _, c := range changes {
		if err := setCockpitNodeCode(ctx, qtx, cc.workspaceID, c.id, c.to, c.from); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to renumber")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to renumber")
		return
	}
	h.publishCockpit(r, cc, "node", "renumbered", map[string]any{"id": uuidToString(node.ID), "changed": len(changes)})
	writeJSON(w, http.StatusOK, map[string]any{"id": uuidToString(node.ID), "changed": len(changes)})
}

// setCockpitNodeCode moves one row to a new code, leaving everything else as
// it is (the two-phase write needs a code-only update).
func setCockpitNodeCode(ctx context.Context, q *db.Queries, workspaceID, id pgtype.UUID, code, previous string) error {
	err := q.SetCockpitNodeCode(ctx, db.SetCockpitNodeCodeParams{
		WorkspaceID: workspaceID,
		ID:          id,
		Code:        code,
	})
	if err == nil {
		return nil
	}
	return fmt.Errorf("set code of %s (%s → %s): %w", uuidToString(id), previous, code, err)
}
