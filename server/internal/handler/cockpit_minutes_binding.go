package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
)

// R1 (design-principles-2026-10-12): minutes bindings are associations with
// first-class commands — bind another task, unbind any of them, move focus.

type CockpitMinutesBindingResponse struct {
	Issue   *CockpitWorkflowIssueResponse `json:"issue"`
	IsFocus bool                          `json:"is_focus"`
	Roles   []string                      `json:"roles"`
}

func decodeCockpitBindingBody(w http.ResponseWriter, r *http.Request) (pgtype.UUID, int64, bool) {
	var req struct {
		IssueID          string `json:"issue_id"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid binding request body")
		return pgtype.UUID{}, 0, false
	}
	id, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
	if !ok {
		return pgtype.UUID{}, 0, false
	}
	return id, req.ExpectedRevision, true
}

func (h *Handler) BindCockpitMeetingMinutesIssue(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	issueID, revision, ok := decodeCockpitBindingBody(w, r)
	if !ok {
		return
	}
	issue, found := h.resolveCockpitIssue(r.Context(), uuidToString(issueID), uuidToString(cc.workspaceID))
	if !found {
		writeError(w, http.StatusBadRequest, "minutes issue not found in this workspace")
		return
	}
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "bound", h.IssueService.BindCockpitMinutesIssue(r.Context(), service.CockpitMinutesBindingCommand{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, IssueID: issue.ID, ExpectedRevision: revision,
	}))
}

func (h *Handler) UnbindCockpitMeetingMinutesIssue(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	issueID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "issueId"), "issue_id")
	if !ok {
		return
	}
	var revision int64
	if raw := r.URL.Query().Get("expected_revision"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			revision = parsed
		}
	}
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "unbound", h.IssueService.UnbindCockpitMinutesIssue(r.Context(), service.CockpitMinutesBindingCommand{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, IssueID: issueID, ExpectedRevision: revision,
	}))
}

func (h *Handler) FocusCockpitMeetingMinutesIssue(w http.ResponseWriter, r *http.Request) {
	cc, meeting, ok := h.cockpitWorkflowContext(w, r, true)
	if !ok {
		return
	}
	issueID, revision, ok := decodeCockpitBindingBody(w, r)
	if !ok {
		return
	}
	h.writeCockpitWorkflowResult(w, r, cc, meeting.ID, "focused", h.IssueService.FocusCockpitMinutesIssue(r.Context(), service.CockpitMinutesBindingCommand{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, ActorID: cc.member.UserID, IssueID: issueID, ExpectedRevision: revision,
	}))
}
