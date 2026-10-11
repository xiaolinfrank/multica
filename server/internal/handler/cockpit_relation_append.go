package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func lockCockpitReferenceIssues(ctx context.Context, q *db.Queries, ws pgtype.UUID, ids []pgtype.UUID) error {
	ordered := append([]pgtype.UUID(nil), ids...)
	sort.Slice(ordered, func(i, j int) bool { return bytes.Compare(ordered[i].Bytes[:], ordered[j].Bytes[:]) < 0 })
	var previous pgtype.UUID
	for _, id := range ordered {
		if id == previous {
			continue
		}
		if _, err := q.LockIssueForChannelMediaBind(ctx, db.LockIssueForChannelMediaBindParams{WorkspaceID: ws, ID: id}); err != nil {
			return err
		}
		previous = id
	}
	return nil
}

type CockpitNodeIssueLinkReceipt struct {
	WorkspaceID string                   `json:"workspace_id"`
	NodeID      string                   `json:"node_id"`
	Link        CockpitNodeIssueResponse `json:"link"`
}
type CockpitMeetingIssueLinkReceipt struct {
	WorkspaceID string                      `json:"workspace_id"`
	MeetingID   string                      `json:"meeting_id"`
	Link        CockpitMeetingIssueResponse `json:"link"`
}
type CockpitMeetingNodeLinkReceipt struct {
	WorkspaceID string                     `json:"workspace_id"`
	MeetingID   string                     `json:"meeting_id"`
	Link        CockpitMeetingNodeResponse `json:"link"`
}

// A reference needs an existing owner. Invalid append requests do not create
// an unrelated empty programme board as a side effect.
func (h *Handler) requireCockpitReference(w http.ResponseWriter, r *http.Request) (cockpitContext, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	id, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return cockpitContext{}, false
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return cockpitContext{}, false
	}
	board, err := h.Queries.GetCockpitByWorkspace(r.Context(), id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "cockpit not found")
		} else {
			writeError(w, 500, "failed to read cockpit")
		}
		return cockpitContext{}, false
	}
	return cockpitContext{workspaceID: id, member: member, cockpit: board}, true
}

func (h *Handler) beginCockpitReferenceAppend(ctx context.Context, cc cockpitContext, meetingID pgtype.UUID) (pgx.Tx, *db.Queries, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	q := h.Queries.WithTx(tx)
	success := false
	defer func() {
		if !success {
			_ = tx.Rollback(ctx)
		}
	}()
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, cc.workspaceID); err != nil {
		return nil, nil, err
	}
	boardID, err := q.LockCockpitForWorkspaceChanges(ctx, cc.workspaceID)
	if err != nil {
		return nil, nil, err
	}
	if boardID != cc.cockpit.ID {
		return nil, nil, pgx.ErrNoRows
	}
	if meetingID.Valid {
		meeting, err := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{WorkspaceID: cc.workspaceID, ID: meetingID})
		if err != nil {
			return nil, nil, err
		}
		if meeting.CockpitID != boardID {
			return nil, nil, pgx.ErrNoRows
		}
	}
	success = true
	return tx, q, nil
}

func appendCockpitNodeIssueRecord(ctx context.Context, q *db.Queries, cc cockpitContext, nodeID, issueID pgtype.UUID) (CockpitNodeIssueResponse, error) {
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: cc.workspaceID, ID: nodeID})
	if err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	if node.CockpitID != cc.cockpit.ID {
		return CockpitNodeIssueResponse{}, pgx.ErrNoRows
	}
	if _, err := q.LockIssueForChannelMediaBind(ctx, db.LockIssueForChannelMediaBindParams{WorkspaceID: cc.workspaceID, ID: issueID}); err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	if err := q.AppendCockpitNodeIssue(ctx, db.AppendCockpitNodeIssueParams{WorkspaceID: cc.workspaceID, NodeID: nodeID, IssueID: issueID}); err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	row, err := q.GetCockpitNodeIssueLink(ctx, db.GetCockpitNodeIssueLinkParams{WorkspaceID: cc.workspaceID, NodeID: nodeID, IssueID: issueID})
	if err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	workspace, err := q.GetWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	return cockpitLinkToResponse(db.ListCockpitNodeIssuesRow(row), issuePrefixForWorkspace(workspace)), nil
}

