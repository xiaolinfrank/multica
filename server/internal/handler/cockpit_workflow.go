package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type CockpitWorkflowIssueResponse struct {
	ID           string  `json:"id"`
	Identifier   string  `json:"identifier"`
	Title        string  `json:"title"`
	Status       string  `json:"status"`
	AssigneeType *string `json:"assignee_type"`
	AssigneeID   *string `json:"assignee_id"`
}

type CockpitMinutesVersionResponse struct {
	ID              string                        `json:"id"`
	VersionNumber   int32                         `json:"version_number"`
	SubmissionKey   string                        `json:"submission_key"`
	Content         string                        `json:"content"`
	ContentHash     string                        `json:"content_hash"`
	SourceIssueID   string                        `json:"source_issue_id"`
	ReviewIssue     *CockpitWorkflowIssueResponse `json:"review_issue"`
	ReviewerID      string                        `json:"reviewer_id"`
	Decision        string                        `json:"decision"`
	Feedback        string                        `json:"feedback"`
	SubmittedByType string                        `json:"submitted_by_type"`
	SubmittedByID   string                        `json:"submitted_by_id"`
	CreatedAt       string                        `json:"created_at"`
	ReviewedBy      *string                       `json:"reviewed_by"`
	ReviewedAt      *string                       `json:"reviewed_at"`
	PublishedBy     *string                       `json:"published_by"`
	PublishedAt     *string                       `json:"published_at"`
}

type CockpitMeetingWorkflowResponse struct {
	Enabled              bool                             `json:"enabled"`
	MeetingID            string                           `json:"meeting_id"`
	Revision             int64                            `json:"revision"`
	EndedAt              *string                          `json:"ended_at"`
	MaterialsReady       bool                             `json:"materials_ready"`
	ReleasedAt           *string                          `json:"released_at"`
	ReleaseTaskID        *string                          `json:"release_task_id"`
	ReviewerID           *string                          `json:"reviewer_id"`
	MinutesIssue         *CockpitWorkflowIssueResponse    `json:"minutes_issue"`
	CurrentVersionID     *string                          `json:"current_version_id"`
	PublishedVersionID   *string                          `json:"published_version_id"`
	Versions             []CockpitMinutesVersionResponse  `json:"versions"`
	CanManage            bool                             `json:"can_manage"`
	CanSubmit            bool                             `json:"can_submit"`
	CanReview            bool                             `json:"can_review"`
	CanPublish           bool                             `json:"can_publish"`
	CanReassignReviewer  bool                             `json:"can_reassign_reviewer"`
	ReviewerHandoffs     []CockpitReviewerHandoffResponse `json:"reviewer_handoffs"`
	NASDestination       *cockpitnas.Directory            `json:"nas_destination"`
	NASUnavailableReason string                           `json:"nas_unavailable_reason"`
	CanExportNAS         bool                             `json:"can_export_nas"`
	NASExports           []CockpitMinutesExportResponse   `json:"nas_exports"`
}

