package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
)

func writeCockpitActionError(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	if writeIssueLimitReached(w, err) {
		return true
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, service.ErrCockpitWorkflowInput), errors.Is(err, service.ErrProjectNotFound), errors.Is(err, service.ErrModuleNotFound), errors.Is(err, service.ErrModuleNotInProject):
		status = http.StatusBadRequest
	case errors.Is(err, service.ErrCockpitWorkflowConflict), errors.Is(err, service.ErrCockpitWorkflowExecutionBlocked):
		status = http.StatusConflict
	case errors.Is(err, service.ErrCockpitWorkflowForbidden):
		status = http.StatusForbidden
	case errors.Is(err, service.ErrCockpitWorkflowNotFound), errors.Is(err, pgx.ErrNoRows):
		status = http.StatusNotFound
	}
	if status == http.StatusInternalServerError {
		slog.Error("cockpit action request failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, status, "cockpit operation could not be confirmed; reload before retrying")
	} else {
		writeError(w, status, err.Error())
	}
	return true
}

func cockpitActionPageSize(w http.ResponseWriter, r *http.Request) (int32, bool) {
	size := 25
	if raw := r.URL.Query().Get("page_size"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "page_size must be between 1 and 100")
			return 0, false
		}
		size = parsed
	}
	if len(r.URL.Query().Get("q")) > 512 || len(r.URL.Query().Get("cursor")) > 4096 {
		writeError(w, http.StatusBadRequest, "search or cursor exceeds the supported length")
		return 0, false
	}
	return int32(size), true
}

func (h *Handler) ListCockpitMeetingActions(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, false)
	if !ok {
		return
	}
	size, ok := cockpitActionPageSize(w, r)
	if !ok {
		return
	}
	query := r.URL.Query()
	var version pgtype.UUID
	if ref := query.Get("version_id"); ref != "" {
		version, ok = parseUUIDOrBadRequest(w, ref, "version_id")
		if !ok {
			return
		}
	}
	out, err := h.IssueService.ListCockpitMeetingActions(r.Context(), service.CockpitActionList{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, VersionID: version,
		Human: !isMachineCredentialActor(r), Query: query.Get("q"), Status: query.Get("status"), Cursor: query.Get("cursor"), PageSize: size,
	})
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) GetCockpitMeetingAction(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, false)
	if !ok {
		return
	}
	action, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "actionId"), "action_id")
	if ok {
		h.writeCockpitMeetingAction(w, r, cc, meeting.ID, action)
	}
}

func (h *Handler) writeCockpitMeetingAction(w http.ResponseWriter, r *http.Request, cc cockpitContext, meeting, action pgtype.UUID) {
	out, err := h.IssueService.GetCockpitMeetingAction(r.Context(), service.CockpitActionRead{
		WorkspaceID: cc.workspaceID, MeetingID: meeting, ActionID: action, ActorID: cc.member.UserID, Human: !isMachineCredentialActor(r),
	})
	if !writeCockpitActionError(w, r, err) {
		writeJSON(w, http.StatusOK, out)
	}
}

