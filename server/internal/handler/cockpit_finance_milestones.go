package handler

import (
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

type CockpitPaymentRequest struct {
	Label    *string         `json:"label"`
	PayDate  *string         `json:"pay_date"`
	Amount   *pgtype.Numeric `json:"amount"`
	Position *float64        `json:"position"`
}

func (h *Handler) CreateCockpitPayment(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	var req CockpitPaymentRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	payDate, _, ok := cockpitDate(w, raw, "pay_date", req.PayDate)
	if !ok {
		return
	}

	payment, err := h.Queries.CreateCockpitPayment(r.Context(), db.CreateCockpitPaymentParams{
		WorkspaceID: cc.workspaceID,
		NodeID:      node.ID,
		Label:       textOrEmpty(req.Label),
		PayDate:     payDate,
		Amount:      numericPtrOrZero(req.Amount),
		Position:    floatOrZero(req.Position),
	})
	if err != nil {
		slog.Warn("CreateCockpitPayment failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create payment")
		return
	}

	resp := cockpitPaymentToResponse(payment)
	h.publishCockpit(r, cc, "payment", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateCockpitPayment(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "paymentId"), "payment id")
	if !ok {
		return
	}

	var req CockpitPaymentRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	payDate, clearPayDate, ok := cockpitDate(w, raw, "pay_date", req.PayDate)
	if !ok {
		return
	}

	params := db.UpdateCockpitPaymentParams{
		ID:           id,
		WorkspaceID:  cc.workspaceID,
		Label:        optionalText(req.Label),
		PayDate:      payDate,
		ClearPayDate: clearPayDate,
		Position:     optionalFloat(req.Position),
	}
	if req.Amount != nil {
		params.Amount = *req.Amount
	}

	payment, err := h.Queries.UpdateCockpitPayment(r.Context(), params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "payment not found")
			return
		}
		slog.Warn("UpdateCockpitPayment failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update payment")
		return
	}

	resp := cockpitPaymentToResponse(payment)
	h.publishCockpit(r, cc, "payment", "updated", resp)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteCockpitPayment(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "paymentId"), "payment id")
	if !ok {
		return
	}
	if err := h.Queries.DeleteCockpitPayment(r.Context(), db.DeleteCockpitPaymentParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitPayment failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete payment")
		return
	}
	h.publishCockpit(r, cc, "payment", "deleted", map[string]any{"id": uuidToString(id)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

type CockpitMilestoneRequest struct {
	Name       *string  `json:"name"`
	PlanDate   *string  `json:"plan_date"`
	ActualDate *string  `json:"actual_date"`
	Status     *string  `json:"status"`
	NodeID     *string  `json:"node_id"`
	Condition  *string  `json:"condition"`
	Guard      *string  `json:"guard"`
	Position   *float64 `json:"position"`
}

// resolveMilestoneNode accepts a node UUID or code, so a milestone can be
// pinned to "L1-02" the way the plan names it.
func (h *Handler) resolveMilestoneNode(w http.ResponseWriter, r *http.Request, cc cockpitContext, ref string) (pgtype.UUID, bool) {
	ref = strings.TrimSpace(ref)
	if id, err := util.ParseUUID(ref); err == nil {
		node, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{ID: id, WorkspaceID: cc.workspaceID})
		if err == nil && node.CockpitID == cc.cockpit.ID {
			return id, true
		}
	}
	node, err := h.Queries.GetCockpitNodeByCode(r.Context(), db.GetCockpitNodeByCodeParams{
		CockpitID: cc.cockpit.ID,
		Code:      ref,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "node not found: "+ref)
		return pgtype.UUID{}, false
	}
	return node.ID, true
}

func (h *Handler) CreateCockpitMilestone(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req CockpitMilestoneRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	planDate, _, ok := cockpitDate(w, raw, "plan_date", req.PlanDate)
	if !ok {
		return
	}
	actualDate, _, ok := cockpitDate(w, raw, "actual_date", req.ActualDate)
	if !ok {
		return
	}

	var nodeID pgtype.UUID
	if req.NodeID != nil && strings.TrimSpace(*req.NodeID) != "" {
		nodeID, ok = h.resolveMilestoneNode(w, r, cc, *req.NodeID)
		if !ok {
			return
		}
	}

	milestone, err := h.Queries.CreateCockpitMilestone(r.Context(), db.CreateCockpitMilestoneParams{
		WorkspaceID: cc.workspaceID,
		CockpitID:   cc.cockpit.ID,
		Name:        textOrEmpty(req.Name),
		PlanDate:    planDate,
		ActualDate:  actualDate,
		Status:      textOrEmpty(req.Status),
		NodeID:      nodeID,
		Condition:   textOrEmpty(req.Condition),
		Guard:       textOrEmpty(req.Guard),
		Position:    floatOrZero(req.Position),
	})
	if err != nil {
		slog.Warn("CreateCockpitMilestone failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create milestone")
		return
	}

	resp := cockpitMilestoneToResponse(milestone)
	h.publishCockpit(r, cc, "milestone", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateCockpitMilestone(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "milestoneId"), "milestone id")
	if !ok {
		return
	}

	var req CockpitMilestoneRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	planDate, clearPlan, ok := cockpitDate(w, raw, "plan_date", req.PlanDate)
	if !ok {
		return
	}
	actualDate, clearActual, ok := cockpitDate(w, raw, "actual_date", req.ActualDate)
	if !ok {
		return
	}

	params := db.UpdateCockpitMilestoneParams{
		ID:              id,
		WorkspaceID:     cc.workspaceID,
		Name:            optionalText(req.Name),
		PlanDate:        planDate,
		ClearPlanDate:   clearPlan,
		ActualDate:      actualDate,
		ClearActualDate: clearActual,
		Status:          optionalText(req.Status),
		Condition:       optionalText(req.Condition),
		Guard:           optionalText(req.Guard),
		Position:        optionalFloat(req.Position),
	}
	if _, touched := raw["node_id"]; touched {
		if req.NodeID == nil || strings.TrimSpace(*req.NodeID) == "" {
			params.ClearNode = true
		} else {
			nodeID, ok := h.resolveMilestoneNode(w, r, cc, *req.NodeID)
			if !ok {
				return
			}
			params.NodeID = nodeID
		}
	}

	milestone, err := h.Queries.UpdateCockpitMilestone(r.Context(), params)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "milestone not found")
			return
		}
		slog.Warn("UpdateCockpitMilestone failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update milestone")
		return
	}

	resp := cockpitMilestoneToResponse(milestone)
	h.publishCockpit(r, cc, "milestone", "updated", resp)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteCockpitMilestone(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "milestoneId"), "milestone id")
	if !ok {
		return
	}
	if err := h.Queries.DeleteCockpitMilestone(r.Context(), db.DeleteCockpitMilestoneParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMilestone failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete milestone")
		return
	}
	h.publishCockpit(r, cc, "milestone", "deleted", map[string]any{"id": uuidToString(id)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------
