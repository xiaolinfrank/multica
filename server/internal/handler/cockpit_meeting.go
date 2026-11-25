package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/localpaths"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Cockpit meeting register (BayClaw fork).
//
// A meeting on the board is not just a log line: it opens work and it leaves
// material behind. Filing one therefore has three parts, and they are kept as
// three separate outcomes rather than one all-or-nothing write:
//
//  1. the meeting row itself (cockpit.go — an ordinary board row),
//  2. the task it is carried out through: an ordinary Multica issue, filed
//     under the project and module the programme keeps its meetings in,
//  3. the folder its material goes in, under the project's persistent
//     collaboration space.
//
// Only (1) is guaranteed to succeed. Inaccessible storage or a project with no
// collaboration space must not cost someone the record
// of a meeting that happened — so provisioning reports per-part outcomes and
// can be re-run for the part that failed.

// ---------------------------------------------------------------------------
// Destination: which project, which module, which folder
// ---------------------------------------------------------------------------

// meetingRef is one resolved optional UUID field of a partial update: the id
// to write, or an instruction to clear the column.
type meetingRef struct {
	id    pgtype.UUID
	clear bool
}

func (ref meetingRef) effective(stored pgtype.UUID) pgtype.UUID {
	if ref.clear {
		return pgtype.UUID{}
	}
	if ref.id.Valid {
		return ref.id
	}
	return stored
}

// resolveMeetingDestination validates the project/module/sub-item a board
// wants its meetings filed under. Absent fields leave the board's current
// choice alone; an empty string clears it.
//
// The names ("06项目管理与规划", "06.06 多方协同与会议", "06.06.03 会议纪要与
// 素材") are deliberately not in the code. Which project a programme keeps its
// meetings in is a property of that programme, so it is chosen in the
// product, validated here, and remembered on the board.
func (h *Handler) resolveMeetingDestination(
	w http.ResponseWriter,
	r *http.Request,
	cc cockpitContext,
	raw map[string]json.RawMessage,
	projectRef, moduleRef, nodeRef *string,
) (meetingRef, meetingRef, meetingRef, bool) {
	var project, module, node meetingRef

	if _, touched := raw["meeting_project_id"]; touched {
		if projectRef == nil || strings.TrimSpace(*projectRef) == "" {
			project.clear = true
		} else {
			id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*projectRef), "meeting_project_id")
			if !ok {
				return project, module, node, false
			}
			if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
				ID: id, WorkspaceID: cc.workspaceID,
			}); err != nil {
				writeError(w, http.StatusBadRequest, "project not found in this workspace")
				return project, module, node, false
			}
			project.id = id
		}
	}

	if _, touched := raw["meeting_module_id"]; touched {
		if moduleRef == nil || strings.TrimSpace(*moduleRef) == "" {
			module.clear = true
		} else {
			id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*moduleRef), "meeting_module_id")
			if !ok {
				return project, module, node, false
			}
			row, err := h.Queries.GetModuleInWorkspace(r.Context(), db.GetModuleInWorkspaceParams{
				ID: id, WorkspaceID: cc.workspaceID,
			})
			if err != nil {
				writeError(w, http.StatusBadRequest, "module not found in this workspace")
				return project, module, node, false
			}
			// The module names its own project, so the pair is checked against
			// whichever project this request settles on — the one it is
			// setting, or the one already stored.
			target := cc.cockpit.MeetingProjectID
			if project.id.Valid {
				target = project.id
			}
			if project.clear {
				target = pgtype.UUID{}
			}
			if target.Valid && row.ProjectID != target {
				writeError(w, http.StatusBadRequest, "module does not belong to the meeting project")
				return project, module, node, false
			}
			module.id = id
		}
	}

	if _, touched := raw["meeting_node_id"]; touched {
		if nodeRef == nil || strings.TrimSpace(*nodeRef) == "" {
			node.clear = true
		} else {
			id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*nodeRef), "meeting_node_id")
			if !ok {
				return project, module, node, false
			}
			// A node off another board would name a folder this programme
			// does not own, so only this board's tree is accepted. Which
			// module it hangs under is NOT checked: the tree and the
			// project→module hierarchy are two independent shapes over the
			// same programme, and forcing them to agree would reject a
			// legitimate re-organisation of either.
			row, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{
				ID: id, WorkspaceID: cc.workspaceID,
			})
			if err != nil || row.CockpitID != cc.cockpit.ID {
				writeError(w, http.StatusBadRequest, "work item not found on this board")
				return project, module, node, false
			}
			node.id = id
		}
	}

	_, projectTouched := raw["meeting_project_id"]
	_, moduleTouched := raw["meeting_module_id"]
	_, nodeTouched := raw["meeting_node_id"]
	if projectTouched || moduleTouched || nodeTouched {
		resolvedProject, resolvedModule, err := h.reconcileMeetingNodeDestination(
			r.Context(), cc,
			project.effective(cc.cockpit.MeetingProjectID),
			module.effective(cc.cockpit.MeetingModuleID),
			node.effective(cc.cockpit.MeetingNodeID),
			projectTouched, moduleTouched,
		)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return project, module, node, false
		}
		// A derived pair is stored with the work item, so the board and the
		// plan tree cannot disagree about where its meetings are filed.
		if !projectTouched && resolvedProject != project.effective(cc.cockpit.MeetingProjectID) {
			project = meetingRef{id: resolvedProject}
		}
		if !moduleTouched && resolvedModule != module.effective(cc.cockpit.MeetingModuleID) {
			module = meetingRef{id: resolvedModule}
		}
		if err := h.validateMeetingDirectoryReferences(r.Context(), cc, project.effective(cc.cockpit.MeetingProjectID), module.effective(cc.cockpit.MeetingModuleID), node.effective(cc.cockpit.MeetingNodeID)); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return project, module, node, false
		}
	}
	return project, module, node, true
}

// resolveMeetingAssignee validates the default assignee a board wants its
// meeting tasks to go to. Absent fields leave the board's current choice
// alone; an empty type clears it back to "the member filing the meeting".
//
// Who that is stays a property of the programme, not of the code: here the
// minutes are an agent's job ("会议纪要整理专员"), elsewhere they are a
// person's, so the pair is chosen in the product and validated here against
// the same rules an issue's own assignee is held to.
func (h *Handler) resolveMeetingAssignee(
	w http.ResponseWriter,
	r *http.Request,
	cc cockpitContext,
	raw map[string]json.RawMessage,
	kind *string,
	id *string,
) (pgtype.Text, meetingRef, bool) {
	_, typeSent := raw["meeting_assignee_type"]
	_, idSent := raw["meeting_assignee_id"]
	if !typeSent && !idSent {
		return pgtype.Text{}, meetingRef{}, true
	}

	wantType := strings.TrimSpace(derefOr(kind, cc.cockpit.MeetingAssigneeType))
	wantID := strings.TrimSpace(derefOr(id, uuidToString(cc.cockpit.MeetingAssigneeID)))
	// Clearing either half clears both: a type with no id names no row, and
	// an id with no type does not say which table to look in.
	if wantType == "" || wantID == "" {
		return pgtype.Text{String: "", Valid: true}, meetingRef{clear: true}, true
	}

	parsed, err := util.ParseUUID(wantID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid meeting_assignee_id")
		return pgtype.Text{}, meetingRef{}, false
	}
	if status, msg := h.validateAssigneePair(
		r.Context(), r, uuidToString(cc.workspaceID),
		pgtype.Text{String: wantType, Valid: true}, parsed,
	); status != 0 {
		writeError(w, status, msg)
		return pgtype.Text{}, meetingRef{}, false
	}
	return pgtype.Text{String: wantType, Valid: true}, meetingRef{id: parsed}, true
}

// derefOr reads an optional field, falling back to what is already stored.
func derefOr(value *string, stored string) string {
	if value == nil {
		return stored
	}
	return *value
}

// meetingDirOrError validates a meeting's stored folder. Same contract as a
// project's collaboration space: absolute, no control characters, bounded —
// the server stores what it is told and never resolves it on read.
func (h *Handler) meetingDirOrError(w http.ResponseWriter, _ cockpitContext, value *string) (string, bool) {
	if value == nil {
		return "", true
	}
	normalized, err := normalizeCollabPath(*value)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return "", false
	}
	if !normalized.Valid {
		return "", true
	}
	return normalized.String, true
}

// meetingFolderNameMaxBytes bounds a generated folder name. SMB and APFS both
// stop at 255 bytes per component and a Chinese name spends three of them per
// character, so the limit is counted in bytes rather than characters.
const meetingFolderNameMaxBytes = 180

// sanitizeMeetingFolderName turns a meeting's name into one directory
// component. Everything that could leave the folder it is created in — a
// separator, a parent reference, a NUL — is replaced rather than rejected: the
// name comes from a title someone typed, and refusing to file a meeting over a
// slash in "复星/明略沟通会" would be the wrong answer to it.
func sanitizeMeetingFolderName(name string) string {
	replaced := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', 0:
			return '-'
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)

	fields := strings.Fields(replaced)
	out := strings.Join(fields, " ")
	// A leading dot hides the folder; a trailing dot or space is silently
	// dropped by SMB clients, which would make the stored path and the folder
	// on disk disagree.
	out = strings.Trim(out, ". ")
	for strings.Contains(out, "..") {
		out = strings.ReplaceAll(out, "..", ".")
	}
	for len(out) > meetingFolderNameMaxBytes {
		_, size := utf8DecodeLast(out)
		out = strings.TrimRight(out[:len(out)-size], ". ")
	}
	return out
}

// utf8DecodeLast returns the last rune of s and its width in bytes, so the
// byte-bounded truncation above never cuts a character in half.
func utf8DecodeLast(s string) (rune, int) {
	runes := []rune(s)
	if len(runes) == 0 {
		return 0, 0
	}
	last := runes[len(runes)-1]
	return last, len(string(last))
}