func appendCockpitMeetingIssueRecord(ctx context.Context, q *db.Queries, cc cockpitContext, meetingID, issueID pgtype.UUID) (CockpitMeetingIssueResponse, error) {
	if _, err := q.GetCockpitMeetingIssue(ctx, db.GetCockpitMeetingIssueParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, IssueID: issueID}); errors.Is(err, pgx.ErrNoRows) {
		if err = service.RequireCockpitMeetingPreparationOpen(ctx, q, cc.workspaceID, meetingID); err != nil {
			return CockpitMeetingIssueResponse{}, err
		}
	} else if err != nil {
		return CockpitMeetingIssueResponse{}, err
	}

	if _, err := q.LockIssueForChannelMediaBind(ctx, db.LockIssueForChannelMediaBindParams{WorkspaceID: cc.workspaceID, ID: issueID}); err != nil {
		return CockpitMeetingIssueResponse{}, err
	}
	if err := q.AppendCockpitMeetingIssue(ctx, db.AppendCockpitMeetingIssueParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, IssueID: issueID}); err != nil {
		return CockpitMeetingIssueResponse{}, err
	}
	return readCockpitMeetingIssueReceipt(ctx, q, cc, meetingID, issueID)
}

func readCockpitMeetingIssueReceipt(ctx context.Context, q *db.Queries, cc cockpitContext, meetingID, issueID pgtype.UUID) (CockpitMeetingIssueResponse, error) {
	row, err := q.GetCockpitMeetingIssueLink(ctx, db.GetCockpitMeetingIssueLinkParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, IssueID: issueID})
	if err != nil {
		return CockpitMeetingIssueResponse{}, err
	}
	workspace, err := q.GetWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return CockpitMeetingIssueResponse{}, err
	}
	return cockpitMeetingIssueToResponse(db.ListCockpitMeetingIssuesRow(row), issuePrefixForWorkspace(workspace)), nil
}

func appendCockpitMeetingNodeRecord(ctx context.Context, q *db.Queries, cc cockpitContext, meetingID, nodeID pgtype.UUID) (CockpitMeetingNodeResponse, error) {
	if _, err := q.GetCockpitMeetingNodeLink(ctx, db.GetCockpitMeetingNodeLinkParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, NodeID: nodeID}); errors.Is(err, pgx.ErrNoRows) {
		if err = service.RequireCockpitMeetingPreparationOpen(ctx, q, cc.workspaceID, meetingID); err != nil {
			return CockpitMeetingNodeResponse{}, err
		}
	} else if err != nil {
		return CockpitMeetingNodeResponse{}, err
	}

	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: cc.workspaceID, ID: nodeID})
	if err != nil {
		return CockpitMeetingNodeResponse{}, err
	}
	if node.CockpitID != cc.cockpit.ID {
		return CockpitMeetingNodeResponse{}, pgx.ErrNoRows
	}
	if err := q.AppendCockpitMeetingNode(ctx, db.AppendCockpitMeetingNodeParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, NodeID: nodeID}); err != nil {
		return CockpitMeetingNodeResponse{}, err
	}
	row, err := q.GetCockpitMeetingNodeLink(ctx, db.GetCockpitMeetingNodeLinkParams{WorkspaceID: cc.workspaceID, MeetingID: meetingID, NodeID: nodeID})
	if err != nil {
		return CockpitMeetingNodeResponse{}, err
	}
	return cockpitMeetingNodeToResponse(db.ListCockpitMeetingNodesRow(row)), nil
}

func (h *Handler) appendCockpitNodeIssue(ctx context.Context, cc cockpitContext, nodeID, issueID pgtype.UUID) (CockpitNodeIssueResponse, error) {
	tx, q, err := h.beginCockpitReferenceAppend(ctx, cc, pgtype.UUID{})
	if err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	defer tx.Rollback(ctx)
	link, err := appendCockpitNodeIssueRecord(ctx, q, cc, nodeID, issueID)
	if err != nil {
		return CockpitNodeIssueResponse{}, err
	}
	return link, tx.Commit(ctx)
}

func writeCockpitReferenceError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, service.ErrCockpitWorkflowConflict) {
		writeError(w, 409, err.Error())
	} else if errors.Is(err, service.ErrCockpitWorkflowForbidden) {
		writeError(w, 403, err.Error())
	} else if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 404, "related item no longer exists")
	} else {
		writeError(w, 500, "relation could not be saved; refresh and retry")
	}
	return true
}

