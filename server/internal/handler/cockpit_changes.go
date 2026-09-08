package handler

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Cockpit pending changes (BayClaw fork).
//
// The review queue between "someone knows the board is wrong" and "the board
// is edited": a proposed value for one field of one node is filed (by hand, or
// by an agent writing back what it observed), a human applies or rejects it,
// and only an apply moves the board. The queue is what lets agents contribute
// to a board the programme runs on without asking everyone to trust them
// blindly.
//
// Ingest is one shared funnel for every source. It judges each proposal the
// same way — legal field, parseable value, actually different from what the
// board says, not already proposed — because a queue that fills with rows a
// reviewer must dismiss one by one is worse than no queue at all.

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type CockpitPendingChangeResponse struct {
	ID        string `json:"id"`
	CockpitID string `json:"cockpit_id"`
	NodeID    string `json:"node_id"`
	// The node's code and name resolved server-side, so the queue never has to
	// join against a board the client may not have loaded yet. Empty when the
	// node is gone (defensive; deletion clears the rows, but a read can race).
	NodeCode string `json:"node_code"`
	NodeName string `json:"node_name"`
	Field    string `json:"field"`
	OldValue string `json:"old_value"`
	NewValue string `json:"new_value"`
	// "manual" | "agent".
	Source string `json:"source"`
	Reason string `json:"reason"`
	// "pending" | "applied" | "rejected" | "withdrawn".
	Status         string  `json:"status"`
	CreatedByType  string  `json:"created_by_type"`
	CreatedByLabel string  `json:"created_by_label"`
	DecidedByType  string  `json:"decided_by_type"`
	DecidedByLabel string  `json:"decided_by_label"`
	DecidedAt      *string `json:"decided_at"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

// CockpitChangeRequest is one proposal. Values arrive as text and are
// canonicalised per field, so every client (form, CLI, agent) speaks one wire
// shape and the stored value is exactly what apply will parse.
type CockpitChangeRequest struct {
	// Node reference: UUID or the code people use for it ("L3-01-08").
	Node     string  `json:"node"`
	Field    string  `json:"field"`
	NewValue *string `json:"new_value"`
	Reason   *string `json:"reason"`
}

type CockpitIngestRequest struct {
	Changes []CockpitChangeRequest `json:"changes"`
}

// One judgement per proposal. Status: "queued" (new row), "updated" (replaced
// an open proposal for the same field), "skipped" (nothing to do: no_change or
// duplicate), "rejected" (bad input: invalid_field, invalid_value or
// unknown_node). Machine-readable on both axes so an agent can react without
// parsing prose.
type CockpitIngestItem struct {
	Node   string  `json:"node"`
	Field  string  `json:"field"`
	Status string  `json:"status"`
	Reason string  `json:"reason"`
	ID     *string `json:"id"`
}

type CockpitIngestResponse struct {
	Results []CockpitIngestItem `json:"results"`
}

// What one apply actually did: the decided change and the node row it moved.
// The node lets clients patch their board cache from the same response
// instead of re-reading.
type CockpitChangeApplyResponse struct {
	Change CockpitPendingChangeResponse `json:"change"`
	Node   CockpitNodeResponse          `json:"node"`
}

// pendingRowToResponse maps the list query's flat row (sqlc inlines `c.*`
// rather than embedding the model, and the LEFT JOIN makes the node columns
// nullable) onto the wire shape it shares with the single-row paths.
func pendingRowToResponse(row db.ListCockpitPendingChangesRow) CockpitPendingChangeResponse {
	resp := pendingChangeToResponse(db.CockpitPendingChange{
		ID:             row.ID,
		WorkspaceID:    row.WorkspaceID,
		CockpitID:      row.CockpitID,
		NodeID:         row.NodeID,
		Field:          row.Field,
		OldValue:       row.OldValue,
		NewValue:       row.NewValue,
		Source:         row.Source,
		Reason:         row.Reason,
		Status:         row.Status,
		CreatedByType:  row.CreatedByType,
		CreatedByLabel: row.CreatedByLabel,
		DecidedByType:  row.DecidedByType,
		DecidedByLabel: row.DecidedByLabel,
		DecidedAt:      row.DecidedAt,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}, row.NodeCode.String, row.NodeName.String)
	return resp
}

func pendingChangeToResponse(c db.CockpitPendingChange, nodeCode, nodeName string) CockpitPendingChangeResponse {
	decidedAt := (*string)(nil)
	if c.DecidedAt.Valid {
		s := timestampToString(c.DecidedAt)
		decidedAt = &s
	}
	return CockpitPendingChangeResponse{
		ID:             uuidToString(c.ID),
		CockpitID:      uuidToString(c.CockpitID),
		NodeID:         uuidToString(c.NodeID),
		NodeCode:       nodeCode,
		NodeName:       nodeName,
		Field:          c.Field,
		OldValue:       c.OldValue,
		NewValue:       c.NewValue,
		Source:         c.Source,
		Reason:         c.Reason,
		Status:         c.Status,
		CreatedByType:  c.CreatedByType,
		CreatedByLabel: c.CreatedByLabel,
		DecidedByType:  c.DecidedByType,
		DecidedByLabel: c.DecidedByLabel,
		DecidedAt:      decidedAt,
		CreatedAt:      timestampToString(c.CreatedAt),
		UpdatedAt:      timestampToString(c.UpdatedAt),
	}
}

// ---------------------------------------------------------------------------
// Field model
// ---------------------------------------------------------------------------

type cockpitChangeFieldKind int

const (
	cockpitChangeText cockpitChangeFieldKind = iota
	cockpitChangeDate
	cockpitChangeNumber
)

// The proposable fields: everything a reviewer can eyeball in a diff. Tree
// shape (code, parent_id, position) is deliberately absent — see the schema
// comment in 920_cockpit_pending_change.up.sql.
var cockpitChangeFields = map[string]cockpitChangeFieldKind{
	"name":             cockpitChangeText,
	"owner":            cockpitChangeText,
	"collaborators":    cockpitChangeText,
	"status":           cockpitChangeText,
	"deliverable":      cockpitChangeText,
	"dependencies":     cockpitChangeText,
	"note":             cockpitChangeText,
	"current_progress": cockpitChangeText,
	"vendor":           cockpitChangeText,
	"budget_category":  cockpitChangeText,
	"exec_status":      cockpitChangeText,
	"contract":         cockpitChangeText,
	"color":            cockpitChangeText,
	"source":           cockpitChangeText,
	"start_date":       cockpitChangeDate,
	"end_date":         cockpitChangeDate,
	"progress":         cockpitChangeNumber,
	"budget_amount":    cockpitChangeNumber,
}

// cockpitNodeFieldValue renders what the node currently says for `field`, as
// the text a canonicalised proposal compares against. Every field reports ""
// for "no value", including the numeric ones, so "empty" is one word.
func cockpitNodeFieldValue(node db.CockpitNode, field string) string {
	switch field {
	case "name":
		return node.Name
	case "owner":
		return node.Owner
	case "collaborators":
		return node.Collaborators
	case "status":
		return node.Status
	case "deliverable":
		return node.Deliverable
	case "dependencies":
		return node.Dependencies
	case "note":
		return node.Note
	case "current_progress":
		return node.CurrentProgress
	case "vendor":
		return node.Vendor
	case "budget_category":
		return node.BudgetCategory
	case "exec_status":
		return node.ExecStatus
	case "contract":
		return node.Contract
	case "color":
		return node.Color
	case "source":
		return node.Source
	case "start_date":
		if d := dateToPtr(node.StartDate); d != nil {
			return *d
		}
		return ""
	case "end_date":
		if d := dateToPtr(node.EndDate); d != nil {
			return *d
		}
		return ""
	case "progress":
		return strconv.FormatFloat(node.Progress, 'f', -1, 64)
	case "budget_amount":
		if v := numericToPtr(node.BudgetAmount); v != nil {
			return strconv.FormatFloat(*v, 'f', -1, 64)
		}
		return ""
	}
	return ""
}

// cockpitNormalizeChangeValue validates and canonicalises a proposed value.
// The canonical form is the same text cockpitNodeFieldValue would emit, so
// "already the current value" and "already proposed" are plain string
// compares. Dates normalise to YYYY-MM-DD; numbers to their shortest form.
//
// Empty string is a real edit for every field except progress: a withdrawn
// date or a removed budget line is "clear it", while progress is NOT NULL and
// 0 is written as "0".
func cockpitNormalizeChangeValue(field string, raw string) (string, bool) {
	kind, ok := cockpitChangeFields[field]
	if !ok {
		return "", false
	}
	value := strings.TrimSpace(raw)
	switch kind {
	case cockpitChangeText:
		return value, true
	case cockpitChangeDate:
		if value == "" {
			return "", true
		}
		d, err := util.ParseCalendarDate(value)
		if err != nil {
			return "", false
		}
		s := d.Time.Format("2006-01-02")
		return s, true
	case cockpitChangeNumber:
		if value == "" {
			return "", field == "budget_amount"
		}
		v, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return "", false
		}
		if field == "progress" && (v < 0 || v > 100) {
			return "", false
		}
		if field == "budget_amount" && math.Abs(v) >= 1e14 {
			return "", false // NUMERIC(14,4): fourteen digits before the point.
		}
		return strconv.FormatFloat(v, 'f', -1, 64), true
	}
	return "", false
}

// cockpitChangeWriteParams moves a canonicalised value into an
// UpdateCockpitNodeParams, touching nothing else. Returns false only if the
// value cannot be parsed — impossible for a stored change, but apply still
// checks rather than trusting its own history.
func cockpitChangeWriteParams(field, value string, params *db.UpdateCockpitNodeParams) bool {
	setText := func(dst *pgtype.Text) {
		if value == "" {
			*dst = pgtype.Text{}
		} else {
			*dst = pgtype.Text{String: value, Valid: true}
		}
	}
	setDate := func(dst *pgtype.Date, clear *bool) bool {
		if value == "" {
			*clear = true
			return true
		}
		d, err := util.ParseCalendarDate(value)
		if err != nil {
			return false
		}
		*dst = d
		return true
	}

	switch field {
	case "name":
		setText(&params.Name)
	case "owner":
		setText(&params.Owner)
	case "collaborators":
		setText(&params.Collaborators)
	case "status":
		setText(&params.Status)
	case "deliverable":
		setText(&params.Deliverable)
	case "dependencies":
		setText(&params.Dependencies)
	case "note":
		setText(&params.Note)
	case "current_progress":
		setText(&params.CurrentProgress)
	case "vendor":
		setText(&params.Vendor)
	case "budget_category":
		setText(&params.BudgetCategory)
	case "exec_status":
		setText(&params.ExecStatus)
	case "contract":
		setText(&params.Contract)
	case "color":
		setText(&params.Color)
	case "source":
		setText(&params.Source)
	case "start_date":
		return setDate(&params.StartDate, &params.ClearStartDate)
	case "end_date":
		return setDate(&params.EndDate, &params.ClearEndDate)
	case "progress":
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return false
		}
		params.Progress = pgtype.Float8{Float64: v, Valid: true}
	case "budget_amount":
		if value == "" {
			params.ClearBudgetAmount = true
			return true
		}
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			return false
		}
		params.BudgetAmount = floatToNumeric(v)
	default:
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Node reference
// ---------------------------------------------------------------------------

// resolveCockpitNodeRef is the non-HTTP sibling of loadCockpitNode: it
// resolves a UUID-or-code reference for ingest, where a bad reference is one
// row's outcome rather than the whole request's.
func (h *Handler) resolveCockpitNodeRef(ctx context.Context, cc cockpitContext, ref string) (db.CockpitNode, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return db.CockpitNode{}, pgx.ErrNoRows
	}
	if id, err := util.ParseUUID(ref); err == nil {
		node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
			ID:          id,
			WorkspaceID: cc.workspaceID,
		})
		if err == nil {
			return node, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return db.CockpitNode{}, err
		}
	}
	return h.Queries.GetCockpitNodeByCode(ctx, db.GetCockpitNodeByCodeParams{
		CockpitID: cc.cockpit.ID,
		Code:      ref,
	})
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

// ingestCockpitChange judges and files one proposal. It never writes a
// response; the caller decides how each outcome reads on the wire (batch =
// one item, single = a status code).
func (h *Handler) ingestCockpitChange(
	ctx context.Context,
	qtx *db.Queries,
	cc cockpitContext,
	req CockpitChangeRequest,
	actorType, actorLabel string,
) (db.CockpitPendingChange, string, string, error) {
	field := strings.TrimSpace(req.Field)
	if _, ok := cockpitChangeFields[field]; !ok {
		return db.CockpitPendingChange{}, "rejected", "invalid_field", nil
	}
	if req.NewValue == nil {
		return db.CockpitPendingChange{}, "rejected", "invalid_field", nil
	}
	value, ok := cockpitNormalizeChangeValue(field, *req.NewValue)
	if !ok {
		return db.CockpitPendingChange{}, "rejected", "invalid_value", nil
	}

	node, err := h.resolveCockpitNodeRef(ctx, cc, req.Node)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.CockpitPendingChange{}, "rejected", "unknown_node", nil
		}
		return db.CockpitPendingChange{}, "", "", err
	}

	// A proposal that states the present is noise for a reviewer, and an
	// ingest that re-sends the same observation (agents re-running a report)
	// must be a no-op, not a queue refill.
	current := cockpitNodeFieldValue(node, field)
	if value == current {
		return db.CockpitPendingChange{}, "skipped", "no_change", nil
	}

	reason := ""
	if req.Reason != nil {
		reason = strings.TrimSpace(*req.Reason)
	}
	params := db.CreateCockpitPendingChangeParams{
		WorkspaceID:    cc.workspaceID,
		CockpitID:      cc.cockpit.ID,
		NodeID:         node.ID,
		Field:          field,
		OldValue:       current,
		NewValue:       value,
		Source:         actorSource(actorType),
		Reason:         reason,
		CreatedByType:  actorType,
		CreatedByLabel: actorLabel,
	}

	// One open proposal per (node, field): a re-ingest replaces it, latest
	// intent wins. The probe-then-insert race is closed by the partial unique
	// index — the loser falls back to the update it was racing.
	open, err := qtx.GetOpenCockpitPendingChangeByNodeField(ctx, db.GetOpenCockpitPendingChangeByNodeFieldParams{
		NodeID: node.ID,
		Field:  field,
	})
	if err == nil {
		if open.NewValue == value {
			return open, "skipped", "duplicate", nil
		}
		updated, err := qtx.UpdateCockpitPendingChangeProposal(ctx, db.UpdateCockpitPendingChangeProposalParams{
			ID:       open.ID,
			OldValue: current,
			NewValue: value,
			Reason:   reason,
		})
		if err != nil {
			return db.CockpitPendingChange{}, "", "", err
		}
		return updated, "updated", "", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.CockpitPendingChange{}, "", "", err
	}

	created, err := qtx.CreateCockpitPendingChange(ctx, params)
	if err != nil {
		if !isUniqueViolation(err) {
			return db.CockpitPendingChange{}, "", "", err
		}
		// Lost the insert race: the winner holds the open row now.
		open, err := qtx.GetOpenCockpitPendingChangeByNodeField(ctx, db.GetOpenCockpitPendingChangeByNodeFieldParams{
			NodeID: node.ID,
			Field:  field,
		})
		if err != nil {
			return db.CockpitPendingChange{}, "", "", err
		}
		if open.NewValue == value {
			return open, "skipped", "duplicate", nil
		}
		updated, err := qtx.UpdateCockpitPendingChangeProposal(ctx, db.UpdateCockpitPendingChangeProposalParams{
			ID:       open.ID,
			OldValue: current,
			NewValue: value,
			Reason:   reason,
		})
		if err != nil {
			return db.CockpitPendingChange{}, "", "", err
		}
		return updated, "updated", "", nil
	}
	return created, "queued", "", nil
}

// stringPtr exists because this file hands the wire an optional id without
// allocating inline pointers at each call site.
func stringPtr(s string) *string { return &s }

// actorSource names where a proposal came from for the queue's badge. The
// actor type comes from resolveActor, never from the request body — a member
// must not be able to badge their own filing as an agent's.
func actorSource(actorType string) string {
	if actorType == "agent" {
		return "agent"
	}
	return "manual"
}

// ListCockpitChanges is the queue: open proposals first, then the decision
// history. One response, not two endpoints — the panel shows both halves of
// the same story and a second round trip would only buy flicker.
func (h *Handler) ListCockpitChanges(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.ListCockpitPendingChanges(r.Context(), cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitPendingChanges failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list cockpit changes")
		return
	}
	out := make([]CockpitPendingChangeResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, pendingRowToResponse(row))
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateCockpitChange files one proposal by hand — the human entry into the
// same funnel agents will use. The single-projection of ingest, with its
// outcomes read as status codes rather than a result list.
func (h *Handler) CreateCockpitChange(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CockpitChangeRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	if _, touched := raw["new_value"]; !touched {
		writeError(w, http.StatusBadRequest, "new_value is required")
		return
	}

	actorType, actorLabel := h.cockpitActor(r, cc)
	change, status, reason, err := h.ingestCockpitChange(r.Context(), h.Queries, cc, req, actorType, actorLabel)
	if err != nil {
		slog.Warn("ingestCockpitChange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to file cockpit change")
		return
	}
	switch status {
	case "rejected":
		switch reason {
		case "unknown_node":
			writeError(w, http.StatusNotFound, "cockpit node not found")
		case "invalid_value":
			writeError(w, http.StatusBadRequest, "invalid new_value for field "+req.Field)
		default:
			writeError(w, http.StatusBadRequest, "unknown or non-proposable field "+req.Field)
		}
		return
	case "skipped":
		// Filing what the board already says is not an error worth a red
		// toast; it is worth hearing about. 200 with the reason, so the form
		// can say "already current" without parsing prose.
		writeJSON(w, http.StatusOK, CockpitIngestResponse{Results: []CockpitIngestItem{{
			Node: req.Node, Field: req.Field, Status: status, Reason: reason,
			ID: stringPtr(uuidToString(change.ID)),
		}}})
		return
	}

	resp := pendingChangeToResponse(change, "", "")
	if node, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{
		ID:          change.NodeID,
		WorkspaceID: cc.workspaceID,
	}); err == nil {
		resp.NodeCode, resp.NodeName = node.Code, node.Name
	}
	h.publishCockpit(r, cc, "changes", "queued", resp)
	writeJSON(w, http.StatusCreated, resp)
}

// IngestCockpitChanges is the batch funnel: agent write-backs land here.
// Every proposal is judged on its own — one bad row never poisons the batch,
// because a reporter that got nine fields right and one wrong has still done
// nine fields of work.
func (h *Handler) IngestCockpitChanges(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CockpitIngestRequest
	if _, ok := decodeCockpitBody(w, r, &req); !ok {
		return
	}
	if len(req.Changes) > 500 {
		writeError(w, http.StatusBadRequest, "too many changes; limit is 500 per request")
		return
	}

	actorType, actorLabel := h.cockpitActor(r, cc)
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		slog.Warn("cockpit ingest begin failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to file cockpit changes")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)

	results := make([]CockpitIngestItem, 0, len(req.Changes))
	queued := false
	for _, item := range req.Changes {
		change, status, reason, err := h.ingestCockpitChange(r.Context(), qtx, cc, item, actorType, actorLabel)
		if err != nil {
			slog.Warn("ingestCockpitChange failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to file cockpit changes")
			return
		}
		var id *string
		if status == "queued" || status == "updated" {
			queued = true
			id = stringPtr(uuidToString(change.ID))
		} else if status == "skipped" && reason == "duplicate" {
			id = stringPtr(uuidToString(change.ID))
		}
		results = append(results, CockpitIngestItem{
			Node: item.Node, Field: item.Field, Status: status, Reason: reason, ID: id,
		})
	}
	if err := tx.Commit(r.Context()); err != nil {
		slog.Warn("cockpit ingest commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to file cockpit changes")
		return
	}
	if queued {
		h.publishCockpit(r, cc, "changes", "ingested", nil)
	}
	writeJSON(w, http.StatusOK, CockpitIngestResponse{Results: results})
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

// ApplyCockpitChange is the one place a proposal becomes board state. The
// node write and the status transition commit together: an applied flag with
// no field written (or the reverse) would make the queue lie about the board.
//
// Apply does not re-judge the proposal. By the time a human says yes, the
// board may have moved — that is what they are deciding on. What it records
// is the truth of what it overwrote (old_value), so the history reads what
// actually happened even then.
func (h *Handler) ApplyCockpitChange(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "changeId"), "change id")
	if !ok {
		return
	}

	ctx := r.Context()
	change, err := h.Queries.GetCockpitPendingChange(ctx, db.GetCockpitPendingChangeParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "cockpit change not found")
			return
		}
		slog.Warn("GetCockpitPendingChange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}
	if change.Status != "pending" {
		writeError(w, http.StatusConflict, "this change has already been decided")
		return
	}

	node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
		ID:          change.NodeID,
		WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		// Node deletion clears its change rows in the same request, so a
		// missing node here is a race with one — not a state to apply onto.
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "the node this change targets no longer exists")
			return
		}
		slog.Warn("GetCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}

	actorType, actorLabel := h.cockpitActor(r, cc)
	actorID, _ := h.resolveActor(r, uuidToString(cc.member.UserID), uuidToString(cc.workspaceID))
	decidedByID, err := util.ParseUUID(actorID)
	if err != nil {
		decidedByID = cc.member.UserID
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		slog.Warn("cockpit apply begin failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	// What the column says right now — the value apply will overwrite and the
	// history will record, which is not necessarily what the proposal queued.
	current := cockpitNodeFieldValue(node, change.Field)
	params := db.UpdateCockpitNodeParams{
		ID:            node.ID,
		WorkspaceID:   cc.workspaceID,
		UpdatedByType: actorType,
		UpdatedByID:   decidedByID,
	}
	if !cockpitChangeWriteParams(change.Field, change.NewValue, &params) {
		// Stored values are canonicalised at ingest; unparsable here means
		// the row was written by something that skipped the funnel.
		writeError(w, http.StatusConflict, "this change carries a value that can no longer be parsed")
		return
	}
	updated, err := qtx.UpdateCockpitNode(ctx, params)
	if err != nil {
		slog.Warn("UpdateCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}
	decided, err := qtx.DecideCockpitPendingChange(ctx, db.DecideCockpitPendingChangeParams{
		ID:             change.ID,
		WorkspaceID:    cc.workspaceID,
		Status:         "applied",
		OldValue:       current,
		DecidedByType:  actorType,
		DecidedByLabel: actorLabel,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Someone else decided this row between the read above and now.
			writeError(w, http.StatusConflict, "this change has already been decided")
			return
		}
		slog.Warn("DecideCockpitPendingChange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		slog.Warn("cockpit apply commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to apply cockpit change")
		return
	}

	nodeResp := cockpitNodeToResponse(updated)
	h.publishCockpit(r, cc, "node", "updated", nodeResp)
	h.publishCockpit(r, cc, "changes", "applied", pendingChangeToResponse(decided, node.Code, node.Name))
	writeJSON(w, http.StatusOK, CockpitChangeApplyResponse{
		Change: pendingChangeToResponse(decided, node.Code, node.Name),
		Node:   nodeResp,
	})
}

// decideCockpitChange closes an open proposal without touching the board.
// Reject (a reviewer said no) and withdraw (the proposer took it back) are
// the same write with a different word — the queue treats both as "open no
// more", and neither ever edits a field.
func (h *Handler) decideCockpitChange(w http.ResponseWriter, r *http.Request, status string) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "changeId"), "change id")
	if !ok {
		return
	}

	ctx := r.Context()
	change, err := h.Queries.GetCockpitPendingChange(ctx, db.GetCockpitPendingChangeParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "cockpit change not found")
			return
		}
		slog.Warn("GetCockpitPendingChange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to decide cockpit change")
		return
	}
	if change.Status != "pending" {
		writeError(w, http.StatusConflict, "this change has already been decided")
		return
	}

	actorType, actorLabel := h.cockpitActor(r, cc)
	decided, err := h.Queries.DecideCockpitPendingChange(ctx, db.DecideCockpitPendingChangeParams{
		ID:             change.ID,
		WorkspaceID:    cc.workspaceID,
		Status:         status,
		OldValue:       change.OldValue,
		DecidedByType:  actorType,
		DecidedByLabel: actorLabel,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusConflict, "this change has already been decided")
			return
		}
		slog.Warn("DecideCockpitPendingChange failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to decide cockpit change")
		return
	}

	resp := pendingChangeToResponse(decided, "", "")
	if node, err := h.Queries.GetCockpitNode(ctx, db.GetCockpitNodeParams{
		ID:          change.NodeID,
		WorkspaceID: cc.workspaceID,
	}); err == nil {
		resp.NodeCode, resp.NodeName = node.Code, node.Name
	}
	h.publishCockpit(r, cc, "changes", status, resp)
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) RejectCockpitChange(w http.ResponseWriter, r *http.Request) {
	h.decideCockpitChange(w, r, "rejected")
}

func (h *Handler) WithdrawCockpitChange(w http.ResponseWriter, r *http.Request) {
	h.decideCockpitChange(w, r, "withdrawn")
}