// normalizeDirMatch strips the spacing that separates a module's title from
// the folder that answers to it. The programme writes "06.06 多方协同与会议"
// on the platform and "06.06多方协同与会议" on disk; treating those as
// different would have the server create a second, near-identical folder
// beside the real one.
func normalizeDirMatch(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

// collabFolderName is a platform title written the way the share writes it.
//
// The programme separates a code from its name with a space on the platform
// ("06.06 多方协同与会议") and runs them together on disk
// ("06.06多方协同与会议"). Proposing a folder is only useful if the proposal
// looks like the ones already there, so the leading code is rejoined to the
// name. Titles that do not open with a code are left alone.
func collabFolderName(title string) string {
	trimmed := strings.TrimSpace(title)
	head, rest, found := strings.Cut(trimmed, " ")
	if !found || head == "" {
		return trimmed
	}
	for _, r := range head {
		if r != '.' && !unicode.IsDigit(r) {
			return trimmed
		}
	}
	return head + strings.TrimSpace(rest)
}

func (h *Handler) validateMeetingDirectoryReferences(ctx context.Context, cc cockpitContext, projectID, moduleID, nodeID pgtype.UUID) error {
	if projectID.Valid {
		if _, err := h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: cc.workspaceID}); err != nil {
			return errors.New("meeting project not found in this workspace")
		}
	}
	if moduleID.Valid {
		module, err := h.Queries.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: moduleID, WorkspaceID: cc.workspaceID})
		if err != nil {
			return errors.New("meeting module not found in this workspace")
		}
		if projectID.Valid && module.ProjectID != projectID {
			return errors.New("meeting module does not belong to the selected project")
		}
	}
	if nodeID.Valid {
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: nodeID, WorkspaceID: cc.workspaceID})
		if err != nil || node.CockpitID != cc.cockpit.ID {
			return errors.New("meeting sub-item not found on this board")
		}
		if cc.cockpit.PlanReconciledAt.Valid {
			depth, err := meetingLinkNodeDepth(ctx, h.Queries, cc, nodeID)
			if err != nil {
				return err
			}
			// A project row or module row is only valid for its own branch.
			// `reconcileMeetingNodeDestination` fills an unnamed level in; a
			// level named explicitly has to agree with the row.
			if depth == 0 && node.ProjectID.Valid && projectID.Valid && node.ProjectID != projectID {
				return errors.New("the project row does not belong to the selected project")
			}
			if depth == 1 {
				if node.ProjectID.Valid && projectID.Valid && node.ProjectID != projectID {
					return errors.New("the module row does not belong to the selected project")
				}
				if node.ModuleID.Valid && moduleID.Valid && node.ModuleID != moduleID {
					return errors.New("the module row does not belong to the selected module")
				}
			}
			if depth == 2 {
				parent, ok, err := meetingNodeParent(ctx, h.Queries, cc, node)
				if err != nil {
					return err
				}
				if !ok || !parent.ModuleID.Valid || !parent.ProjectID.Valid {
					return errors.New("the work item does not hang from a module row")
				}
				if moduleID.Valid && parent.ModuleID != moduleID {
					return errors.New("the work item does not belong to the selected module")
				}
				if projectID.Valid && parent.ProjectID != projectID {
					return errors.New("the work item does not belong to the selected project")
				}
			}
		}
	}
	return nil
}

// meetingNodeParent reads a node's parent row on this board.
func meetingNodeParent(ctx context.Context, q *db.Queries, cc cockpitContext, node db.CockpitNode) (db.CockpitNode, bool, error) {
	if !node.ParentID.Valid {
		return db.CockpitNode{}, false, nil
	}
	parent, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: node.ParentID, WorkspaceID: cc.workspaceID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.CockpitNode{}, false, nil
		}
		return db.CockpitNode{}, false, err
	}
	if parent.CockpitID != cc.cockpit.ID {
		return db.CockpitNode{}, false, nil
	}
	return parent, true, nil
}

// meetingWorkItemUnder reads nodeID as an L3 work item and returns the module
// row it hangs from. ok is false for a project or module row (and for a row
// deeper than a work item): those name where the path already is, not a work
// item a task can call home.
func meetingWorkItemUnder(ctx context.Context, q *db.Queries, cc cockpitContext, nodeID pgtype.UUID) (db.CockpitNode, db.CockpitNode, bool, error) {
	if !nodeID.Valid {
		return db.CockpitNode{}, db.CockpitNode{}, false, nil
	}
	depth, err := meetingNodeDepth(ctx, q, cc, nodeID)
	if err != nil {
		return db.CockpitNode{}, db.CockpitNode{}, false, err
	}
	if depth != 2 {
		return db.CockpitNode{}, db.CockpitNode{}, false, nil
	}
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: nodeID, WorkspaceID: cc.workspaceID})
	if err != nil {
		return db.CockpitNode{}, db.CockpitNode{}, false, err
	}
	parent, ok, err := meetingNodeParent(ctx, q, cc, node)
	if err != nil || !ok {
		return node, db.CockpitNode{}, false, err
	}
	if !parent.ModuleID.Valid || !parent.ProjectID.Valid {
		return node, parent, false, nil
	}
	return node, parent, true, nil
}

// meetingDestinationRefs is a request's meeting destination: the board's
// stored choice, overridden by whichever fields the request actually named.
type meetingDestinationRefs struct {
	projectID       pgtype.UUID
	projectExplicit bool
	moduleID        pgtype.UUID
	moduleExplicit  bool
	nodeID          pgtype.UUID
	nodeExplicit    bool
}

// resolve applies the "moving down clears what is below" rule. A request that
// switches project must not keep the old project's module, and one that
// switches module must not keep the old module's work item: those rows belong
// to the level above, and carrying them over files the meeting in a folder the
// request never named (or is refused as a contradiction).
func (refs meetingDestinationRefs) resolve(cc cockpitContext) meetingDestinationRefs {
	if refs.projectExplicit && refs.projectID != cc.cockpit.MeetingProjectID && !refs.moduleExplicit {
		refs.moduleID = pgtype.UUID{}
	}
	if refs.moduleID != cc.cockpit.MeetingModuleID && !refs.nodeExplicit {
		refs.nodeID = pgtype.UUID{}
	}
	return refs
}

// meetingDestinationRefsFromQuery reads the destination query parameters.
// `module_id=` and `node_id=` are explicit clearings — the absence of the
// parameter is what means "use the board's stored choice".
func meetingDestinationRefsFromQuery(r *http.Request, cc cockpitContext) (meetingDestinationRefs, string, bool) {
	refs := meetingDestinationRefs{
		projectID: cc.cockpit.MeetingProjectID,
		moduleID:  cc.cockpit.MeetingModuleID,
		nodeID:    cc.cockpit.MeetingNodeID,
	}
	query := r.URL.Query()
	if v := strings.TrimSpace(query.Get("project_id")); v != "" {
		id, err := util.ParseUUID(v)
		if err != nil {
			return refs, "invalid project_id", false
		}
		refs.projectID, refs.projectExplicit = id, true
	}
	if _, sent := query["module_id"]; sent {
		v := strings.TrimSpace(query.Get("module_id"))
		refs.moduleID, refs.moduleExplicit = pgtype.UUID{}, true
		if v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				return refs, "invalid module_id", false
			}
			refs.moduleID = id
		}
	}
	if _, sent := query["node_id"]; sent {
		v := strings.TrimSpace(query.Get("node_id"))
		refs.nodeID, refs.nodeExplicit = pgtype.UUID{}, true
		if v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				return refs, "invalid node_id", false
			}
			refs.nodeID = id
		}
	}
	return refs.resolve(cc), "", true
}

// meetingDestinationRefsFromJSON reads the same three fields from a request
// body, where a present-but-empty field is again an explicit clearing.
func meetingDestinationRefsFromJSON(projectID, moduleID, nodeID *string, cc cockpitContext) (meetingDestinationRefs, string, bool) {
	refs := meetingDestinationRefs{
		projectID: cc.cockpit.MeetingProjectID,
		moduleID:  cc.cockpit.MeetingModuleID,
		nodeID:    cc.cockpit.MeetingNodeID,
	}
	if projectID != nil {
		refs.projectID, refs.projectExplicit = pgtype.UUID{}, true
		if v := strings.TrimSpace(*projectID); v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				return refs, "invalid project_id", false
			}
			refs.projectID = id
		}
	}
	if moduleID != nil {
		refs.moduleID, refs.moduleExplicit = pgtype.UUID{}, true
		if v := strings.TrimSpace(*moduleID); v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				return refs, "invalid module_id", false
			}
			refs.moduleID = id
		}
	}
	if nodeID != nil {
		refs.nodeID, refs.nodeExplicit = pgtype.UUID{}, true
		if v := strings.TrimSpace(*nodeID); v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				return refs, "invalid node_id", false
			}
			refs.nodeID = id
		}
	}
	return refs.resolve(cc), "", true
}

// reconcileMeetingNodeDestination keeps an archive target and its project and
// module together. On a reconciled board the work item's parent module row IS
// the work item's module, so a request that names only the work item has its
// project and module derived from it; a request that names a different project
// or module is refused rather than stored as a contradiction. A project or
// module row names the branch it belongs to the same way, so picking one from
// another branch is refused too.
func (h *Handler) reconcileMeetingNodeDestination(
	ctx context.Context,
	cc cockpitContext,
	projectID, moduleID, nodeID pgtype.UUID,
	projectExplicit, moduleExplicit bool,
) (pgtype.UUID, pgtype.UUID, error) {
	if !cc.cockpit.PlanReconciledAt.Valid || !nodeID.Valid {
		return projectID, moduleID, nil
	}
	depth, err := meetingLinkNodeDepth(ctx, h.Queries, cc, nodeID)
	if err != nil {
		return pgtype.UUID{}, pgtype.UUID{}, err
	}
	node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: nodeID, WorkspaceID: cc.workspaceID})
	if err != nil {
		return pgtype.UUID{}, pgtype.UUID{}, errors.New("meeting sub-item not found on this board")
	}
	// A project row and a module row name a branch, not a new destination: the
	// levels below them are the rows' own bindings, and a row from another
	// branch is a contradiction rather than a filing.
	if depth == 0 {
		if !node.ProjectID.Valid {
			return projectID, moduleID, nil
		}
		if projectExplicit && projectID != node.ProjectID {
			return pgtype.UUID{}, pgtype.UUID{}, errors.New("the project row does not belong to the selected project")
		}
		return node.ProjectID, moduleID, nil
	}
	if depth == 1 {
		if node.ProjectID.Valid {
			if projectExplicit && projectID != node.ProjectID {
				return pgtype.UUID{}, pgtype.UUID{}, errors.New("the module row does not belong to the selected project")
			}
			projectID = node.ProjectID
		}
		if node.ModuleID.Valid {
			if moduleExplicit && moduleID != node.ModuleID {
				return pgtype.UUID{}, pgtype.UUID{}, errors.New("the module row does not belong to the selected module")
			}
			moduleID = node.ModuleID
		}
		return projectID, moduleID, nil
	}
	parent, ok, err := meetingNodeParent(ctx, h.Queries, cc, node)
	if err != nil {
		return pgtype.UUID{}, pgtype.UUID{}, err
	}
	if !ok || !parent.ModuleID.Valid || !parent.ProjectID.Valid {
		return pgtype.UUID{}, pgtype.UUID{}, errors.New("the work item does not hang from a module row")
	}
	if projectExplicit && projectID != parent.ProjectID {
		return pgtype.UUID{}, pgtype.UUID{}, errors.New("the work item does not belong to the selected project")
	}
	if moduleExplicit && moduleID != parent.ModuleID {
		return pgtype.UUID{}, pgtype.UUID{}, errors.New("the work item does not belong to the selected module")
	}
	return parent.ProjectID, parent.ModuleID, nil
}

