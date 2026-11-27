package handler

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/collabfs"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// The delivery folder of one issue. An issue owns no folder: its files go where
// the team already works, which is the folder of the work item it is filed
// under (or its module, or the project root). Issues that prepare, record or
// review a meeting use the folder bound to that meeting.
//
// The platform creates a missing filing folder on request. It never creates a
// meeting folder for an issue: that folder belongs to the meeting, whose own
// directory maintenance prepares it, so the issue only reports it and points
// there.

// Where an issue's delivery folder comes from.
const (
	issueFolderSourceFiling  = "filing"
	issueFolderSourceMeeting = "meeting"
)

// IssueDirectoryStatus is the on-demand view behind the detail's delivery row.
type IssueDirectoryStatus struct {
	IssueID              string                `json:"issue_id"`
	ProjectID            *string               `json:"project_id"`
	ProjectCollabPath    *string               `json:"project_collab_path"`
	FullPath             *string               `json:"full_path"`
	Source               string                `json:"source"`
	MeetingID            *string               `json:"meeting_id"`
	Status               string                `json:"status"`
	SharedCollabProjects []SharedCollabProject `json:"shared_collab_projects"`
	Error                string                `json:"error,omitempty"`
}

// issueFolder is the resolved delivery folder of an issue.
type issueFolder struct {
	issue    db.Issue
	project  db.Project
	module   *db.Module
	workItem *db.CockpitNode
	// meetingDir is the bound folder of the meeting this issue works for. It
	// replaces the filing chain. meetingID is the meeting it is bound to.
	meetingDir string
	meetingID  pgtype.UUID
	// segments lead from the collaboration root to the filing folder.
	segments []string
	blocked  string
}

func (f issueFolder) collabPath() string {
	if !f.project.CollabPath.Valid {
		return ""
	}
	return strings.TrimSpace(f.project.CollabPath.String)
}

func (f issueFolder) source() string {
	if f.meetingDir != "" {
		return issueFolderSourceMeeting
	}
	return issueFolderSourceFiling
}

func (f issueFolder) fullPath() string {
	if f.meetingDir != "" {
		return f.meetingDir
	}
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
	path, err := collabfs.DeliveryPath(f.project.CollabPath.String, moduleDir, workItemDir)
	if err != nil {
		return ""
	}
	return path
}

// loadIssueFolder resolves the meeting binding and the project/module/work item
// chain. Every hop is a database read; the disk is only touched by the callers
// that ask about it.
func (h *Handler) loadIssueFolder(ctx context.Context, q *db.Queries, issue db.Issue) (issueFolder, error) {
	out := issueFolder{issue: issue}
	meetingDirs, err := q.ListIssueMeetingDirectories(ctx, db.ListIssueMeetingDirectoriesParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID})
	if err != nil {
		return out, err
	}
	// An issue shared by meetings with different folders has no single meeting
	// folder, so it stays with its filing.
	if len(meetingDirs) == 1 {
		out.meetingDir = meetingDirs[0].NasDir
		out.meetingID = meetingDirs[0].MeetingID
	}
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
	if out.blocked == "" {
		if out.module != nil {
			out.segments = append(out.segments, out.module.DirectoryName.String)
		}
		if out.workItem != nil {
			out.segments = append(out.segments, out.workItem.DirectoryName.String)
		}
	}
	return out, nil
}

// statIssueFolder classifies the resolved folder on disk. It never writes.
func statIssueFolder(f issueFolder) (collabfs.StatCode, error) {
	if f.meetingDir == "" {
		return collabfs.StatDir(f.collabPath(), f.segments...)
	}
	// Walk from the collaboration root when the meeting folder is inside it, so
	// an unavailable share is not reported as a missing folder.
	if root := f.collabPath(); root != "" {
		if rel, err := filepath.Rel(root, f.meetingDir); err == nil && rel != "." && filepath.IsLocal(rel) {
			return collabfs.StatDir(root, strings.Split(rel, string(filepath.Separator))...)
		}
	}
	return collabfs.StatDir(filepath.Dir(f.meetingDir), filepath.Base(f.meetingDir))
}

// issueDirectoryStatus classifies the folder. It never writes.
func (h *Handler) issueDirectoryStatus(ctx context.Context, q *db.Queries, f issueFolder) IssueDirectoryStatus {
	out := IssueDirectoryStatus{
		IssueID:              uuidToString(f.issue.ID),
		Source:               f.source(),
		SharedCollabProjects: []SharedCollabProject{},
	}
	if f.meetingID.Valid {
		id := uuidToString(f.meetingID)
		out.MeetingID = &id
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
	if full := f.fullPath(); full != "" {
		out.FullPath = &full
	}
	switch {
	case f.meetingDir == "" && f.collabPath() == "":
		out.Status = "no_collab_path"
		if f.blocked != "" {
			out.Error = f.blocked
		}
	case f.meetingDir == "" && f.blocked != "":
		out.Status = "invalid"
		out.Error = f.blocked
	default:
		switch code, err := statIssueFolder(f); code {
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

// GetIssueDirectory is the detail row's read. It never creates the folder.
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

// EnsureIssueDirectory creates the filing folder (and its parents) on the
// server. This is the "open folder" path: a person asked for it, so the
// platform may write. A meeting folder is only reported.
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
	if folder.meetingDir == "" {
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
	}
	status := h.issueDirectoryStatus(ctx, h.Queries, folder)
	if folder.meetingDir == "" {
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
		"full_path":              status.FullPath,
		"source":                 status.Source,
		"meeting_id":             status.MeetingID,
		"status":                 status.Status,
		"exists":                 status.Status == "ok",
		"shared_collab_projects": status.SharedCollabProjects,
		"error":                  status.Error,
	})
}
