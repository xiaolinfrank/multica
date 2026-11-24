package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/collabfs"
	"github.com/multica-ai/multica/server/internal/localpaths"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The delivery folder of one issue. Unlike the plan rows, an issue's folder is
// allocated on first need (an agent claim or a human opening it) and never on a
// list read: most issues never produce a file, and a NAS that is slow must not
// make the issue list slow.

// IssueDirectoryStatus is the on-demand view behind the detail's delivery row.
type IssueDirectoryStatus struct {
	IssueID              string                `json:"issue_id"`
	ProjectID            *string               `json:"project_id"`
	ProjectCollabPath    *string               `json:"project_collab_path"`
	DirectoryName        *string               `json:"directory_name"`
	FullPath             *string               `json:"full_path"`
	Status               string                `json:"status"`
	RunningTasks         []RunningTaskRef      `json:"running_tasks"`
	SharedCollabProjects []SharedCollabProject `json:"shared_collab_projects"`
	Error                string                `json:"error,omitempty"`
}

// issueFolder is the resolved chain an issue's delivery folder hangs from.
type issueFolder struct {
	issue    db.Issue
	project  db.Project
	module   *db.Module
	workItem *db.CockpitNode
	segments []string
	blocked  string
}

func (f issueFolder) collabPath() string {
	if !f.project.CollabPath.Valid {
		return ""
	}
	return strings.TrimSpace(f.project.CollabPath.String)
}

func (f issueFolder) fullPath() string {
	if f.blocked != "" {
		return ""
	}
	moduleDir, workItemDir := (*string)(nil), (*string)(nil)
	if f.module != nil {
		moduleDir = &f.module.DirectoryName.String
	}
	if f.workItem != nil {
		workItemDir = &f.workItem.DirectoryName.String
	}
	issueDir := f.issue.DirectoryName.String
	path, err := collabfs.DeliveryPath(f.project.CollabPath.String, moduleDir, workItemDir, &issueDir)
	if err != nil {
		return ""
	}
	return path
}

// loadIssueFolder resolves the project/module/work item chain. Every hop is a
// database read; the disk is only touched by the callers that ask about it.
func (h *Handler) loadIssueFolder(ctx context.Context, q *db.Queries, issue db.Issue) (issueFolder, error) {
	out := issueFolder{issue: issue}
	if !issue.ProjectID.Valid {
		out.blocked = "the issue is not filed into a project"
		return out, nil
	}
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: issue.ProjectID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return out, err
	}
	out.project = project
	if issue.ModuleID.Valid {
		module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: issue.ModuleID, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return out, err
		}
		out.module = &module
		if module.DirectoryName.String == "" {
			out.blocked = "the module has no folder name yet"
		}
	}
	if issue.WorkItemID.Valid {
		node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: issue.WorkItemID, WorkspaceID: issue.WorkspaceID})
		if err != nil {
			return out, err
		}
		out.workItem = &node
		if node.DirectoryName.String == "" {
			out.blocked = "the work item has no folder name yet"
		}
	}
	if issue.DirectoryName.String != "" && out.blocked == "" {
		out.segments = []string{}
		if out.module != nil {
			out.segments = append(out.segments, out.module.DirectoryName.String)
		}
		if out.workItem != nil {
			out.segments = append(out.segments, out.workItem.DirectoryName.String)
		}
		out.segments = append(out.segments, issue.DirectoryName.String)
	}
	return out, nil
}