// meetingDirPlan is where this board's meeting folders go, and how far up
// that path the server is allowed to create what is missing.
type meetingDirPlan struct {
	// The project's collaboration space. Nothing above it is ever created:
	// a /Volumes path whose share is not mounted must fail, not be rebuilt
	// as local directories that the next mount hides.
	Root string
	// The folder new meeting folders are created in.
	Dir string
	// Dir was worked out from the module and sub-item rather than confirmed
	// by someone. A derived path is shown as a proposal.
	Derived bool
}

// meetingNodeDepth walks the plan tree up from nodeID and reports its level:
// 0 for a project row (L1), 1 for a module row (L2), 2 for a work item (L3)
// and 3 for anything deeper. The walk is bounded at three steps so a cycle in
// a corrupted parent chain is refused rather than followed.
func meetingNodeDepth(ctx context.Context, q *db.Queries, cc cockpitContext, nodeID pgtype.UUID) (int, error) {
	if !nodeID.Valid {
		return 0, nil
	}
	seen := make(map[pgtype.UUID]bool, 4)
	current := nodeID
	for depth := 0; depth < 3; depth++ {
		if seen[current] {
			return 3, nil
		}
		seen[current] = true
		node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: current, WorkspaceID: cc.workspaceID})
		if err != nil {
			return 0, err
		}
		if node.CockpitID != cc.cockpit.ID {
			return 0, errors.New("work item not found on this board")
		}
		if !node.ParentID.Valid {
			return depth, nil
		}
		current = node.ParentID
	}
	return 3, nil
}

// meetingLinkNodeDepth refuses a fourth level (or deeper): a meeting links to
// a project, a module, or a work item row, never to anything below one.
func meetingLinkNodeDepth(ctx context.Context, q *db.Queries, cc cockpitContext, nodeID pgtype.UUID) (int, error) {
	depth, err := meetingNodeDepth(ctx, q, cc, nodeID)
	if err != nil {
		return 0, err
	}
	if depth > 2 {
		return depth, errMeetingLinkDepth
	}
	return depth, nil
}

const meetingLinkDepthError = "meetings can only link to project, module, or work item rows"

var errMeetingLinkDepth = errors.New(meetingLinkDepthError)

// meetingSafeFolderName accepts one folder component a stored directory name
// proposes. A name that could leave its parent is refused, not rewritten:
// these names are already recorded, and silently changing one would move a
// folder people are working in.
func meetingSafeFolderName(label, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", nil
	}
	if !localpaths.ValidFolder(name) {
		return "", fmt.Errorf("the %s folder name %q is not a single safe path segment", label, name)
	}
	return name, nil
}

// meetingModuleFolderName is the module's segment of a meeting path. The
// module's stored directory name is authoritative; the plan row's name is the
// fallback, and a board that has recorded neither (an old fixture, an
// un-reconciled programme) gets the name the share would use. The disk is
// never consulted by title: a renamed module must not silently file new
// meetings in a near-identical folder.
func (h *Handler) meetingModuleFolderName(ctx context.Context, cc cockpitContext, moduleID pgtype.UUID) (string, error) {
	module, err := h.Queries.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{
		ID: moduleID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		return "", errors.New("meeting module not found in this workspace")
	}
	if module.DirectoryName.Valid {
		if name, err := meetingSafeFolderName("module", module.DirectoryName.String); err != nil {
			return "", err
		} else if name != "" {
			return name, nil
		}
	}
	row, rowErr := h.Queries.GetCockpitNodeByModuleID(ctx, db.GetCockpitNodeByModuleIDParams{
		WorkspaceID: cc.workspaceID, ModuleID: moduleID,
	})
	if rowErr == nil {
		if row.DirectoryName.Valid {
			if name, err := meetingSafeFolderName("module plan row", row.DirectoryName.String); err != nil {
				return "", err
			} else if name != "" {
				return name, nil
			}
		}
		if name, err := meetingSafeFolderName("module plan row", collabfs.SanitizeFolderName(row.Code+module.Title, 0)); err != nil {
			return "", err
		} else if name != "" {
			return name, nil
		}
	} else if !errors.Is(rowErr, pgx.ErrNoRows) {
		return "", rowErr
	}
	name := sanitizeMeetingFolderName(collabFolderName(module.Title))
	return meetingSafeFolderName("module", name)
}

// meetingWorkItemFolderName is a work item's segment: its stored directory
// name, or the platform's proposal for a row that has not been given one.
func meetingWorkItemFolderName(node db.CockpitNode) (string, error) {
	if node.DirectoryName.Valid {
		if name, err := meetingSafeFolderName("work item", node.DirectoryName.String); err != nil {
			return "", err
		} else if name != "" {
			return name, nil
		}
	}
	return meetingSafeFolderName("work item", collabfs.SanitizeFolderName(node.Code+node.Name, 0))
}

// meetingBaseDir answers "which folder do this board's meeting folders go in".
//
// A board that has confirmed a folder uses it, full stop. Otherwise the answer
// is derived by walking down from the project's collaboration space: the
// module's stored directory name, then the work item's. Both are read from the
// database rather than matched against the disk by title, so renaming a module
// on the platform cannot silently file new meetings in a second folder beside
// the real one. The derivation is a SUGGESTION: it is returned to the caller
// to show and confirm, and only a confirmed value is stored.
func (h *Handler) meetingBaseDir(
	ctx context.Context,
	cc cockpitContext,
	projectID, moduleID, nodeID pgtype.UUID,
) (meetingDirPlan, error) {
	if err := h.validateMeetingDirectoryReferences(ctx, cc, projectID, moduleID, nodeID); err != nil {
		return meetingDirPlan{}, err
	}
	if confirmed := strings.TrimSpace(cc.cockpit.MeetingDir); confirmed != "" && projectID == cc.cockpit.MeetingProjectID && moduleID == cc.cockpit.MeetingModuleID && nodeID == cc.cockpit.MeetingNodeID {
		clean := filepath.Clean(confirmed)
		return meetingDirPlan{Root: clean, Dir: clean}, nil
	}
	if !projectID.Valid {
		return meetingDirPlan{}, errors.New("no meeting project is set for this board")
	}
	project, err := h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{
		ID: projectID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		return meetingDirPlan{}, errors.New("meeting project not found in this workspace")
	}
	base := ""
	if project.CollabPath.Valid {
		base = strings.TrimSpace(project.CollabPath.String)
	}
	if base == "" {
		return meetingDirPlan{}, errors.New("the meeting project has no collaboration space path")
	}
	plan := meetingDirPlan{Root: filepath.Clean(base), Derived: true}
	plan.Dir = plan.Root

	if moduleID.Valid {
		name, err := h.meetingModuleFolderName(ctx, cc, moduleID)
		if err != nil {
			return meetingDirPlan{}, err
		}
		if name == "" {
			return meetingDirPlan{}, errors.New("the meeting destination has no folder name")
		}
		plan.Dir = filepath.Join(plan.Dir, name)
	}
	if nodeID.Valid {
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
			ID: nodeID, WorkspaceID: cc.workspaceID,
		})
		if err != nil {
			return meetingDirPlan{}, errors.New("meeting sub-item not found on this board")
		}
		// A project row or the module row itself adds no segment: it names
		// where the path already is, not a folder inside it. A board that was
		// never reconciled can still carry a free-standing archive row (no
		// parent, no project, no module binding); that row IS the archive
		// folder, so its own segment must not be dropped.
		depth, err := meetingNodeDepth(ctx, h.Queries, cc, nodeID)
		if err != nil {
			return meetingDirPlan{}, err
		}
		archiveRow := depth == 2 || (!cc.cockpit.PlanReconciledAt.Valid && !node.ProjectID.Valid && !node.ModuleID.Valid)
		if archiveRow {
			name, err := meetingWorkItemFolderName(node)
			if err != nil {
				return meetingDirPlan{}, err
			}
			if name == "" {
				return meetingDirPlan{}, errors.New("the meeting destination has no folder name")
			}
			plan.Dir = filepath.Join(plan.Dir, name)
		}
	}
	return plan, nil
}

// ---------------------------------------------------------------------------
// Destination preview
// ---------------------------------------------------------------------------

type CockpitMeetingDestinationResponse struct {
	ProjectID    string `json:"project_id"`
	ProjectTitle string `json:"project_title"`
	ModuleID     string `json:"module_id"`
	ModuleTitle  string `json:"module_title"`
	// The archive sub-item under the module, and the code its task titles
	// open with.
	NodeID     string `json:"node_id"`
	NodeCode   string `json:"node_code"`
	NodeTitle  string `json:"node_title"`
	CollabPath string `json:"collab_path"`
	// The folder new meeting folders are created in.
	BaseDir string `json:"base_dir"`
	// True when base_dir was derived from the project, module and sub-item
	// rather than confirmed by someone. A derived path shows as a proposal.
	Derived bool `json:"derived"`
	// True when base_dir exists on this server right now. False is not an
	// error: the share may not be mounted here, or the archive folder may
	// simply not have been created yet.
	BaseDirExists bool `json:"base_dir_exists"`
	// True when this server could create what is missing — i.e. the project's
	// collaboration space is mounted and readable here. This, not
	// base_dir_exists, is what decides whether filing a folder can be asked
	// for.
	Creatable bool `json:"creatable"`
	// Why no folder could be worked out, when base_dir is empty.
	Error string `json:"error"`
}

// Directory previews may exist before the first board or meeting is created.
func (h *Handler) readMeetingDirectoryContext(w http.ResponseWriter, r *http.Request) (cockpitContext, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return cockpitContext{}, false
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return cockpitContext{}, false
	}
	board, err := h.Queries.GetCockpitByWorkspace(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		board = db.Cockpit{WorkspaceID: id}
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read meeting directory configuration")
		return cockpitContext{}, false
	}
	return cockpitContext{workspaceID: id, member: member, cockpit: board}, true
}