// A bounded relation command must not trigger the legacy full-board snapshot
// reader. The single-link event invalidates scoped readers; manual snapshots
// and the old whole-set PUT behavior retain their existing contract.
func (h *Handler) publishCockpitReference(r *http.Request, cc cockpitContext, scope string, receipt any) {
	actorType, actorID := h.resolveActor(r, uuidToString(cc.member.UserID), uuidToString(cc.workspaceID))
	h.publish(protocol.EventCockpitChanged, uuidToString(cc.workspaceID), actorType, actorID,
		cockpitReferenceEventPayload(scope, receipt))
}

// Installed clients understand board invalidation but only whole arrays in
// relation scopes. A single board event remains safe for both generations.
func cockpitReferenceEventPayload(kind string, receipt any) map[string]any {
	return map[string]any{"scope": "board", "action": "reference_changed", "entity": map[string]any{"relation_kind": kind, "reference": receipt}}
}

func (h *Handler) AppendCockpitNodeIssue(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpitReference(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}
	var req struct {
		IssueID string `json:"issue_id"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	issue, ok := h.resolveCockpitIssue(r.Context(), strings.TrimSpace(req.IssueID), uuidToString(cc.workspaceID))
	if !ok || strings.TrimSpace(req.IssueID) == "" {
		writeError(w, 400, "issue_id must identify an issue in this workspace")
		return
	}
	link, err := h.appendCockpitNodeIssue(r.Context(), cc, node.ID, issue.ID)
	if writeCockpitReferenceError(w, err) {
		return
	}
	result := CockpitNodeIssueLinkReceipt{WorkspaceID: uuidToString(cc.workspaceID), NodeID: uuidToString(node.ID), Link: link}
	h.publishCockpitReference(r, cc, "issue_links", result)
	writeJSON(w, 200, result)
}

func (h *Handler) AppendCockpitMeetingIssue(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpitReference(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}
	var req struct {
		IssueID string `json:"issue_id"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	issue, ok := h.resolveCockpitIssue(r.Context(), strings.TrimSpace(req.IssueID), uuidToString(cc.workspaceID))
	if !ok || strings.TrimSpace(req.IssueID) == "" {
		writeError(w, 400, "issue_id must identify an issue in this workspace")
		return
	}
	tx, q, err := h.beginCockpitReferenceAppend(r.Context(), cc, meeting.ID)
	if writeCockpitReferenceError(w, err) {
		return
	}
	defer tx.Rollback(r.Context())
	link, err := appendCockpitMeetingIssueRecord(r.Context(), q, cc, meeting.ID, issue.ID)
	if writeCockpitReferenceError(w, err) || writeCockpitReferenceError(w, tx.Commit(r.Context())) {
		return
	}
	result := CockpitMeetingIssueLinkReceipt{WorkspaceID: uuidToString(cc.workspaceID), MeetingID: uuidToString(meeting.ID), Link: link}
	h.publishCockpitReference(r, cc, "meeting_issues", result)
	writeJSON(w, 200, result)
}

func (h *Handler) AppendCockpitMeetingNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpitReference(w, r)
	if !ok {
		return
	}
	meeting, ok := h.requireCockpitMeeting(w, r, cc)
	if !ok {
		return
	}
	var req struct {
		NodeID string `json:"node_id"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	node, ok := h.resolveCockpitNode(r.Context(), cc, strings.TrimSpace(req.NodeID))
	if !ok || strings.TrimSpace(req.NodeID) == "" {
		writeError(w, 400, "node_id must identify a work item in this workspace")
		return
	}
	tx, q, err := h.beginCockpitReferenceAppend(r.Context(), cc, meeting.ID)
	if writeCockpitReferenceError(w, err) {
		return
	}
	defer tx.Rollback(r.Context())
	link, err := appendCockpitMeetingNodeRecord(r.Context(), q, cc, meeting.ID, node.ID)
	if writeCockpitReferenceError(w, err) || writeCockpitReferenceError(w, tx.Commit(r.Context())) {
		return
	}
	result := CockpitMeetingNodeLinkReceipt{WorkspaceID: uuidToString(cc.workspaceID), MeetingID: uuidToString(meeting.ID), Link: link}
	h.publishCockpitReference(r, cc, "meeting_nodes", result)
	writeJSON(w, 200, result)
}
