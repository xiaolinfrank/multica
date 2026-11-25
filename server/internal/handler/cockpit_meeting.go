package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/localpaths"
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