// GetCockpitMeetingDestination reports where a new meeting would be filed,
// for the create form to show BEFORE anything is created. Query parameters
// override the board's stored choice so the form can preview a different
// project or module while someone is still picking one.
func (h *Handler) GetCockpitMeetingDestination(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.readMeetingDirectoryContext(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	refs, badField, ok := meetingDestinationRefsFromQuery(r, cc)
	if !ok {
		writeError(w, http.StatusBadRequest, badField)
		return
	}
	projectID, moduleID, nodeID := refs.projectID, refs.moduleID, refs.nodeID

	projectID, moduleID, resolveErr := h.reconcileMeetingNodeDestination(ctx, cc, projectID, moduleID, nodeID, refs.projectExplicit, refs.moduleExplicit)
	if resolveErr != nil {
		writeError(w, http.StatusBadRequest, resolveErr.Error())
		return
	}

	resp := CockpitMeetingDestinationResponse{
		ProjectID: uuidToString(projectID),
		ModuleID:  uuidToString(moduleID),
		NodeID:    uuidToString(nodeID),
	}
	if projectID.Valid {
		if project, err := h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{
			ID: projectID, WorkspaceID: cc.workspaceID,
		}); err == nil {
			resp.ProjectTitle = project.Title
			if project.CollabPath.Valid {
				resp.CollabPath = project.CollabPath.String
			}
		}
	}
	if moduleID.Valid {
		if module, err := h.Queries.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{
			ID: moduleID, WorkspaceID: cc.workspaceID,
		}); err == nil {
			resp.ModuleTitle = module.Title
		}
	}
	if nodeID.Valid {
		if node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
			ID: nodeID, WorkspaceID: cc.workspaceID,
		}); err == nil {
			resp.NodeCode = node.Code
			resp.NodeTitle = node.Name
		}
	}

	// The board's own override is what a preview of a DIFFERENT destination
	// must not inherit: a stored folder answers for the stored one only.
	probe := cc
	if uuidToString(moduleID) != uuidToString(cc.cockpit.MeetingModuleID) ||
		uuidToString(projectID) != uuidToString(cc.cockpit.MeetingProjectID) ||
		uuidToString(nodeID) != uuidToString(cc.cockpit.MeetingNodeID) {
		probe.cockpit.MeetingDir = ""
	}
	plan, err := h.meetingBaseDir(ctx, probe, projectID, moduleID, nodeID)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDir = plan.Dir
	resp.Derived = plan.Derived
	if archive, openErr := openMeetingArchive(plan.Root); openErr == nil {
		defer archive.close()
		resp.Creatable = true
		if _, err := archive.directory(plan.Dir, false); err == nil {
			resp.BaseDirExists = true
		} else if !os.IsNotExist(err) {
			resp.Creatable = false
			resp.Error = err.Error()
		}
	} else {
		resp.Error = openErr.Error()
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

type CockpitMeetingProvisionRequest struct {
	// Both default to true: provisioning is what this endpoint is for.
	CreateTask *bool `json:"create_task"`
	CreateDir  *bool `json:"create_dir"`
	// Override the board's stored destination for this one meeting.
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
	// The archive sub-item. Sent as an empty string to file at the module
	// level instead, which is why "absent" and "empty" differ here.
	NodeID *string `json:"node_id"`
	// The folder to create the meeting's folder in, and what to call it.
	// Absent means "derive both", which is what the form sends back after
	// showing the derivation to a human.
	BaseDir    *string `json:"base_dir"`
	FolderName *string `json:"folder_name"`
	// Who the meeting's task belongs to. Defaults to the member filing the
	// meeting — NOT to the workspace's fallback agent, which would answer a
	// diary entry by starting an agent run.
	AssigneeType *string `json:"assignee_type"`
	AssigneeID   *string `json:"assignee_id"`
	// Store this destination on the board so later meetings pre-fill it.
	Remember *bool `json:"remember"`
}

type CockpitMeetingProvisionResponse struct {
	Meeting CockpitMeetingResponse        `json:"meeting"`
	Issues  []CockpitMeetingIssueResponse `json:"issues"`
	// The task that was opened, when one was. Null when task creation was not
	// asked for or did not succeed.
	Task *CockpitMeetingIssueResponse `json:"task"`
	// Human-readable reason the task or the folder is missing. Empty on
	// success; a filled one is not an HTTP error — the meeting itself is fine
	// and the missing part can be retried.
	TaskError            string `json:"task_error"`
	Dir                  string `json:"dir"`
	DirCreated           bool   `json:"dir_created"`
	DirError             string `json:"dir_error"`
	DirErrorCode         string `json:"dir_error_code"`
	DirectoryOperationID string `json:"directory_operation_id"`
	DirectoryState       string `json:"directory_state"`
}

func boolOrDefault(v *bool, fallback bool) bool {
	if v == nil {
		return fallback
	}
	return *v
}

// ProvisionCockpitMeeting opens the meeting's task and creates its folder.
//
// Separate from creating the meeting row so the two can fail independently:
// the record of a meeting that happened must never be lost to an unmounted
// share, and a task that could not be opened is worth retrying without
// filing the meeting twice. Re-running it is safe — an existing folder is
// accepted as-is, and a meeting that already has a task keeps it.
func (h *Handler) ProvisionCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	meetingID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return
	}
	ctx := r.Context()
	meeting, err := h.Queries.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{
		ID: meetingID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "meeting not found")
			return
		}
		slog.Warn("GetCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load meeting")
		return
	}

	var req CockpitMeetingProvisionRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}

	refs, badField, ok := meetingDestinationRefsFromJSON(req.ProjectID, req.ModuleID, req.NodeID, cc)
	if !ok {
		writeError(w, http.StatusBadRequest, badField)
		return
	}
	projectID, moduleID, nodeID := refs.projectID, refs.moduleID, refs.nodeID

	var reconcileErr error
	projectID, moduleID, reconcileErr = h.reconcileMeetingNodeDestination(ctx, cc, projectID, moduleID, nodeID, refs.projectExplicit, refs.moduleExplicit)
	if reconcileErr != nil {
		writeError(w, http.StatusBadRequest, reconcileErr.Error())
		return
	}

	if err := h.validateMeetingDirectoryReferences(ctx, cc, projectID, moduleID, nodeID); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Remembering a writer is a write even when task creation is disabled.
	// Validate it before any directory or meeting side effect.
	if boolOrDefault(req.Remember, true) && (projectID.Valid || moduleID.Valid) && req.AssigneeType != nil {
		kind := strings.TrimSpace(*req.AssigneeType)
		ref := strings.TrimSpace(derefOr(req.AssigneeID, ""))
		if kind != "" || ref != "" {
			id, valid := parseUUIDOrBadRequest(w, ref, "assignee_id")
			if !valid {
				return
			}
			if status, message := h.validateAssigneePair(ctx, r, uuidToString(cc.workspaceID), pgtype.Text{String: kind, Valid: true}, id); status != 0 {
				writeError(w, status, message)
				return
			}
		}
	}
	if boolOrDefault(req.CreateTask, true) {
		if err := service.RequireCockpitMeetingPreparationOpen(ctx, h.Queries, cc.workspaceID, meeting.ID); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		if wp, werr := h.Queries.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: cc.workspaceID, ID: meeting.ID}); werr == nil && wp.MinutesIssueID.Valid {
			writeError(w, http.StatusConflict, "this meeting has a work package; use its minutes task and workflow")
			return
		} else if werr != nil && !errors.Is(werr, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "failed to check meeting workflow")
			return
		}
	}
	resp := CockpitMeetingProvisionResponse{}

	// --- the folder -----------------------------------------------------
	dir := meeting.NasDir
	plan, planErr := h.meetingBaseDir(ctx, cc, projectID, moduleID, nodeID)
	if boolOrDefault(req.CreateDir, true) {
		if planErr != nil {
			resp.DirError = planErr.Error()
		}
		if req.BaseDir != nil && strings.TrimSpace(*req.BaseDir) != "" {
			// A one-shot selection can narrow the configured root, never
			// upgrade an unrelated directory into a new write boundary.
			normalized, inputErr := normalizeCollabPath(*req.BaseDir)
			if inputErr != nil {
				resp.DirError = inputErr.Error()
			} else {
				plan.Dir = filepath.Clean(normalized.String)
				rel, err := filepath.Rel(filepath.Clean(plan.Root), plan.Dir)
				if planErr != nil || plan.Root == "" || err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
					resp.DirError = "the selected meeting folder is outside its configured root"
				} else {
					resp.DirError = ""
				}
			}
		}
		// An existing binding is stable across title changes. Explicit legacy
		// destination fields still describe a new proposal, never a write root.
		target := meeting.NasDir
		explicitTarget := req.BaseDir != nil && strings.TrimSpace(*req.BaseDir) != "" || req.FolderName != nil && strings.TrimSpace(*req.FolderName) != ""
		if target != "" && !explicitTarget {
			resp.DirError = ""
		}
		if resp.DirError == "" {
			if target == "" || explicitTarget {
				name := meetingFolderName(meeting)
				if req.FolderName != nil && strings.TrimSpace(*req.FolderName) != "" {
					name = strings.TrimSpace(*req.FolderName)
				}
				name = sanitizeMeetingFolderName(name)
				if name == "" {
					resp.DirError = "meeting folder name is empty"
				} else {
					target = filepath.Join(plan.Dir, name)
				}
			}
			if resp.DirError == "" {
				result := h.provisionLegacyCockpitDirectory(r, cc, meeting.ID, target)
				resp.Dir, resp.DirCreated, resp.DirError = result.Directory, result.BaseReady, result.ErrorMessage
				resp.DirErrorCode, resp.DirectoryOperationID, resp.DirectoryState = result.ErrorCode, result.OperationID, result.State
				// The service alone owns binding CAS. Never repeat its write
				// outside that transaction, even if a legacy request retries.
				refreshed, readErr := h.Queries.GetCockpitMeeting(ctx, db.GetCockpitMeetingParams{ID: meeting.ID, WorkspaceID: cc.workspaceID})
				if readErr != nil {
					resp.DirError = "Directory work may have changed; reload the meeting to confirm its binding."
				} else {
					meeting = refreshed
					dir = meeting.NasDir
				}
			}
		}
	}

	// --- the task -------------------------------------------------------
	// An explicitly empty assignee means "whoever is filing it", and that has
	// to hold for this meeting as well as the ones after it — the board's own
	// default is cleared further down, too late for the task opened here.
	if req.AssigneeType != nil && strings.TrimSpace(*req.AssigneeType) == "" {
		cc.cockpit.MeetingAssigneeType = ""
		cc.cockpit.MeetingAssigneeID = pgtype.UUID{}
	}
	if boolOrDefault(req.CreateTask, true) {
		link, taskErr := h.openMeetingTask(r, cc, meeting, meetingTaskPlacement{
			projectID:    projectID,
			moduleID:     moduleID,
			nodeID:       nodeID,
			codePrefix:   h.meetingNodeCode(ctx, cc, nodeID),
			assigneeType: req.AssigneeType,
			assigneeID:   req.AssigneeID,
			dir:          dir,
		})
		if taskErr != "" {
			resp.TaskError = taskErr
		} else {
			resp.Task = link
		}
	}

	// --- what the board remembers ---------------------------------------

	if boolOrDefault(req.Remember, true) && (projectID.Valid || moduleID.Valid) {
		params := db.UpdateCockpitParams{ID: cc.cockpit.ID, WorkspaceID: cc.workspaceID}
		params.MeetingProjectID = projectID
		params.MeetingModuleID = moduleID
		params.MeetingNodeID = nodeID
		params.ClearMeetingNode = !nodeID.Valid
		if projectID != cc.cockpit.MeetingProjectID || moduleID != cc.cockpit.MeetingModuleID || nodeID != cc.cockpit.MeetingNodeID {
			params.MeetingDir = pgtype.Text{String: "", Valid: true}
		}
		// Only a folder that was actually used is worth remembering, and only
		// its parent: the board stores where meeting folders go, not where one
		// meeting went.
		if resp.DirCreated && resp.Dir != "" {
			params.MeetingDir = pgtype.Text{String: filepath.Dir(resp.Dir), Valid: true}
		}
		// Who writes the minutes is part of the destination the form just
		// confirmed, so it is stored with it: naming someone once makes them
		// the board's default, and sending an empty type hands the job back to
		// whoever files the meeting.
		if kind := strings.TrimSpace(derefOr(req.AssigneeType, "")); req.AssigneeType != nil {
			id := strings.TrimSpace(derefOr(req.AssigneeID, ""))
			switch {
			case kind == "" || id == "":
				params.MeetingAssigneeType = pgtype.Text{String: "", Valid: true}
				params.ClearMeetingAssignee = true
			default:
				parsed, err := util.ParseUUID(id)
				candidate := pgtype.Text{String: kind, Valid: true}
				if status, _ := h.validateAssigneePair(ctx, r, uuidToString(cc.workspaceID), candidate, parsed); err == nil && status == 0 {
					params.MeetingAssigneeType = candidate
					params.MeetingAssigneeID = parsed
				}
			}
		}
		board, err := h.Queries.UpdateCockpit(ctx, params)
		if err != nil {
			slog.Warn("UpdateCockpit meeting destination failed", append(logger.RequestAttrs(r), "error", err)...)
		} else {
			h.publishCockpit(r, cc, "cockpit", "updated", cockpitToResponse(board))
		}
	}

	resp.Meeting = cockpitMeetingToResponse(meeting)
	links, linksErr := h.meetingIssueLinks(ctx, cc, meeting.ID)
	if linksErr != nil {
		writeError(w, http.StatusInternalServerError, "meeting work was updated; reload to read its links")
		return
	}
	resp.Issues = links
	// Announced on the link scope, not the meeting scope: provisioning moved
	// the meeting's issues, and the meeting row rides along because its folder
	// may have changed in the same breath.
	h.publishCockpit(r, cc, "meeting_issues", "provisioned", map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"meeting":    resp.Meeting,
		"links":      resp.Issues,
	})
	writeJSON(w, http.StatusOK, resp)
}