// issueDirectoryStatus classifies the folder. It never writes.
func (h *Handler) issueDirectoryStatus(ctx context.Context, q *db.Queries, f issueFolder) IssueDirectoryStatus {
	out := IssueDirectoryStatus{
		IssueID:              uuidToString(f.issue.ID),
		RunningTasks:         []RunningTaskRef{},
		SharedCollabProjects: []SharedCollabProject{},
	}
	if f.issue.ProjectID.Valid {
		id := uuidToString(f.issue.ProjectID)
		out.ProjectID = &id
	}
	if f.collabPath() != "" {
		path := f.collabPath()
		out.ProjectCollabPath = &path
		out.SharedCollabProjects = h.sharedCollabProjects(ctx, q, f.project.ID, path)
	}
	if f.issue.DirectoryName.Valid && f.issue.DirectoryName.String != "" {
		name := f.issue.DirectoryName.String
		out.DirectoryName = &name
	}
	if full := f.fullPath(); full != "" {
		out.FullPath = &full
	}
	tasks, err := q.ListRunningAgentTasksForIssue(ctx, db.ListRunningAgentTasksForIssueParams{
		WorkspaceID: f.issue.WorkspaceID, IssueID: f.issue.ID,
	})
	if err == nil {
		for _, task := range tasks {
			out.RunningTasks = append(out.RunningTasks, h.runningTaskRefs(ctx, f.issue.WorkspaceID, []runningTask{
				{task.TaskID, task.IssueID, task.IssueNumber, task.Status},
			})...)
		}
	}
	switch {
	case f.collabPath() == "":
		out.Status = "no_collab_path"
		if f.blocked != "" {
			out.Error = f.blocked
		}
	case f.issue.DirectoryName.String == "":
		out.Status = "unallocated"
	case f.blocked != "":
		out.Status = "invalid"
		out.Error = f.blocked
	default:
		switch code, err := collabfs.StatDir(f.collabPath(), f.segments...); code {
		case collabfs.StatOK:
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
	}
	return out
}

// allocateIssueDirectoryName gives the issue its folder name, once. A retried
// claim or a double-clicked "open folder" reads the first winner's value back.
func (h *Handler) allocateIssueDirectoryName(ctx context.Context, q *db.Queries, issue db.Issue, prefix string) (string, error) {
	if issue.DirectoryName.Valid && issue.DirectoryName.String != "" {
		return issue.DirectoryName.String, nil
	}
	// Identifier plus a title cut to 40 characters, so the folder is
	// recognisable in a file browser without being a paragraph.
	base := collabfs.SanitizeFolderName(prefix+"-"+strconv.Itoa(int(issue.Number)), 0)
	title := collabfs.SanitizeFolderName(issue.Title, 40)
	name := base + title
	if name == "" {
		name = base + "task"
	}
	allocated, err := q.AllocateIssueDirectoryName(ctx, db.AllocateIssueDirectoryNameParams{
		ID: issue.ID, WorkspaceID: issue.WorkspaceID, DirectoryName: name,
	})
	if err == nil {
		return allocated.String, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	current, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return "", err
	}
	return current.DirectoryName.String, nil
}

// GetIssueDirectory is the detail row's read. It does not allocate: an
// unallocated issue is a state the UI offers to resolve, not a side effect of
// opening the page.
func (h *Handler) GetIssueDirectory(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	folder, err := h.loadIssueFolder(r.Context(), h.Queries, issue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve the delivery folder")
		return
	}
	writeJSON(w, http.StatusOK, h.issueDirectoryStatus(r.Context(), h.Queries, folder))
}

// EnsureIssueDirectory allocates the name if needed and creates the folder (and
// its parents) on the server. This is the "open folder" path: a person asked
// for it, so the platform may write.
func (h *Handler) EnsureIssueDirectory(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	ctx := r.Context()
	folder, err := h.loadIssueFolder(ctx, h.Queries, issue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve the delivery folder")
		return
	}
	if !issue.ProjectID.Valid {
		writeError(w, http.StatusBadRequest, "file the issue into a project first")
		return
	}
	if folder.collabPath() == "" {
		writeError(w, http.StatusBadRequest, "set the project's collaboration space path first")
		return
	}
	if folder.blocked != "" {
		writeError(w, http.StatusBadRequest, folder.blocked)
		return
	}
	prefix := h.getIssuePrefix(ctx, issue.WorkspaceID)
	name, err := h.allocateIssueDirectoryName(ctx, h.Queries, issue, prefix)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to allocate a folder name")
		return
	}
	issue.DirectoryName = pgtype.Text{String: name, Valid: true}
	folder, err = h.loadIssueFolder(ctx, h.Queries, issue)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to resolve the delivery folder")
		return
	}
	status := h.issueDirectoryStatus(ctx, h.Queries, folder)
	if folder.blocked == "" && len(folder.segments) > 0 {
		if err := collabfs.EnsureDir(folder.collabPath(), folder.segments...); err != nil {
			// Keep the disk's own category: a share that is away is not a
			// missing folder, and an unsafe entry is not something a retry
			// fixes by waiting.
			switch {
			case errors.Is(err, collabfs.ErrRootUnavailable):
				status.Status = "root_unavailable"
			case errors.Is(err, collabfs.ErrDirectoryChanged), errors.Is(err, collabfs.ErrOutsideRoot):
				status.Status = "invalid"
			default:
				status.Status = "missing"
			}
			status.Error = err.Error()
		} else {
			status.Status = "ok"
			status.Error = ""
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"directory_name":         status.DirectoryName,
		"full_path":              status.FullPath,
		"status":                 status.Status,
		"exists":                 status.Status == "ok",
		"shared_collab_projects": status.SharedCollabProjects,
		"error":                  status.Error,
	})
}

// applyIssueDirectoryName stores a hand-picked folder name. The files stay
// where they are: adopting an existing folder must not move it.
func (h *Handler) applyIssueDirectoryName(w http.ResponseWriter, r *http.Request, issue db.Issue, name string) bool {
	if isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "directory_name is a human decision")
		return false
	}
	if !localpaths.ValidFolder(name) {
		writeError(w, http.StatusBadRequest, "directory_name must be one safe folder name")
		return false
	}
	return true
}

// issueDirectoryMove is one folder that follows its issue to a new filing.
type issueDirectoryMove struct {
	issueID      pgtype.UUID
	directory    string
	fromRoot     string
	fromSegments []string
	toRoot       string
	toSegments   []string
}