type CockpitMinutesExportResponse struct {
	ID            string  `json:"id"`
	VersionID     string  `json:"version_id"`
	VersionNumber int32   `json:"version_number"`
	SourceIssueID string  `json:"source_issue_id"`
	ContentHash   string  `json:"content_hash"`
	RootID        string  `json:"root_id"`
	Directory     string  `json:"directory"`
	TargetPath    string  `json:"target_path"`
	Status        string  `json:"status"`
	Attempts      int32   `json:"attempts"`
	Revision      int64   `json:"revision"`
	NextRetryAt   *string `json:"next_retry_at"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
	CompletedAt   *string `json:"completed_at"`
	LastErrorCode string  `json:"last_error_code"`
	LastError     string  `json:"last_error"`
	SizeBytes     *int64  `json:"size_bytes"`
	CanRetry      bool    `json:"can_retry"`
}

type CockpitReviewerHandoffResponse struct {
	ID               string                        `json:"id"`
	HandoffKey       string                        `json:"handoff_key"`
	FromReviewerID   string                        `json:"from_reviewer_id"`
	ToReviewerID     string                        `json:"to_reviewer_id"`
	FromReviewerName string                        `json:"from_reviewer_name"`
	ToReviewerName   string                        `json:"to_reviewer_name"`
	CreatedByName    string                        `json:"created_by_name"`
	VersionID        *string                       `json:"version_id"`
	FromReviewIssue  *CockpitWorkflowIssueResponse `json:"from_review_issue"`
	ToReviewIssue    *CockpitWorkflowIssueResponse `json:"to_review_issue"`
	Reason           string                        `json:"reason"`
	CreatedBy        string                        `json:"created_by"`
	CreatedAt        string                        `json:"created_at"`
	Revision         int64                         `json:"revision"`
}

func cockpitWorkflowTime(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	stamp := value.Time.UTC().Format(time.RFC3339Nano)
	return &stamp
}

func cockpitWorkflowManagedBy(work db.CockpitMeetingWorkPackage, member db.Member) bool {
	return work.CreatedBy == member.UserID || member.Role == "owner" || member.Role == "admin"
}

// Human-only operations keep a handler backstop as well as the router guard.
func (h *Handler) cockpitWorkflowContext(w http.ResponseWriter, r *http.Request, humanOnly bool) (cockpitContext, db.CockpitMeeting, bool) {
	if humanOnly && isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this meeting operation requires a human actor")
		return cockpitContext{}, db.CockpitMeeting{}, false
	}
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return cc, db.CockpitMeeting{}, false
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	return cc, meeting, ok
}

func (h *Handler) canSubmitCockpitMinutes(r *http.Request, q *db.Queries, cc cockpitContext, work db.CockpitMeetingWorkPackage, issue *CockpitWorkflowIssueResponse) bool {
	if !work.ReleasedAt.Valid || issue == nil {
		return false
	}
	if !isMachineCredentialActor(r) {
		return cockpitWorkflowManagedBy(work, cc.member) ||
			(issue.AssigneeType != nil && *issue.AssigneeType == "member" && issue.AssigneeID != nil && *issue.AssigneeID == uuidToString(cc.member.UserID))
	}
	// A cloud-node credential is not an issue-scoped author. Task-token auth
	// stamps this identity after stripping client-supplied actor headers.
	if r.Header.Get("X-Actor-Source") != "task_token" {
		return false
	}
	taskID, err := util.ParseUUID(r.Header.Get("X-Task-ID"))
	if err != nil {
		return false
	}
	task, err := q.GetAgentTaskInWorkspace(r.Context(), db.GetAgentTaskInWorkspaceParams{ID: taskID, WorkspaceID: cc.workspaceID})
	return err == nil && task.IssueID == work.MinutesIssueID && uuidToString(task.AgentID) == r.Header.Get("X-Agent-ID")
}

// Read the package under a shared lock, then batch-load issue cards. Concurrent
// review/submit commands cannot produce a mixed version/revision response.
func (h *Handler) cockpitWorkflowResponse(r *http.Request, cc cockpitContext, meetingID pgtype.UUID) (CockpitMeetingWorkflowResponse, error) {
	out := CockpitMeetingWorkflowResponse{MeetingID: uuidToString(meetingID), Versions: []CockpitMinutesVersionResponse{}, ReviewerHandoffs: []CockpitReviewerHandoffResponse{}, NASExports: []CockpitMinutesExportResponse{}}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		return out, err
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	work, err := q.GetCockpitMeetingWorkPackageForRead(r.Context(), db.GetCockpitMeetingWorkPackageForReadParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID})
	if errors.Is(err, pgx.ErrNoRows) {
		out.CanManage = !isMachineCredentialActor(r)
		return out, nil
	}
	if err != nil {
		return out, err
	}
	meeting, err := q.GetCockpitMeeting(r.Context(), db.GetCockpitMeetingParams{ID: meetingID, WorkspaceID: cc.workspaceID})
	if err != nil {
		return out, err
	}
	out.NASUnavailableReason = "not_configured"
	if exporter := h.IssueService.CockpitNASExporter; exporter != nil {
		preview, previewErr := exporter.Preview(uuidToString(cc.workspaceID), meeting.NasDir)
		if previewErr == nil {
			out.NASDestination = &preview
			out.NASUnavailableReason = ""
		} else {
			var detail *cockpitnas.Error
			if errors.As(previewErr, &detail) {
				out.NASUnavailableReason = detail.Code
			}
		}
	}
	versions, err := q.ListCockpitMinutesVersions(r.Context(), db.ListCockpitMinutesVersionsParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID})
	if err != nil {
		return out, err
	}
	handoffs, err := q.ListCockpitReviewerHandoffs(r.Context(), db.ListCockpitReviewerHandoffsParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID})
	if err != nil {
		return out, err
	}
	ids := []pgtype.UUID{work.MinutesIssueID}
	for _, version := range versions {
		ids = append(ids, version.ReviewIssueID)
	}
	for _, handoff := range handoffs {
		if handoff.FromReviewIssueID.Valid {
			ids = append(ids, handoff.FromReviewIssueID)
		}
		if handoff.ToReviewIssueID.Valid {
			ids = append(ids, handoff.ToReviewIssueID)
		}
	}
	// Only identities from this authorized meeting's ledger are enriched. A
	// departed member's account can still supply its display name; emails and
	// other profile fields never enter this response. IDs remain authoritative.
	names := make(map[pgtype.UUID]string)
	if len(handoffs) > 0 {
		userIDs := make([]pgtype.UUID, 0, len(handoffs)*3)
		for _, handoff := range handoffs {
			userIDs = append(userIDs, handoff.FromReviewerID, handoff.ToReviewerID, handoff.CreatedBy)
		}
		users, err := q.GetUsersByIDs(r.Context(), userIDs)
		if err != nil {
			return out, err
		}
		for _, user := range users {
			names[user.ID] = user.Name
		}
	}
	issues, err := q.ListCockpitWorkflowIssues(r.Context(), db.ListCockpitWorkflowIssuesParams{WorkspaceID: cc.workspaceID, IssueIds: ids})
	if err != nil {
		return out, err
	}
	cards := make(map[pgtype.UUID]*CockpitWorkflowIssueResponse, len(issues))
	workspace, err := q.GetWorkspace(r.Context(), cc.workspaceID)
	if err != nil {
		return out, err
	}
	prefix := issuePrefixForWorkspace(workspace)
	for _, issue := range issues {
		cards[issue.ID] = &CockpitWorkflowIssueResponse{ID: uuidToString(issue.ID), Identifier: fmt.Sprintf("%s-%d", prefix, issue.Number),
			Title: issue.Title, Status: issue.Status, AssigneeType: textToPtr(issue.AssigneeType), AssigneeID: uuidToPtr(issue.AssigneeID)}
	}
	out.Enabled = true
	out.Revision = work.Revision
	out.EndedAt = cockpitWorkflowTime(work.EndedAt)
	out.MaterialsReady = work.MaterialsReady
	out.ReleasedAt = cockpitWorkflowTime(work.ReleasedAt)
	out.ReleaseTaskID = uuidToPtr(work.ReleaseTaskID)
	out.ReviewerID = uuidToPtr(work.ReviewerID)
	out.MinutesIssue = cards[work.MinutesIssueID]
	out.CurrentVersionID = uuidToPtr(work.CurrentVersionID)
	out.PublishedVersionID = uuidToPtr(work.PublishedVersionID)
	out.CanManage = !isMachineCredentialActor(r) && cockpitWorkflowManagedBy(work, cc.member)
	out.CanReassignReviewer = out.CanManage
	out.CanSubmit = h.canSubmitCockpitMinutes(r, q, cc, work, out.MinutesIssue)
	for _, handoff := range handoffs {
		out.ReviewerHandoffs = append(out.ReviewerHandoffs, CockpitReviewerHandoffResponse{
			ID: uuidToString(handoff.ID), HandoffKey: uuidToString(handoff.HandoffKey),
			FromReviewerID: uuidToString(handoff.FromReviewerID), ToReviewerID: uuidToString(handoff.ToReviewerID),
			FromReviewerName: names[handoff.FromReviewerID], ToReviewerName: names[handoff.ToReviewerID], CreatedByName: names[handoff.CreatedBy],
			VersionID: uuidToPtr(handoff.VersionID), FromReviewIssue: cards[handoff.FromReviewIssueID], ToReviewIssue: cards[handoff.ToReviewIssueID],
			Reason: handoff.Reason, CreatedBy: uuidToString(handoff.CreatedBy), CreatedAt: handoff.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: handoff.Revision,
		})
	}
	for _, version := range versions {
		out.Versions = append(out.Versions, CockpitMinutesVersionResponse{
			ID: uuidToString(version.ID), VersionNumber: version.VersionNumber, SubmissionKey: uuidToString(version.SubmissionKey),
			Content: version.Content, ContentHash: version.ContentHash, SourceIssueID: uuidToString(version.SourceIssueID),
			ReviewIssue: cards[version.ReviewIssueID], ReviewerID: uuidToString(version.ReviewerID), Decision: version.Decision, Feedback: version.Feedback,
			SubmittedByType: version.SubmittedByType, SubmittedByID: uuidToString(version.SubmittedByID), CreatedAt: version.CreatedAt.Time.UTC().Format(time.RFC3339Nano),
			ReviewedBy: uuidToPtr(version.ReviewedBy), ReviewedAt: cockpitWorkflowTime(version.ReviewedAt),
			PublishedBy: uuidToPtr(version.PublishedBy), PublishedAt: cockpitWorkflowTime(version.PublishedAt),
		})
		if version.ID == work.CurrentVersionID && !isMachineCredentialActor(r) {
			out.CanReview = version.ReviewerID == cc.member.UserID && version.Decision == "pending"
			out.CanPublish = (version.ReviewerID == cc.member.UserID || out.CanManage) && version.Decision == "approved"
		}
		if version.ID == work.PublishedVersionID && version.PublishedAt.Valid && version.Decision == "approved" && !isMachineCredentialActor(r) {
			out.CanExportNAS = version.ReviewerID == cc.member.UserID || out.CanManage
		}
	}
	exports, err := q.ListCockpitMinutesExports(r.Context(), db.ListCockpitMinutesExportsParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID})
	if err != nil {
		return out, err
	}
	for _, export := range exports {
		mayExport := false
		for _, version := range versions {
			if version.ID == export.VersionID && version.PublishedAt.Valid && version.Decision == "approved" {
				mayExport = !isMachineCredentialActor(r) && (out.CanManage || version.ReviewerID == cc.member.UserID)
				break
			}
		}
		var size *int64
		if export.SizeBytes.Valid {
			value := export.SizeBytes.Int64
			size = &value
		}
		var next *string
		if export.Status == "retry_wait" || export.Status == "queued" {
			next = cockpitWorkflowTime(export.NextRetryAt)
		}
		out.NASExports = append(out.NASExports, CockpitMinutesExportResponse{
			ID: uuidToString(export.ID), VersionID: uuidToString(export.VersionID), VersionNumber: export.VersionNumber,
			SourceIssueID: uuidToString(export.SourceIssueID), ContentHash: export.ContentHash, RootID: export.RootID,
			Directory: export.Directory, TargetPath: export.TargetPath, Status: export.Status, Attempts: export.Attempts, Revision: export.Revision,
			NextRetryAt: next, CreatedAt: export.CreatedAt.Time.UTC().Format(time.RFC3339Nano), UpdatedAt: export.UpdatedAt.Time.UTC().Format(time.RFC3339Nano),
			CompletedAt: cockpitWorkflowTime(export.CompletedAt), LastErrorCode: export.LastErrorCode, LastError: export.LastError, SizeBytes: size,
			CanRetry: mayExport && (export.Status == "retry_wait" || export.Status == "needs_attention"),
		})
	}
	return out, nil
}

func (h *Handler) writeCockpitWorkflowResult(w http.ResponseWriter, r *http.Request, cc cockpitContext, meetingID pgtype.UUID, action string, err error) {
	if err != nil {
		if writeIssueLimitReached(w, err) {
			return
		}
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, service.ErrCockpitWorkflowInput), errors.Is(err, service.ErrProjectNotFound), errors.Is(err, service.ErrModuleNotFound), errors.Is(err, service.ErrModuleNotInProject):
			status = http.StatusBadRequest
		case errors.Is(err, service.ErrCockpitWorkflowConflict), errors.Is(err, service.ErrCockpitWorkflowExecutionBlocked):
			status = http.StatusConflict
		case errors.Is(err, service.ErrCockpitWorkflowForbidden):
			status = http.StatusForbidden
		case errors.Is(err, service.ErrCockpitWorkflowNotFound):
			status = http.StatusNotFound
		}
		if status == http.StatusInternalServerError {
			slog.Error("meeting workflow operation failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, status, "meeting workflow could not be completed; reload and retry")
		} else {
			writeError(w, status, err.Error())
		}
		return
	}
	out, err := h.cockpitWorkflowResponse(r, cc, meetingID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "meeting workflow was updated; reload to read the result")
		return
	}
	if action != "" {
		actorType, actorID := h.resolveActor(r, uuidToString(cc.member.UserID), uuidToString(cc.workspaceID))
		h.publish(protocol.EventCockpitChanged, uuidToString(cc.workspaceID), actorType, actorID, map[string]any{
			"scope": "meeting_workflow", "action": action, "entity": map[string]any{"meeting_id": uuidToString(meetingID)},
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) GetCockpitMeetingWorkflow(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, false)
	if ok {
		h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "", nil)
	}
}

type cockpitWorkflowRevisionRequest struct {
	ExpectedRevision *int64 `json:"expected_revision"`
}

func cockpitWorkflowCommand(w http.ResponseWriter, cc cockpitContext, meetingID pgtype.UUID, revision *int64) (service.CockpitWorkPackageCommand, bool) {
	if revision == nil || *revision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be a positive integer")
		return service.CockpitWorkPackageCommand{}, false
	}
	return service.CockpitWorkPackageCommand{WorkspaceID: cc.workspaceID, MeetingID: meetingID, ActorID: cc.member.UserID, ExpectedRevision: *revision}, true
}

func (h *Handler) EnableCockpitMeetingWorkflow(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req struct {
		ReviewerID      string  `json:"reviewer_id"`
		ExistingIssueID string  `json:"existing_issue_id"`
		ProjectID       *string `json:"project_id"`
		ModuleID        *string `json:"module_id"`
		NodeID          *string `json:"node_id"`
		AssigneeType    *string `json:"assignee_type"`
		AssigneeID      *string `json:"assignee_id"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	reviewer, ok := parseUUIDOrBadRequest(w, req.ReviewerID, "reviewer_id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetMemberByUserAndWorkspace(r.Context(), db.GetMemberByUserAndWorkspaceParams{UserID: reviewer, WorkspaceID: cc.workspaceID}); err != nil {
		writeError(w, http.StatusBadRequest, "reviewer must be a member of this workspace")
		return
	}
	input := service.CockpitWorkPackageInit{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, ReviewerID: reviewer}
	if req.NodeID != nil && strings.TrimSpace(*req.NodeID) != "" {
		node, found := h.resolveCockpitNode(r.Context(), cc, *req.NodeID)
		if !found {
			writeError(w, http.StatusBadRequest, "archive node not found on this board")
			return
		}
		input.NodeID = node.ID
	}
	if strings.TrimSpace(req.ExistingIssueID) != "" {
		if req.AssigneeType != nil || req.AssigneeID != nil {
			writeError(w, http.StatusBadRequest, "adoption preserves the existing executor; omit assignee_type and assignee_id")
			return
		}
		issue, found := h.resolveCockpitIssue(r.Context(), req.ExistingIssueID, uuidToString(cc.workspaceID))
		if !found {
			writeError(w, http.StatusBadRequest, "minutes issue not found in this workspace")
			return
		}
		input.ExistingIssueID = issue.ID
		for _, field := range []struct {
			name  string
			raw   *string
			owned pgtype.UUID
		}{{"project_id", req.ProjectID, issue.ProjectID}, {"module_id", req.ModuleID, issue.ModuleID}} {
			if field.raw == nil {
				continue
			}
			var selected pgtype.UUID
			if strings.TrimSpace(*field.raw) != "" {
				selected, ok = parseUUIDOrBadRequest(w, *field.raw, field.name)
				if !ok {
					return
				}
			}
			if selected != field.owned {
				writeError(w, http.StatusConflict, "adoption cannot move an existing issue to another project or module")
				return
			}
		}
	} else {
		// Destination defaults remain explicit UUIDs. A missing NAS mount must
		// not prevent preparing a business task; no filesystem access occurs here.
		project, module := cc.cockpit.MeetingProjectID, cc.cockpit.MeetingModuleID
		for _, field := range []struct {
			name string
			raw  *string
			id   *pgtype.UUID
		}{{"project_id", req.ProjectID, &project}, {"module_id", req.ModuleID, &module}} {
			if field.raw != nil {
				*field.id = pgtype.UUID{}
				if strings.TrimSpace(*field.raw) != "" {
					id, ok := parseUUIDOrBadRequest(w, *field.raw, field.name)
					if !ok {
						return
					}
					*field.id = id
				}
			}
		}
		assigneeType, assigneeID := pgtype.Text{String: "member", Valid: true}, cc.member.UserID
		if req.AssigneeID != nil && strings.TrimSpace(*req.AssigneeID) != "" && (req.AssigneeType == nil || strings.TrimSpace(*req.AssigneeType) == "") {
			writeError(w, http.StatusBadRequest, "assignee_type is required with assignee_id")
			return
		}
		if req.AssigneeType != nil && *req.AssigneeType != "" {
			assigneeType.String = *req.AssigneeType
			if req.AssigneeID == nil {
				writeError(w, http.StatusBadRequest, "assignee_id is required with assignee_type")
				return
			}
			assigneeID, ok = parseUUIDOrBadRequest(w, *req.AssigneeID, "assignee_id")
			if !ok {
				return
			}
		}
		if status, msg := h.validateAssigneePair(r.Context(), r, uuidToString(cc.workspaceID), assigneeType, assigneeID); status != 0 {
			writeError(w, status, msg)
			return
		}
		input.NewIssue = service.IssueCreateParams{WorkspaceID: cc.workspaceID, Title: meetingTaskTitle("", meeting),
			Description: pgtype.Text{String: meetingTaskDescription(meeting, meeting.NasDir), Valid: true},
			Status:      "backlog", Priority: "none", ProjectID: project, ModuleID: module,
			AssigneeType: assigneeType, AssigneeID: assigneeID, CreatorType: "member", CreatorID: cc.member.UserID, AllowDuplicate: true}
	}
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "enabled", h.IssueService.EnableCockpitMeetingWorkPackage(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(cc.member.UserID)}))
}