// nextMeetingCode is the next free number for a meeting on day: "20260921-01",
// then -02. Numbered per day because the register is read by date, so a gap a
// deleted meeting left is not worth renumbering the day for. Numbers already
// on the board are respected, so a day someone numbered by hand carries on
// where they stopped.
//
// The rule is the one the meeting form applies in nextCockpitMeetingCode, and
// it lives here as well because the form is not the only way a meeting is
// filed: the overview's quick add and a folder scan both reach the register
// without a number, and an unnumbered row files its folder and its task
// without the prefix the rest of the register carries.
func nextMeetingCode(existing []db.CockpitMeeting, day time.Time) string {
	prefix := day.Format("20060102")
	highest := 0
	for _, m := range existing {
		if n, ok := meetingCodeNumber(strings.TrimSpace(m.Code), prefix); ok && n > highest {
			highest = n
		}
	}
	return fmt.Sprintf("%s-%02d", prefix, highest+1)
}

// meetingCodeNumber reads the "-NN" off a code already on prefix's day. Two
// digits at least, digits only: a code shaped some other way is somebody's own
// and must not move the day's count.
func meetingCodeNumber(code, prefix string) (int, bool) {
	rest, ok := strings.CutPrefix(code, prefix+"-")
	if !ok || len(rest) < 2 {
		return 0, false
	}
	n := 0
	for _, r := range rest {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
	}
	return n, true
}

// meetingFolderName is what a meeting's folder is called when nobody says
// otherwise: its platform number and its name, which is how the register
// reads and how the folders sort.
func meetingFolderName(m db.CockpitMeeting) string {
	code := strings.TrimSpace(m.Code)
	title := strings.TrimSpace(m.Title)
	switch {
	case title == "" && code == "":
		if d := dateToPtr(m.MeetDate); d != nil {
			return *d
		}
		return uuidToString(m.ID)
	case title == "":
		return code
	case code == "" || title == code || strings.HasPrefix(title, code+" "):
		// The generated name already opens with the number; prefixing it
		// again would file "20260921-01 20260921-01 …".
		return title
	default:
		return code + " " + title
	}
}

// meetingTaskDescription is the task's body: everything about the meeting that
// someone opening the task from their inbox would otherwise have to go back to
// the board for.
func meetingTaskDescription(m db.CockpitMeeting, dir string) string {
	var b strings.Builder
	line := func(label, value string) {
		if strings.TrimSpace(value) == "" {
			return
		}
		fmt.Fprintf(&b, "- %s：%s\n", label, value)
	}
	when := ""
	if d := dateToPtr(m.MeetDate); d != nil {
		when = *d
	}
	if span := meetingSpan(m); span != "" {
		when = strings.TrimSpace(when + " " + span)
	}
	line("时间", when)
	line("参会方", m.Parties)
	line("参会人", m.Attendees)
	line("召集人", m.Organizer)
	line("地点", m.Location)
	line("会议号", m.MeetNo)
	line("入会链接", m.Link)
	line("资料目录", dir)
	if agenda := strings.TrimSpace(m.Note); agenda != "" {
		b.WriteString("\n## 议程\n")
		b.WriteString(agenda)
		b.WriteString("\n")
	}
	return b.String()
}

// meetingSpan renders the meeting's span, preferring the structured times and
// falling back to the free text rows written before they existed.
func meetingSpan(m db.CockpitMeeting) string {
	start, end := clockToPtr(m.StartTime), clockToPtr(m.EndTime)
	switch {
	case start != nil && end != nil:
		return *start + "–" + *end
	case start != nil:
		return *start
	default:
		return strings.TrimSpace(m.TimeRange)
	}
}

// meetingNodeCode reads the archive sub-item's number, which the meeting
// task's title opens with. An unset or unreadable node is not an error: the
// task is simply titled without a number.
func (h *Handler) meetingNodeCode(ctx context.Context, cc cockpitContext, nodeID pgtype.UUID) string {
	if !nodeID.Valid {
		return ""
	}
	node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
		ID: nodeID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(node.Code)
}

// meetingTaskPlacement is everything about WHERE a meeting's task goes, kept
// apart from the request shape so scan-and-import can open the same task
// without borrowing a provisioning request it never received.
type meetingTaskPlacement struct {
	projectID, moduleID pgtype.UUID
	// The archive sub-item the meeting is filed under. Its number opens the
	// task's title, and the task is linked to it as well: a title says where
	// the work belongs, a link is what makes the board show it there.
	nodeID pgtype.UUID
	// The archive sub-item's number ("06.06.03"), which the title opens with
	// so the task sorts and reads like the rest of the programme's work.
	codePrefix   string
	assigneeType *string
	assigneeID   *string
	dir          string
}

// meetingTaskTitle is what the meeting's task is called: the archive
// sub-item's number, then the meeting's own number, then its name.
//
// The meeting's number is part of the title rather than left to the name
// because the task is read away from the board — in an inbox, in a list of
// everything assigned to someone — where the number is the only thing tying
// it back to a row in the register and to a folder on the share.
func meetingTaskTitle(prefix string, meeting db.CockpitMeeting) string {
	name := strings.TrimSpace(meeting.Title)
	if name == "" {
		name = meetingFolderName(meeting)
	}
	return prefixTitleOnce(strings.TrimSpace(prefix),
		prefixTitleOnce(strings.TrimSpace(meeting.Code), name))
}

// prefixTitleOnce puts a number in front of a name, unless the name already
// opens with it — a meeting named by the form carries its own number, and
// "20260921-01 20260921-01 周例会" is nobody's idea of a title.
func prefixTitleOnce(prefix, name string) string {
	switch {
	case prefix == "":
		return name
	case name == "":
		return prefix
	case name == prefix || strings.HasPrefix(name, prefix+" "):
		return name
	default:
		return prefix + " " + name
	}
}

