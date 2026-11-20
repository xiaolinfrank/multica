package handler

import (
	"context"
	"fmt"
	"net/http"
	"sort"
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
	ModuleID    string  `json:"module_id"`
	Name        string  `json:"name"`
	AfterID     *string `json:"after_id"`
	CreationKey *string `json:"creation_key"`
}

// CreateCockpitWorkItem writes a work item under a module's plan row. A machine
// credential may call it (§0 item 20) and may pass creation_key, so a retried
// agent run reuses the row it already created instead of minting a second one.
func (h *Handler) CreateCockpitWorkItem(w http.ResponseWriter, r *http.Request) {
	var req CockpitWorkItemCreateRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	// resource_kind stays "node": a work item IS a node row, and the intent
	// table's CHECK only allows node/meeting (migration 992). The request hash
	// still separates a retry from a different body under the same key.
	cc, command, ok := h.prepareCockpitCreation(w, r, "node", req.CreationKey, req)
	if !ok {
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
	tx, qtx, board, replay, err := h.beginCockpitCreation(ctx, cc.workspaceID, pgtype.UUID{}, command)
	if err != nil {
		writeCockpitCreationError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	if replay != nil {
		writeJSON(w, http.StatusOK, replay)
		return
	}
	cc.cockpit = board
	// S3 §11.2: before the plan is reconciled its codes are still provisional,
	// so structure writes wait for the reconcile.
	if err := requireReconciledPlan(board); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	// The module's L2 row: the only place a work item can hang from. This is
	// GetCockpitNodeBindingConflict by name, but here the "conflict" IS the row
	// the module already binds.
	l2ID, err := qtx.GetCockpitNodeBindingConflict(ctx, db.GetCockpitNodeBindingConflictParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID, ModuleID: moduleID})
	if err != nil {
		writeError(w, http.StatusBadRequest, "module has no row on the plan board yet")
		return
	}
	code, err := nextWorkItemCode(ctx, qtx, cc.workspaceID, board.ID, l2ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to allocate a code")
		return
	}
	position, err := cockpitWorkItemPosition(ctx, qtx, cc.workspaceID, l2ID, afterID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "after_id does not name a work item of this module")
		return
	}
	// The row binds neither project nor module: both come from the module row
	// it hangs from, and a project-only binding here would collide with the L1
	// row that owns that project (cockpit_node_project_binding_unique).
	node, err := qtx.CreateCockpitNode(ctx, db.CreateCockpitNodeParams{
		WorkspaceID: cc.workspaceID, CockpitID: board.ID, ParentID: l2ID,
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
	resp := CockpitNodeCreateResponse{CockpitNodeResponse: cockpitNodeToResponse(node), WorkspaceID: uuidToString(cc.workspaceID)}
	if command != nil {
		resp.CreationKey = uuidToString(command.Key)
	}
	if err := saveCockpitCreationReceipt(ctx, qtx, command, node.ID, resp); err != nil {
		writeCockpitCreationError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create work item")
		return
	}
	h.publishCockpit(r, cc, "node", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

// nextWorkItemCode allocates the code and records it as spent in one step: a
// code is spent the moment it is handed out (migration 948).
func nextWorkItemCode(ctx context.Context, q *db.Queries, workspaceID, cockpitID, parentID pgtype.UUID) (string, error) {
	code, err := service.ReadCockpitNextNodeCode(ctx, q, workspaceID, parentID)
	if err != nil {
		return "", err
	}
	if _, err := q.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{WorkspaceID: workspaceID, CockpitID: cockpitID, Code: code}); err != nil {
		return "", err
	}
	return code, nil
}

// cockpitWorkItemPosition places a new row in the gap after the named sibling:
// the midpoint between it and the next row, so inserting twice after the same
// row yields two distinct positions. With no sibling named, or the last one
// named, the row appends at the end.
func cockpitWorkItemPosition(ctx context.Context, q *db.Queries, workspaceID, parentID, afterID pgtype.UUID) (float64, error) {
	children, err := q.ListCockpitDirectChildren(ctx, db.ListCockpitDirectChildrenParams{WorkspaceID: workspaceID, ParentID: parentID})
	if err != nil {
		return 0, err
	}
	if len(children) == 0 {
		return 0, nil
	}
	if !afterID.Valid {
		return children[len(children)-1].Position + 1, nil
	}
	for i, child := range children {
		if child.ID != afterID {
			continue
		}
		if i == len(children)-1 {
			return child.Position + 1, nil
		}
		if next := children[i+1].Position; next > child.Position {
			return (child.Position + next) / 2, nil
		}
		// Same position (legacy import): step just past it.
		return child.Position + 0.5, nil
	}
	return 0, fmt.Errorf("after_id %s is not a child of %s", uuidToString(afterID), uuidToString(parentID))
}

type cockpitCodeChange struct {
	id   pgtype.UUID
	from string
	to   string
}

// RenumberCockpitChildren rewrites the children's codes to the order they are
// shown in, and rewrites every descendant's prefix with it (a module moving
// from 01.02 to 01.01 takes its work items 01.02.03 → 01.01.03). Codes are
// unique per board, so the write is two-phase: every row that changes takes a
// temporary code first, then its final one. The first child keeps a "…00" code
// — the governance row that occupies no number in the parent's sequence.
func (h *Handler) RenumberCockpitChildren(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	if err := requireReconciledPlan(cc.cockpit); err != nil {
		writeError(w, http.StatusConflict, err.Error())
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
	// The whole board, because a child's renumber carries its subtree: reading
	// only the children would leave the grandchildren's prefixes behind.
	nodes, err := qtx.ListCockpitNodes(ctx, cc.cockpit.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the plan rows")
		return
	}
	byParent := make(map[pgtype.UUID][]db.CockpitNode, len(nodes))
	for _, n := range nodes {
		if n.ParentID.Valid {
			byParent[n.ParentID] = append(byParent[n.ParentID], n)
		}
	}
	for parent := range byParent {
		sort.SliceStable(byParent[parent], func(i, j int) bool {
			a, b := byParent[parent][i], byParent[parent][j]
			if a.Position != b.Position {
				return a.Position < b.Position
			}
			return uuidToString(a.ID) < uuidToString(b.ID)
		})
	}
	// Only the DIRECT children are renumbered to the shown order; a descendant
	// keeps its own tail and only takes the new prefix. Recursing here would
	// renumber a grandchild whose sibling was deleted (01.02.03 → 01.01.02),
	// and the ledger would then spend a number no row uses.
	var changes []cockpitCodeChange
	seen := make(map[pgtype.UUID]bool, len(nodes))
	add := func(c cockpitCodeChange) {
		if seen[c.id] {
			return
		}
		seen[c.id] = true
		changes = append(changes, c)
	}
	ordinal := 0
	for _, child := range byParent[node.ID] {
		ordinal++
		code := fmt.Sprintf("%s.%02d", node.Code, ordinal)
		if ordinal == 1 && strings.HasSuffix(child.Code, ".00") {
			// The zero-segment row keeps its published code and the siblings
			// after it number from 01.
			code = child.Code
			ordinal = 0
		}
		if code == child.Code {
			continue
		}
		add(cockpitCodeChange{id: child.ID, from: child.Code, to: code})
		collectReprefixed(child.ID, child.Code, code, byParent, add)
	}
	for _, c := range changes {
		if err := qtx.SetCockpitNodeCode(ctx, db.SetCockpitNodeCodeParams{WorkspaceID: cc.workspaceID, ID: c.id, Code: "~" + uuidToString(c.id)}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to renumber")
			return
		}
	}
	for _, c := range changes {
		if err := qtx.SetCockpitNodeCode(ctx, db.SetCockpitNodeCodeParams{WorkspaceID: cc.workspaceID, ID: c.id, Code: c.to}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to renumber")
			return
		}
		// New codes go into the ledger; a spent answer is expected here (a
		// reorder reuses numbers this group already owns), so it is ignored.
		if _, err := qtx.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, Code: c.to}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record the code")
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

// collectReprefixed records a change for every descendant whose code starts
// with the child's old code, keeping its own tail. Deduplicated by the caller:
// a row can be reached through one path only, but the map is shared.
func collectReprefixed(id pgtype.UUID, oldCode, newCode string, byParent map[pgtype.UUID][]db.CockpitNode, add func(cockpitCodeChange)) {
	for _, child := range byParent[id] {
		if !strings.HasPrefix(child.Code, oldCode+".") {
			continue
		}
		to := newCode + strings.TrimPrefix(child.Code, oldCode)
		add(cockpitCodeChange{id: child.ID, from: child.Code, to: to})
		collectReprefixed(child.ID, child.Code, to, byParent, add)
	}
}
