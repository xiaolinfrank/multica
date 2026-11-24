package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/collabfs"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The plan's folders inside a project's collaboration space. A module owns
// `<collab>/<code><title>`; a work item owns a folder inside its module; an
// issue's delivery folder sits inside its work item (or module, or project).
//
// Two rules hold the whole thing together:
//
//   - a folder's name is the row's address plus its title (`04.01确权线`), so a
//     renumber renames the folder and a rename moves nothing else;
//   - `module.directory_name` and the module's L2 `cockpit_node.directory_name`
//     are always the same string. The module is what the panel edits, the row
//     is what the tree reads; letting them drift is what produced the random
//     `title--ab12cd34` folders this replaces.
//
// Nothing here runs on a tree read. The tree composes paths from data it
// already has; only the directory panel, the fill pass and a rename ask the
// disk anything.

// DirectorySyncMode says what a structural edit does about the folder it
// affects. "sync" is the default: refuse the edit while an agent is working in
// the folder, and otherwise rename it with the row. "defer" edits the row and
// leaves the folder alone (the panel then offers to sync it). "force" renames
// even while an agent is working.
type DirectorySyncMode string

const (
	DirectorySyncSync  DirectorySyncMode = "sync"
	DirectorySyncDefer DirectorySyncMode = "defer"
	DirectorySyncForce DirectorySyncMode = "force"
)

// parseDirectorySyncMode reads the optional body field. An unknown value is a
// caller error rather than a silent default: the difference between "defer"
// and "sync" is a rename on someone's NAS.
func parseDirectorySyncMode(raw map[string]json.RawMessage) (DirectorySyncMode, bool) {
	value, present := raw["directory_sync"]
	if !present {
		return DirectorySyncSync, true
	}
	var mode string
	if err := json.Unmarshal(value, &mode); err != nil {
		return "", false
	}
	switch DirectorySyncMode(strings.TrimSpace(mode)) {
	case "", DirectorySyncSync:
		return DirectorySyncSync, true
	case DirectorySyncDefer:
		return DirectorySyncDefer, true
	case DirectorySyncForce:
		return DirectorySyncForce, true
	default:
		return "", false
	}
}

// RunningTaskRef is one queued/dispatched/running agent task that would have a
// folder renamed under it.
type RunningTaskRef struct {
	TaskID          string `json:"task_id"`
	IssueID         string `json:"issue_id"`
	IssueIdentifier string `json:"issue_identifier"`
	Status          string `json:"status"`
}

// SharedCollabProject names another project that points at the same
// collaboration root. Writing into a folder another workspace also owns is the
// caller's decision to make knowingly.
type SharedCollabProject struct {
	WorkspaceID   string `json:"workspace_id"`
	WorkspaceSlug string `json:"workspace_slug"`
	WorkspaceName string `json:"workspace_name"`
	ProjectID     string `json:"project_id"`
	ProjectTitle  string `json:"project_title"`
}