// openMeetingTask files the meeting's issue and links it. Returns a
// human-readable reason instead of an error when the task could not be
// opened: the caller reports it alongside a meeting that was still saved.
func (h *Handler) openMeetingTask(
	r *http.Request,
	cc cockpitContext,
	meeting db.CockpitMeeting,
	placement meetingTaskPlacement,
) (*CockpitMeetingIssueResponse, string) {
	ctx := r.Context()
	title := meetingTaskTitle(placement.codePrefix, meeting)
	if title == "" {
		return nil, "the meeting has no name to open a task with"
	}

	// Default to the member filing the meeting. An unassigned issue falls back
	// to the workspace's cluster agent and enqueues a run immediately, which
	// is the right default for work someone asked an agent for and the wrong
	// one for the minutes of a meeting.
	assigneeType := pgtype.Text{String: "member", Valid: true}
	assigneeID := cc.member.UserID
	// A board that named someone whose job the minutes are overrides that:
	// the person who opened the row is rarely the person who writes them up.
	// Validated on use rather than trusted, and a setting that no longer
	// resolves — an archived agent, a member who left — falls back to the
	// filer instead of refusing to file the meeting at all.
	if kind := strings.TrimSpace(cc.cockpit.MeetingAssigneeType); kind != "" && cc.cockpit.MeetingAssigneeID.Valid {
		boardType := pgtype.Text{String: kind, Valid: true}
		if status, _ := h.validateAssigneePair(
			ctx, r, uuidToString(cc.workspaceID), boardType, cc.cockpit.MeetingAssigneeID,
		); status == 0 {
			assigneeType = boardType
			assigneeID = cc.cockpit.MeetingAssigneeID
		}
	}
	if placement.assigneeType != nil && strings.TrimSpace(*placement.assigneeType) != "" {
		assigneeType = pgtype.Text{String: strings.TrimSpace(*placement.assigneeType), Valid: true}
		assigneeID = pgtype.UUID{}
		if placement.assigneeID != nil && strings.TrimSpace(*placement.assigneeID) != "" {
			id, err := util.ParseUUID(strings.TrimSpace(*placement.assigneeID))
			if err != nil {
				return nil, "invalid assignee_id"
			}
			assigneeID = id
		}
		if status, msg := h.validateAssigneePair(ctx, r, uuidToString(cc.workspaceID), assigneeType, assigneeID); status != 0 {
			return nil, msg
		}
	}

	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	fillCreated := h.newStatusCategoryFiller(ctx, cc.workspaceID)
	// The work item is the task's own filing, not a second relation: a task
	// opened for a meeting filed at a work item belongs to it the same way a
	// task created there by hand does. A board whose archive node is not an L3
	// row keeps the older cockpit_node_issue link instead.
	workItemID := pgtype.UUID{}
	if node, parent, ok, err := meetingWorkItemUnder(ctx, h.Queries, cc, placement.nodeID); err == nil && ok {
		if (!placement.moduleID.Valid || parent.ModuleID == placement.moduleID) &&
			(!placement.projectID.Valid || parent.ProjectID == placement.projectID) {
			workItemID = node.ID
		}
	}
	result, err := h.IssueService.Create(ctx, service.IssueCreateParams{
		WorkspaceID:  cc.workspaceID,
		MeetingTask:  &service.CockpitMeetingTask{MeetingID: meeting.ID, NodeID: placement.nodeID},
		Title:        title,
		Description:  pgtype.Text{String: meetingTaskDescription(meeting, placement.dir), Valid: true},
		Status:       "todo",
		Priority:     "none",
		AssigneeType: assigneeType,
		AssigneeID:   assigneeID,
		CreatorType:  "member",
		CreatorID:    cc.member.UserID,
		ProjectID:    placement.projectID,
		ModuleID:     placement.moduleID,
		WorkItemID:   workItemID,
		StartDate:    meeting.MeetDate,
		DueDate:      meeting.MeetDate,
		// A programme runs the same weekly meeting all year; two of them
		// sharing a title is the normal case, not a mistake to guard against.
		AllowDuplicate: true,
	}, service.IssueCreateOpts{
		ActorID:  uuidToString(cc.member.UserID),
		Platform: func() string { p, _, _ := middleware.ClientMetadataFromContext(ctx); return p }(),
		// The full response shape, so every open client renders the new task
		// without a refetch. No attachments: a meeting task is born empty.
		BroadcastPayload: func(issue db.Issue, _ []db.Attachment, labels []db.IssueLabel) map[string]any {
			payload := issueToResponse(issue, prefix)
			fillCreated(&payload)
			labelResponses := labelsToResponse(labels)
			payload.Labels = &labelResponses
			return map[string]any{"issue": payload}
		},
	})
	switch {
	case errors.Is(err, service.ErrProjectNotFound):
		return nil, "the meeting project no longer exists in this workspace"
	case errors.Is(err, service.ErrModuleNotFound):
		return nil, "the meeting module no longer exists in this workspace"
	case errors.Is(err, service.ErrModuleNotInProject):
		return nil, "the meeting module belongs to another project"
	case err != nil:
		slog.Warn("cockpit meeting task create failed", append(logger.RequestAttrs(r), "error", err)...)
		return nil, "failed to open the meeting task"
	}

	// The service commits the issue and both links together and reuses an
	// existing task under a meeting row lock. Read its metadata rather than
	// resetting user-assigned purposes when provisioning is retried.
	link, err := h.Queries.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: result.Issue.ID,
	})
	if err != nil {
		return nil, "the task was opened; reload to read its meeting link"
	}

	return &CockpitMeetingIssueResponse{
		MeetingID:       uuidToString(meeting.ID),
		IssueID:         uuidToString(result.Issue.ID),
		Role:            "task",
		Roles:           append([]string{}, link.Roles...),
		IssueNumber:     result.Issue.Number,
		IssueIdentifier: fmt.Sprintf("%s-%d", prefix, result.Issue.Number),
		IssueTitle:      result.Issue.Title,
		IssueStatus:     result.Issue.Status,
		Position:        -1,
	}, ""
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

// meetingIssueLinks reads one meeting's issue links out of the board-wide
// query. The board carries a few dozen meetings, so one read that the response
// filters beats a second query shape to maintain.
func (h *Handler) meetingIssueLinks(ctx context.Context, cc cockpitContext, meetingID pgtype.UUID) ([]CockpitMeetingIssueResponse, error) {
	return meetingIssueLinksWithQueries(ctx, h.Queries, cc, meetingID)
}

func meetingIssueLinksWithQueries(ctx context.Context, q *db.Queries, cc cockpitContext, meetingID pgtype.UUID) ([]CockpitMeetingIssueResponse, error) {
	workspace, err := q.GetWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return nil, err
	}
	prefix := issuePrefixForWorkspace(workspace)
	rows, err := q.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
	if err != nil {
		return nil, err
	}
	out := make([]CockpitMeetingIssueResponse, 0, len(rows))
	for _, row := range rows {
		if row.MeetingID != meetingID {
			continue
		}
		out = append(out, cockpitMeetingIssueToResponse(row, prefix))
	}
	return out, nil
}

// requireCockpitMeeting resolves the meeting a link endpoint addresses.
func (h *Handler) requireCockpitMeeting(w http.ResponseWriter, r *http.Request, cc cockpitContext) (db.CockpitMeeting, bool) {
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return db.CockpitMeeting{}, false
	}
	meeting, err := h.Queries.GetCockpitMeeting(r.Context(), db.GetCockpitMeetingParams{
		ID: id, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "meeting not found")
			return db.CockpitMeeting{}, false
		}
		slog.Warn("GetCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load meeting")
		return db.CockpitMeeting{}, false
	}
	return meeting, true
}

type CockpitMeetingIssuesRequest struct {
	// Issue identifiers, each either a UUID or a human-readable number
	// ("BIO-314") — the same vocabulary the node links accept.
	IssueIDs []string `json:"issue_ids"`
	// Replace swaps the meeting's whole link set. The default adds to it,
	// which is what a picker does.
	Replace bool `json:"replace"`
}

// SetCockpitMeetingIssues links issues to a meeting. The meeting's own task is
// one of these links; everything else is what someone attached by hand.
func (h *Handler) SetCockpitMeetingIssues(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}

	var req CockpitMeetingIssuesRequest
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
		issue, found := h.resolveCockpitIssue(ctx, raw, uuidToString(cc.workspaceID))
		if !found {
			writeError(w, http.StatusBadRequest, "issue not found: "+raw)
			return
		}
		resolved = append(resolved, issue.ID)
	}

	// Serialize relation replacement with purpose edits and provisioning. Keep
	// surviving rows in place so old clients cannot erase their new metadata.
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)

	markers := make(map[pgtype.UUID]string)
	if req.Replace {
		existing, err := q.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read meeting issue links")
			return
		}
		for _, link := range existing {
			if link.MeetingID == meeting.ID {
				markers[link.IssueID] = link.Role
			}
		}
	}
	if req.Replace {
		owned, err := q.ListCockpitMeetingWorkflowIssueIDs(ctx, db.ListCockpitMeetingWorkflowIssueIDsParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check workflow links")
			return
		}
		selected := make(map[pgtype.UUID]bool, len(resolved))
		for _, id := range resolved {
			selected[id] = true
		}
		for _, id := range owned {
			if !selected[id] {
				writeError(w, http.StatusConflict, "work package issue links must be preserved")
				return
			}
		}
	}
	if req.Replace {
		if err := q.DeleteCockpitMeetingIssuesExcept(ctx, db.DeleteCockpitMeetingIssuesExceptParams{
			MeetingID: meeting.ID, WorkspaceID: cc.workspaceID, IssueIds: resolved,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}
	if err := lockCockpitReferenceIssues(ctx, q, cc.workspaceID, resolved); writeCockpitReferenceError(w, err) {
		return
	}
	for i, issueID := range resolved {
		if !req.Replace {
			if _, err := appendCockpitMeetingIssueRecord(ctx, q, cc, meeting.ID, issueID); writeCockpitReferenceError(w, err) {
				return
			}
			continue
		}
		if _, err := q.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
			WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issueID,
			Role: markers[issueID], Position: float64(i),
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}
	links, err := meetingIssueLinksWithQueries(ctx, q, cc, meeting.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read meeting issue links")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link issues")
		return
	}

	payload := map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"links":      links,
	}
	h.publishCockpit(r, cc, "meeting_issues", "replaced", payload)
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) DeleteCockpitMeetingIssue(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}
	issue, found := h.resolveCockpitIssue(r.Context(), chi.URLParam(r, "issueId"), uuidToString(cc.workspaceID))
	if !found {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}
	ctx := r.Context()
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	role, err := q.CockpitMeetingWorkflowRequiredRole(ctx, db.CockpitMeetingWorkflowRequiredRoleParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issue.ID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check workflow link")
		return
	}
	if role != "" {
		writeError(w, http.StatusConflict, "work package issue links must be preserved")
		return
	}
	if err := q.DeleteCockpitMeetingIssue(ctx, db.DeleteCockpitMeetingIssueParams{
		MeetingID:   meeting.ID,
		IssueID:     issue.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink issue")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unlink meeting relation")
		return
	}
	h.publishCockpit(r, cc, "meeting_issues", "removed", map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"issue_id":   uuidToString(issue.ID),
	})
	w.WriteHeader(http.StatusNoContent)
}

type CockpitMeetingNodesRequest struct {
	// Work items, each either a UUID or the code the board addresses it by
	// ("06.06.02"), so the picker and an import speak the same language.
	NodeIDs []string `json:"node_ids"`
	Replace bool     `json:"replace"`
}

