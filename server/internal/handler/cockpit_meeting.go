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
//  3. the folder its material goes in, on the shared NAS under the project's
//     collaboration space.
//
// Only (1) is guaranteed to succeed. A NAS that is not mounted on this host,
// or a project with no collaboration space, must not cost someone the record
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

// childDirNamed finds the folder inside parent that answers to want, matched
// without the spacing the platform and the share disagree about. Returns ""
// when parent cannot be read — an unmounted share, or a folder nobody has
// created yet — which the caller answers with a proposal.
func childDirNamed(parent, want string) string {
	entries, err := os.ReadDir(parent)
	if err != nil {
		return ""
	}
	target := normalizeDirMatch(want)
	for _, entry := range entries {
		if entry.IsDir() && normalizeDirMatch(entry.Name()) == target {
			return entry.Name()
		}
	}
	return ""
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

// meetingBaseDir answers "which folder do this board's meeting folders go in".
//
// A board that has confirmed a folder uses it, full stop. Otherwise the answer
// is derived by walking down from the project's collaboration space: the
// folder that answers to the module, then the folder that answers to the
// archive sub-item ("06.06.03 会议纪要与素材"). Both are matched by name,
// because those directories are found by name rather than stored (see
// migration 928). The derivation is a SUGGESTION: it is returned to the
// caller to show and confirm, and only a confirmed value is stored.
func (h *Handler) meetingBaseDir(
	ctx context.Context,
	cc cockpitContext,
	projectID, moduleID, nodeID pgtype.UUID,
) (meetingDirPlan, error) {
	if confirmed := strings.TrimSpace(cc.cockpit.MeetingDir); confirmed != "" {
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

	descend := func(want string) error {
		name := childDirNamed(plan.Dir, want)
		if name == "" {
			// Nothing answers to it yet — name the folder the way the share
			// names the others and let the caller see the path before
			// anything is created.
			name = sanitizeMeetingFolderName(collabFolderName(want))
		}
		if name == "" {
			return errors.New("the meeting destination has no folder name")
		}
		plan.Dir = filepath.Join(plan.Dir, name)
		return nil
	}

	if moduleID.Valid {
		module, err := h.Queries.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{
			ID: moduleID, WorkspaceID: cc.workspaceID,
		})
		if err != nil {
			return meetingDirPlan{}, errors.New("meeting module not found in this workspace")
		}
		if err := descend(module.Title); err != nil {
			return meetingDirPlan{}, err
		}
	}
	if nodeID.Valid {
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
			ID: nodeID, WorkspaceID: cc.workspaceID,
		})
		if err != nil {
			return meetingDirPlan{}, errors.New("meeting sub-item not found on this board")
		}
		if err := descend(strings.TrimSpace(node.Code + " " + node.Name)); err != nil {
			return meetingDirPlan{}, err
		}
	}
	return plan, nil
}

// ensureMeetingBase creates the folders between root and dir that are not
// there yet, one level at a time.
//
// Root itself is never created. Everything below it is fair game: an archive
// sub-item that nobody has made a folder for is an ordinary state of a share
// that IS mounted, and refusing to file a meeting over it would send someone
// to Finder to create one empty directory.
func ensureMeetingBase(root, dir string) error {
	root = filepath.Clean(strings.TrimSpace(root))
	dir = filepath.Clean(strings.TrimSpace(dir))
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return fmt.Errorf("meeting folder root is unavailable: %s", root)
	}
	if dir == root {
		return nil
	}
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("meeting folder would fall outside its root")
	}
	current := root
	for _, component := range strings.Split(rel, string(os.PathSeparator)) {
		next, err := createMeetingDir(current, component)
		if err != nil {
			return err
		}
		current = next
	}
	return nil
}