// NodeDirectorySync is the outcome of one folder operation.
type NodeDirectorySync struct {
	// Status is created | renamed | ok | skipped | failed.
	Status        string `json:"status"`
	DirectoryName string `json:"directory_name,omitempty"`
	FromDirectory string `json:"from_directory,omitempty"`
	ToDirectory   string `json:"to_directory,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Error         string `json:"error,omitempty"`
}

// PlanDirectoryStatus is the on-demand view of one row's folder.
type PlanDirectoryStatus struct {
	NodeID                string                `json:"node_id"`
	Kind                  string                `json:"kind"`
	ProjectID             string                `json:"project_id"`
	ProjectCollabPath     *string               `json:"project_collab_path"`
	DirectoryName         *string               `json:"directory_name"`
	ExpectedDirectoryName *string               `json:"expected_directory_name"`
	FullPath              *string               `json:"full_path"`
	Status                string                `json:"status"`
	RunningTasks          []RunningTaskRef      `json:"running_tasks"`
	SharedCollabProjects  []SharedCollabProject `json:"shared_collab_projects"`
	Error                 string                `json:"error,omitempty"`
}

// planDirectory is everything needed to place one row on disk.
type planDirectory struct {
	node      db.CockpitNode
	kind      string
	project   db.Project
	module    *db.Module
	moduleRow *db.CockpitNode

	// directoryName is the folder the row currently names ("" = none yet);
	// expected is the name the row's address and title call for.
	directoryName string
	expected      string
	// segments are the path components below the collaboration root.
	segments []string
	// blocked explains why a path cannot be composed at all.
	blocked string
}

// fullPath joins the collaboration root and the row's segments.
func (p planDirectory) fullPath() string {
	collabPath := strings.TrimSpace(p.project.CollabPath.String)
	if !p.project.CollabPath.Valid || collabPath == "" || len(p.segments) == 0 || p.blocked != "" {
		return ""
	}
	return filepath.Join(append([]string{collabPath}, p.segments...)...)
}

// loadPlanDirectory resolves one row's chain. It reads the module and project
// rows because that is where titles and the collaboration root live; it never
// touches the filesystem.
func (h *Handler) loadPlanDirectory(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, node db.CockpitNode) (planDirectory, error) {
	out := planDirectory{node: node}
	moduleRow := node
	if node.ParentID.Valid {
		parent, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: node.ParentID, WorkspaceID: workspaceID})
		if err != nil {
			return out, err
		}
		if parent.ParentID.Valid {
			// A row under a module row is a work item; its module lives on the
			// parent.
			out.kind = "work_item"
			moduleRow = parent
		} else {
			// A row under the project root IS the module row.
			out.kind = "module"
		}
	} else {
		out.kind = "project"
	}
	out.moduleRow = &moduleRow

	projectID := node.ProjectID
	if !projectID.Valid {
		projectID = moduleRow.ProjectID
	}
	if !projectID.Valid {
		out.blocked = "the row is not filed into a project"
		return out, nil
	}
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID})
	if err != nil {
		return out, err
	}
	out.project = project
	if out.kind == "project" {
		return out, nil
	}

	moduleID := moduleRow.ModuleID
	if !moduleID.Valid {
		out.blocked = "the module row carries no module"
		return out, nil
	}
	module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: moduleID, WorkspaceID: workspaceID})
	if err != nil {
		return out, err
	}
	out.module = &module

	switch out.kind {
	case "module":
		out.directoryName = module.DirectoryName.String
		if !module.DirectoryName.Valid || out.directoryName == "" {
			out.directoryName = node.DirectoryName.String
		}
		out.expected = collabfs.SanitizeFolderName(node.Code+module.Title, 0)
		if out.directoryName != "" {
			out.segments = []string{out.directoryName}
		}
	case "work_item":
		out.directoryName = node.DirectoryName.String
		out.expected = collabfs.SanitizeFolderName(node.Code+node.Name, 0)
		moduleDir := module.DirectoryName.String
		if moduleDir == "" {
			out.blocked = "the module has no folder name yet"
		} else if out.directoryName != "" {
			out.segments = []string{moduleDir, out.directoryName}
		}
	}
	return out, nil
}

// runningTask is the common shape of the three running-task queries; they
// differ only in how they select issues.
type runningTask struct {
	taskID      pgtype.UUID
	issueID     pgtype.UUID
	issueNumber int32
	status      string
}

// runningTasksForNode lists the queued/dispatched/running agent tasks that
// would be disturbed by renaming this row's folder.
func (h *Handler) runningTasksForNode(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory) ([]RunningTaskRef, error) {
	var rows []runningTask
	switch pd.kind {
	case "module":
		if pd.module == nil {
			return nil, nil
		}
		found, err := q.ListRunningAgentTasksForModules(ctx, db.ListRunningAgentTasksForModulesParams{
			WorkspaceID: workspaceID, ModuleIds: []pgtype.UUID{pd.module.ID},
		})
		if err != nil {
			return nil, err
		}
		for _, row := range found {
			rows = append(rows, runningTask{row.TaskID, row.IssueID, row.IssueNumber, row.Status})
		}
	case "work_item":
		found, err := q.ListRunningAgentTasksForWorkItems(ctx, db.ListRunningAgentTasksForWorkItemsParams{
			WorkspaceID: workspaceID, WorkItemIds: []pgtype.UUID{pd.node.ID},
		})
		if err != nil {
			return nil, err
		}
		for _, row := range found {
			rows = append(rows, runningTask{row.TaskID, row.IssueID, row.IssueNumber, row.Status})
		}
	}
	return h.runningTaskRefs(ctx, workspaceID, rows), nil
}

func (h *Handler) runningTaskRefs(ctx context.Context, workspaceID pgtype.UUID, rows []runningTask) []RunningTaskRef {
	prefix := h.getIssuePrefix(ctx, workspaceID)
	out := make([]RunningTaskRef, 0, len(rows))
	for _, row := range rows {
		out = append(out, RunningTaskRef{
			TaskID:          uuidToString(row.taskID),
			IssueID:         uuidToString(row.issueID),
			IssueIdentifier: prefix + "-" + strconv.Itoa(int(row.issueNumber)),
			Status:          row.status,
		})
	}
	return out
}

// sharedCollabProjects lists other projects pointed at the same root.
func (h *Handler) sharedCollabProjects(ctx context.Context, q *db.Queries, projectID pgtype.UUID, collabPath string) []SharedCollabProject {
	out := []SharedCollabProject{}
	normalized := foldCollabPath(collabPath)
	if normalized == "" {
		return out
	}
	rows, err := q.ListProjectsWithCollabPath(ctx)
	if err != nil {
		return out
	}
	for _, row := range rows {
		if row.ProjectID == projectID {
			continue
		}
		if foldCollabPath(row.CollabPath.String) != normalized {
			continue
		}
		out = append(out, SharedCollabProject{
			WorkspaceID:   uuidToString(row.WorkspaceID),
			WorkspaceSlug: row.WorkspaceSlug,
			WorkspaceName: row.WorkspaceName,
			ProjectID:     uuidToString(row.ProjectID),
			ProjectTitle:  row.ProjectTitle,
		})
	}
	return out
}

// foldCollabPath is the comparison form of a collaboration root: two projects
// point at the same folder when they agree once spacing, a trailing separator
// and letter case are ignored.
func foldCollabPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	return strings.ToLower(filepath.Clean(trimmed))
}

// planDirectoryStatus answers what the panel shows, without writing anything.
func (h *Handler) planDirectoryStatus(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory) PlanDirectoryStatus {
	out := PlanDirectoryStatus{
		NodeID:               uuidToString(pd.node.ID),
		Kind:                 pd.kind,
		ProjectID:            uuidToString(pd.project.ID),
		RunningTasks:         []RunningTaskRef{},
		SharedCollabProjects: h.sharedCollabProjects(ctx, q, pd.project.ID, pd.project.CollabPath.String),
	}
	if pd.project.CollabPath.Valid && strings.TrimSpace(pd.project.CollabPath.String) != "" {
		path := pd.project.CollabPath.String
		out.ProjectCollabPath = &path
	}
	if pd.kind == "project" {
		if out.ProjectCollabPath == nil {
			out.Status = "no_collab_path"
			return out
		}
		path := strings.TrimSpace(pd.project.CollabPath.String)
		out.FullPath = &path
		switch code, _ := collabfs.StatDir(path); code {
		case collabfs.StatOK:
			out.Status = "ok"
		case collabfs.StatMissing:
			out.Status = "missing"
		case collabfs.StatNoRoot:
			out.Status = "root_unavailable"
		default:
			out.Status = "invalid"
		}
		return out
	}
	if pd.directoryName != "" {
		name := pd.directoryName
		out.DirectoryName = &name
	}
	if pd.expected != "" {
		name := pd.expected
		out.ExpectedDirectoryName = &name
	}
	if tasks, err := h.runningTasksForNode(ctx, q, workspaceID, pd); err == nil {
		out.RunningTasks = append(out.RunningTasks, tasks...)
	}
	if out.ProjectCollabPath == nil {
		out.Status = "no_collab_path"
		return out
	}
	if pd.blocked != "" {
		out.Status = "invalid"
		out.Error = pd.blocked
		return out
	}
	if pd.directoryName == "" {
		out.Status = "missing"
		return out
	}
	if full := pd.fullPath(); full != "" {
		out.FullPath = &full
	}
	// The disk decides first: a folder that is not there is "missing" (or
	// "root_unavailable"), whatever its name would have been. Comparing names
	// before asking the share is what showed "name mismatch" plus a working
	// "open" button for a folder that does not exist.
	switch code, err := collabfs.StatDir(strings.TrimSpace(pd.project.CollabPath.String), pd.segments...); code {
	case collabfs.StatOK:
		if pd.expected != "" && !collabfs.DirectoryNameMatches(pd.directoryName, pd.expected) {
			out.Status = "name_mismatch"
			return out
		}
		out.Status = "ok"
	case collabfs.StatMissing:
		out.Status = "missing"
	case collabfs.StatNoRoot:
		out.Status = "root_unavailable"
		out.Error = errString(err)
	default:
		out.Status = "invalid"
		out.Error = errString(err)
	}
	return out
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// writePlanDirectoryName stores the folder name on the row that owns the
// folder. A module row's L2 carries the same name as the module record; a work
// item's own row carries it and nothing else does.
func writePlanDirectoryName(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory, name string) error {
	rowID := pd.node.ID
	if pd.kind == "module" {
		if pd.module != nil {
			if err := q.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{
				WorkspaceID: workspaceID, ID: pd.module.ID, DirectoryName: name,
			}); err != nil {
				return err
			}
		}
		if pd.moduleRow != nil {
			rowID = pd.moduleRow.ID
		}
	}
	if err := q.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{
		WorkspaceID: workspaceID, ID: rowID, DirectoryName: name,
	}); err != nil {
		return err
	}
	return nil
}

// siblingFolders lists the folder names already used beside this row, from the
// database (rows whose folder has not been created yet) and the disk.
func siblingFolders(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory) []string {
	names := make([]string, 0, 8)
	if pd.kind == "module" {
		modules, err := q.ListModules(ctx, db.ListModulesParams{WorkspaceID: workspaceID, ProjectID: pd.project.ID})
		if err == nil {
			for _, module := range modules {
				if module.ID != pd.module.ID && module.DirectoryName.Valid {
					names = append(names, module.DirectoryName.String)
				}
			}
		}
	} else if pd.moduleRow != nil {
		nodes, err := q.ListCockpitNodes(ctx, pd.node.CockpitID)
		if err == nil {
			for _, child := range nodes {
				if child.ID != pd.node.ID && child.ParentID == pd.moduleRow.ID && child.DirectoryName.Valid {
					names = append(names, child.DirectoryName.String)
				}
			}
		}
	}
	return names
}

// applyPlanDirectory creates or renames one row's folder to the expected name.
// It never deletes anything: a name that is already on disk is adopted, not
// overwritten.
func (h *Handler) applyPlanDirectory(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory, fromSegments []string, force bool) NodeDirectorySync {
	result := NodeDirectorySync{DirectoryName: pd.directoryName}
	collabPath := strings.TrimSpace(pd.project.CollabPath.String)
	if !pd.project.CollabPath.Valid || collabPath == "" {
		// Nothing on disk to create or move, but the row still names its
		// folder: a project that has not been given a collaboration space must
		// not leave a stale name behind after a rename.
		if pd.expected != "" && pd.directoryName != pd.expected {
			if err := writePlanDirectoryName(ctx, q, workspaceID, pd, pd.expected); err != nil {
				result.Status, result.Error = "failed", err.Error()
				return result
			}
			result.Status, result.Reason = "renamed", "no_collab_space"
			result.DirectoryName = pd.expected
			result.FromDirectory, result.ToDirectory = pd.directoryName, pd.expected
			return result
		}
		result.Status, result.Reason = "skipped", "no_collab_space"
		return result
	}
	if pd.blocked != "" {
		result.Status, result.Reason, result.Error = "failed", "blocked", pd.blocked
		return result
	}
	if pd.expected == "" {
		result.Status, result.Reason = "failed", "no_expected_name"
		return result
	}
	if !force {
		// Only a rename disturbs work in the folder. Creating a missing one
		// (or confirming an existing one) touches nothing an agent has open.
		needsRename := pd.directoryName != "" && pd.expected != "" && !collabfs.DirectoryNameMatches(pd.directoryName, pd.expected)
		if needsRename {
			tasks, err := h.runningTasksForNode(ctx, q, workspaceID, pd)
			if err != nil {
				result.Status, result.Error = "failed", err.Error()
				return result
			}
			if len(tasks) > 0 {
				result.Status, result.Reason = "skipped", "running_agent_tasks"
				return result
			}
		}
	}
	parentSegments := []string{}
	if pd.kind == "work_item" {
		if pd.module == nil || pd.module.DirectoryName.String == "" {
			result.Status, result.Reason, result.Error = "failed", "blocked", "the module has no folder name yet"
			return result
		}
		parentSegments = []string{pd.module.DirectoryName.String}
	}

	// Nothing named yet: adopt a tolerant match, or create the expected name.
	if pd.directoryName == "" {
		name := h.adoptOrCreateFolder(ctx, q, workspaceID, pd, collabPath, parentSegments)
		if name.err != nil {
			result.Status, result.Reason, result.Error = "failed", name.reason, name.err.Error()
			return result
		}
		if err := writePlanDirectoryName(ctx, q, workspaceID, pd, name.name); err != nil {
			result.Status, result.Error = "failed", err.Error()
			return result
		}
		result.Status, result.DirectoryName, result.ToDirectory = "created", name.name, name.name
		return result
	}

	if len(fromSegments) == 0 {
		fromSegments = append(append([]string{}, parentSegments...), pd.directoryName)
	}
	if collabfs.DirectoryNameMatches(pd.directoryName, pd.expected) {
		// Already named right: make sure the folder exists. An adopted name
		// ("04.01 确权线") and a disambiguated one ("…(2)") count as right, so
		// retrying a fill never tries to rename them onto an occupied name.
		if code, _ := collabfs.StatDir(collabPath, fromSegments...); code == collabfs.StatOK {
			result.Status = "ok"
			return result
		}
		if err := collabfs.EnsureDir(collabPath, fromSegments...); err != nil {
			result.Status, result.Reason, result.Error = "failed", "create_failed", err.Error()
			return result
		}
		result.Status = "created"
		return result
	}

	toSegments := append(append([]string{}, parentSegments...), pd.expected)
	err := collabfs.RenameOrMove(collabPath, fromSegments, collabPath, toSegments)
	switch {
	case err == nil, errors.Is(err, collabfs.ErrSourceMissing):
		// A folder that was never created just takes the new name; there is
		// nothing to move and nothing to apologise for.
		if writeErr := writePlanDirectoryName(ctx, q, workspaceID, pd, pd.expected); writeErr != nil {
			result.Status, result.Error = "failed", writeErr.Error()
			return result
		}
		result.Status, result.DirectoryName = "renamed", pd.expected
		result.FromDirectory, result.ToDirectory = pd.directoryName, pd.expected
		return result
	case errors.Is(err, collabfs.ErrTargetExists):
		// Keep the old name so the row and the disk still agree; the panel can
		// retry once the collision is resolved.
		result.Status, result.Reason = "failed", "target_exists"
		result.Error = "a folder with the new name already exists"
		return result
	default:
		result.Status, result.Reason, result.Error = "failed", "rename_failed", err.Error()
		return result
	}
}

type adoptResult struct {
	name   string
	reason string
	err    error
}

// adoptOrCreateFolder picks a name for a row that has none: an existing folder
// below the parent whose name matches once spacing is ignored, else the
// expected name made unique against disk and database siblings.
func (h *Handler) adoptOrCreateFolder(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, pd planDirectory, collabPath string, parentSegments []string) adoptResult {
	existing := map[string]string{} // normalised -> actual
	if root, err := collabfs.OpenRoot(collabPath); err == nil {
		defer root.Close()
		if dir, err := root.Directory(filepath.Join(append([]string{collabPath}, parentSegments...)...), false); err == nil {
			if entries, _, err := dir.Entries(ctx, 500); err == nil {
				for _, entry := range entries {
					existing[collabfs.NormalizeForMatch(entry)] = entry
				}
			}
		}
	}
	if match, ok := existing[collabfs.NormalizeForMatch(pd.expected)]; ok {
		return adoptResult{name: match}
	}
	taken := map[string]bool{}
	for _, name := range siblingFolders(ctx, q, workspaceID, pd) {
		taken[strings.ToLower(name)] = true
	}
	for _, name := range existing {
		taken[strings.ToLower(name)] = true
	}
	name := collabfs.UniqueName(pd.expected, func(candidate string) bool { return taken[strings.ToLower(candidate)] })
	if err := collabfs.EnsureDir(collabPath, append(append([]string{}, parentSegments...), name)...); err != nil {
		return adoptResult{reason: "create_failed", err: err}
	}
	return adoptResult{name: name}
}

// ListCockpitPlanDirectories answers the panel's on-demand read. The tree never
// calls it; it is a separate request so opening a plan does not stat a NAS.
func (h *Handler) ListCockpitPlanDirectories(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("node_ids"))
	if raw == "" {
		writeError(w, http.StatusBadRequest, "node_ids is required")
		return
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 100 {
		writeError(w, http.StatusBadRequest, "at most 100 node_ids per request")
		return
	}
	ids := make([]pgtype.UUID, 0, len(parts))
	for _, part := range parts {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(part), "node_id")
		if !ok {
			return
		}
		ids = append(ids, id)
	}
	ctx := r.Context()
	items := make([]PlanDirectoryStatus, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[uuidToString(id)] {
			continue
		}
		seen[uuidToString(id)] = true
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: id, WorkspaceID: cc.workspaceID})
		if err != nil {
			writeError(w, http.StatusNotFound, "node not found in this workspace")
			return
		}
		pd, err := h.loadPlanDirectory(ctx, h.Queries, cc.workspaceID, node)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to resolve the row")
			return
		}
		items = append(items, h.planDirectoryStatus(ctx, h.Queries, cc.workspaceID, pd))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// SyncCockpitNodeDirectory is the panel's retry/sync button: create a folder
// that is missing, or rename one the row's name has outgrown.
func (h *Handler) SyncCockpitNodeDirectory(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	var req struct {
		Force bool `json:"force"`
	}
	if r.ContentLength > 0 {
		if _, ok := decodeCockpitBody(w, r, &req); !ok {
			return
		}
	}
	ctx := r.Context()
	pd, err := h.loadPlanDirectory(ctx, h.Queries, cc.workspaceID, node)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve the row")
		return
	}
	// Only a rename disturbs work in progress. A folder that is missing (or
	// merely not created yet) can be created without touching what an agent
	// has open, so it never asks about running tasks.
	needsRename := false
	if pd.directoryName != "" && pd.expected != "" && !collabfs.DirectoryNameMatches(pd.directoryName, pd.expected) {
		if code, _ := collabfs.StatDir(strings.TrimSpace(pd.project.CollabPath.String), pd.segments...); code == collabfs.StatOK {
			needsRename = true
		}
	}
	if needsRename && !req.Force {
		tasks, err := h.runningTasksForNode(ctx, h.Queries, cc.workspaceID, pd)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check running tasks")
			return
		}
		if len(tasks) > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"code":          "running_agent_tasks",
				"error":         "agent tasks are running in this folder",
				"running_tasks": tasks,
			})
			return
		}
	}
	result := h.applyPlanDirectory(ctx, h.Queries, cc.workspaceID, pd, pd.segments, req.Force)
	// Re-read so the response carries the state after the write. The disk's own
	// classification is kept even when the operation failed: a collision leaves
	// the folder in place and the panel must still offer "sync" for it.
	if refreshed, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: node.ID, WorkspaceID: cc.workspaceID}); err == nil {
		if after, err := h.loadPlanDirectory(ctx, h.Queries, cc.workspaceID, refreshed); err == nil {
			status := h.planDirectoryStatus(ctx, h.Queries, cc.workspaceID, after)
			if result.Status == "failed" {
				if result.Error != "" {
					status.Error = result.Error
				} else if result.Reason != "" {
					status.Error = result.Reason
				}
			}
			writeJSON(w, http.StatusOK, map[string]any{"directory_sync": result, "directory": status})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"directory_sync": result})
}

// DirectoryFillItem is one row the fill pass looked at.
type DirectoryFillItem struct {
	NodeID        string `json:"node_id"`
	Code          string `json:"code"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Action        string `json:"action"`
	DirectoryName string `json:"directory_name,omitempty"`
	FullPath      string `json:"full_path,omitempty"`
	Status        string `json:"status"`
	Reason        string `json:"reason,omitempty"`
	Error         string `json:"error,omitempty"`
}

