package handler

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var cockpitMeetingIssueRoles = map[string]bool{
	"preparation": true,
	"support":     true,
	"minutes":     true,
	"review":      true,
	"action":      true,
	"delivery":    true,
	"reference":   true,
}

// Existing unknown values are preserved by older clients; only known purposes
// can be added. The legacy role="task" remains a separate provisioning marker.
func normalizeCockpitMeetingRoles(values, existing []string) ([]string, error) {
	if values == nil {
		return nil, errors.New("roles must be an array; use [] to clear purposes")
	}
	if len(values) > 32 {
		return nil, errors.New("at most 32 roles can be supplied")
	}
	allowed := make(map[string]bool, len(existing))
	for _, role := range existing {
		allowed[role] = true
	}
	seen := make(map[string]bool, len(values))
	roles := make([]string, 0, len(values))
	for _, value := range values {
		role := strings.TrimSpace(value)
		if role == "" || len(role) > 64 || (!cockpitMeetingIssueRoles[role] && !allowed[role]) {
			return nil, fmt.Errorf("unknown meeting issue role: %s", role)
		}
		if !seen[role] {
			seen[role] = true
			roles = append(roles, role)
		}
	}
	sort.Strings(roles)
	return roles, nil
}

// SetCockpitMeetingIssueRoles classifies an existing relation without changing
// issue ownership, its execution status, or the meeting's occurrence state.
func (h *Handler) SetCockpitMeetingIssueRoles(w http.ResponseWriter, r *http.Request) {
	response := r.URL.Query().Get("response")
	if response != "" && response != "compact" {
		writeError(w, http.StatusBadRequest, "response must be compact or omitted")
		return
	}
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
	var req struct {
		Roles []string `json:"roles"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	ctx := r.Context()
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)

	link, err := q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issue.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "issue is not linked to this meeting")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read meeting issue roles")
		return
	}
	roles, err := normalizeCockpitMeetingRoles(req.Roles, link.Roles)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	required, err := q.CockpitMeetingWorkflowRequiredRole(ctx, db.CockpitMeetingWorkflowRequiredRoleParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issue.ID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check workflow purpose")
		return
	}
	if required != "" {
		present := false
		for _, role := range roles {
			present = present || role == required
		}
		if !present {
			writeError(w, http.StatusConflict, "the work package purpose cannot be removed")
			return
		}
	}
	if _, err := q.UpdateCockpitMeetingIssueRoles(ctx, db.UpdateCockpitMeetingIssueRolesParams{
		WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issue.ID, Roles: roles,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update meeting issue roles")
		return
	}
	if response == "compact" {
		link, err := readCockpitMeetingIssueReceipt(ctx, q, cc, meeting.ID, issue.ID)
		if writeCockpitReferenceError(w, err) || writeCockpitReferenceError(w, tx.Commit(ctx)) {
			return
		}
		receipt := CockpitMeetingIssueLinkReceipt{WorkspaceID: uuidToString(cc.workspaceID), MeetingID: uuidToString(meeting.ID), Link: link}
		h.publishCockpitReference(r, cc, "meeting_issues", receipt)
		writeJSON(w, http.StatusOK, receipt)
		return
	}
	links, err := meetingIssueLinksWithQueries(ctx, q, cc, meeting.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read meeting issue roles")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update meeting issue roles")
		return
	}
	payload := map[string]any{"meeting_id": uuidToString(meeting.ID), "links": links}
	h.publishCockpit(r, cc, "meeting_issues", "replaced", payload)
	writeJSON(w, http.StatusOK, payload)
}
