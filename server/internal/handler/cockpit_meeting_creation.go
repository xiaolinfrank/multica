package handler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

var errCockpitMeetingDirectoryRecorded = errors.New("meeting directory is already in the register")

type cockpitCreatedMeeting struct {
	Meeting  db.CockpitMeeting
	NodeLink *db.CockpitMeetingNode
	Board    db.Cockpit
	Response CockpitMeetingCreateResponse
	Replay   json.RawMessage
}

type CockpitMeetingCreateRequest struct {
	CockpitMeetingRequest
	NodeID      *string `json:"node_id"`
	CreationKey *string `json:"creation_key"`
}

type CockpitMeetingCreateResponse struct {
	CockpitMeetingResponse
	WorkspaceID string                      `json:"workspace_id"`
	NodeLink    *CockpitMeetingNodeResponse `json:"node_link,omitempty"`
	CreationKey string                      `json:"creation_key,omitempty"`
	Replayed    bool                        `json:"replayed"`
}

// Manual creation and archive adoption share the same allocation lock. File
// operations happen outside this short transaction and use the acknowledged row.
func (h *Handler) createCockpitMeetingRecord(ctx context.Context, p db.CreateCockpitMeetingParams, adopting bool, nodeID pgtype.UUID, command *cockpitCreationCommand) (cockpitCreatedMeeting, error) {
	var out cockpitCreatedMeeting
	tx, q, board, replay, err := h.beginCockpitCreation(ctx, p.WorkspaceID, p.CockpitID, command)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if replay != nil {
		out.Replay = replay
		return out, nil
	}
	out.Board = board
	p.CockpitID = board.ID
	if nodeID.Valid {
		node, e := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: p.WorkspaceID, ID: nodeID})
		if e != nil {
			return out, e
		}
		if node.CockpitID != p.CockpitID {
			return out, pgx.ErrNoRows
		}
	}
	if adopting {
		exists, e := q.CockpitMeetingDirectoryRecorded(ctx, db.CockpitMeetingDirectoryRecordedParams{WorkspaceID: p.WorkspaceID, NasDir: p.NasDir})
		if e != nil {
			return out, e
		}
		if exists {
			return out, errCockpitMeetingDirectoryRecorded
		}
	}
		// R4 collapse: creating a meeting IS the schedule confirmation. Only
	// NAS-scanned rows arrive unconfirmed, waiting for a human check.
	if p.OccurrenceState == "" {
		p.OccurrenceState = "scheduled"
	}
if strings.TrimSpace(p.Code) == "" && p.MeetDate.Valid {
		p.Code, err = service.ReadCockpitMeetingNextCode(ctx, q, p.WorkspaceID, p.MeetDate.Time)
		if err != nil {
			return out, err
		}
	}
	out.Meeting, err = q.CreateCockpitMeeting(ctx, p)
	if err != nil {
		return out, err
	}
	if nodeID.Valid {
		link, e := q.CreateCockpitMeetingNode(ctx, db.CreateCockpitMeetingNodeParams{WorkspaceID: p.WorkspaceID, MeetingID: out.Meeting.ID, NodeID: nodeID})
		if e != nil {
			return out, e
		}
		out.NodeLink = &link
	}
	out.Response = CockpitMeetingCreateResponse{CockpitMeetingResponse: cockpitMeetingToResponse(out.Meeting), WorkspaceID: uuidToString(p.WorkspaceID)}
	if out.NodeLink != nil {
		out.Response.NodeLink = &CockpitMeetingNodeResponse{MeetingID: uuidToString(out.NodeLink.MeetingID), NodeID: uuidToString(out.NodeLink.NodeID), Position: out.NodeLink.Position}
	}
	if command != nil {
		out.Response.CreationKey = uuidToString(command.Key)
	}
	if err = saveCockpitCreationReceipt(ctx, q, command, out.Meeting.ID, out.Response); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