// FillCockpitPlanDirectories creates the folders a reconciled plan is missing
// and syncs the ones whose name drifted. A preview is the default: the caller
// asks for `apply` when the list looks right.
//
// Issues are deliberately not touched — their delivery folder is allocated when
// it is first needed, not in bulk.
func (h *Handler) FillCockpitPlanDirectories(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	if err := requireReconciledPlan(cc.cockpit); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	var req struct {
		Apply     bool   `json:"apply"`
		ProjectID string `json:"project_id"`
		Force     bool   `json:"force"`
	}
	if r.ContentLength > 0 {
		if _, ok := decodeCockpitBody(w, r, &req); !ok {
			return
		}
	}
	var projectFilter pgtype.UUID
	if strings.TrimSpace(req.ProjectID) != "" {
		id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(req.ProjectID), "project_id")
		if !ok {
			return
		}
		projectFilter = id
	}

	ctx := r.Context()
	index, err := h.newDirectoryIndex(ctx, h.Queries, cc.workspaceID, cc.cockpit.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read the plan rows")
		return
	}
	nodes := make([]db.CockpitNode, 0, len(index.nodes))
	for _, node := range index.nodes {
		nodes = append(nodes, node)
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].Position != nodes[j].Position {
			return nodes[i].Position < nodes[j].Position
		}
		return nodes[i].Code < nodes[j].Code
	})
	byID := index.nodes
	kindOf := func(node db.CockpitNode) string {
		if !node.ParentID.Valid {
			return "project"
		}
		parent, ok := byID[node.ParentID]
		if !ok || !parent.ParentID.Valid {
			return "module"
		}
		return "work_item"
	}

	items := make([]DirectoryFillItem, 0, len(nodes))
	pending := make([]planDirectory, 0, len(nodes))
	shared := []SharedCollabProject{}
	seenShared := map[string]bool{}
	// Modules first: a work item's folder lives inside its module's, so the
	// module has to exist before the item can be placed.
	for _, wantKind := range []string{"module", "work_item"} {
		for _, node := range nodes {
			if kindOf(node) != wantKind {
				continue
			}
			pd, err := index.directory(ctx, h.Queries, cc.workspaceID, node)
			if err != nil {
				continue
			}
			if projectFilter.Valid && pd.project.ID != projectFilter {
				continue
			}
			if wantKind == "module" {
				// One pass per project is enough for the shared-root warning:
				// every row in the project points at the same root.
				for _, entry := range h.sharedCollabProjects(ctx, h.Queries, pd.project.ID, pd.project.CollabPath.String) {
					key := entry.WorkspaceID + "/" + entry.ProjectID
					if !seenShared[key] {
						seenShared[key] = true
						shared = append(shared, entry)
					}
				}
			}
			item := DirectoryFillItem{
				NodeID: uuidToString(node.ID),
				Code:   node.Code,
				Name:   node.Name,
				Kind:   wantKind,
			}
			if pd.module != nil && wantKind == "module" {
				item.Name = pd.module.Title
			}
			item.DirectoryName = pd.directoryName
			item.FullPath = pd.fullPath()
			switch {
			case !pd.project.CollabPath.Valid || strings.TrimSpace(pd.project.CollabPath.String) == "":
				item.Action, item.Status, item.Reason = "none", "no_collab_path", "no_collab_path"
			case pd.blocked != "" && pd.blocked != "the module has no folder name yet":
				// A genuinely broken binding (unfiled row or a module row with
				// no module) cannot be repaired by filling folders.
				item.Action, item.Status, item.Error = "none", "invalid", pd.blocked
			case pd.directoryName == "":
				// A work item whose module has no folder yet is still
				// creatable: this same pass creates the module folder first
				// and then places the item inside it. Treating it as invalid
				// here is what made a two-level fill skip every item.
				item.Action, item.Status = "create", "pending"
			case pd.expected != "" && !collabfs.DirectoryNameMatches(pd.directoryName, pd.expected):
				item.Action, item.Status = "sync", "pending"
			case len(pd.segments) == 0:
				// The work item already carries a matching name while its
				// module has no folder name yet; never call StatDir with zero
				// segments, which would stat the collaboration root itself.
				item.Action, item.Status = "create", "pending"
			default:
				code, _ := collabfs.StatDir(strings.TrimSpace(pd.project.CollabPath.String), pd.segments...)
				if code == collabfs.StatOK {
					item.Action, item.Status = "none", "ok"
				} else {
					item.Action, item.Status = "create", "pending"
				}
			}
			if item.Action != "none" {
				pending = append(pending, pd)
			}
			items = append(items, item)
		}
	}

	counts := map[string]int{}
	if req.Apply {
		for i := range items {
			item := &items[i]
			if item.Action == "none" {
				counts[item.Status]++
				continue
			}
			// Re-read the row instead of reusing the preview's snapshot: an
			// earlier module in this pass may have just created or renamed the
			// folder this item lives in, and the item must land inside that
			// one — never inside a re-built copy of the old module folder.
			pd := planDirectory{}
			if fresh, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
				ID: parseUUID(item.NodeID), WorkspaceID: cc.workspaceID,
			}); err == nil {
				pd, err = h.loadPlanDirectory(ctx, h.Queries, cc.workspaceID, fresh)
				if err != nil {
					pd = planDirectory{}
				}
			}
			if pd.node.ID != (pgtype.UUID{}) {
				result := h.applyPlanDirectory(ctx, h.Queries, cc.workspaceID, pd, pd.segments, req.Force)
				item.DirectoryName = result.DirectoryName
				item.Status = result.Status
				item.Reason = result.Reason
				item.Error = result.Error
				if refreshed, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: pd.node.ID, WorkspaceID: cc.workspaceID}); err == nil {
					if after, err := h.loadPlanDirectory(ctx, h.Queries, cc.workspaceID, refreshed); err == nil {
						item.FullPath = after.fullPath()
					}
				}
			} else {
				item.Status, item.Error = "failed", "the row could not be read again"
			}
			counts[item.Status]++
		}
	} else {
		for _, item := range items {
			counts[item.Action]++
		}
	}
	// A preview also reports who is working in the folders it would touch, so
	// the reader can choose "force" before anything is written.
	running := []RunningTaskRef{}
	if !req.Apply {
		seenTask := map[string]bool{}
		for _, pd := range pending {
			tasks, err := h.runningTasksForNode(ctx, h.Queries, cc.workspaceID, pd)
			if err != nil {
				continue
			}
			for _, task := range tasks {
				if seenTask[task.TaskID] {
					continue
				}
				seenTask[task.TaskID] = true
				running = append(running, task)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"applied":                req.Apply,
		"items":                  items,
		"counts":                 counts,
		"shared_collab_projects": shared,
		"running_tasks":          running,
	})
}

