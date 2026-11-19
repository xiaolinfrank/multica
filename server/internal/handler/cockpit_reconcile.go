package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ReconcileCockpitPlan previews or applies the one-time plan migration. The
// dry run is a pure read; apply takes a snapshot inside the same transaction
// and writes the whole mapping at once.
func (h *Handler) ReconcileCockpitPlan(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req struct {
		Apply bool `json:"apply"`
	}
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if req.Apply && isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "applying plan reconciliation requires a human actor")
		return
	}
	actorType, actorLabel := h.cockpitActor(r, cc)
	snapshot := func(ctx context.Context, q *db.Queries, board db.Cockpit) (string, error) {
		cc.cockpit = board
		doc, hasContent, err := buildCockpitSnapshotDocument(ctx, q, cc, true)
		if err != nil {
			return "", err
		}
		// A board with no nodes, milestones, meetings or board text has nothing
		// to lose, and apply on it still has to mark the plan reconciled so the
		// skeleton starts mirroring new projects. Skipping the snapshot keeps
		// that path a clean no-op instead of a "nothing to snapshot" failure.
		if !hasContent {
			return "", nil
		}
		payload, err := json.Marshal(doc)
		if err != nil {
			return "", err
		}
		row, err := q.CreateCockpitSnapshot(ctx, db.CreateCockpitSnapshotParams{
			WorkspaceID: cc.workspaceID, CockpitID: board.ID, TriggerKind: "manual",
			Label: "对账前自动快照", Payload: payload, NodeCount: int32(len(doc.Nodes)),
			CreatedByType: actorType, CreatedByLabel: actorLabel,
		})
		if err != nil {
			return "", err
		}
		return uuidToString(row.ID), nil
	}
	report, err := h.IssueService.ReconcileCockpitPlan(r.Context(), service.CockpitReconcileInput{
		WorkspaceID: cc.workspaceID, ActorID: cc.member.UserID, Apply: req.Apply,
	}, snapshot)
	if writeCockpitActionError(w, r, err) {
		return
	}
	writeJSON(w, http.StatusOK, report)
}