// createMeetingDir creates one folder under base and returns its path.
//
// The name is sanitised to a single component and the result is re-checked
// against base after cleaning, so a title full of separators still cannot
// address anything outside the folder the board configured. Creating a folder
// that already exists is success: provisioning is re-runnable.
func createMeetingDir(base, name string) (string, error) {
	base = filepath.Clean(strings.TrimSpace(base))
	if !isAbsoluteCollabPath(base) {
		return "", fmt.Errorf("meeting folder root is not an absolute path: %s", base)
	}
	component := sanitizeMeetingFolderName(name)
	if component == "" {
		return "", errors.New("meeting folder name is empty")
	}
	target := filepath.Clean(filepath.Join(base, component))
	if target != base && !strings.HasPrefix(target, base+string(os.PathSeparator)) {
		return "", errors.New("meeting folder would fall outside its root")
	}
	info, err := os.Stat(base)
	if err != nil || !info.IsDir() {
		// A root that is not there is almost always an unmounted share. Only
		// the leaf is ever created, never the chain: MkdirAll would answer an
		// unmounted /Volumes by silently building the mount point as local
		// directories, and material written into it then vanishes the next
		// time the share mounts over it.
		return "", fmt.Errorf("meeting folder root is unavailable: %s", base)
	}
	if err := os.Mkdir(target, 0o755); err != nil && !os.IsExist(err) {
		return "", fmt.Errorf("create meeting folder: %w", err)
	}
	return target, nil
}

// meetingSubdirs are the drawers every meeting folder is given. Three fixed
// names, so material lands in the same place whoever files it and whoever
// goes looking for it a year later knows where to look.
var meetingSubdirs = []string{"会议纪要与录音转写", "会议材料", "照片"}

