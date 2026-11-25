package handler

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

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
