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

// resolveMeetingDestination validates the project/module pair a board wants
// its meetings filed under. Absent fields leave the board's current choice
// alone; an empty string clears it.
//
// The names ("06项目管理与规划", "06.06 多方协同与会议") are deliberately not
// in the code. Which project a programme keeps its meetings in is a property
// of that programme, so it is chosen in the product, validated here, and
// remembered on the board.
func (h *Handler) resolveMeetingDestination(
	w http.ResponseWriter,
	r *http.Request,
	cc cockpitContext,
	raw map[string]json.RawMessage,
	projectRef, moduleRef *string,
) (meetingRef, meetingRef, bool) {
	var project, module meetingRef

	if _, touched := raw["meeting_project_id"]; touched {
		if projectRef == nil || strings.TrimSpace(*projectRef) == "" {
			project.clear = true
		} else {
			id, ok := parseUUIDOrBadRequest(w, strings.TrimSpace(*projectRef), "meeting_project_id")
			if !ok {
				return project, module, false
			}
			if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
				ID: id, WorkspaceID: cc.workspaceID,
			}); err != nil {
				writeError(w, http.StatusBadRequest, "project not found in this workspace")
				return project, module, false
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
				return project, module, false
			}
			row, err := h.Queries.GetModuleInWorkspace(r.Context(), db.GetModuleInWorkspaceParams{
				ID: id, WorkspaceID: cc.workspaceID,
			})
			if err != nil {
				writeError(w, http.StatusBadRequest, "module not found in this workspace")
				return project, module, false
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
				return project, module, false
			}
			module.id = id
		}
	}

	return project, module, true
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

