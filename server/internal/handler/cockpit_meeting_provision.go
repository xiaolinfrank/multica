package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/projectaccess"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

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
	fillCreated := h.newStatusCategoryFiller(ctx, cc.workspaceID, projectaccess.Hidden{}, nil)
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