func (h *Handler) UpdateCockpitMeetingReadiness(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Ended          *bool `json:"ended"`
		MaterialsReady *bool `json:"materials_ready"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	if req.Ended == nil && req.MaterialsReady == nil {
		writeError(w, http.StatusBadRequest, "ended or materials_ready is required")
		return
	}
	err := h.IssueService.SetCockpitMeetingReadiness(r.Context(), service.CockpitWorkPackageReadiness{CockpitWorkPackageCommand: command, Ended: req.Ended, MaterialsReady: req.MaterialsReady})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "readiness", err)
}

func (h *Handler) ReleaseCockpitMeetingMinutes(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req cockpitWorkflowRevisionRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "released", h.IssueService.ReleaseCockpitMeetingMinutes(r.Context(), command))
}

func (h *Handler) SubmitCockpitMeetingMinutes(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, false)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		SubmissionKey string `json:"submission_key"`
		Content       string `json:"content"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, req.SubmissionKey, "submission_key")
	if !ok {
		return
	}
	work, err := h.Queries.GetCockpitMeetingWorkPackage(r.Context(), db.GetCockpitMeetingWorkPackageParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID})
	if err != nil {
		h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "", service.ErrCockpitWorkflowNotFound)
		return
	}
	issue, err := h.Queries.GetIssueInWorkspace(r.Context(), db.GetIssueInWorkspaceParams{WorkspaceID: cc.workspaceID, ID: work.MinutesIssueID})
	card := &CockpitWorkflowIssueResponse{AssigneeType: textToPtr(issue.AssigneeType), AssigneeID: uuidToPtr(issue.AssigneeID)}
	if err != nil || !h.canSubmitCockpitMinutes(r, h.Queries, cc, work, card) {
		h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "", service.ErrCockpitWorkflowForbidden)
		return
	}
	actorType, actorID := h.resolveActor(r, uuidToString(cc.member.UserID), uuidToString(cc.workspaceID))
	author, ok := parseUUIDOrBadRequest(w, actorID, "author_id")
	if !ok {
		return
	}
	err = h.IssueService.SubmitCockpitMeetingMinutes(r.Context(), service.CockpitMinutesSubmission{CockpitWorkPackageCommand: command,
		SubmissionKey: key, Content: strings.TrimSpace(req.Content), ActorType: actorType, AuthorID: author}, service.IssueCreateOpts{ActorID: actorID})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "submitted", err)
}