func (h *Handler) CreateCockpitMeetingAction(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	version, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "versionId"), "version_id")
	if !ok {
		return
	}
	var req struct {
		ProposalKey string `json:"proposal_key"`
		Title       string `json:"title"`
		Description string `json:"description"`
		SourceQuote string `json:"source_quote"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	key, ok := parseUUIDOrBadRequest(w, req.ProposalKey, "proposal_key")
	if !ok {
		return
	}
	action, err := h.IssueService.CreateCockpitMeetingAction(r.Context(), service.CockpitActionDraft{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, VersionID: version, ActorID: cc.member.UserID, ProposalKey: key,
		Title: req.Title, Description: req.Description, SourceQuote: req.SourceQuote,
	})
	if !writeCockpitActionError(w, r, err) {
		h.writeCockpitMeetingAction(w, r, cc, meeting.ID, action.ID)
	}
}

func (h *Handler) UpdateCockpitMeetingAction(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	actionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "actionId"), "action_id")
	if !ok {
		return
	}
	var req struct {
		cockpitWorkflowRevisionRequest
		Title       *string `json:"title"`
		Description *string `json:"description"`
		SourceQuote *string `json:"source_quote"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 || req.Title == nil || req.Description == nil || req.SourceQuote == nil {
		writeError(w, http.StatusBadRequest, "positive expected_revision and all proposal text fields are required")
		return
	}
	action, err := h.IssueService.UpdateCockpitMeetingAction(r.Context(), service.CockpitActionEdit{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActionID: actionID, ActorID: cc.member.UserID,
		ExpectedRevision: *req.ExpectedRevision, Title: *req.Title, Description: *req.Description, SourceQuote: *req.SourceQuote,
	})
	if !writeCockpitActionError(w, r, err) {
		h.writeCockpitMeetingAction(w, r, cc, meeting.ID, action.ID)
	}
}

type cockpitActionIssueFields struct {
	AssigneeType *string `json:"assignee_type"`
	AssigneeID   *string `json:"assignee_id"`
	Priority     *string `json:"priority"`
	DueDate      *string `json:"due_date"`
}

func (h *Handler) cockpitActionIssueInput(w http.ResponseWriter, r *http.Request, cc cockpitContext, req cockpitActionIssueFields) (service.IssueCreateParams, bool) {
	input := service.IssueCreateParams{WorkspaceID: cc.workspaceID, Status: "backlog", Priority: "none", CreatorType: "member", CreatorID: cc.member.UserID}
	if req.Priority != nil {
		input.Priority = *req.Priority
		if input.Priority != "none" && input.Priority != "urgent" && input.Priority != "high" && input.Priority != "medium" && input.Priority != "low" {
			writeError(w, http.StatusBadRequest, "invalid priority")
			return input, false
		}
	}
	if (req.AssigneeType == nil) != (req.AssigneeID == nil) {
		writeError(w, http.StatusBadRequest, "assignee_type and assignee_id must be supplied together")
		return input, false
	}
	if req.AssigneeID != nil {
		id, ok := parseUUIDOrBadRequest(w, *req.AssigneeID, "assignee_id")
		if !ok {
			return input, false
		}
		input.AssigneeID, input.AssigneeType = id, pgtype.Text{String: *req.AssigneeType, Valid: true}
		if status, msg := h.validateAssigneePair(r.Context(), r, uuidToString(cc.workspaceID), input.AssigneeType, input.AssigneeID); status != 0 {
			writeError(w, status, msg)
			return input, false
		}
	}
	if req.DueDate != nil {
		date, err := util.ParseCalendarDate(*req.DueDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "due_date must be a valid YYYY-MM-DD date")
			return input, false
		}
		input.DueDate = date
	}
	return input, true
}