// resolveModuleFolderName makes a module and its L2 row name the same folder.
//
// On a reconciled board the skeleton has already named the row — from the
// module's existing name when it had one, else from its address and title. On
// a board that has not been reconciled there is no row yet, so the module's own
// title (cleaned, unique within the project) is all there is.
func (h *Handler) resolveModuleFolderName(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, module db.Module) (db.Module, error) {
	row, rowErr := q.GetCockpitNodeByModuleID(ctx, db.GetCockpitNodeByModuleIDParams{WorkspaceID: workspaceID, ModuleID: module.ID})
	name := strings.TrimSpace(module.DirectoryName.String)
	switch {
	case rowErr == nil:
		rowName := strings.TrimSpace(row.DirectoryName.String)
		if name == "" {
			name = rowName
			if name == "" {
				name = collabfs.SanitizeFolderName(row.Code+module.Title, 0)
			}
		}
		if rowName != name {
			// The module's name wins: it may already be a folder people use.
			if err := q.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{
				WorkspaceID: workspaceID, ID: row.ID, DirectoryName: name,
			}); err != nil {
				return module, err
			}
		}
	case errors.Is(rowErr, pgx.ErrNoRows):
		modules, err := q.ListModules(ctx, db.ListModulesParams{WorkspaceID: workspaceID, ProjectID: module.ProjectID})
		if err != nil {
			return module, err
		}
		taken := map[string]bool{}
		for _, sibling := range modules {
			if sibling.ID != module.ID && sibling.DirectoryName.Valid {
				taken[strings.ToLower(sibling.DirectoryName.String)] = true
			}
		}
		if name == "" {
			name = collabfs.UniqueName(
				collabfs.SanitizeFolderName(module.Title, 0),
				func(candidate string) bool { return taken[strings.ToLower(candidate)] },
			)
		}
	default:
		return module, rowErr
	}
	if name == "" {
		return module, nil
	}
	if module.DirectoryName.String != name || !module.DirectoryName.Valid {
		if err := q.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{
			WorkspaceID: workspaceID, ID: module.ID, DirectoryName: name,
		}); err != nil {
			return module, err
		}
	}
	module.DirectoryName = pgtype.Text{String: name, Valid: true}
	return module, nil
}