func (h *Handler) ReviewCockpitMeetingMinutes(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Decision string `json:"decision"`
		Feedback string `json:"feedback"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	versionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version_id")
	if !ok {
		return
	}
	err := h.IssueService.ReviewCockpitMeetingMinutes(r.Context(), service.CockpitMinutesReview{
		CockpitMinutesVersionCommand: service.CockpitMinutesVersionCommand{CockpitWorkPackageCommand: command, VersionID: versionID}, Decision: req.Decision, Feedback: strings.TrimSpace(req.Feedback)})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "reviewed", err)
}

func (h *Handler) PublishCockpitMeetingMinutes(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		NASExport *cockpitNASExportRequest `json:"nas_export"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	versionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version_id")
	if !ok {
		return
	}
	var target *service.CockpitMinutesExportTarget
	if req.NASExport != nil {
		parsed, ok := req.NASExport.parse(w)
		if !ok {
			return
		}
		target = &parsed
	}
	err := h.IssueService.PublishCockpitMeetingMinutes(r.Context(), service.CockpitMinutesVersionCommand{CockpitWorkPackageCommand: command, VersionID: versionID, NASExport: target})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "published", err)
}

type cockpitNASExportRequest struct {
	RootID    string `json:"root_id"`
	Directory string `json:"directory"`
}