// decodeCockpitActionResolution decodes the shared resolve/revise command
// body. resolve demands a reason only for dismiss; revise demands one for
// every outcome (the revision motive, design-principles-2026-10-12).
func (h *Handler) decodeCockpitActionResolution(w http.ResponseWriter, r *http.Request, cc cockpitContext, requireReason bool) (service.CockpitActionResolution, bool) {
	var req struct {
		cockpitWorkflowRevisionRequest
		cockpitActionIssueFields
		DecisionKey string  `json:"decision_key"`
		Outcome     string  `json:"outcome"`
		NodeID      *string `json:"node_id"`
		IssueID     *string `json:"issue_id"`
		Reason      string  `json:"reason"`
	}
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return service.CockpitActionResolution{}, false
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 || (req.Outcome != "create" && req.Outcome != "reuse" && req.Outcome != "dismiss") {
		writeError(w, http.StatusBadRequest, "positive expected_revision and create/reuse/dismiss outcome are required")
		return service.CockpitActionResolution{}, false
	}
	key, ok := parseUUIDOrBadRequest(w, req.DecisionKey, "decision_key")
	if !ok {
		return service.CockpitActionResolution{}, false
	}
	input := service.CockpitActionResolution{ExpectedRevision: *req.ExpectedRevision, DecisionKey: key, Outcome: req.Outcome, Reason: req.Reason}
	if requireReason && strings.TrimSpace(req.Reason) == "" {
		writeError(w, http.StatusBadRequest, "a reason is required to revise a resolution")
		return service.CockpitActionResolution{}, false
	}
	if req.Outcome != "create" {
		for _, field := range []string{"assignee_type", "assignee_id", "priority", "due_date"} {
			if _, present := raw[field]; present {
				writeError(w, http.StatusBadRequest, "reuse and dismiss preserve existing issue fields")
				return service.CockpitActionResolution{}, false
			}
		}
	} else {
		input.NewIssue, ok = h.cockpitActionIssueInput(w, r, cc, req.cockpitActionIssueFields)
		if !ok {
			return service.CockpitActionResolution{}, false
		}
	}
	if req.Outcome == "dismiss" {
		_, hasNode := raw["node_id"]
		_, hasIssue := raw["issue_id"]
		if hasNode || hasIssue || strings.TrimSpace(req.Reason) == "" {
			writeError(w, http.StatusBadRequest, "dismiss requires a reason and cannot assign a node or issue")
			return service.CockpitActionResolution{}, false
		}
	} else {
		if req.NodeID == nil {
			writeError(w, http.StatusBadRequest, "node_id is required")
			return service.CockpitActionResolution{}, false
		}
		input.NodeID, ok = parseUUIDOrBadRequest(w, *req.NodeID, "node_id")
		if !ok {
			return service.CockpitActionResolution{}, false
		}
	}
	if req.Outcome == "reuse" {
		if req.IssueID == nil || strings.TrimSpace(*req.IssueID) == "" {
			writeError(w, http.StatusBadRequest, "issue_id is required for reuse")
			return service.CockpitActionResolution{}, false
		}
		issue, ok := h.loadIssueForUser(w, r, *req.IssueID)
		if !ok {
			return service.CockpitActionResolution{}, false
		}
		input.IssueID = issue.ID
	} else if _, present := raw["issue_id"]; present {
		writeError(w, http.StatusBadRequest, "issue_id is only valid for reuse")
		return service.CockpitActionResolution{}, false
	}
	return input, true
}

func (h *Handler) ResolveCockpitMeetingAction(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	actionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "actionId"), "action_id")
	if !ok {
		return
	}
	input, ok := h.decodeCockpitActionResolution(w, r, cc, false)
	if !ok {
		return
	}
	input.WorkspaceID, input.MeetingID, input.ActionID, input.ActorID = cc.workspaceID, meeting.ID, actionID, cc.member.UserID
	action, err := h.IssueService.ResolveCockpitMeetingAction(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(cc.member.UserID)})
	if !writeCockpitActionError(w, r, err) {
		h.writeCockpitMeetingAction(w, r, cc, meeting.ID, action.ID)
	}
}

// ReviseCockpitMeetingActionResolution rewrites the decision written on an
// accepted or dismissed action (R2, design-principles-2026-10-12): the same
// command shape and idempotency protocol as resolve, with a mandatory
// revision reason; previously created issues are never deleted by it.
func (h *Handler) ReviseCockpitMeetingActionResolution(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	actionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "actionId"), "action_id")
	if !ok {
		return
	}
	input, ok := h.decodeCockpitActionResolution(w, r, cc, true)
	if !ok {
		return
	}
	input.WorkspaceID, input.MeetingID, input.ActionID, input.ActorID = cc.workspaceID, meeting.ID, actionID, cc.member.UserID
	action, err := h.IssueService.ReviseCockpitMeetingActionResolution(r.Context(), input, service.IssueCreateOpts{ActorID: uuidToString(cc.member.UserID)})
	if !writeCockpitActionError(w, r, err) {
		h.writeCockpitMeetingAction(w, r, cc, meeting.ID, action.ID)
	}
}
