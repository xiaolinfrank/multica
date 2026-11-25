package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitMeetingRequest struct {
	MeetDate  *string `json:"meet_date"`
	TimeRange *string `json:"time_range"`
	StartTime *string `json:"start_time"`
	EndTime   *string `json:"end_time"`
	Title     *string `json:"title"`
	Code      *string `json:"code"`
	Kind      *string `json:"kind"`
	Status    *string `json:"status"`
	Track     *string `json:"track"`
	Parties   *string `json:"parties"`
	Organizer *string `json:"organizer"`
	Location  *string `json:"location"`
	Attendees *string `json:"attendees"`
	MeetNo    *string `json:"meet_no"`
	Link      *string `json:"link"`
	Note      *string `json:"note"`
	Minutes   *string `json:"minutes"`
	Decisions *string `json:"decisions"`
	Actions   *string `json:"actions"`
	// The meeting's folder on configured persistent storage. Set by provisioning
	// rather than typed, but writable so an existing folder can be adopted.
	NasDir *string `json:"nas_dir"`
	// Sent as false by whoever has checked a row the scan guessed at. Only
	// the scan sets it to true.
	Detected *bool `json:"detected"`
}

func (h *Handler) CreateCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	var req CockpitMeetingCreateRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	// The submitted anchor and absent auto-code remain part of the original intent.
	cc, command, ok := h.prepareCockpitCreation(w, r, "meeting", req.CreationKey, raw)
	if !ok {
		return
	}
	meetDate, _, ok := cockpitDate(w, raw, "meet_date", req.MeetDate)
	if !ok {
		return
	}
	startTime, _, ok := cockpitClock(w, raw, "start_time", req.StartTime)
	if !ok {
		return
	}
	endTime, _, ok := cockpitClock(w, raw, "end_time", req.EndTime)
	if !ok {
		return
	}
	nasDir, ok := h.meetingDirOrError(w, cc, req.NasDir)
	if !ok {
		return
	}

	var nodeID pgtype.UUID
	if req.NodeID != nil {
		nodeID, ok = parseUUIDOrBadRequest(w, *req.NodeID, "node_id")
		if !ok {
			return
		}
	}

	created, err := h.createCockpitMeetingRecord(r.Context(), db.CreateCockpitMeetingParams{
		WorkspaceID: cc.workspaceID,
		CockpitID:   cc.cockpit.ID,
		MeetDate:    meetDate,
		TimeRange:   textOrEmpty(req.TimeRange),
		StartTime:   startTime,
		EndTime:     endTime,
		Title:       textOrEmpty(req.Title),
		Code:        textOrEmpty(req.Code),
		Kind:        textOrEmpty(req.Kind),
		Status:      textOrEmpty(req.Status),
		Track:       textOrEmpty(req.Track),
		Parties:     textOrEmpty(req.Parties),
		Organizer:   textOrEmpty(req.Organizer),
		Location:    textOrEmpty(req.Location),
		Attendees:   textOrEmpty(req.Attendees),
		MeetNo:      textOrEmpty(req.MeetNo),
		Link:        textOrEmpty(req.Link),
		Note:        textOrEmpty(req.Note),
		Minutes:     textOrEmpty(req.Minutes),
		Decisions:   textOrEmpty(req.Decisions),
		Actions:     textOrEmpty(req.Actions),
		NasDir:      nasDir,
		Detected:    req.Detected != nil && *req.Detected,
	}, false, nodeID, command)
	if err != nil {
		writeCockpitCreationError(w, err)
		return
	}
	if created.Replay != nil {
		writeJSON(w, http.StatusOK, created.Replay)
		return
	}
	cc.cockpit = created.Board
	resp := created.Response
	if link := created.NodeLink; link != nil {
		resp.NodeLink = &CockpitMeetingNodeResponse{MeetingID: uuidToString(link.MeetingID), NodeID: uuidToString(link.NodeID), Position: link.Position}
		// Older clients invalidate the board for an atomic multi-entity change.
		h.publishCockpit(r, cc, "board", "meeting_created", resp)
	} else {
		h.publishCockpit(r, cc, "meeting", "created", resp.CockpitMeetingResponse)
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return
	}

	var req CockpitMeetingRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	meetDate, clearMeetDate, ok := cockpitDate(w, raw, "meet_date", req.MeetDate)
	if !ok {
		return
	}
	startTime, clearStartTime, ok := cockpitClock(w, raw, "start_time", req.StartTime)
	if !ok {
		return
	}
	endTime, clearEndTime, ok := cockpitClock(w, raw, "end_time", req.EndTime)
	if !ok {
		return
	}
	// The stored path is the normalized one, not what the caller typed: the
	// same string is later compared against the directory provisioning would
	// have created, and an untrimmed copy of that path would read as a
	// different folder.
	nasDir := pgtype.Text{}
	if req.NasDir != nil {
		normalized, ok := h.meetingDirOrError(w, cc, req.NasDir)
		if !ok {
			return
		}
		nasDir = pgtype.Text{String: normalized, Valid: true}
	}

	tx, q, ok := h.beginCockpitMeetingMutation(w, r, cc, id)
	if !ok {
		return
	}
	defer tx.Rollback(r.Context())
	if _, minutes := raw["minutes"]; minutes || req.Decisions != nil || req.Actions != nil {
		if wp, werr := q.GetCockpitMeetingWorkPackage(r.Context(), db.GetCockpitMeetingWorkPackageParams{WorkspaceID: cc.workspaceID, ID: id}); werr == nil && wp.MinutesIssueID.Valid {
			writeError(w, http.StatusConflict, "this meeting uses versioned minutes; submit a workflow version instead")
			return
		} else if werr != nil && !errors.Is(werr, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "failed to check meeting workflow")
			return
		}
	}
	meeting, err := q.UpdateCockpitMeeting(r.Context(), db.UpdateCockpitMeetingParams{
		ID:             id,
		WorkspaceID:    cc.workspaceID,
		MeetDate:       meetDate,
		ClearMeetDate:  clearMeetDate,
		StartTime:      startTime,
		ClearStartTime: clearStartTime,
		EndTime:        endTime,
		ClearEndTime:   clearEndTime,
		TimeRange:      optionalText(req.TimeRange),
		Title:          optionalText(req.Title),
		Code:           optionalText(req.Code),
		Kind:           optionalText(req.Kind),
		Status:         optionalText(req.Status),
		Track:          optionalText(req.Track),
		Parties:        optionalText(req.Parties),
		Organizer:      optionalText(req.Organizer),
		Location:       optionalText(req.Location),
		Attendees:      optionalText(req.Attendees),
		MeetNo:         optionalText(req.MeetNo),
		Link:           optionalText(req.Link),
		Note:           optionalText(req.Note),
		Minutes:        optionalText(req.Minutes),
		Decisions:      optionalText(req.Decisions),
		Actions:        optionalText(req.Actions),
		NasDir:         nasDir,
		Detected:       optionalBool(req.Detected),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "meeting not found")
			return
		}
		slog.Warn("UpdateCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update meeting")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update meeting")
		return
	}
	resp := cockpitMeetingToResponse(meeting)
	h.publishCockpit(r, cc, "meeting", "updated", resp)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "meetingId"), "meeting id")
	if !ok {
		return
	}
	// No cascading deletes in the schema (repository rule): the meeting's own
	// links go first in the same transaction, so a re-used UUID can never adopt
	// another meeting's attachments.
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	defer tx.Rollback(ctx)
	q := h.Queries.WithTx(tx)
	if err := lockCockpitBindings(ctx, q, cc.workspaceID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to lock cockpit")
		return
	}
	if _, err := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{ID: id, WorkspaceID: cc.workspaceID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.WriteHeader(http.StatusNoContent)
		} else {
			writeError(w, http.StatusInternalServerError, "failed to lock meeting")
		}
		return
	}
	// R1 (design-principles-2026-10-12): minutes bindings are associations;
	// deleting a meeting sweeps them. Only submitted minutes versions carry
	// formal history and retain the meeting.
	if versions, err := q.CountCockpitMinutesVersions(ctx, db.CountCockpitMinutesVersionsParams{WorkspaceID: cc.workspaceID, MeetingID: id}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check meeting workflow")
		return
	} else if versions > 0 {
		writeError(w, http.StatusConflict, "meetings with submitted minutes versions cannot be deleted individually")
		return
	}
	if retained, err := q.HasCockpitArtifactMeeting(ctx, db.HasCockpitArtifactMeetingParams{WorkspaceID: cc.workspaceID, SourceMeetingID: id}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check fixed artifact provenance")
		return
	} else if retained {
		writeError(w, http.StatusConflict, "This meeting is retained by fixed artifact provenance; preserve its history")
		return
	}
	if retained, err := q.HasCockpitMeetingPreparationHistory(ctx, db.HasCockpitMeetingPreparationHistoryParams{WorkspaceID: cc.workspaceID, MeetingID: id}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check meeting preparation history")
		return
	} else if retained {
		writeError(w, http.StatusConflict, "This meeting retains preparation history; archive it instead")
		return
	}
	if retained, err := q.HasCockpitDirectoryHistory(ctx, db.HasCockpitDirectoryHistoryParams{WorkspaceID: cc.workspaceID, MeetingID: id}); err != nil || !retained.Valid {
		writeError(w, http.StatusInternalServerError, "failed to check meeting directory history")
		return
	} else if retained.Bool {
		writeError(w, http.StatusConflict, "This meeting retains directory history; open its meeting directory or archive it instead")
		return
	}
	if retained, err := q.HasCockpitInputMeetingReferences(ctx, db.HasCockpitInputMeetingReferencesParams{WorkspaceID: cc.workspaceID, MeetingID: id}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check meeting input references")
		return
	} else if retained {
		writeErrorCode(w, http.StatusConflict, "meeting_input_references", "This meeting retains historical material references; archive it to preserve them")
		return
	}
	if err := q.DeleteRemovedCockpitInputReferencesByMeeting(ctx, db.DeleteRemovedCockpitInputReferencesByMeetingParams{WorkspaceID: cc.workspaceID, MeetingID: id}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to clear removed input references")
		return
	}
	if err := q.DeleteCockpitMeetingIssuesByMeeting(ctx, db.DeleteCockpitMeetingIssuesByMeetingParams{
		MeetingID:   id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingIssuesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	if err := q.DeleteCockpitMeetingNodesByMeeting(ctx, db.DeleteCockpitMeetingNodesByMeetingParams{
		MeetingID:   id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNodesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	if err := q.DeleteCockpitMeeting(ctx, db.DeleteCockpitMeetingParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	h.publishCockpit(r, cc, "meeting", "deleted", map[string]any{"id": uuidToString(id)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Import — shared by the HTTP endpoint and snapshot restore
// ---------------------------------------------------------------------------

// CockpitImportNode is one node of an imported board. Parents are named by
// `parent_code`, not by id, because an import document is written before any id
// exists — and because a person editing that document thinks in "L1-02", not
// in UUIDs.