func (req cockpitNASExportRequest) parse(w http.ResponseWriter) (service.CockpitMinutesExportTarget, bool) {
	id, ok := parseUUIDOrBadRequest(w, req.RootID, "root_id")
	if !ok {
		return service.CockpitMinutesExportTarget{}, false
	}
	if strings.TrimSpace(req.Directory) == "" {
		writeError(w, http.StatusBadRequest, "directory is required")
		return service.CockpitMinutesExportTarget{}, false
	}
	return service.CockpitMinutesExportTarget{RootID: uuidToString(id), Directory: strings.TrimSpace(req.Directory)}, true
}

func (h *Handler) ExportCockpitMeetingMinutes(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req cockpitNASExportRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	target, ok := req.parse(w)
	if !ok {
		return
	}
	version, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version_id")
	if !ok {
		return
	}
	_, err := h.IssueService.ExportCockpitMeetingMinutes(r.Context(), service.CockpitMinutesExportCommand{
		CockpitMinutesVersionCommand: service.CockpitMinutesVersionCommand{CockpitWorkPackageCommand: service.CockpitWorkPackageCommand{
			WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID}, VersionID: version}, Target: target,
	})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "nas_export_queued", err)
}

func (h *Handler) RetryCockpitMinutesExport(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req cockpitWorkflowRevisionRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 {
		writeError(w, http.StatusBadRequest, "expected_revision must be positive")
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "exportId"), "export_id")
	if !ok {
		return
	}
	_, err := h.IssueService.RetryCockpitMinutesExport(r.Context(), service.CockpitMinutesExportRetry{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, ExportID: id, ExpectedRevision: *req.ExpectedRevision,
	})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "nas_export_retried", err)
}