// SetCockpitMeetingNodes links work-breakdown items to a meeting — the L2/L3
// rows of the execution gantt the meeting was about.
func (h *Handler) SetCockpitMeetingNodes(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}

	var req CockpitMeetingNodesRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if len(req.NodeIDs) > 200 {
		writeError(w, http.StatusBadRequest, "at most 200 work items can be linked in one request")
		return
	}

	ctx := r.Context()
	resolved := make([]pgtype.UUID, 0, len(req.NodeIDs))
	for _, raw := range req.NodeIDs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		node, found := h.resolveCockpitNode(ctx, cc, raw)
		if !found {
			writeError(w, http.StatusBadRequest, "cockpit node not found: "+raw)
			return
		}
		resolved = append(resolved, node.ID)
	}

	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	for _, nodeID := range resolved {
		if node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: nodeID, WorkspaceID: cc.workspaceID}); err != nil || node.CockpitID != cc.cockpit.ID {
			writeError(w, http.StatusBadRequest, "a selected work item no longer exists")
			return
		}
		if _, err := meetingLinkNodeDepth(ctx, q, cc, nodeID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if req.Replace {
		if err := q.DeleteCockpitMeetingNodesByMeeting(ctx, db.DeleteCockpitMeetingNodesByMeetingParams{
			MeetingID:   meeting.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitMeetingNodesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link work items")
			return
		}
	}
	for i, nodeID := range resolved {
		if !req.Replace {
			if _, err := appendCockpitMeetingNodeRecord(ctx, q, cc, meeting.ID, nodeID); writeCockpitReferenceError(w, err) {
				return
			}
			continue
		}
		if _, err := q.CreateCockpitMeetingNode(ctx, db.CreateCockpitMeetingNodeParams{
			WorkspaceID: cc.workspaceID,
			MeetingID:   meeting.ID,
			NodeID:      nodeID,
			Position:    float64(i),
		}); err != nil {
			slog.Warn("CreateCockpitMeetingNode failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link work items")
			return
		}
	}

	links, err := q.ListCockpitMeetingNodes(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetingNodes failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to link work items")
		return
	}
	out := make([]CockpitMeetingNodeResponse, 0, len(resolved))
	for _, l := range links {
		if l.MeetingID != meeting.ID {
			continue
		}
		out = append(out, cockpitMeetingNodeToResponse(l))
	}

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link work items")
		return
	}
	payload := map[string]any{"meeting_id": uuidToString(meeting.ID), "links": out}
	h.publishCockpit(r, cc, "meeting_nodes", "replaced", payload)
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) DeleteCockpitMeetingNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}
	node, found := h.resolveCockpitNode(r.Context(), cc, chi.URLParam(r, "nodeId"))
	if !found {
		writeError(w, http.StatusNotFound, "cockpit node not found")
		return
	}
	ctx := r.Context()
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	if err := q.DeleteCockpitMeetingNode(ctx, db.DeleteCockpitMeetingNodeParams{
		MeetingID:   meeting.ID,
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink work item")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unlink meeting relation")
		return
	}
	h.publishCockpit(r, cc, "meeting_nodes", "removed", map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"node_id":    uuidToString(node.ID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// resolveCockpitNode resolves a node reference that may be a UUID or the
// board's own code. The read-only sibling of loadCockpitNode: link endpoints
// resolve references in bulk, where one unknown reference must be reported as
// itself rather than as the whole response.
func (h *Handler) resolveCockpitNode(ctx context.Context, cc cockpitContext, ref string) (db.CockpitNode, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return db.CockpitNode{}, false
	}
	if id, err := util.ParseUUID(ref); err == nil {
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
			ID: id, WorkspaceID: cc.workspaceID,
		})
		if err == nil {
			return node, true
		}
	}
	node, err := h.Queries.GetCockpitNodeByCode(ctx, db.GetCockpitNodeByCodeParams{
		CockpitID: cc.cockpit.ID, Code: ref,
	})
	if err != nil {
		return db.CockpitNode{}, false
	}
	return node, true
}

// ---------------------------------------------------------------------------
// Reading meetings back off the share
// ---------------------------------------------------------------------------
//
// Meetings happen whether or not anybody opens the register, and their
// material lands in the archive folder either way — dropped there from a
// laptop, by someone who has never used the board. Those folders ARE the
// record; the register just does not know about them yet. Scanning turns them
// into rows.
//
// Everything the scan reads is a guess off a folder name a human wrote
// freehand, so nothing it produces is presented as fact: the rows it creates
// are flagged (cockpit_meeting.detected) and the form shows every guessed
// field for correction before anything is written.

// meetingFolderGuess is what a folder name gives up about the meeting that
// filled it.
type meetingFolderGuess struct {
	Code     string
	MeetDate string
	Parties  string
	Title    string
}

// partySeparators are the characters the programme writes between the sides
// of a meeting. The register stores them separated by "、"; folder names use
// whichever one was to hand.
const partySeparators = "×xX/／、&＆"

// leadingDate pulls a date off the front of a folder name, in the shapes the
// programme actually writes: 20260921, 2026-09-21, 2026.09.21. Returns the
// ISO date and how many bytes it consumed.
func leadingDate(name string) (string, int) {
	digits := func(s string, n int) bool {
		if len(s) < n {
			return false
		}
		for i := 0; i < n; i++ {
			if s[i] < '0' || s[i] > '9' {
				return false
			}
		}
		return true
	}
	valid := func(iso string) bool {
		_, err := time.Parse("2006-01-02", iso)
		return err == nil
	}
	if digits(name, 8) {
		iso := name[0:4] + "-" + name[4:6] + "-" + name[6:8]
		if valid(iso) {
			return iso, 8
		}
	}
	if digits(name, 4) && len(name) >= 10 &&
		(name[4] == '-' || name[4] == '.' || name[4] == '_') && name[4] == name[7] &&
		digits(name[5:], 2) && digits(name[8:], 2) {
		iso := name[0:4] + "-" + name[5:7] + "-" + name[8:10]
		if valid(iso) {
			return iso, 10
		}
	}
	return "", 0
}

// parseMeetingFolderName reads a folder name the way the register writes one
// ("20260921-01 复星医药×华大基因 数据对接") and degrades, field by field,
// for names that were written some other way. Whatever it cannot work out it
// leaves empty rather than inventing — an empty field asks to be filled in,
// a wrong one has to be spotted first.
func parseMeetingFolderName(name string) meetingFolderGuess {
	guess := meetingFolderGuess{Title: strings.TrimSpace(name)}
	rest := strings.TrimSpace(name)

	if iso, n := leadingDate(rest); n > 0 {
		guess.MeetDate = iso
		head, tail := rest[:n], rest[n:]
		// "20260921-01": the day's sequence number, which is the register's
		// own numbering. "20260921-复星" is a separator, not a sequence.
		if len(tail) > 1 && tail[0] == '-' {
			seq := 0
			for seq+1 < len(tail) && tail[seq+1] >= '0' && tail[seq+1] <= '9' {
				seq++
			}
			if seq > 0 && seq <= 3 {
				guess.Code = head + tail[:seq+1]
				tail = tail[seq+1:]
			}
		}
		rest = strings.TrimLeft(tail, " \t-_—–、.")
	}

	fields := strings.Fields(rest)
	if len(fields) >= 2 && strings.ContainsAny(fields[0], partySeparators) {
		parties := strings.FieldsFunc(fields[0], func(r rune) bool {
			return strings.ContainsRune(partySeparators, r)
		})
		cleaned := make([]string, 0, len(parties))
		for _, party := range parties {
			if trimmed := strings.TrimSpace(party); trimmed != "" {
				cleaned = append(cleaned, trimmed)
			}
		}
		if len(cleaned) > 1 {
			guess.Parties = strings.Join(cleaned, "、")
			rest = strings.Join(fields[1:], " ")
		}
	}
	if trimmed := strings.TrimSpace(rest); trimmed != "" {
		guess.Title = trimmed
	}
	return guess
}

// meetingScanLimit bounds one scan. An archive folder holds a programme's
// meetings, not a filesystem; a folder with more entries than this is not
// the one that was configured, and reading all of it would be the wrong
// thing to do about that.
const meetingScanLimit = 500

type CockpitMeetingScanEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// When the folder was last touched and how much is in it — the two
	// things that say whether it holds a real meeting's material.
	ModifiedAt string `json:"modified_at"`
	Files      int    `json:"files"`
	// The meeting already recording this folder, or empty when nothing does.
	MeetingID string `json:"meeting_id"`
	// Guessed from the folder name; every one of them is editable before
	// import and the imported row stays flagged afterwards.
	Code     string `json:"code"`
	MeetDate string `json:"meet_date"`
	Parties  string `json:"parties"`
	Title    string `json:"title"`
}

type CockpitMeetingScanResponse struct {
	BaseDir       string                    `json:"base_dir"`
	BaseDirExists bool                      `json:"base_dir_exists"`
	Entries       []CockpitMeetingScanEntry `json:"entries"`
	// How many of the folders are already in the register. Reported rather
	// than filtered out so "nothing new" reads as "I looked" instead of
	// "I found nothing at all".
	Matched int `json:"matched"`
	// The archive folder holds more than one scan will read.
	Truncated bool   `json:"truncated"`
	Error     string `json:"error"`
}

