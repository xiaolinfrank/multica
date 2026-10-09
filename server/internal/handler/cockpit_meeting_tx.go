package handler

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Meeting mutations share the board -> meeting -> relations lock order with
// plan replacement and provisioning. This also prevents a delete from removing
// links before a concurrent writer has finished creating them.
func (h *Handler) beginCockpitMeetingMutation(w http.ResponseWriter, r *http.Request, cc cockpitContext, meetingID pgtype.UUID) (pgx.Tx, *db.Queries, bool) {
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start meeting update")
		return nil, nil, false
	}
	q := h.Queries.WithTx(tx)
	if _, err := q.LockCockpitForWorkspaceChanges(ctx, cc.workspaceID); err != nil {
		_ = tx.Rollback(ctx)
		writeError(w, http.StatusInternalServerError, "failed to lock cockpit")
		return nil, nil, false
	}
	meeting, err := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{
		ID: meetingID, WorkspaceID: cc.workspaceID,
	})
	if err != nil || meeting.CockpitID != cc.cockpit.ID {
		_ = tx.Rollback(ctx)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && meeting.CockpitID != cc.cockpit.ID) {
			writeError(w, http.StatusNotFound, "meeting not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to lock meeting")
		}
		return nil, nil, false
	}
	return tx, q, true
}
