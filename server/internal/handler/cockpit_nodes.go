package handler

import (
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitNodeRequest struct {
	ParentID        *string         `json:"parent_id"`
	ProjectID       *string         `json:"project_id"`
	ModuleID        *string         `json:"module_id"`
	Code            *string         `json:"code"`
	Name            *string         `json:"name"`
	Position        *float64        `json:"position"`
	Color           *string         `json:"color"`
	Owner           *string         `json:"owner"`
	Collaborators   *string         `json:"collaborators"`
	StartDate       *string         `json:"start_date"`
	EndDate         *string         `json:"end_date"`
	Status          *string         `json:"status"`
	Progress        *float64        `json:"progress"`
	Deliverable     *string         `json:"deliverable"`
	Dependencies    *string         `json:"dependencies"`
	Note            *string         `json:"note"`
	CurrentProgress *string         `json:"current_progress"`
	Vendor          *string         `json:"vendor"`
	BudgetCategory  *string         `json:"budget_category"`
	BudgetAmount    *pgtype.Numeric `json:"budget_amount"`
	ExecStatus      *string         `json:"exec_status"`
	Contract        *string         `json:"contract"`
	Source          *string         `json:"source"`
}

// progressOrError validates the 0-100 range shared by create and update. A
// progress outside it would pass the column CHECK only by luck of rounding.
func progressOrError(w http.ResponseWriter, v *float64) (float64, bool) {
	if v == nil {
		return 0, true
	}
	if math.IsNaN(*v) || *v < 0 || *v > 100 {
		writeError(w, http.StatusBadRequest, "progress must be between 0 and 100")
		return 0, false
	}
	return *v, true
}

// resolveCockpitParent validates a requested parent: it must belong to this
// board, and it must not be the node being edited (a node cannot parent
// itself, and a one-node cycle is the only cycle a single write can create).
func (h *Handler) resolveCockpitParent(w http.ResponseWriter, r *http.Request, cc cockpitContext, parentID string, self pgtype.UUID) (db.CockpitNode, bool) {
	id, ok := parseUUIDOrBadRequest(w, parentID, "parent_id")
	if !ok {
		return db.CockpitNode{}, false
	}
	if self.Valid && id == self {
		writeError(w, http.StatusBadRequest, "a node cannot be its own parent")
		return db.CockpitNode{}, false
	}
	parent, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "parent node not found")
		return db.CockpitNode{}, false
	}
	if parent.CockpitID != cc.cockpit.ID {
		writeError(w, http.StatusBadRequest, "parent node belongs to another cockpit")
		return db.CockpitNode{}, false
	}
	return parent, true
}