// ScanCockpitMeetingFolders lists the archive folder and says which of its
// folders no meeting records.
//
// The folder is resolved from the board's own destination, never taken from
// the request: this endpoint would otherwise be a way to list any directory
// the server can read.
func (h *Handler) ScanCockpitMeetingFolders(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.readMeetingDirectoryContext(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	refs, badField, ok := meetingDestinationRefsFromQuery(r, cc)
	if !ok {
		writeError(w, http.StatusBadRequest, badField)
		return
	}
	projectID, moduleID, nodeID := refs.projectID, refs.moduleID, refs.nodeID

	resp := CockpitMeetingScanResponse{Entries: []CockpitMeetingScanEntry{}}
	projectID, moduleID, err := h.reconcileMeetingNodeDestination(ctx, cc, projectID, moduleID, nodeID, refs.projectExplicit, refs.moduleExplicit)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	plan, err := h.meetingBaseDir(ctx, cc, projectID, moduleID, nodeID)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDir = plan.Dir

	archive, err := openMeetingArchive(plan.Root)
	if err != nil {
		resp.Error = fmt.Sprintf("the archive folder cannot be read here: %s", plan.Dir)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	defer archive.close()
	base, err := archive.directory(plan.Dir, false)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	entries, truncated, err := base.entries(ctx, meetingScanLimit)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDirExists = true
	resp.Truncated = truncated

	meetings, err := h.Queries.ListCockpitMeetingDirectoryMetadata(ctx, db.ListCockpitMeetingDirectoryMetadataParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID})
	if err != nil {
		slog.Warn("ListCockpitMeetingDirectoryMetadata failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load meetings")
		return
	}
	byDir := make(map[string]string, len(meetings))
	byName := make(map[string]string, len(meetings))
	for _, m := range meetings {
		if dir := strings.TrimSpace(m.NasDir); dir != "" {
			byDir[filepath.Clean(dir)] = uuidToString(m.ID)
		}
		// A meeting filed before its folder existed still answers to the name
		// it would have created, which is how a folder someone made by hand
		// under the same name is recognised instead of imported twice.
		if name := normalizeDirMatch(meetingFolderName(db.CockpitMeeting{ID: m.ID, Code: m.Code, Title: m.Title, MeetDate: m.MeetDate})); name != "" {
			byName[name] = uuidToString(m.ID)
		}
	}

	for _, name := range entries {
		child, err := base.child(name, false)
		if err != nil {
			resp.Error = err.Error()
			resp.Entries = []CockpitMeetingScanEntry{}
			writeJSON(w, http.StatusOK, resp)
			return
		}
		path := child.Path()
		guess := parseMeetingFolderName(name)
		row := CockpitMeetingScanEntry{
			Name:     name,
			Path:     path,
			Code:     guess.Code,
			MeetDate: guess.MeetDate,
			Parties:  guess.Parties,
			Title:    guess.Title,
		}
		if id, found := byDir[path]; found {
			row.MeetingID = id
		} else if id, found := byName[normalizeDirMatch(name)]; found {
			row.MeetingID = id
		}
		if row.MeetingID != "" {
			resp.Matched++
		}
		row.ModifiedAt = child.Info().ModTime().UTC().Format(time.RFC3339)
		row.Files, err = child.visibleCount(ctx)
		_ = child.Close()
		if err != nil {
			resp.Error = err.Error()
			resp.Entries = []CockpitMeetingScanEntry{}
			writeJSON(w, http.StatusOK, resp)
			return
		}
		resp.Entries = append(resp.Entries, row)
	}
	if err := base.verify(); err != nil {
		resp.Error = err.Error()
		resp.Entries = []CockpitMeetingScanEntry{}
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Importing what the scan found
// ---------------------------------------------------------------------------

type CockpitMeetingImportItem struct {
	// The folder, as the scan reported it. Resolved under the archive folder
	// and required to exist: importing invents a row FOR a folder, never a
	// row about one that is not there.
	Name string `json:"name"`
	// The scan's guesses, as corrected by whoever is importing.
	Code     string `json:"code"`
	MeetDate string `json:"meet_date"`
	Title    string `json:"title"`
	Parties  string `json:"parties"`
	Kind     string `json:"kind"`
}

type CockpitMeetingImportRequest struct {
	Items           []CockpitMeetingImportItem `json:"items"`
	ExpectedBaseDir *string                    `json:"expected_base_dir"`
	// Override the board's destination, the same way provisioning does.
	ProjectID *string `json:"project_id"`
	ModuleID  *string `json:"module_id"`
	NodeID    *string `json:"node_id"`
	// Off by default: these meetings already happened, and opening a task
	// per historical folder is a worse default than opening none.
	CreateTask *bool `json:"create_task"`
}

type CockpitMeetingImportSkip struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

type CockpitMeetingImportDirectoryResult struct {
	Name                 string `json:"name"`
	MeetingID            string `json:"meeting_id"`
	DirectoryOperationID string `json:"directory_operation_id"`
	DirectoryState       string `json:"directory_state"`
	DirCreated           bool   `json:"dir_created"`
	DirError             string `json:"dir_error"`
	DirErrorCode         string `json:"dir_error_code"`
}

type CockpitMeetingImportTaskError struct {
	Name      string `json:"name"`
	MeetingID string `json:"meeting_id"`
	Error     string `json:"error"`
}

type CockpitMeetingImportResponse struct {
	TaskErrors       []CockpitMeetingImportTaskError       `json:"task_errors"`
	DirectoryResults []CockpitMeetingImportDirectoryResult `json:"directory_results"`
	Meetings         []CockpitMeetingResponse              `json:"meetings"`
	Issues           []CockpitMeetingIssueResponse         `json:"issues"`
	// Folders that were asked for and not imported, each with why. Reported
	// rather than failing the batch: one folder that disappeared between the
	// scan and the import must not cost the other nine.
	Skipped []CockpitMeetingImportSkip `json:"skipped"`
}

// ImportCockpitMeetingFolders turns archive folders into meeting rows.
func (h *Handler) ImportCockpitMeetingFolders(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.readMeetingDirectoryContext(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	var req CockpitMeetingImportRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if len(req.Items) == 0 {
		writeError(w, http.StatusBadRequest, "no folders to import")
		return
	}
	if len(req.Items) > meetingScanLimit {
		writeError(w, http.StatusBadRequest, "too many folders in one import")
		return
	}

	refs, badField, ok := meetingDestinationRefsFromJSON(req.ProjectID, req.ModuleID, req.NodeID, cc)
	if !ok {
		writeError(w, http.StatusBadRequest, badField)
		return
	}
	projectID, moduleID, nodeID := refs.projectID, refs.moduleID, refs.nodeID

	var reconcileErr error
	projectID, moduleID, reconcileErr = h.reconcileMeetingNodeDestination(ctx, cc, projectID, moduleID, nodeID, refs.projectExplicit, refs.moduleExplicit)
	if reconcileErr != nil {
		writeError(w, http.StatusBadRequest, reconcileErr.Error())
		return
	}

	plan, err := h.meetingBaseDir(ctx, cc, projectID, moduleID, nodeID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	if req.ExpectedBaseDir != nil {
		observed, inputErr := normalizeCollabPath(*req.ExpectedBaseDir)
		if inputErr != nil || !observed.Valid {
			writeError(w, http.StatusBadRequest, "expected_base_dir must be a valid absolute directory")
			return
		}
		if filepath.Clean(observed.String) != filepath.Clean(plan.Dir) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "the archive directory changed; scan it again before importing", "code": "directory_changed"})
			return
		}
	}

	archive, err := openMeetingArchive(plan.Root)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer archive.close()
	base, err := archive.directory(plan.Dir, false)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	existing, err := h.Queries.ListCockpitMeetingRecordedDirectories(ctx, db.ListCockpitMeetingRecordedDirectoriesParams{WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID})
	if err != nil {
		slog.Warn("ListCockpitMeetingRecordedDirectories failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load meetings")
		return
	}
	recorded := make(map[string]bool, len(existing))
	for _, directory := range existing {
		if dir := strings.TrimSpace(directory); dir != "" {
			recorded[filepath.Clean(dir)] = true
		}
	}

	codePrefix := h.meetingNodeCode(ctx, cc, nodeID)
	createTask := req.CreateTask != nil && *req.CreateTask
	resp := CockpitMeetingImportResponse{
		TaskErrors:       []CockpitMeetingImportTaskError{},
		DirectoryResults: []CockpitMeetingImportDirectoryResult{},
		Meetings:         []CockpitMeetingResponse{},
		Issues:           []CockpitMeetingIssueResponse{},
		Skipped:          []CockpitMeetingImportSkip{},
	}

	for _, item := range req.Items {
		name := sanitizeMeetingFolderName(item.Name)
		if name == "" {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "empty folder name"})
			continue
		}
		path := filepath.Clean(filepath.Join(plan.Dir, name))
		if !strings.HasPrefix(path, filepath.Clean(plan.Dir)+string(os.PathSeparator)) {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "folder is outside the archive folder"})
			continue
		}
		child, openErr := base.child(name, false)
		if openErr != nil {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "folder is unavailable or contains an unsafe filesystem entry"})
			continue
		}
		_ = child.Close()
		if recorded[path] {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "already in the register"})
			continue
		}

		meetDate, dateErr := importDate(strings.TrimSpace(item.MeetDate))
		if dateErr != nil {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "invalid meeting date"})
			continue
		}
		title := strings.TrimSpace(item.Title)
		if title == "" {
			title = name
		}
		// A folder whose name opens with a number keeps it; one scanned out
		// of a folder named by hand is numbered into the day it belongs to.
		code := strings.TrimSpace(item.Code)
		child, err = base.child(name, false)
		if err != nil {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, err.Error()})
			continue
		}
		// Import is the write boundary. A stale scan or invalid folder must
		// not initialize a board during its read-only validation phase.
		if !cc.cockpit.ID.Valid {
			initialized, allowed := h.requireCockpit(w, r)
			if !allowed {
				_ = child.Close()
				return
			}
			cc = initialized
		}
		verifyErr := child.verify()
		_ = child.Close()
		if verifyErr != nil {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, verifyErr.Error()})
			continue
		}
		created, err := h.createCockpitMeetingRecord(ctx, db.CreateCockpitMeetingParams{
			WorkspaceID:     cc.workspaceID,
			CockpitID:       cc.cockpit.ID,
			MeetDate:        meetDate,
			Title:           title,
			Code:            code,
			Parties:         strings.TrimSpace(item.Parties),
			Kind:            strings.TrimSpace(item.Kind),
			NasDir:          path,
			Detected:        true,
			OccurrenceState: "unconfirmed",
		}, true, pgtype.UUID{}, &cockpitCreationCommand{WorkspaceID: cc.workspaceID, ActorID: cc.member.UserID, Kind: "meeting"})
		if errors.Is(err, errCockpitMeetingDirectoryRecorded) {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "already in the register"})
			continue
		}
		if err != nil {
			slog.Warn("import meeting folder failed", append(logger.RequestAttrs(r), "error", err)...)
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "failed to record the meeting"})
			continue
		}
		meeting := created.Meeting
		recorded[path] = true

		result := h.provisionLegacyCockpitDirectory(r, cc, meeting.ID, path)
		resp.DirectoryResults = append(resp.DirectoryResults, CockpitMeetingImportDirectoryResult{Name: item.Name, MeetingID: uuidToString(meeting.ID), DirectoryOperationID: result.OperationID, DirectoryState: result.State, DirCreated: result.BaseReady, DirError: result.ErrorMessage, DirErrorCode: result.ErrorCode})

		row := cockpitMeetingToResponse(meeting)
		resp.Meetings = append(resp.Meetings, row)
		h.publishCockpit(r, cc, "meeting", "created", row)

		if createTask {
			link, taskErr := h.openMeetingTask(r, cc, meeting, meetingTaskPlacement{
				projectID:  projectID,
				moduleID:   moduleID,
				nodeID:     nodeID,
				codePrefix: codePrefix,
				dir:        path,
			})
			if taskErr != "" {
				resp.TaskErrors = append(resp.TaskErrors, CockpitMeetingImportTaskError{Name: item.Name, MeetingID: uuidToString(meeting.ID), Error: taskErr})
			} else if link != nil {
				resp.Issues = append(resp.Issues, *link)
				// Another client may already have appended a reference after
				// meeting creation. This receipt is not a replacement list.
				h.publishCockpitReference(r, cc, "meeting_issues", CockpitMeetingIssueLinkReceipt{
					WorkspaceID: uuidToString(cc.workspaceID), MeetingID: uuidToString(meeting.ID), Link: *link,
				})
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