// planIssueDirectoryMoves works out which folders have to follow the issue,
// from the bindings before the write and after it. Rows without a name, or
// whose bindings did not change, are not moves.
func (h *Handler) planIssueDirectoryMoves(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, before, after []db.ListIssueSubtreeDirectoryRowsRow) []issueDirectoryMove {
	afterByID := make(map[pgtype.UUID]db.ListIssueSubtreeDirectoryRowsRow, len(after))
	for _, row := range after {
		afterByID[row.ID] = row
	}
	moves := make([]issueDirectoryMove, 0, len(before))
	for _, old := range before {
		if old.DirectoryName.String == "" {
			continue
		}
		next, ok := afterByID[old.ID]
		if !ok {
			continue
		}
		if old.ProjectID == next.ProjectID && old.ModuleID == next.ModuleID && old.WorkItemID == next.WorkItemID {
			continue
		}
		fromRoot, fromSegments, err := h.issueFolderLocation(ctx, q, workspaceID, old.ProjectID, old.ModuleID, old.WorkItemID, old.DirectoryName.String)
		if err != nil || fromRoot == "" {
			continue
		}
		toRoot, toSegments, err := h.issueFolderLocation(ctx, q, workspaceID, next.ProjectID, next.ModuleID, next.WorkItemID, old.DirectoryName.String)
		if err != nil || toRoot == "" {
			continue
		}
		if fromRoot == toRoot && strings.Join(fromSegments, "/") == strings.Join(toSegments, "/") {
			continue
		}
		moves = append(moves, issueDirectoryMove{
			issueID: old.ID, directory: old.DirectoryName.String,
			fromRoot: fromRoot, fromSegments: fromSegments, toRoot: toRoot, toSegments: toSegments,
		})
	}
	return moves
}

// issueFolderLocation resolves one issue's folder into its collaboration root
// and the segments below it, which is the shape RenameOrMove walks.
func (h *Handler) issueFolderLocation(ctx context.Context, q *db.Queries, workspaceID, projectID, moduleID, workItemID pgtype.UUID, directory string) (string, []string, error) {
	if !projectID.Valid || directory == "" {
		return "", nil, nil
	}
	project, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{ID: projectID, WorkspaceID: workspaceID})
	if err != nil {
		return "", nil, err
	}
	if !project.CollabPath.Valid || strings.TrimSpace(project.CollabPath.String) == "" {
		return "", nil, nil
	}
	segments := []string{}
	if moduleID.Valid {
		module, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{ID: moduleID, WorkspaceID: workspaceID})
		if err != nil {
			return "", nil, err
		}
		if module.DirectoryName.String == "" {
			return "", nil, nil
		}
		segments = append(segments, module.DirectoryName.String)
	}
	if workItemID.Valid {
		node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: workItemID, WorkspaceID: workspaceID})
		if err != nil {
			return "", nil, err
		}
		if node.DirectoryName.String == "" {
			return "", nil, nil
		}
		segments = append(segments, node.DirectoryName.String)
	}
	segments = append(segments, directory)
	return strings.TrimSpace(project.CollabPath.String), segments, nil
}

// moveIssueDirectories follows through on a filing change. A missing source is
// not an error — a historical issue may never have had a folder. A collision
// keeps both folders and reports the reason; nothing is ever overwritten.
func (h *Handler) moveIssueDirectories(ctx context.Context, q *db.Queries, moves []issueDirectoryMove) []NodeDirectorySync {
	results := make([]NodeDirectorySync, 0, len(moves))
	for _, move := range moves {
		result := NodeDirectorySync{DirectoryName: move.directory}
		if move.fromRoot == move.toRoot {
			result.FromDirectory = strings.Join(move.fromSegments, "/")
			result.ToDirectory = strings.Join(move.toSegments, "/")
		}
		err := collabfs.RenameOrMove(move.fromRoot, move.fromSegments, move.toRoot, move.toSegments)
		switch {
		case err == nil, errors.Is(err, collabfs.ErrSourceMissing):
			result.Status = "renamed"
		case errors.Is(err, collabfs.ErrTargetExists):
			result.Status, result.Reason = "failed", "target_exists"
			result.Error = "a folder with this name already exists at the destination"
		default:
			result.Status, result.Reason, result.Error = "failed", "rename_failed", err.Error()
		}
		results = append(results, result)
	}
	return results
}

// subtreeDirectoryRows reads the subtree's folder bindings. Called before and
// after a filing change; a failure is logged and treated as "no folders".
func (h *Handler) subtreeDirectoryRows(ctx context.Context, q *db.Queries, workspaceID, issueID pgtype.UUID) []db.ListIssueSubtreeDirectoryRowsRow {
	rows, err := q.ListIssueSubtreeDirectoryRows(ctx, db.ListIssueSubtreeDirectoryRowsParams{WorkspaceID: workspaceID, IssueID: issueID})
	if err != nil {
		return nil
	}
	return rows
}

// filingFieldsTouched reports whether a write names any of the fields that
// decide where the issue's folder lives.
func filingFieldsTouched(raw map[string]json.RawMessage) bool {
	for _, key := range []string{"project_id", "module_id", "work_item_id", "parent_issue_id"} {
		if _, touched := raw[key]; touched {
			return true
		}
	}
	return false
}