// GetCockpitNextNodeCode answers what code the next execution task under a
// direction would wear. Codes are handed out once (migration 948), so the
// answer steps past every number the board has ever used — deleted rows
// included. The preview reserves nothing: keyed auto_code creates allocate
// their final number under the board lock. Legacy manual codes remain valid.
func (h *Handler) GetCockpitNextNodeCode(w http.ResponseWriter, r *http.Request) {
	p, ok := h.cockpitSurfaceQuery(w, r)
	if !ok {
		return
	}
	var parent pgtype.UUID
	if value := r.URL.Query().Get("parent_id"); value != "" {
		parent, ok = parseUUIDOrBadRequest(w, value, "parent_id")
		if !ok {
			return
		}
	}
	out, err := h.IssueService.GetCockpitNodeCodePreview(r.Context(), p, parent)
	if !writeCockpitSurfaceError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) CreateCockpitNode(w http.ResponseWriter, r *http.Request) {
	var req CockpitNodeCreateRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	cc, command, ok := h.prepareCockpitCreation(w, r, "node", req.CreationKey, raw)
	if !ok {
		return
	}

	binding, ok := parseCockpitNodeBinding(w, req.ProjectID, req.ModuleID, raw)
	if !ok {
		return
	}

	code := textOrEmpty(req.Code)
	autoCode := req.AutoCode != nil && *req.AutoCode
	_, codeSupplied := raw["code"]
	if autoCode && (!command.Key.Valid || codeSupplied) {
		writeError(w, http.StatusBadRequest, "auto_code requires creation_key and an omitted code")
		return
	}
	if !autoCode && (code == "" || len([]rune(code)) > 64) {
		writeError(w, http.StatusBadRequest, "code must be 1-64 characters")
		return
	}

	var parentID pgtype.UUID
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		parentID, ok = parseUUIDOrBadRequest(w, strings.TrimSpace(*req.ParentID), "parent_id")
		if !ok {
			return
		}
	}

	startDate, _, ok := cockpitDate(w, raw, "start_date", req.StartDate)
	if !ok {
		return
	}
	endDate, _, ok := cockpitDate(w, raw, "end_date", req.EndDate)
	if !ok {
		return
	}
	progress, ok := progressOrError(w, req.Progress)
	if !ok {
		return
	}

	// The node and its used-code ledger row land together (migration 948):
	// a code is spent the moment it is handed out, and the moment it stops
	// being revocable is when the node exists. The ledger write doubles as
	// the spent-code gate — zero rows inserted means the code was handed out
	// before, and a spent code never comes back, even after its row was
	// deleted. Imports are the one exception (see runCockpitImport): a
	// restored snapshot replays its own codes.
	tx, qtx, board, replay, err := h.beginCockpitCreation(r.Context(), cc.workspaceID, pgtype.UUID{}, command)
	if err != nil {
		writeCockpitCreationError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if replay != nil {
		writeJSON(w, http.StatusOK, replay)
		return
	}
	cc.cockpit = board
	if parentID.Valid {
		parent, e := qtx.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{ID: parentID, WorkspaceID: cc.workspaceID})
		if e != nil || parent.CockpitID != cc.cockpit.ID {
			writeError(w, http.StatusBadRequest, "parent node no longer exists on this board")
			return
		}
	}
	// S3: on a reconciled board the generic create may only do what creating a
	// work item does — a row under a module row, binding nothing. Anything else
	// (a fourth level, an unbound root, a row that binds a project) would break
	// I1/I2 from a path the skill no longer teaches. "Binding nothing" means by
	// VALUE: the installed frontend sends project_id/module_id as null, which
	// must stay accepted for the one-release compatibility window (§7).
	if cc.cockpit.PlanReconciledAt.Valid {
		parentRow, isModuleParent, e := loadModuleRow(r.Context(), qtx, cc.workspaceID, parentID)
		if e != nil {
			writeError(w, http.StatusInternalServerError, "failed to read the parent row")
			return
		}
		if !isModuleParent || binding.project.Valid || binding.module.Valid {
			writeError(w, http.StatusBadRequest, "a reconciled board only accepts work items here: use work-item create, or the module/project endpoints for structure")
			return
		}
		// A hand-written code must be the parent's code plus a two-digit tail
		// (§2.5: numbers are allocated by the parent); the frontend's
		// next-code preview already fits that shape.
		if !autoCode && code != "" {
			want := regexp.MustCompile(`^` + regexp.QuoteMeta(parentRow.Code) + `\.[0-9]{2}$`)
			if !want.MatchString(code) {
				writeError(w, http.StatusBadRequest, "code must be the parent's code plus a two-digit tail (e.g. "+parentRow.Code+".11) on a reconciled board")
				return
			}
		}
	}
	projectID, moduleID, bindErr := resolveCockpitNodeBinding(r.Context(), qtx, cc.workspaceID, db.CockpitNode{}, binding)
	if bindErr != nil {
		writeError(w, bindErr.status, bindErr.msg)
		return
	}
	if existing, e := qtx.GetCockpitNodeBindingConflict(r.Context(), db.GetCockpitNodeBindingConflictParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, ProjectID: projectID, ModuleID: moduleID}); e == nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "this project or module already has a plan item", "code": "node_binding_exists", "workspace_id": uuidToString(cc.workspaceID), "creation_key": uuidToString(command.Key), "existing_node_id": uuidToString(existing)})
		return
	} else if !errors.Is(e, pgx.ErrNoRows) {
		writeError(w, 500, "failed to check existing plan binding")
		return
	}
	if autoCode {
		code, err = service.ReadCockpitNextNodeCode(r.Context(), qtx, cc.workspaceID, parentID)
		if err != nil {
			writeCockpitSurfaceError(w, r, err)
			return
		}
	}
	position := floatOrZero(req.Position)
	if req.Position == nil {
		maximum, e := qtx.GetCockpitSiblingMaximumPosition(r.Context(), db.GetCockpitSiblingMaximumPositionParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, ParentID: parentID})
		if e != nil {
			writeError(w, http.StatusInternalServerError, "failed to read sibling order")
			return
		}
		position = maximum + 1
		if position <= maximum {
			position = math.Nextafter(maximum, math.Inf(1))
		}
		if math.IsNaN(position) || math.IsInf(position, 0) {
			writeError(w, http.StatusConflict, "sibling order needs to be reset before appending a node")
			return
		}
	}

	spent, err := qtx.RecordCockpitUsedCode(r.Context(), db.RecordCockpitUsedCodeParams{
		WorkspaceID: cc.workspaceID,
		CockpitID:   cc.cockpit.ID,
		Code:        code,
	})
	if err != nil {
		slog.Warn("RecordCockpitUsedCode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create cockpit node")
		return
	}
	if spent == 0 {
		writeError(w, http.StatusConflict, "this code has been used before and stays spent")
		return
	}
	actorType, _ := h.cockpitActor(r, cc)
	node, err := qtx.CreateCockpitNode(r.Context(), db.CreateCockpitNodeParams{
		WorkspaceID:     cc.workspaceID,
		CockpitID:       cc.cockpit.ID,
		ParentID:        parentID,
		ProjectID:       projectID,
		ModuleID:        moduleID,
		Code:            code,
		Name:            textOrEmpty(req.Name),
		Position:        position,
		Color:           textOrEmpty(req.Color),
		Owner:           textOrEmpty(req.Owner),
		Collaborators:   textOrEmpty(req.Collaborators),
		StartDate:       startDate,
		EndDate:         endDate,
		Status:          textOrEmpty(req.Status),
		Progress:        progress,
		Deliverable:     textOrEmpty(req.Deliverable),
		Dependencies:    textOrEmpty(req.Dependencies),
		Note:            textOrEmpty(req.Note),
		CurrentProgress: textOrEmpty(req.CurrentProgress),
		Vendor:          textOrEmpty(req.Vendor),
		BudgetCategory:  textOrEmpty(req.BudgetCategory),
		BudgetAmount:    numericPtrValue(req.BudgetAmount),
		ExecStatus:      textOrEmpty(req.ExecStatus),
		Contract:        textOrEmpty(req.Contract),
		Source:          textOrEmpty(req.Source),
		UpdatedByType:   actorType,
		UpdatedByID:     cc.member.UserID,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a node with this code or project/module binding already exists")
			return
		}
		if writeCockpitPrimaryIntegrityError(w, err) {
			return
		}
		slog.Warn("CreateCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create cockpit node")
		return
	}
	if err := checkCockpitBindingTree(r.Context(), qtx, cc.cockpit.ID); err != nil {
		writeError(w, err.status, err.msg)
		return
	}
	resp := CockpitNodeCreateResponse{CockpitNodeResponse: cockpitNodeToResponse(node), WorkspaceID: uuidToString(cc.workspaceID)}
	if command != nil {
		resp.CreationKey = uuidToString(command.Key)
	}
	if err := saveCockpitCreationReceipt(r.Context(), qtx, command, node.ID, resp); err != nil {
		writeCockpitCreationError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Warn("CreateCockpitNode commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create cockpit node")
		return
	}

	h.publishCockpit(r, cc, "node", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateCockpitNode(w http.ResponseWriter, r *http.Request) {
	// Direct plan edits are a human prerogative: an agent that sees the board
	// drift files a proposal (POST /api/cockpit/changes) and a person applies
	// it after review. A machine credential that could PATCH nodes directly
	// would bypass the governance queue entirely.
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "direct plan edits require a human actor; propose the change via POST /api/cockpit/changes so it can be reviewed")
		return
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	current, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	var req CockpitNodeRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	syncMode, ok := parseDirectorySyncMode(raw)
	if !ok {
		writeError(w, http.StatusBadRequest, "directory_sync must be sync, defer or force")
		return
	}

	binding, ok := parseCockpitNodeBinding(w, req.ProjectID, req.ModuleID, raw)
	if !ok {
		return
	}
	// S3: on a reconciled board the bindings are the structure. A node's
	// project/module come from the row it hangs from, so editing them here
	// would let a caller reshape the tree around I1/I2.
	if cc.cockpit.PlanReconciledAt.Valid && (binding.projectSet || binding.moduleSet) {
		writeError(w, http.StatusBadRequest, "bindings are set by the module and project endpoints; use work-item create or the module/project APIs")
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update cockpit node")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := lockCockpitBindings(r.Context(), qtx, cc.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock cockpit bindings")
		return
	}
	current, err = qtx.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{ID: current.ID, WorkspaceID: cc.workspaceID})
	if err != nil {
		writeError(w, http.StatusNotFound, "node no longer exists")
		return
	}
	projectID, moduleID, bindErr := resolveCockpitNodeBinding(r.Context(), qtx, cc.workspaceID, current, binding)
	if bindErr != nil {
		writeError(w, bindErr.status, bindErr.msg)
		return
	}

	actorType, _ := h.cockpitActor(r, cc)
	params := db.UpdateCockpitNodeParams{
		ID:              current.ID,
		WorkspaceID:     cc.workspaceID,
		ProjectID:       projectID,
		ModuleID:        moduleID,
		ClearProject:    !projectID.Valid,
		ClearModule:     !moduleID.Valid,
		Code:            optionalText(req.Code),
		Name:            optionalText(req.Name),
		Position:        optionalFloat(req.Position),
		Color:           optionalText(req.Color),
		Owner:           optionalText(req.Owner),
		Collaborators:   optionalText(req.Collaborators),
		Status:          optionalText(req.Status),
		Deliverable:     optionalText(req.Deliverable),
		Dependencies:    optionalText(req.Dependencies),
		Note:            optionalText(req.Note),
		CurrentProgress: optionalText(req.CurrentProgress),
		Vendor:          optionalText(req.Vendor),
		BudgetCategory:  optionalText(req.BudgetCategory),
		ExecStatus:      optionalText(req.ExecStatus),
		Contract:        optionalText(req.Contract),
		Source:          optionalText(req.Source),
		UpdatedByType:   actorType,
		UpdatedByID:     cc.member.UserID,
	}

	parentTouched := false
	if _, touched := raw["parent_id"]; touched {
		parentTouched = true
		if req.ParentID == nil || strings.TrimSpace(*req.ParentID) == "" {
			params.ClearParent = true
		} else {
			parent, ok := h.resolveCockpitParent(w, r, cc, *req.ParentID, current.ID)
			if !ok {
				return
			}
			params.ParentID = parent.ID
		}
	}

	if req.Progress != nil {
		progress, ok := progressOrError(w, req.Progress)
		if !ok {
			return
		}
		params.Progress = pgtype.Float8{Float64: progress, Valid: true}
	}

	startDate, clearStart, ok := cockpitDate(w, raw, "start_date", req.StartDate)
	if !ok {
		return
	}
	params.StartDate, params.ClearStartDate = startDate, clearStart

	endDate, clearEnd, ok := cockpitDate(w, raw, "end_date", req.EndDate)
	if !ok {
		return
	}
	params.EndDate, params.ClearEndDate = endDate, clearEnd

	if _, touched := raw["budget_amount"]; touched {
		if req.BudgetAmount == nil {
			params.ClearBudgetAmount = true
		} else {
			params.BudgetAmount = *req.BudgetAmount
		}
	}

	if req.Code != nil {
		code := strings.TrimSpace(*req.Code)
		if code == "" || len([]rune(code)) > 64 {
			writeError(w, http.StatusBadRequest, "code must be 1-64 characters")
			return
		}
		if cc.cockpit.PlanReconciledAt.Valid && code != current.Code {
			// §2.5: a number is fixed once allocated. It changes through a
			// cross-module move or an explicit renumber, never a direct edit —
			// a hand-edited code would break the prefix invariants the
			// reconcile fixed (S2 rehearsed them at zero).
			writeError(w, http.StatusBadRequest, "codes are fixed on a reconciled board; renumber the parent or move the work item instead")
			return
		}
		params.Code = pgtype.Text{String: code, Valid: true}
	}

	// The board lock serializes reparenting, binding edits and replacement.
	// Code allocation remains atomic with the row update.
	if req.Code != nil && strings.TrimSpace(*req.Code) != current.Code {
		spent, err := qtx.RecordCockpitUsedCode(r.Context(), db.RecordCockpitUsedCodeParams{
			WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID, Code: strings.TrimSpace(*req.Code),
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to record node code")
			return
		}
		if spent == 0 {
			writeError(w, http.StatusConflict, "this code has been used before and stays spent")
			return
		}
	}
	// Crossing modules takes the destination's next number; the old one stays
	// spent (§0 item 19). The number is allocated BEFORE the row moves, so the
	// allocation cannot count the moving row itself as a child of the target.
	if parentTouched && params.ParentID.Valid && params.ParentID != current.ParentID {
		code, err := movedWorkItemCode(r.Context(), qtx, cc, params.ParentID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to renumber the moved work item")
			return
		}
		if code != "" {
			params.Code = pgtype.Text{String: code, Valid: true}
		}
	}
	// A work item's folder is its address plus its title: renaming the row or
	// moving it to another module renames the folder. The check runs before
	// the write, so a refused edit changes nothing.
	beforePD, _ := h.loadPlanDirectory(r.Context(), qtx, cc.workspaceID, current)
	willChangeFolder := cc.cockpit.PlanReconciledAt.Valid && beforePD.kind == "work_item" &&
		((req.Name != nil && strings.TrimSpace(*req.Name) != current.Name) || (parentTouched && params.ParentID != current.ParentID))
	// Only a project with a collaboration space has a folder to disturb; a
	// plan-only board must not refuse a rename because an agent runs elsewhere.
	hasCollab := beforePD.project.CollabPath.Valid && strings.TrimSpace(beforePD.project.CollabPath.String) != ""
	if willChangeFolder && hasCollab && syncMode == DirectorySyncSync {
		tasks, err := qtx.ListRunningAgentTasksForWorkItems(r.Context(), db.ListRunningAgentTasksForWorkItemsParams{
			WorkspaceID: cc.workspaceID, WorkItemIds: []pgtype.UUID{current.ID},
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check running tasks")
			return
		}
		if len(tasks) > 0 {
			rows := make([]runningTask, 0, len(tasks))
			for _, task := range tasks {
				rows = append(rows, runningTask{task.TaskID, task.IssueID, task.IssueNumber, task.Status})
			}
			h.writeRunningTaskConflict(w, r.Context(), cc.workspaceID, rows)
			return
		}
	}

	node, err := qtx.UpdateCockpitNode(r.Context(), params)
	if err != nil {
		if writeCockpitPrimaryIntegrityError(w, err) {
			return
		}
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a node with this code or project/module binding already exists")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update cockpit node")
		return
	}
	if parentTouched || binding.projectSet || binding.moduleSet {
		if err := checkCockpitBindingTree(r.Context(), qtx, cc.cockpit.ID); err != nil {
			writeError(w, err.status, err.msg)
			return
		}
	}
	// A work item that moved takes its issues' filing scope with it (I3): the
	// module and project come from the tree, so they are rewritten in the same
	// transaction. Crossing projects maps the status the same way the issue
	// detail path does (S3).
	var refiled []db.MoveFilingScopeRow
	statusChanged := 0
	if parentTouched {
		// Only a work item may be reparented, and only under a module row: a
		// project row or module row moving would break I1/I2, and a work item
		// under anything but L2 loses its scope.
		if err := h.requireWorkItemMove(r.Context(), qtx, cc, current, node); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		// Only a reconciled board has work items with filing to carry; on a
		// legacy board the rows are still the pre-S3 grouping.
		if cc.cockpit.PlanReconciledAt.Valid {
			refiled, statusChanged, err = h.IssueService.RefileWorkItemScope(r.Context(), qtx, cc.workspaceID, node.ID)
		}
		if err != nil {
			h.writeWorkItemMoveError(w, r, cc, err)
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update cockpit node")
		return
	}

	resp := cockpitNodeToResponse(node)
	// A move reports what it carried: how many issues changed scope and how
	// many needed their status mapped, so the CLI can say so (S3).
	resp.RefiledIssues = len(refiled)
	resp.StatusMapped = statusChanged
	if willChangeFolder && syncMode != DirectorySyncDefer {
		if afterPD, err := h.loadPlanDirectory(r.Context(), h.Queries, cc.workspaceID, node); err == nil {
			result := h.applyPlanDirectory(r.Context(), h.Queries, cc.workspaceID, afterPD, beforePD.segments, syncMode == DirectorySyncForce)
			resp.DirectorySync = &result
			if result.Status == "renamed" || result.Status == "created" {
				resp.DirectoryName = &result.DirectoryName
			}
		}
	}
	h.publishCockpit(r, cc, "node", "updated", resp)
	for _, row := range refiled {
		h.publishRefiledWorkItemIssue(r, cc, row)
	}
	writeJSON(w, http.StatusOK, resp)
}

// DeleteCockpitNode removes a leaf. A branch with children is refused rather
// than cascaded: the tree carries the programme's structure, and silently
// deleting a module's whole subtree on one mis-clicked row is not a recovery
// anyone has.
func (h *Handler) DeleteCockpitNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	// S3: a reconciled board deletes structure through the module/project
	// endpoints (they remove the whole subtree). Deleting an L1/L2 row here
	// would leave its children behind and the next read would recreate the
	// skeleton row (I1).
	if cc.cockpit.PlanReconciledAt.Valid {
		if _, isModuleRow, err := loadModuleRow(r.Context(), h.Queries, cc.workspaceID, node.ParentID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read the plan row")
			return
		} else if !isModuleRow {
			writeError(w, http.StatusBadRequest, "delete the module or project instead: structural rows are removed with it")
			return
		}
	}
	// S3 §0 item 20: a machine credential may only delete a work item that
	// files nothing — anything else is a human decision (or a proposal).
	if isMachineCredentialActor(r) {
		filed, err := h.Queries.ListIssueIDsFiledAtNode(r.Context(), db.ListIssueIDsFiledAtNodeParams{WorkspaceID: cc.workspaceID, WorkItemID: node.ID})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check the work item's issues")
			return
		}
		if len(filed) > 0 {
			writeError(w, http.StatusForbidden, "this work item still files issues; a human must delete it or propose the change")
			return
		}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if err := lockCockpitBindings(r.Context(), qtx, cc.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock cockpit bindings")
		return
	}
	children, err := qtx.ListCockpitNodeChildIDs(r.Context(), db.ListCockpitNodeChildIDsParams{
		CockpitID: cc.cockpit.ID,
		ParentID:  node.ID,
	})
	if err != nil {
		slog.Warn("ListCockpitNodeChildIDs failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if len(children) > 0 {
		writeError(w, http.StatusConflict, "this node still has children; delete or reparent them first")
		return
	}

	// No cascading deletes in the schema (repository rule), so the node's own
	// instalments and issue links are cleared here, in the same request, before
	// the row they belong to disappears.
	ctx := r.Context()
	if err := qtx.DeleteCockpitPaymentsByNode(ctx, db.DeleteCockpitPaymentsByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitPaymentsByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	// Issues filed at a work item lose their filing with it (S3): the row is
	// the last thing to disappear, so the issue side is cleared first.
	unfiled, unfilErr := qtx.ClearIssuesFiledAtNode(ctx, db.ClearIssuesFiledAtNodeParams{
		WorkspaceID: cc.workspaceID,
		WorkItemID:  node.ID,
	})
	if unfilErr != nil {
		slog.Warn("ClearIssuesFiledAtNode failed", append(logger.RequestAttrs(r), "error", unfilErr)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := qtx.DeleteCockpitMilestonesByNode(ctx, db.DeleteCockpitMilestonesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMilestonesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := qtx.DeleteCockpitNodeIssuesByNode(ctx, db.DeleteCockpitNodeIssuesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNodeIssuesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := qtx.DeleteCockpitMeetingNodesByNode(ctx, db.DeleteCockpitMeetingNodesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNodesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if _, err := qtx.SystemWithdrawCockpitPendingChangesByNode(ctx, db.SystemWithdrawCockpitPendingChangesByNodeParams{
		NodeID:       node.ID,
		WorkspaceID:  cc.workspaceID,
		DecisionNote: "node deleted",
	}); err != nil {
		slog.Warn("SystemWithdrawCockpitPendingChangesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := qtx.DeleteCockpitNode(ctx, db.DeleteCockpitNodeParams{
		ID:          node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		if writeCockpitPrimaryIntegrityError(w, err) {
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	h.publishCockpit(r, cc, "node", "deleted", map[string]any{"id": uuidToString(node.ID)})
	for _, row := range unfiled {
		h.publish(h.workItemChangedEvent(cc, row.ID, row.Number, row.Status, row.Revision, row.ProjectID, row.ModuleID, pgtype.UUID{}))
	}
	// Pending proposals against the node were system-withdrawn in the same
	// transaction; open queues refresh on the same event.
	h.publishCockpit(r, cc, "changes", "withdrawn", nil)
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------

type CockpitNodeIssuesRequest struct {
	// Issue identifiers, each either a UUID or a human-readable number
	// ("BIO-314") — the board's own vocabulary for the same thing.
	IssueIDs []string `json:"issue_ids"`
	// Replace swaps the node's whole link set for IssueIDs. The default adds to
	// it, which is what a picker does; replace is what a bulk import does.
	Replace bool `json:"replace"`
}

// SetCockpitNodeIssues links issues to a node. Multi-select is the point: the
// source board carried one free-text "BIO-176（待确认）" per task, which could
// neither be searched nor resolved to a live issue.
func (h *Handler) SetCockpitNodeIssues(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	var req CockpitNodeIssuesRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if len(req.IssueIDs) > 200 {
		writeError(w, http.StatusBadRequest, "at most 200 issues can be linked in one request")
		return
	}

	ctx := r.Context()
	resolved := make([]pgtype.UUID, 0, len(req.IssueIDs))
	for _, raw := range req.IssueIDs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		// Resolved through a loader before any write sees it: the identifier
		// may be "BIO-314", and only issue.ID is ever stored.
		issue, found := h.resolveCockpitIssue(ctx, raw, uuidToString(cc.workspaceID))
		if !found {
			writeError(w, http.StatusBadRequest, "issue not found: "+raw)
			return
		}
		resolved = append(resolved, issue.ID)
	}

	if req.Replace {
		if err := h.Queries.DeleteCockpitNodeIssuesByNode(ctx, db.DeleteCockpitNodeIssuesByNodeParams{
			NodeID:      node.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitNodeIssuesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}

	for i, issueID := range resolved {
		if !req.Replace {
			if _, err := h.appendCockpitNodeIssue(ctx, cc, node.ID, issueID); writeCockpitReferenceError(w, err) {
				return
			}
			continue
		}
		if _, err := h.Queries.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{
			WorkspaceID: cc.workspaceID,
			NodeID:      node.ID,
			IssueID:     issueID,
			Position:    float64(i),
		}); err != nil {
			slog.Warn("CreateCockpitNodeIssue failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}

	links, err := h.Queries.ListCockpitNodeIssues(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitNodeIssues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to link issues")
		return
	}
	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	nodeLinks := make([]CockpitNodeIssueResponse, 0, len(resolved))
	for _, l := range links {
		if l.NodeID != node.ID {
			continue
		}
		nodeLinks = append(nodeLinks, cockpitLinkToResponse(l, prefix))
	}

	payload := map[string]any{"node_id": uuidToString(node.ID), "links": nodeLinks}
	h.publishCockpit(r, cc, "issue_links", "replaced", payload)
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) DeleteCockpitNodeIssue(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	issue, found := h.resolveCockpitIssue(r.Context(), chi.URLParam(r, "issueId"), uuidToString(cc.workspaceID))
	if !found {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}

	if err := h.Queries.DeleteCockpitNodeIssue(r.Context(), db.DeleteCockpitNodeIssueParams{
		NodeID:      node.ID,
		IssueID:     issue.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNodeIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink issue")
		return
	}

	h.publishCockpit(r, cc, "issue_links", "removed", map[string]any{
		"node_id":  uuidToString(node.ID),
		"issue_id": uuidToString(issue.ID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
