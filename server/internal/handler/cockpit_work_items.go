package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/collabfs"
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
	// The folder name is the row's address plus its title, cleaned to one path
	// segment and made unique among its siblings. The folder itself is created
	// after the commit: a NAS that is down must not roll back the row.
	siblings, err := qtx.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the plan rows")
		return
	}
	taken := map[string]bool{}
	for _, sibling := range siblings {
		if sibling.ParentID == l2ID && sibling.DirectoryName.Valid {
			taken[strings.ToLower(sibling.DirectoryName.String)] = true
		}
	}
	directoryName := collabfs.UniqueName(
		collabfs.SanitizeFolderName(code+name, 0),
		func(candidate string) bool { return taken[strings.ToLower(candidate)] },
	)
	if err := qtx.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{
		WorkspaceID: cc.workspaceID, ID: node.ID, DirectoryName: directoryName,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set the directory name")
		return
	}
	node.DirectoryName = pgtype.Text{String: directoryName, Valid: true}
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
	if sync := h.createWorkItemFolder(ctx, h.Queries, cc.workspaceID, moduleID, l2ID, directoryName); sync != nil {
		resp.DirectorySync = sync
	}
	h.publishCockpit(r, cc, "node", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

// createWorkItemFolder makes `<collab>/<module>/<work item>` when the project
// has a collaboration space. Failures are reported, not fatal: the row is
// already saved, and the directory panel offers a retry.
func (h *Handler) createWorkItemFolder(ctx context.Context, q *db.Queries, workspaceID, moduleID, moduleRowID pgtype.UUID, directoryName string) *NodeDirectorySync {
	module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: moduleID, WorkspaceID: workspaceID})
	if err != nil {
		return nil
	}
	moduleRow, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: moduleRowID, WorkspaceID: workspaceID})
	if err != nil {
		return nil
	}
	projectID := moduleRow.ProjectID
	if !projectID.Valid {
		return nil
	}
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID})
	if err != nil || !project.CollabPath.Valid || strings.TrimSpace(project.CollabPath.String) == "" {
		return &NodeDirectorySync{Status: "skipped", Reason: "no_collab_space", DirectoryName: directoryName}
	}
	if module.DirectoryName.String == "" {
		return &NodeDirectorySync{Status: "skipped", Reason: "module_directory_missing", DirectoryName: directoryName}
	}
	if err := collabfs.EnsureDir(strings.TrimSpace(project.CollabPath.String), module.DirectoryName.String, directoryName); err != nil {
		return &NodeDirectorySync{Status: "failed", Reason: "create_failed", Error: err.Error(), DirectoryName: directoryName}
	}
	return &NodeDirectorySync{Status: "created", DirectoryName: directoryName}
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
	syncMode := DirectorySyncSync
	if raw, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20)); len(raw) > 0 {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body")
			return
		}
		mode, ok := parseDirectorySyncMode(fields)
		if !ok {
			writeError(w, http.StatusBadRequest, "directory_sync must be sync, defer or force")
			return
		}
		syncMode = mode
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
	// What each changed row's folder looks like before the codes move. Read
	// from the same snapshot the codes were computed from.
	index, err := h.newDirectoryIndex(ctx, qtx, cc.workspaceID, cc.cockpit.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the plan rows")
		return
	}
	beforeDirs := make(map[string]planDirectory, len(changes))
	for _, change := range changes {
		node, ok := index.nodes[change.id]
		if !ok {
			continue
		}
		pd, err := index.directory(ctx, qtx, cc.workspaceID, node)
		if err != nil || pd.kind == "project" {
			continue
		}
		beforeDirs[uuidToString(change.id)] = pd
	}
	if syncMode == DirectorySyncSync && len(beforeDirs) > 0 {
		var moduleIDs, workItemIDs []pgtype.UUID
		for id, pd := range beforeDirs {
			// The expected name is the one the NEW code calls for: comparing
			// against the old-code name would say "nothing changes" for every
			// row, and the pass would rename folders without asking.
			change := changedCode(id, changes)
			expected := pd.expected
			switch {
			case change != "" && pd.kind == "module" && pd.module != nil:
				expected = collabfs.SanitizeFolderName(change+pd.module.Title, 0)
			case change != "" && pd.kind == "work_item":
				expected = collabfs.SanitizeFolderName(change+pd.node.Name, 0)
			}
			if expected == pd.directoryName {
				continue
			}
			if pd.kind == "module" && pd.module != nil {
				moduleIDs = append(moduleIDs, pd.module.ID)
			}
			if pd.kind == "work_item" {
				workItemIDs = append(workItemIDs, pd.node.ID)
			}
		}
		var tasks []runningTask
		if len(moduleIDs) > 0 {
			found, err := qtx.ListRunningAgentTasksForModules(ctx, db.ListRunningAgentTasksForModulesParams{WorkspaceID: cc.workspaceID, ModuleIds: moduleIDs})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to check running tasks")
				return
			}
			for _, row := range found {
				tasks = append(tasks, runningTask{row.TaskID, row.IssueID, row.IssueNumber, row.Status})
			}
		}
		if len(workItemIDs) > 0 {
			found, err := qtx.ListRunningAgentTasksForWorkItems(ctx, db.ListRunningAgentTasksForWorkItemsParams{WorkspaceID: cc.workspaceID, WorkItemIds: workItemIDs})
			if err != nil {
				writeError(w, http.StatusInternalServerError, "failed to check running tasks")
				return
			}
			for _, row := range found {
				tasks = append(tasks, runningTask{row.TaskID, row.IssueID, row.IssueNumber, row.Status})
			}
		}
		if len(tasks) > 0 {
			h.writeRunningTaskConflict(w, ctx, cc.workspaceID, tasks)
			return
		}
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
	// The folders follow the codes, one at a time and each on its own: one
	// collision must not leave the rest of the group half-renamed.
	results := make([]map[string]any, 0, len(beforeDirs))
	if syncMode != DirectorySyncDefer {
		afterIndex, err := h.newDirectoryIndex(ctx, h.Queries, cc.workspaceID, cc.cockpit.ID)
		if err == nil {
			for _, change := range changes {
				before, ok := beforeDirs[uuidToString(change.id)]
				if !ok {
					continue
				}
				afterNode, ok := afterIndex.nodes[change.id]
				if !ok {
					continue
				}
				after, err := afterIndex.directory(ctx, h.Queries, cc.workspaceID, afterNode)
				if err != nil {
					continue
				}
				result := h.applyPlanDirectory(ctx, h.Queries, cc.workspaceID, after, before.segments, syncMode == DirectorySyncForce)
				results = append(results, map[string]any{
					"node_id":        uuidToString(change.id),
					"code":           change.to,
					"from_directory": before.directoryName,
					"to_directory":   result.DirectoryName,
					"status":         result.Status,
					"error":          result.Error,
					"reason":         result.Reason,
				})
			}
		}
	}
	h.publishCockpit(r, cc, "node", "renumbered", map[string]any{"id": uuidToString(node.ID), "changed": len(changes)})
	writeJSON(w, http.StatusOK, map[string]any{"id": uuidToString(node.ID), "changed": len(changes), "directory_results": results})
}

// changedCode answers the new code for one node id, or "" when it keeps its
// code.
func changedCode(id string, changes []cockpitCodeChange) string {
	for _, change := range changes {
		if uuidToString(change.id) == id {
			return change.to
		}
	}
	return ""
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