// ensureModuleFolder creates the module's folder when the project has a
// collaboration space. Reported, never fatal: the module is already saved.
func (h *Handler) ensureModuleFolder(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, module db.Module) *NodeDirectorySync {
	if !module.DirectoryName.Valid || strings.TrimSpace(module.DirectoryName.String) == "" {
		return &NodeDirectorySync{Status: "skipped", Reason: "module_directory_missing"}
	}
	name := module.DirectoryName.String
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: module.ProjectID, WorkspaceID: workspaceID})
	if err != nil {
		return nil
	}
	if !project.CollabPath.Valid || strings.TrimSpace(project.CollabPath.String) == "" {
		return &NodeDirectorySync{Status: "skipped", Reason: "no_collab_space", DirectoryName: name}
	}
	if err := collabfs.EnsureDir(strings.TrimSpace(project.CollabPath.String), name); err != nil {
		return &NodeDirectorySync{Status: "failed", Reason: "create_failed", Error: err.Error(), DirectoryName: name}
	}
	return &NodeDirectorySync{Status: "created", DirectoryName: name}
}

// writeRunningTasksConflict answers a structural edit that would rename a
// folder an agent is working in. The client chooses "sync now" (force) or
// "later" (defer); nothing has been written at this point.
func (h *Handler) writeRunningTasksConflict(w http.ResponseWriter, ctx context.Context, workspaceID pgtype.UUID, rows []db.ListRunningAgentTasksForModulesRow) {
	tasks := make([]runningTask, 0, len(rows))
	for _, row := range rows {
		tasks = append(tasks, runningTask{row.TaskID, row.IssueID, row.IssueNumber, row.Status})
	}
	h.writeRunningTaskConflict(w, ctx, workspaceID, tasks)
}