func (h *Handler) ChangeCockpitMeetingReviewer(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		HandoffKey string `json:"handoff_key"`
		ReviewerID string `json:"reviewer_id"`
		Reason     string `json:"reason"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	command, ok := cockpitWorkflowCommand(w, cc, meeting.ID, req.ExpectedRevision)
	if !ok {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, req.HandoffKey, "handoff_key")
	if !ok {
		return
	}
	reviewer, ok := parseUUIDOrBadRequest(w, req.ReviewerID, "reviewer_id")
	if !ok {
		return
	}
	err := h.IssueService.ChangeCockpitMeetingReviewer(r.Context(), service.CockpitReviewerHandoff{
		CockpitWorkPackageCommand: command, HandoffKey: key, ReviewerID: reviewer, Reason: strings.TrimSpace(req.Reason),
	}, service.IssueCreateOpts{ActorID: uuidToString(cc.member.UserID)})
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "reviewer_reassigned", err)
}

// Kept here so destructive operations can recheck in their own transaction.
func cockpitWorkflowProtectsIssue(ctx context.Context, q *db.Queries, issue db.Issue) error {
	protected, err := q.CockpitWorkflowReferencesIssue(ctx, db.CockpitWorkflowReferencesIssueParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID})
	if err != nil {
		return err
	}
	if protected {
		return fmt.Errorf("%w: this issue preserves meeting workflow history and cannot be deleted", service.ErrCockpitWorkflowConflict)
	}
	return nil
}