// meetingBaseDir answers "which folder do this board's meeting folders go in".
//
// A board that has confirmed a folder uses it, full stop. Otherwise the answer
// is derived: the project's collaboration space, then the child folder that
// answers to the module — matched by name, because a module's directory is
// found by name rather than stored (see migration 928). The derivation is a
// SUGGESTION: it is returned to the caller to show and confirm, and only a
// confirmed value is stored on the board.
func (h *Handler) meetingBaseDir(
	ctx context.Context,
	cc cockpitContext,
	projectID, moduleID pgtype.UUID,
) (dir string, derived bool, err error) {
	if strings.TrimSpace(cc.cockpit.MeetingDir) != "" {
		return cc.cockpit.MeetingDir, false, nil
	}
	if !projectID.Valid {
		return "", false, errors.New("no meeting project is set for this board")
	}
	project, err := h.Queries.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{
		ID: projectID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		return "", false, errors.New("meeting project not found in this workspace")
	}
	base := ""
	if project.CollabPath.Valid {
		base = strings.TrimSpace(project.CollabPath.String)
	}
	if base == "" {
		return "", false, errors.New("the meeting project has no collaboration space path")
	}
	if !moduleID.Valid {
		return filepath.Clean(base), true, nil
	}
	module, err := h.Queries.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{
		ID: moduleID, WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		return "", false, errors.New("meeting module not found in this workspace")
	}

	want := normalizeDirMatch(module.Title)
	if entries, readErr := os.ReadDir(base); readErr == nil {
		for _, entry := range entries {
			if entry.IsDir() && normalizeDirMatch(entry.Name()) == want {
				return filepath.Join(base, entry.Name()), true, nil
			}
		}
	}
	// No folder answers to the module yet — name it after the module and let
	// the caller see the path before anything is created.
	return filepath.Join(base, sanitizeMeetingFolderName(module.Title)), true, nil
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

// ---------------------------------------------------------------------------
// Destination preview
// ---------------------------------------------------------------------------

type CockpitMeetingDestinationResponse struct {
	ProjectID    string `json:"project_id"`
	ProjectTitle string `json:"project_title"`
	ModuleID     string `json:"module_id"`
	ModuleTitle  string `json:"module_title"`
	CollabPath   string `json:"collab_path"`
	// The folder new meeting folders are created in.
	BaseDir string `json:"base_dir"`
	// True when base_dir was derived from the project and module rather than
	// confirmed by someone. The form shows a derived path as a proposal.
	Derived bool `json:"derived"`
	// True when base_dir exists on this server right now. False is not an
	// error: the share may simply not be mounted here.
	BaseDirExists bool `json:"base_dir_exists"`
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

	resp := CockpitMeetingDestinationResponse{
		ProjectID: uuidToString(projectID),
		ModuleID:  uuidToString(moduleID),
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

	// The board's own override is what a preview of a DIFFERENT module must
	// not inherit: a stored folder answers for the stored module only.
	probe := cc
	if uuidToString(moduleID) != uuidToString(cc.cockpit.MeetingModuleID) ||
		uuidToString(projectID) != uuidToString(cc.cockpit.MeetingProjectID) {
		probe.cockpit.MeetingDir = ""
	}
	base, derived, err := h.meetingBaseDir(ctx, probe, projectID, moduleID)
	if err != nil {
		resp.Error = err.Error()
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.BaseDir = base
	resp.Derived = derived
	if info, statErr := os.Stat(base); statErr == nil && info.IsDir() {
		resp.BaseDirExists = true
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

	resp := CockpitMeetingProvisionResponse{}

	// --- the folder -----------------------------------------------------
	dir := meeting.NasDir
	if boolOrDefault(req.CreateDir, true) {
		base := ""
		if req.BaseDir != nil {
			base = strings.TrimSpace(*req.BaseDir)
		}
		if base == "" {
			derivedBase, _, baseErr := h.meetingBaseDir(ctx, cc, projectID, moduleID)
			if baseErr != nil {
				resp.DirError = baseErr.Error()
			}
			base = derivedBase
		}
		if resp.DirError == "" {
			name := meetingFolderName(meeting)
			if req.FolderName != nil && strings.TrimSpace(*req.FolderName) != "" {
				name = strings.TrimSpace(*req.FolderName)
			}
			created, dirErr := createMeetingDir(base, name)
			if dirErr != nil {
				resp.DirError = dirErr.Error()
			} else {
				dir = created
				resp.Dir = created
				resp.DirCreated = true
			}
		}
	}

	// --- the task -------------------------------------------------------
	if boolOrDefault(req.CreateTask, true) {
		link, taskErr := h.openMeetingTask(r, cc, meeting, projectID, moduleID, req, dir)
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
		// Only a folder that was actually used is worth remembering, and only
		// its parent: the board stores where meeting folders go, not where one
		// meeting went.
		if resp.DirCreated && resp.Dir != "" {
			params.MeetingDir = pgtype.Text{String: filepath.Dir(resp.Dir), Valid: true}
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

// openMeetingTask files the meeting's issue and links it. Returns a
// human-readable reason instead of an error when the task could not be
// opened: the caller reports it alongside a meeting that was still saved.
func (h *Handler) openMeetingTask(
	r *http.Request,
	cc cockpitContext,
	meeting db.CockpitMeeting,
	projectID, moduleID pgtype.UUID,
	req CockpitMeetingProvisionRequest,
	dir string,
) (*CockpitMeetingIssueResponse, string) {
	ctx := r.Context()
	title := strings.TrimSpace(meeting.Title)
	if title == "" {
		title = meetingFolderName(meeting)
	}
	if title == "" {
		return nil, "the meeting has no name to open a task with"
	}

	// Default to the member filing the meeting. An unassigned issue falls back
	// to the workspace's cluster agent and enqueues a run immediately, which
	// is the right default for work someone asked an agent for and the wrong
	// one for the minutes of a meeting.
	assigneeType := pgtype.Text{String: "member", Valid: true}
	assigneeID := cc.member.UserID
	if req.AssigneeType != nil && strings.TrimSpace(*req.AssigneeType) != "" {
		assigneeType = pgtype.Text{String: strings.TrimSpace(*req.AssigneeType), Valid: true}
		assigneeID = pgtype.UUID{}
		if req.AssigneeID != nil && strings.TrimSpace(*req.AssigneeID) != "" {
			id, err := util.ParseUUID(strings.TrimSpace(*req.AssigneeID))
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
		Description:  pgtype.Text{String: meetingTaskDescription(meeting, dir), Valid: true},
		Status:       "todo",
		Priority:     "none",
		AssigneeType: assigneeType,
		AssigneeID:   assigneeID,
		CreatorType:  "member",
		CreatorID:    cc.member.UserID,
		ProjectID:    projectID,
		ModuleID:     moduleID,
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