func (h *Handler) writeRunningTaskConflict(w http.ResponseWriter, ctx context.Context, workspaceID pgtype.UUID, tasks []runningTask) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"code":          "running_agent_tasks",
		"error":         "agent tasks are running in this folder; sync now or defer",
		"running_tasks": h.runningTaskRefs(ctx, workspaceID, tasks),
	})
}

// renameModuleFolder moves a module's folder to its new name. A folder that was
// never created only takes the new name; a collision leaves the old name in
// place so the row and the disk still agree.
func (h *Handler) renameModuleFolder(ctx context.Context, workspaceID pgtype.UUID, module db.Module, row db.CockpitNode, hasRow bool, from, to string) NodeDirectorySync {
	result := NodeDirectorySync{Status: "skipped", Reason: "no_collab_space", DirectoryName: from, FromDirectory: from, ToDirectory: to}
	if from == "" {
		// Nothing on disk yet: just name it.
		if err := h.Queries.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{WorkspaceID: workspaceID, ID: module.ID, DirectoryName: to}); err != nil {
			result.Status, result.Error = "failed", err.Error()
			return result
		}
		if hasRow {
			if err := h.Queries.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{WorkspaceID: workspaceID, ID: row.ID, DirectoryName: to}); err != nil {
				result.Status, result.Error = "failed", err.Error()
				return result
			}
		}
		result.Status, result.DirectoryName = "renamed", to
		return result
	}
	project, err := h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: module.ProjectID, WorkspaceID: workspaceID})
	if err != nil || !project.CollabPath.Valid || strings.TrimSpace(project.CollabPath.String) == "" {
		// No share, no folder to move — but the record still follows its title,
		// so the module and its row never keep a name the user just replaced.
		if writeErr := h.Queries.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{WorkspaceID: workspaceID, ID: module.ID, DirectoryName: to}); writeErr != nil {
			result.Status, result.Error = "failed", writeErr.Error()
			return result
		}
		if hasRow {
			if writeErr := h.Queries.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{WorkspaceID: workspaceID, ID: row.ID, DirectoryName: to}); writeErr != nil {
				result.Status, result.Error = "failed", writeErr.Error()
				return result
			}
		}
		result.Status, result.Reason = "renamed", "no_collab_space"
		result.DirectoryName = to
		return result
	}
	collabPath := strings.TrimSpace(project.CollabPath.String)
	err = collabfs.RenameOrMove(collabPath, []string{from}, collabPath, []string{to})
	switch {
	case err == nil, errors.Is(err, collabfs.ErrSourceMissing):
		if writeErr := h.Queries.SetModuleDirectoryName(ctx, db.SetModuleDirectoryNameParams{WorkspaceID: workspaceID, ID: module.ID, DirectoryName: to}); writeErr != nil {
			result.Status, result.Error = "failed", writeErr.Error()
			return result
		}
		if hasRow {
			if writeErr := h.Queries.SetCockpitNodeDirectoryName(ctx, db.SetCockpitNodeDirectoryNameParams{WorkspaceID: workspaceID, ID: row.ID, DirectoryName: to}); writeErr != nil {
				result.Status, result.Error = "failed", writeErr.Error()
				return result
			}
		}
		result.Status, result.DirectoryName = "renamed", to
		return result
	case errors.Is(err, collabfs.ErrTargetExists):
		result.Status, result.Reason = "failed", "target_exists"
		result.Error = "a folder with the new name already exists"
		return result
	default:
		result.Status, result.Reason, result.Error = "failed", "rename_failed", err.Error()
		return result
	}
}

