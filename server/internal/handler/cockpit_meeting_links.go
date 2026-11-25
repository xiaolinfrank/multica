package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (h *Handler) meetingIssueLinks(ctx context.Context, cc cockpitContext, meetingID pgtype.UUID) ([]CockpitMeetingIssueResponse, error) {
	return meetingIssueLinksWithQueries(ctx, h.Queries, cc, meetingID)
}

func meetingIssueLinksWithQueries(ctx context.Context, q *db.Queries, cc cockpitContext, meetingID pgtype.UUID) ([]CockpitMeetingIssueResponse, error) {
	workspace, err := q.GetWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return nil, err
	}
	prefix := issuePrefixForWorkspace(workspace)
	rows, err := q.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
	if err != nil {
		return nil, err
	}
	out := make([]CockpitMeetingIssueResponse, 0, len(rows))
	for _, row := range rows {
		if row.MeetingID != meetingID {
			continue
		}
		out = append(out, cockpitMeetingIssueToResponse(row, prefix))
	}
	return out, nil
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

	// Serialize relation replacement with purpose edits and provisioning. Keep
	// surviving rows in place so old clients cannot erase their new metadata.
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)

	markers := make(map[pgtype.UUID]string)
	if req.Replace {
		existing, err := q.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to read meeting issue links")
			return
		}
		for _, link := range existing {
			if link.MeetingID == meeting.ID {
				markers[link.IssueID] = link.Role
			}
		}
	}
	if req.Replace {
		owned, err := q.ListCockpitMeetingWorkflowIssueIDs(ctx, db.ListCockpitMeetingWorkflowIssueIDsParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check workflow links")
			return
		}
		selected := make(map[pgtype.UUID]bool, len(resolved))
		for _, id := range resolved {
			selected[id] = true
		}
		for _, id := range owned {
			if !selected[id] {
				writeError(w, http.StatusConflict, "work package issue links must be preserved")
				return
			}
		}
	}
	if req.Replace {
		if err := q.DeleteCockpitMeetingIssuesExcept(ctx, db.DeleteCockpitMeetingIssuesExceptParams{
			MeetingID: meeting.ID, WorkspaceID: cc.workspaceID, IssueIds: resolved,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}
	if err := lockCockpitReferenceIssues(ctx, q, cc.workspaceID, resolved); writeCockpitReferenceError(w, err) {
		return
	}
	for i, issueID := range resolved {
		if !req.Replace {
			if _, err := appendCockpitMeetingIssueRecord(ctx, q, cc, meeting.ID, issueID); writeCockpitReferenceError(w, err) {
				return
			}
			continue
		}
		if _, err := q.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
			WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issueID,
			Role: markers[issueID], Position: float64(i),
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}
	links, err := meetingIssueLinksWithQueries(ctx, q, cc, meeting.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read meeting issue links")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link issues")
		return
	}

	payload := map[string]any{
		"meeting_id": uuidToString(meeting.ID),
		"links":      links,
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
	ctx := r.Context()
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	role, err := q.CockpitMeetingWorkflowRequiredRole(ctx, db.CockpitMeetingWorkflowRequiredRoleParams{WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issue.ID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check workflow link")
		return
	}
	if role != "" {
		writeError(w, http.StatusConflict, "work package issue links must be preserved")
		return
	}
	if err := q.DeleteCockpitMeetingIssue(ctx, db.DeleteCockpitMeetingIssueParams{
		MeetingID:   meeting.ID,
		IssueID:     issue.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink issue")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unlink meeting relation")
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

	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	for _, nodeID := range resolved {
		if node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: nodeID, WorkspaceID: cc.workspaceID}); err != nil || node.CockpitID != cc.cockpit.ID {
			writeError(w, http.StatusBadRequest, "a selected work item no longer exists")
			return
		}
		if _, err := meetingLinkNodeDepth(ctx, q, cc, nodeID); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if req.Replace {
		if err := q.DeleteCockpitMeetingNodesByMeeting(ctx, db.DeleteCockpitMeetingNodesByMeetingParams{
			MeetingID:   meeting.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitMeetingNodesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link work items")
			return
		}
	}
	for i, nodeID := range resolved {
		if !req.Replace {
			if _, err := appendCockpitMeetingNodeRecord(ctx, q, cc, meeting.ID, nodeID); writeCockpitReferenceError(w, err) {
				return
			}
			continue
		}
		if _, err := q.CreateCockpitMeetingNode(ctx, db.CreateCockpitMeetingNodeParams{
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

	links, err := q.ListCockpitMeetingNodes(ctx, cc.cockpit.ID)
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

	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to link work items")
		return
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
	ctx := r.Context()
	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, meeting.ID)
	if !ok {
		return
	}
	defer tx.Rollback(ctx)
	if err := q.DeleteCockpitMeetingNode(ctx, db.DeleteCockpitMeetingNodeParams{
		MeetingID:   meeting.ID,
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink work item")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to unlink meeting relation")
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

// ---------------------------------------------------------------------------
// Reading meetings back off the share
// ---------------------------------------------------------------------------
//
// Meetings happen whether or not anybody opens the register, and their
// material lands in the archive folder either way — dropped there from a
// laptop, by someone who has never used the board. Those folders ARE the
// record; the register just does not know about them yet. Scanning turns them
// into rows.
//
// Everything the scan reads is a guess off a folder name a human wrote
// freehand, so nothing it produces is presented as fact: the rows it creates
// are flagged (cockpit_meeting.detected) and the form shows every guessed
// field for correction before anything is written.

// meetingFolderGuess is what a folder name gives up about the meeting that
// filled it.