// createMeetingSubdirs fills a meeting folder with its drawers.
//
// Re-runnable like the folder itself: drawers that are already there are
// left alone, and one that was renamed or removed by hand comes back. The
// error names what could not be created rather than stopping at the first
// failure — a share that half-answers should report both.
func createMeetingSubdirs(dir string) error {
	var failed []string
	for _, name := range meetingSubdirs {
		if _, err := createMeetingDir(dir, name); err != nil {
			failed = append(failed, name)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("meeting subfolders not created: %s", strings.Join(failed, ", "))
	}
	return nil
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

// GetCockpitMeetingDestination reports where a new meeting would be filed,
// for the create form to show BEFORE anything is created. Query parameters
// override the board's stored choice so the form can preview a different
// project or module while someone is still picking one.
func (h *Handler) GetCockpitMeetingDestination(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	projectID := cc.cockpit.MeetingProjectID
	if v := strings.TrimSpace(r.URL.Query().Get("project_id")); v != "" {
		id, err := util.ParseUUID(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid project_id")
			return
		}
		projectID = id
	}
	moduleID := cc.cockpit.MeetingModuleID
	if v := strings.TrimSpace(r.URL.Query().Get("module_id")); v != "" {
		id, err := util.ParseUUID(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid module_id")
			return
		}
		moduleID = id
	}
	nodeID := cc.cockpit.MeetingNodeID
	if _, sent := r.URL.Query()["node_id"]; sent {
		v := strings.TrimSpace(r.URL.Query().Get("node_id"))
		nodeID = pgtype.UUID{}
		if v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid node_id")
				return
			}
			nodeID = id
		}
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
	if info, statErr := os.Stat(plan.Dir); statErr == nil && info.IsDir() {
		resp.BaseDirExists = true
	}
	if info, statErr := os.Stat(plan.Root); statErr == nil && info.IsDir() {
		resp.Creatable = true
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
	TaskError  string `json:"task_error"`
	Dir        string `json:"dir"`
	DirCreated bool   `json:"dir_created"`
	DirError   string `json:"dir_error"`
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

	projectID := cc.cockpit.MeetingProjectID
	if req.ProjectID != nil && strings.TrimSpace(*req.ProjectID) != "" {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*req.ProjectID), "project_id")
		if !ok {
			return
		}
		projectID = id
	}
	moduleID := cc.cockpit.MeetingModuleID
	if req.ModuleID != nil && strings.TrimSpace(*req.ModuleID) != "" {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*req.ModuleID), "module_id")
		if !ok {
			return
		}
		moduleID = id
	}
	nodeID := cc.cockpit.MeetingNodeID
	if req.NodeID != nil {
		nodeID = pgtype.UUID{}
		if v := strings.TrimSpace(*req.NodeID); v != "" {
			id, ok := parseUUIDOrBadRequest(w, v, "node_id")
			if !ok {
				return
			}
			nodeID = id
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
			// A caller that names the folder itself is taken at its word, but
			// still only allowed to create BELOW the collaboration space the
			// plan resolved — never to build a mount point out of thin air.
			plan.Dir = filepath.Clean(strings.TrimSpace(*req.BaseDir))
			if plan.Root == "" || !strings.HasPrefix(plan.Dir, filepath.Clean(plan.Root)+string(os.PathSeparator)) {
				plan.Root = plan.Dir
			}
			resp.DirError = ""
		}
		if resp.DirError == "" {
			name := meetingFolderName(meeting)
			if req.FolderName != nil && strings.TrimSpace(*req.FolderName) != "" {
				name = strings.TrimSpace(*req.FolderName)
			}
			if baseErr := ensureMeetingBase(plan.Root, plan.Dir); baseErr != nil {
				resp.DirError = baseErr.Error()
			} else if created, dirErr := createMeetingDir(plan.Dir, name); dirErr != nil {
				resp.DirError = dirErr.Error()
			} else {
				dir = created
				resp.Dir = created
				resp.DirCreated = true
				// Not fatal: the folder is what the register points at, and a
				// drawer that is missing is one anyone can add in Finder.
				if subErr := createMeetingSubdirs(created); subErr != nil {
					slog.Warn("createMeetingSubdirs failed",
						append(logger.RequestAttrs(r), "error", subErr, "dir", created)...)
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
	if dir != meeting.NasDir && dir != "" {
		updated, err := h.Queries.UpdateCockpitMeeting(ctx, db.UpdateCockpitMeetingParams{
			ID:          meeting.ID,
			WorkspaceID: cc.workspaceID,
			NasDir:      pgtype.Text{String: dir, Valid: true},
		})
		if err != nil {
			slog.Warn("UpdateCockpitMeeting nas_dir failed", append(logger.RequestAttrs(r), "error", err)...)
		} else {
			meeting = updated
		}
	}
	if boolOrDefault(req.Remember, true) && (projectID.Valid || moduleID.Valid) {
		params := db.UpdateCockpitParams{ID: cc.cockpit.ID, WorkspaceID: cc.workspaceID}
		params.MeetingProjectID = projectID
		params.MeetingModuleID = moduleID
		params.MeetingNodeID = nodeID
		params.ClearMeetingNode = !nodeID.Valid
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
	resp.Issues = h.meetingIssueLinks(ctx, cc, meeting.ID)
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
	result, err := h.IssueService.Create(ctx, service.IssueCreateParams{
		WorkspaceID:  cc.workspaceID,
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

	if _, err := h.Queries.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
		WorkspaceID: cc.workspaceID,
		MeetingID:   meeting.ID,
		IssueID:     result.Issue.ID,
		Role:        "task",
		Position:    -1, // the meeting's own task leads its list of issues
	}); err != nil {
		slog.Warn("CreateCockpitMeetingIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		return nil, "the task was opened but could not be linked to the meeting"
	}

	// File the task under the archive sub-item as well. Its number was already
	// in the title, which is how it reads in an inbox; the link is what puts
	// it under that item on the board and in the issue's own sidebar. Not
	// fatal: a task that exists but is not filed is recoverable by hand, and
	// refusing the meeting over it is not.
	if placement.nodeID.Valid {
		if _, err := h.Queries.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{
			WorkspaceID: cc.workspaceID,
			NodeID:      placement.nodeID,
			IssueID:     result.Issue.ID,
			Position:    0,
		}); err != nil {
			slog.Warn("CreateCockpitNodeIssue for meeting task failed",
				append(logger.RequestAttrs(r), "error", err)...)
		}
	}

	return &CockpitMeetingIssueResponse{
		MeetingID:       uuidToString(meeting.ID),
		IssueID:         uuidToString(result.Issue.ID),
		Role:            "task",
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
func (h *Handler) meetingIssueLinks(ctx context.Context, cc cockpitContext, meetingID pgtype.UUID) []CockpitMeetingIssueResponse {
	rows, err := h.Queries.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
	if err != nil {
		return []CockpitMeetingIssueResponse{}
	}
	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	out := make([]CockpitMeetingIssueResponse, 0, len(rows))
	for _, row := range rows {
		if row.MeetingID != meetingID {
			continue
		}
		out = append(out, cockpitMeetingIssueToResponse(row, prefix))
	}
	return out
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

	// A link's role ("task" — the meeting's own issue) is a property of the
	// pair, not of this request: a picker re-sending the set has no way to
	// know about it. Dropping it would leave the meeting looking task-less and
	// offer to provision a second one.
	roles := map[string]string{}
	if existing, err := h.Queries.ListCockpitMeetingIssues(ctx, cc.cockpit.ID); err == nil {
		for _, row := range existing {
			if row.MeetingID == meeting.ID && row.Role != "" {
				roles[uuidToString(row.IssueID)] = row.Role
			}
		}
	}

	if req.Replace {
		if err := h.Queries.DeleteCockpitMeetingIssuesByMeeting(ctx, db.DeleteCockpitMeetingIssuesByMeetingParams{
			MeetingID:   meeting.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitMeetingIssuesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}
	for i, issueID := range resolved {
		if _, err := h.Queries.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
			WorkspaceID: cc.workspaceID,
			MeetingID:   meeting.ID,
			IssueID:     issueID,
			Role:        roles[uuidToString(issueID)],
			Position:    float64(i),
		}); err != nil {
			slog.Warn("CreateCockpitMeetingIssue failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}

	payload := map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"links":      h.meetingIssueLinks(ctx, cc, meeting.ID),
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
	if err := h.Queries.DeleteCockpitMeetingIssue(r.Context(), db.DeleteCockpitMeetingIssueParams{
		MeetingID:   meeting.ID,
		IssueID:     issue.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink issue")
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

	if req.Replace {
		if err := h.Queries.DeleteCockpitMeetingNodesByMeeting(ctx, db.DeleteCockpitMeetingNodesByMeetingParams{
			MeetingID:   meeting.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitMeetingNodesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link work items")
			return
		}
	}
	for i, nodeID := range resolved {
		if _, err := h.Queries.CreateCockpitMeetingNode(ctx, db.CreateCockpitMeetingNodeParams{
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

	links, err := h.Queries.ListCockpitMeetingNodes(ctx, cc.cockpit.ID)
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
	if err := h.Queries.DeleteCockpitMeetingNode(r.Context(), db.DeleteCockpitMeetingNodeParams{
		MeetingID:   meeting.ID,
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink work item")
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
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	ctx := r.Context()

	projectID := cc.cockpit.MeetingProjectID
	if v := strings.TrimSpace(r.URL.Query().Get("project_id")); v != "" {
		id, err := util.ParseUUID(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid project_id")
			return
		}
		projectID = id
	}
	moduleID := cc.cockpit.MeetingModuleID
	if v := strings.TrimSpace(r.URL.Query().Get("module_id")); v != "" {
		id, err := util.ParseUUID(v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid module_id")
			return
		}
		moduleID = id
	}
	nodeID := cc.cockpit.MeetingNodeID
	if _, sent := r.URL.Query()["node_id"]; sent {
		v := strings.TrimSpace(r.URL.Query().Get("node_id"))
		nodeID = pgtype.UUID{}
		if v != "" {
			id, err := util.ParseUUID(v)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid node_id")
				return
			}
			nodeID = id
		}
	}

	resp := CockpitMeetingScanResponse{Entries: []CockpitMeetingScanEntry{}}
	plan, err := h.meetingBaseDir(ctx, cc, projectID, moduleID, nodeID)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDir = plan.Dir

	entries, err := os.ReadDir(plan.Dir)
	if err != nil {
		resp.Error = fmt.Sprintf("the archive folder cannot be read here: %s", plan.Dir)
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDirExists = true

	meetings, err := h.Queries.ListCockpitMeetings(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetings failed", append(logger.RequestAttrs(r), "error", err)...)
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
		if name := normalizeDirMatch(meetingFolderName(m)); name != "" {
			byName[name] = uuidToString(m.ID)
		}
	}

	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if len(resp.Entries) >= meetingScanLimit {
			resp.Truncated = true
			break
		}
		path := filepath.Join(plan.Dir, entry.Name())
		guess := parseMeetingFolderName(entry.Name())
		row := CockpitMeetingScanEntry{
			Name:     entry.Name(),
			Path:     path,
			Code:     guess.Code,
			MeetDate: guess.MeetDate,
			Parties:  guess.Parties,
			Title:    guess.Title,
		}
		if id, found := byDir[path]; found {
			row.MeetingID = id
		} else if id, found := byName[normalizeDirMatch(entry.Name())]; found {
			row.MeetingID = id
		}
		if row.MeetingID != "" {
			resp.Matched++
		}
		if info, statErr := entry.Info(); statErr == nil {
			row.ModifiedAt = info.ModTime().UTC().Format(time.RFC3339)
		}
		if inner, readErr := os.ReadDir(path); readErr == nil {
			for _, child := range inner {
				if !strings.HasPrefix(child.Name(), ".") {
					row.Files++
				}
			}
		}
		resp.Entries = append(resp.Entries, row)
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
	Items []CockpitMeetingImportItem `json:"items"`
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

type CockpitMeetingImportResponse struct {
	Meetings []CockpitMeetingResponse      `json:"meetings"`
	Issues   []CockpitMeetingIssueResponse `json:"issues"`
	// Folders that were asked for and not imported, each with why. Reported
	// rather than failing the batch: one folder that disappeared between the
	// scan and the import must not cost the other nine.
	Skipped []CockpitMeetingImportSkip `json:"skipped"`
}

// ImportCockpitMeetingFolders turns archive folders into meeting rows.
func (h *Handler) ImportCockpitMeetingFolders(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
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

	projectID := cc.cockpit.MeetingProjectID
	if req.ProjectID != nil && strings.TrimSpace(*req.ProjectID) != "" {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*req.ProjectID), "project_id")
		if !ok {
			return
		}
		projectID = id
	}
	moduleID := cc.cockpit.MeetingModuleID
	if req.ModuleID != nil && strings.TrimSpace(*req.ModuleID) != "" {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*req.ModuleID), "module_id")
		if !ok {
			return
		}
		moduleID = id
	}
	nodeID := cc.cockpit.MeetingNodeID
	if req.NodeID != nil {
		nodeID = pgtype.UUID{}
		if v := strings.TrimSpace(*req.NodeID); v != "" {
			id, ok := parseUUIDOrBadRequest(w, v, "node_id")
			if !ok {
				return
			}
			nodeID = id
		}
	}

	plan, err := h.meetingBaseDir(ctx, cc, projectID, moduleID, nodeID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	existing, err := h.Queries.ListCockpitMeetings(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetings failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load meetings")
		return
	}
	recorded := make(map[string]bool, len(existing))
	for _, m := range existing {
		if dir := strings.TrimSpace(m.NasDir); dir != "" {
			recorded[filepath.Clean(dir)] = true
		}
	}

	codePrefix := h.meetingNodeCode(ctx, cc, nodeID)
	createTask := req.CreateTask != nil && *req.CreateTask
	resp := CockpitMeetingImportResponse{
		Meetings: []CockpitMeetingResponse{},
		Issues:   []CockpitMeetingIssueResponse{},
		Skipped:  []CockpitMeetingImportSkip{},
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
		if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "folder no longer exists"})
			continue
		}
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
		if code == "" && meetDate.Valid {
			code = nextMeetingCode(existing, meetDate.Time)
		}
		meeting, err := h.Queries.CreateCockpitMeeting(ctx, db.CreateCockpitMeetingParams{
			WorkspaceID: cc.workspaceID,
			CockpitID:   cc.cockpit.ID,
			MeetDate:    meetDate,
			Title:       title,
			Code:        code,
			Parties:     strings.TrimSpace(item.Parties),
			Kind:        strings.TrimSpace(item.Kind),
			NasDir:      path,
			Detected:    true,
		})
		if err != nil {
			slog.Warn("import meeting folder failed", append(logger.RequestAttrs(r), "error", err)...)
			resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, "failed to record the meeting"})
			continue
		}
		recorded[path] = true
		existing = append(existing, meeting)

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
				resp.Skipped = append(resp.Skipped, CockpitMeetingImportSkip{item.Name, taskErr})
			} else if link != nil {
				resp.Issues = append(resp.Issues, *link)
				// One announcement per meeting: the link scope is keyed on a
				// single meeting_id, and a batch payload would be dropped.
				h.publishCockpit(r, cc, "meeting_issues", "provisioned", map[string]any{
					"meeting_id": uuidToString(meeting.ID),
					"links":      []CockpitMeetingIssueResponse{*link},
				})
			}
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