// directoryIndex resolves many rows against one snapshot of the plan, the
// modules and the projects. A renumber or a fill pass touches every row it
// changes; reading each row's chain separately would turn one screen into
// hundreds of queries.
type directoryIndex struct {
	nodes    map[pgtype.UUID]db.CockpitNode
	modules  map[pgtype.UUID]db.Module
	projects map[pgtype.UUID]db.Project
}

func (h *Handler) newDirectoryIndex(ctx context.Context, q *db.Queries, workspaceID, cockpitID pgtype.UUID) (*directoryIndex, error) {
	nodes, err := q.ListCockpitNodes(ctx, cockpitID)
	if err != nil {
		return nil, err
	}
	modules, err := q.ListModules(ctx, db.ListModulesParams{WorkspaceID: workspaceID})
	if err != nil {
		return nil, err
	}
	index := &directoryIndex{
		nodes:    make(map[pgtype.UUID]db.CockpitNode, len(nodes)),
		modules:  make(map[pgtype.UUID]db.Module, len(modules)),
		projects: map[pgtype.UUID]db.Project{},
	}
	for _, node := range nodes {
		index.nodes[node.ID] = node
	}
	for _, module := range modules {
		index.modules[module.ID] = module
	}
	return index, nil
}

// directory resolves one row without touching the database again.
func (idx *directoryIndex) directory(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, node db.CockpitNode) (planDirectory, error) {
	out := planDirectory{node: node}
	moduleRow := node
	if node.ParentID.Valid {
		parent, ok := idx.nodes[node.ParentID]
		if !ok {
			return out, pgx.ErrNoRows
		}
		if parent.ParentID.Valid {
			out.kind = "work_item"
			moduleRow = parent
		} else {
			out.kind = "module"
		}
	} else {
		out.kind = "project"
	}
	out.moduleRow = &moduleRow
	projectID := node.ProjectID
	if !projectID.Valid {
		projectID = moduleRow.ProjectID
	}
	if !projectID.Valid {
		out.blocked = "the row is not filed into a project"
		return out, nil
	}
	project, ok := idx.projects[projectID]
	if !ok {
		loaded, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID})
		if err != nil {
			return out, err
		}
		idx.projects[projectID] = loaded
		project = loaded
	}
	out.project = project
	if out.kind == "project" {
		return out, nil
	}
	if !moduleRow.ModuleID.Valid {
		out.blocked = "the module row carries no module"
		return out, nil
	}
	module, ok := idx.modules[moduleRow.ModuleID]
	if !ok {
		return out, pgx.ErrNoRows
	}
	out.module = &module
	switch out.kind {
	case "module":
		out.directoryName = module.DirectoryName.String
		if out.directoryName == "" {
			out.directoryName = node.DirectoryName.String
		}
		out.expected = collabfs.SanitizeFolderName(node.Code+module.Title, 0)
		if out.directoryName != "" {
			out.segments = []string{out.directoryName}
		}
	case "work_item":
		out.directoryName = node.DirectoryName.String
		out.expected = collabfs.SanitizeFolderName(node.Code+node.Name, 0)
		if module.DirectoryName.String == "" {
			out.blocked = "the module has no folder name yet"
		} else if out.directoryName != "" {
			out.segments = []string{module.DirectoryName.String, out.directoryName}
		}
	}
	return out, nil
}
