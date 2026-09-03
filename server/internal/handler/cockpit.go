package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Project cockpit API (BayClaw fork).
//
// The cockpit is one shared programme board per workspace: a work-breakdown
// tree with dates, owners, budget and instalments, plus milestones, meetings
// and links to the issues that carry the work out.
//
// Two shapes of read exist on purpose. GET /api/cockpit returns the WHOLE board
// in one response — a few hundred rows that every view needs at once, where a
// second round trip per section would only buy latency. Every write returns the
// single row it touched, and the realtime event carries that row, so a keystroke
// never costs a board re-read.
//
// Reads and writes are both open to any workspace member: a planning board that
// only admins can correct is a board that goes stale. Replacing the entire board
// (import) is owner/admin, because it is the one operation that destroys work
// nobody else can recover.

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type CockpitResponse struct {
	ID             string  `json:"id"`
	WorkspaceID    string  `json:"workspace_id"`
	Title          string  `json:"title"`
	GoalTitle      string  `json:"goal_title"`
	GoalDate       *string `json:"goal_date"`
	SummaryOverall string  `json:"summary_overall"`
	SummaryNext    string  `json:"summary_next"`
	SummarySupport string  `json:"summary_support"`
	Basis          string  `json:"basis"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

type CockpitNodeResponse struct {
	ID              string   `json:"id"`
	CockpitID       string   `json:"cockpit_id"`
	ParentID        *string  `json:"parent_id"`
	Code            string   `json:"code"`
	Name            string   `json:"name"`
	Position        float64  `json:"position"`
	Color           string   `json:"color"`
	Owner           string   `json:"owner"`
	Collaborators   string   `json:"collaborators"`
	StartDate       *string  `json:"start_date"`
	EndDate         *string  `json:"end_date"`
	Status          string   `json:"status"`
	Progress        float64  `json:"progress"`
	Deliverable     string   `json:"deliverable"`
	Dependencies    string   `json:"dependencies"`
	Note            string   `json:"note"`
	CurrentProgress string   `json:"current_progress"`
	Vendor          string   `json:"vendor"`
	BudgetCategory  string   `json:"budget_category"`
	BudgetAmount    *float64 `json:"budget_amount"`
	ExecStatus      string   `json:"exec_status"`
	Contract        string   `json:"contract"`
	Source          string   `json:"source"`
	UpdatedByType   string   `json:"updated_by_type"`
	UpdatedByID     *string  `json:"updated_by_id"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
}

type CockpitPaymentResponse struct {
	ID       string  `json:"id"`
	NodeID   string  `json:"node_id"`
	Label    string  `json:"label"`
	PayDate  *string `json:"pay_date"`
	Amount   float64 `json:"amount"`
	Position float64 `json:"position"`
}

type CockpitNodeIssueResponse struct {
	ID      string `json:"id"`
	NodeID  string `json:"node_id"`
	IssueID string `json:"issue_id"`
	// Both the raw number and the workspace-prefixed identifier ("BIO-314"),
	// because the board renders the identifier and sorts on the number.
	IssueNumber     int32   `json:"issue_number"`
	IssueIdentifier string  `json:"issue_identifier"`
	IssueTitle      string  `json:"issue_title"`
	IssueStatus     string  `json:"issue_status"`
	Position        float64 `json:"position"`
}

type CockpitMilestoneResponse struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	PlanDate   *string `json:"plan_date"`
	ActualDate *string `json:"actual_date"`
	Status     string  `json:"status"`
	NodeID     *string `json:"node_id"`
	Condition  string  `json:"condition"`
	Guard      string  `json:"guard"`
	Position   float64 `json:"position"`
}

type CockpitMeetingResponse struct {
	ID        string  `json:"id"`
	MeetDate  *string `json:"meet_date"`
	TimeRange string  `json:"time_range"`
	Title     string  `json:"title"`
	Attendees string  `json:"attendees"`
	MeetNo    string  `json:"meet_no"`
	Link      string  `json:"link"`
	Note      string  `json:"note"`
}

// CockpitBoardResponse is the single read every view starts from.
type CockpitBoardResponse struct {
	Cockpit    CockpitResponse            `json:"cockpit"`
	Nodes      []CockpitNodeResponse      `json:"nodes"`
	Payments   []CockpitPaymentResponse   `json:"payments"`
	IssueLinks []CockpitNodeIssueResponse `json:"issue_links"`
	Milestones []CockpitMilestoneResponse `json:"milestones"`
	Meetings   []CockpitMeetingResponse   `json:"meetings"`
}

// ---------------------------------------------------------------------------
// Numeric conversion
//
// The budget columns are NUMERIC so storage never drifts, but the wire speaks
// float64: a planning board sums a few hundred values with two decimals, which
// float64 represents exactly, and every consumer (browser, CLI --output json)
// would parse a decimal string back into one anyway.
// ---------------------------------------------------------------------------

func numericToPtr(n pgtype.Numeric) *float64 {
	if !n.Valid || n.NaN {
		return nil
	}
	f, err := n.Float64Value()
	if err != nil || !f.Valid {
		return nil
	}
	v := f.Float64
	return &v
}

func numericToFloat(n pgtype.Numeric) float64 {
	if v := numericToPtr(n); v != nil {
		return *v
	}
	return 0
}

// floatToNumeric converts a wire amount to NUMERIC(14,4) by scaling to the
// column's own exponent. Going through big.Int rather than a decimal string
// keeps the rounding decision here — banker-free, half-away-from-zero, the way
// a person reading the board would round it.
func floatToNumeric(f float64) pgtype.Numeric {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return pgtype.Numeric{Valid: false}
	}
	scaled := math.Round(f * 10000)
	return pgtype.Numeric{Int: big.NewInt(int64(scaled)), Exp: -4, Valid: true}
}

func floatPtrToNumeric(f *float64) pgtype.Numeric {
	if f == nil {
		return pgtype.Numeric{Valid: false}
	}
	return floatToNumeric(*f)
}

// ---------------------------------------------------------------------------
// Row → response
// ---------------------------------------------------------------------------

func cockpitToResponse(c db.Cockpit) CockpitResponse {
	return CockpitResponse{
		ID:             uuidToString(c.ID),
		WorkspaceID:    uuidToString(c.WorkspaceID),
		Title:          c.Title,
		GoalTitle:      c.GoalTitle,
		GoalDate:       dateToPtr(c.GoalDate),
		SummaryOverall: c.SummaryOverall,
		SummaryNext:    c.SummaryNext,
		SummarySupport: c.SummarySupport,
		Basis:          c.Basis,
		CreatedAt:      timestampToString(c.CreatedAt),
		UpdatedAt:      timestampToString(c.UpdatedAt),
	}
}

func cockpitNodeToResponse(n db.CockpitNode) CockpitNodeResponse {
	return CockpitNodeResponse{
		ID:              uuidToString(n.ID),
		CockpitID:       uuidToString(n.CockpitID),
		ParentID:        uuidToPtr(n.ParentID),
		Code:            n.Code,
		Name:            n.Name,
		Position:        n.Position,
		Color:           n.Color,
		Owner:           n.Owner,
		Collaborators:   n.Collaborators,
		StartDate:       dateToPtr(n.StartDate),
		EndDate:         dateToPtr(n.EndDate),
		Status:          n.Status,
		Progress:        n.Progress,
		Deliverable:     n.Deliverable,
		Dependencies:    n.Dependencies,
		Note:            n.Note,
		CurrentProgress: n.CurrentProgress,
		Vendor:          n.Vendor,
		BudgetCategory:  n.BudgetCategory,
		BudgetAmount:    numericToPtr(n.BudgetAmount),
		ExecStatus:      n.ExecStatus,
		Contract:        n.Contract,
		Source:          n.Source,
		UpdatedByType:   n.UpdatedByType,
		UpdatedByID:     uuidToPtr(n.UpdatedByID),
		CreatedAt:       timestampToString(n.CreatedAt),
		UpdatedAt:       timestampToString(n.UpdatedAt),
	}
}

func cockpitPaymentToResponse(p db.CockpitPayment) CockpitPaymentResponse {
	return CockpitPaymentResponse{
		ID:       uuidToString(p.ID),
		NodeID:   uuidToString(p.NodeID),
		Label:    p.Label,
		PayDate:  dateToPtr(p.PayDate),
		Amount:   numericToFloat(p.Amount),
		Position: p.Position,
	}
}

func cockpitMilestoneToResponse(m db.CockpitMilestone) CockpitMilestoneResponse {
	return CockpitMilestoneResponse{
		ID:         uuidToString(m.ID),
		Name:       m.Name,
		PlanDate:   dateToPtr(m.PlanDate),
		ActualDate: dateToPtr(m.ActualDate),
		Status:     m.Status,
		NodeID:     uuidToPtr(m.NodeID),
		Condition:  m.Condition,
		Guard:      m.Guard,
		Position:   m.Position,
	}
}

func cockpitMeetingToResponse(m db.CockpitMeeting) CockpitMeetingResponse {
	return CockpitMeetingResponse{
		ID:        uuidToString(m.ID),
		MeetDate:  dateToPtr(m.MeetDate),
		TimeRange: m.TimeRange,
		Title:     m.Title,
		Attendees: m.Attendees,
		MeetNo:    m.MeetNo,
		Link:      m.Link,
		Note:      m.Note,
	}
}

// cockpitLinkToResponse renders one issue link. The prefix is passed in rather
// than looked up per row: it is a property of the workspace, and a board can
// carry a few hundred links.
func cockpitLinkToResponse(l db.ListCockpitNodeIssuesRow, prefix string) CockpitNodeIssueResponse {
	return CockpitNodeIssueResponse{
		ID:              uuidToString(l.ID),
		NodeID:          uuidToString(l.NodeID),
		IssueID:         uuidToString(l.IssueID),
		IssueNumber:     l.IssueNumber,
		IssueIdentifier: fmt.Sprintf("%s-%d", prefix, l.IssueNumber),
		IssueTitle:      l.IssueTitle,
		IssueStatus:     l.IssueStatus,
		Position:        l.Position,
	}
}

// ---------------------------------------------------------------------------
// Shared resolution
// ---------------------------------------------------------------------------

// cockpitContext is everything a cockpit endpoint needs after auth: the
// workspace, the member acting, and the board itself.
type cockpitContext struct {
	workspaceID pgtype.UUID
	member      db.Member
	cockpit     db.Cockpit
}

// ensureCockpit returns the workspace's board, creating it on first use.
//
// Lazy creation rather than a seed on workspace create: the cockpit is opt-in
// programme tooling, and back-filling a row into every workspace that will
// never open it buys nothing. CreateCockpit is idempotent, so a first visit
// racing itself across two pods still yields one board.
func (h *Handler) ensureCockpit(ctx context.Context, workspaceID pgtype.UUID) (db.Cockpit, error) {
	board, err := h.Queries.GetCockpitByWorkspace(ctx, workspaceID)
	if err == nil {
		return board, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.Cockpit{}, err
	}
	return h.Queries.CreateCockpit(ctx, db.CreateCockpitParams{WorkspaceID: workspaceID})
}

// requireCockpit resolves workspace, membership and board in one step. Every
// cockpit endpoint starts here, so the three failure modes (no workspace
// header, not a member, board unreadable) answer identically everywhere.
func (h *Handler) requireCockpit(w http.ResponseWriter, r *http.Request) (cockpitContext, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return cockpitContext{}, false
	}
	member, ok := h.requireWorkspaceMember(w, r, workspaceID, "workspace not found")
	if !ok {
		return cockpitContext{}, false
	}
	board, err := h.ensureCockpit(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ensureCockpit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return cockpitContext{}, false
	}
	return cockpitContext{workspaceID: wsUUID, member: member, cockpit: board}, true
}

// loadCockpitNode resolves a node addressed either by UUID or by the code
// people actually use for it ("L3-01-08"). Path params that may be a
// human-readable identifier must go through a loader before any write touches
// them; every mutation below writes node.ID, never the raw path string.
func (h *Handler) loadCockpitNode(w http.ResponseWriter, r *http.Request, cc cockpitContext, param string) (db.CockpitNode, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, param))
	if raw == "" {
		writeError(w, http.StatusBadRequest, "node id is required")
		return db.CockpitNode{}, false
	}

	if id, err := util.ParseUUID(raw); err == nil {
		node, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{
			ID:          id,
			WorkspaceID: cc.workspaceID,
		})
		if err == nil {
			return node, true
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("GetCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to load cockpit node")
			return db.CockpitNode{}, false
		}
	}

	node, err := h.Queries.GetCockpitNodeByCode(r.Context(), db.GetCockpitNodeByCodeParams{
		CockpitID: cc.cockpit.ID,
		Code:      raw,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "cockpit node not found")
			return db.CockpitNode{}, false
		}
		slog.Warn("GetCockpitNodeByCode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit node")
		return db.CockpitNode{}, false
	}
	return node, true
}

// resolveCockpitIssue resolves an issue reference that may be a UUID or the
// workspace's own identifier ("BIO-314").
//
// It is the read-only sibling of loadIssueForUser: the cockpit resolves issue
// references in bulk, where one unknown reference must be reported alongside
// the ones that did resolve rather than becoming the whole response.
func (h *Handler) resolveCockpitIssue(ctx context.Context, ref, workspaceID string) (db.Issue, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" || workspaceID == "" {
		return db.Issue{}, false
	}
	if issue, ok := h.resolveIssueByIdentifier(ctx, ref, workspaceID); ok {
		return issue, true
	}
	issueUUID, err := util.ParseUUID(ref)
	if err != nil {
		return db.Issue{}, false
	}
	wsUUID, err := util.ParseUUID(workspaceID)
	if err != nil {
		return db.Issue{}, false
	}
	issue, err := h.Queries.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{
		ID:          issueUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		return db.Issue{}, false
	}
	return issue, true
}

// publishCockpit announces one write. The payload carries the changed row so a
// client patches exactly what moved instead of re-reading a board of a few
// hundred nodes on every keystroke of someone else's edit. `scope` names which
// collection moved, so a client that does not model that collection can ignore
// the frame without parsing it.
func (h *Handler) publishCockpit(cc cockpitContext, scope, action string, entity any) {
	h.publish(protocol.EventCockpitChanged, uuidToString(cc.workspaceID), "member", uuidToString(cc.member.UserID), map[string]any{
		"scope":  scope,
		"action": action,
		"entity": entity,
	})
}

// decodeCockpitBody decodes into a typed request AND a raw field map, so a
// handler can tell "field omitted" from "field explicitly cleared". A nullable
// column has no other way to hear "empty this".
func decodeCockpitBody(w http.ResponseWriter, r *http.Request, req any) (map[string]json.RawMessage, bool) {
	var raw map[string]json.RawMessage
	body := http.MaxBytesReader(w, r.Body, 8<<20)
	dec := json.NewDecoder(body)
	if err := dec.Decode(&raw); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	buf, err := json.Marshal(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	if err := json.Unmarshal(buf, req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	return raw, true
}

// cockpitDate reads one optional date field out of a partial update.
//
// Three states, and they are genuinely different: absent leaves the column
// alone, present-and-empty clears it, present-and-set writes it. A withdrawn
// planned end date is an edit, not the absence of one.
func cockpitDate(w http.ResponseWriter, raw map[string]json.RawMessage, key string, value *string) (pgtype.Date, bool, bool) {
	if _, touched := raw[key]; !touched {
		return pgtype.Date{}, false, true
	}
	if value == nil || strings.TrimSpace(*value) == "" {
		return pgtype.Date{}, true, true
	}
	d, err := util.ParseCalendarDate(strings.TrimSpace(*value))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid "+key+" format, expected YYYY-MM-DD")
		return pgtype.Date{}, false, false
	}
	return d, false, true
}

func optionalText(v *string) pgtype.Text {
	if v == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *v, Valid: true}
}

func optionalFloat(v *float64) pgtype.Float8 {
	if v == nil {
		return pgtype.Float8{}
	}
	return pgtype.Float8{Float64: *v, Valid: true}
}

func textOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}

func floatOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// ---------------------------------------------------------------------------
// Board read
// ---------------------------------------------------------------------------

// GetCockpit returns the whole board: the cockpit row, its work-breakdown
// tree, instalments, issue links, milestones and meetings.
func (h *Handler) GetCockpit(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	ctx := r.Context()
	nodes, err := h.Queries.ListCockpitNodes(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitNodes failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	payments, err := h.Queries.ListCockpitPayments(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitPayments failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	links, err := h.Queries.ListCockpitNodeIssues(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitNodeIssues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	milestones, err := h.Queries.ListCockpitMilestones(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMilestones failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	meetings, err := h.Queries.ListCockpitMeetings(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetings failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}

	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	resp := CockpitBoardResponse{
		Cockpit:    cockpitToResponse(cc.cockpit),
		Nodes:      make([]CockpitNodeResponse, len(nodes)),
		Payments:   make([]CockpitPaymentResponse, len(payments)),
		IssueLinks: make([]CockpitNodeIssueResponse, len(links)),
		Milestones: make([]CockpitMilestoneResponse, len(milestones)),
		Meetings:   make([]CockpitMeetingResponse, len(meetings)),
	}
	for i, n := range nodes {
		resp.Nodes[i] = cockpitNodeToResponse(n)
	}
	for i, p := range payments {
		resp.Payments[i] = cockpitPaymentToResponse(p)
	}
	for i, l := range links {
		resp.IssueLinks[i] = cockpitLinkToResponse(l, prefix)
	}
	for i, m := range milestones {
		resp.Milestones[i] = cockpitMilestoneToResponse(m)
	}
	for i, m := range meetings {
		resp.Meetings[i] = cockpitMeetingToResponse(m)
	}

	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Board-level fields
// ---------------------------------------------------------------------------

type UpdateCockpitRequest struct {
	Title          *string `json:"title"`
	GoalTitle      *string `json:"goal_title"`
	GoalDate       *string `json:"goal_date"`
	SummaryOverall *string `json:"summary_overall"`
	SummaryNext    *string `json:"summary_next"`
	SummarySupport *string `json:"summary_support"`
	Basis          *string `json:"basis"`
}

func (h *Handler) UpdateCockpit(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req UpdateCockpitRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}

	goalDate, clearGoalDate, ok := cockpitDate(w, raw, "goal_date", req.GoalDate)
	if !ok {
		return
	}

	board, err := h.Queries.UpdateCockpit(r.Context(), db.UpdateCockpitParams{
		ID:             cc.cockpit.ID,
		WorkspaceID:    cc.workspaceID,
		Title:          optionalText(req.Title),
		GoalTitle:      optionalText(req.GoalTitle),
		GoalDate:       goalDate,
		ClearGoalDate:  clearGoalDate,
		SummaryOverall: optionalText(req.SummaryOverall),
		SummaryNext:    optionalText(req.SummaryNext),
		SummarySupport: optionalText(req.SummarySupport),
		Basis:          optionalText(req.Basis),
	})
	if err != nil {
		slog.Warn("UpdateCockpit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update cockpit")
		return
	}

	resp := cockpitToResponse(board)
	h.publishCockpit(cc, "cockpit", "updated", resp)
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

type CockpitNodeRequest struct {
	ParentID        *string  `json:"parent_id"`
	Code            *string  `json:"code"`
	Name            *string  `json:"name"`
	Position        *float64 `json:"position"`
	Color           *string  `json:"color"`
	Owner           *string  `json:"owner"`
	Collaborators   *string  `json:"collaborators"`
	StartDate       *string  `json:"start_date"`
	EndDate         *string  `json:"end_date"`
	Status          *string  `json:"status"`
	Progress        *float64 `json:"progress"`
	Deliverable     *string  `json:"deliverable"`
	Dependencies    *string  `json:"dependencies"`
	Note            *string  `json:"note"`
	CurrentProgress *string  `json:"current_progress"`
	Vendor          *string  `json:"vendor"`
	BudgetCategory  *string  `json:"budget_category"`
	BudgetAmount    *float64 `json:"budget_amount"`
	ExecStatus      *string  `json:"exec_status"`
	Contract        *string  `json:"contract"`
	Source          *string  `json:"source"`
}

// progressOrError validates the 0-100 range shared by create and update. A
// progress outside it would pass the column CHECK only by luck of rounding.
func progressOrError(w http.ResponseWriter, v *float64) (float64, bool) {
	if v == nil {
		return 0, true
	}
	if math.IsNaN(*v) || *v < 0 || *v > 100 {
		writeError(w, http.StatusBadRequest, "progress must be between 0 and 100")
		return 0, false
	}
	return *v, true
}

// resolveCockpitParent validates a requested parent: it must belong to this
// board, and it must not be the node being edited (a node cannot parent
// itself, and a one-node cycle is the only cycle a single write can create).
func (h *Handler) resolveCockpitParent(w http.ResponseWriter, r *http.Request, cc cockpitContext, parentID string, self pgtype.UUID) (pgtype.UUID, bool) {
	id, ok := parseUUIDOrBadRequest(w, parentID, "parent_id")
	if !ok {
		return pgtype.UUID{}, false
	}
	if self.Valid && id == self {
		writeError(w, http.StatusBadRequest, "a node cannot be its own parent")
		return pgtype.UUID{}, false
	}
	parent, err := h.Queries.GetCockpitNode(r.Context(), db.GetCockpitNodeParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "parent node not found")
		return pgtype.UUID{}, false
	}
	if parent.CockpitID != cc.cockpit.ID {
		writeError(w, http.StatusBadRequest, "parent node belongs to another cockpit")
		return pgtype.UUID{}, false
	}
	return id, true
}

func (h *Handler) CreateCockpitNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req CockpitNodeRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}

	code := textOrEmpty(req.Code)
	if code == "" || len([]rune(code)) > 64 {
		writeError(w, http.StatusBadRequest, "code must be 1-64 characters")
		return
	}

	var parentID pgtype.UUID
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		parentID, ok = h.resolveCockpitParent(w, r, cc, *req.ParentID, pgtype.UUID{})
		if !ok {
			return
		}
	}

	startDate, _, ok := cockpitDate(w, raw, "start_date", req.StartDate)
	if !ok {
		return
	}
	endDate, _, ok := cockpitDate(w, raw, "end_date", req.EndDate)
	if !ok {
		return
	}
	progress, ok := progressOrError(w, req.Progress)
	if !ok {
		return
	}

	node, err := h.Queries.CreateCockpitNode(r.Context(), db.CreateCockpitNodeParams{
		WorkspaceID:     cc.workspaceID,
		CockpitID:       cc.cockpit.ID,
		ParentID:        parentID,
		Code:            code,
		Name:            textOrEmpty(req.Name),
		Position:        floatOrZero(req.Position),
		Color:           textOrEmpty(req.Color),
		Owner:           textOrEmpty(req.Owner),
		Collaborators:   textOrEmpty(req.Collaborators),
		StartDate:       startDate,
		EndDate:         endDate,
		Status:          textOrEmpty(req.Status),
		Progress:        progress,
		Deliverable:     textOrEmpty(req.Deliverable),
		Dependencies:    textOrEmpty(req.Dependencies),
		Note:            textOrEmpty(req.Note),
		CurrentProgress: textOrEmpty(req.CurrentProgress),
		Vendor:          textOrEmpty(req.Vendor),
		BudgetCategory:  textOrEmpty(req.BudgetCategory),
		BudgetAmount:    floatPtrToNumeric(req.BudgetAmount),
		ExecStatus:      textOrEmpty(req.ExecStatus),
		Contract:        textOrEmpty(req.Contract),
		Source:          textOrEmpty(req.Source),
		UpdatedByType:   "member",
		UpdatedByID:     cc.member.UserID,
	})
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a node with this code already exists")
			return
		}
		slog.Warn("CreateCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create cockpit node")
		return
	}

	resp := cockpitNodeToResponse(node)
	h.publishCockpit(cc, "node", "created", resp)
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateCockpitNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	current, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	var req CockpitNodeRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}

	params := db.UpdateCockpitNodeParams{
		ID:              current.ID,
		WorkspaceID:     cc.workspaceID,
		Code:            optionalText(req.Code),
		Name:            optionalText(req.Name),
		Position:        optionalFloat(req.Position),
		Color:           optionalText(req.Color),
		Owner:           optionalText(req.Owner),
		Collaborators:   optionalText(req.Collaborators),
		Status:          optionalText(req.Status),
		Deliverable:     optionalText(req.Deliverable),
		Dependencies:    optionalText(req.Dependencies),
		Note:            optionalText(req.Note),
		CurrentProgress: optionalText(req.CurrentProgress),
		Vendor:          optionalText(req.Vendor),
		BudgetCategory:  optionalText(req.BudgetCategory),
		ExecStatus:      optionalText(req.ExecStatus),
		Contract:        optionalText(req.Contract),
		Source:          optionalText(req.Source),
		UpdatedByType:   "member",
		UpdatedByID:     cc.member.UserID,
	}

	if _, touched := raw["parent_id"]; touched {
		if req.ParentID == nil || strings.TrimSpace(*req.ParentID) == "" {
			params.ClearParent = true
		} else {
			parentID, ok := h.resolveCockpitParent(w, r, cc, *req.ParentID, current.ID)
			if !ok {
				return
			}
			params.ParentID = parentID
		}
	}

	if req.Progress != nil {
		progress, ok := progressOrError(w, req.Progress)
		if !ok {
			return
		}
		params.Progress = pgtype.Float8{Float64: progress, Valid: true}
	}

	startDate, clearStart, ok := cockpitDate(w, raw, "start_date", req.StartDate)
	if !ok {
		return
	}
	params.StartDate, params.ClearStartDate = startDate, clearStart

	endDate, clearEnd, ok := cockpitDate(w, raw, "end_date", req.EndDate)
	if !ok {
		return
	}
	params.EndDate, params.ClearEndDate = endDate, clearEnd

	if _, touched := raw["budget_amount"]; touched {
		if req.BudgetAmount == nil {
			params.ClearBudgetAmount = true
		} else {
			params.BudgetAmount = floatToNumeric(*req.BudgetAmount)
		}
	}

	if req.Code != nil {
		code := strings.TrimSpace(*req.Code)
		if code == "" || len([]rune(code)) > 64 {
			writeError(w, http.StatusBadRequest, "code must be 1-64 characters")
			return
		}
		params.Code = pgtype.Text{String: code, Valid: true}
	}

	node, err := h.Queries.UpdateCockpitNode(r.Context(), params)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a node with this code already exists")
			return
		}
		slog.Warn("UpdateCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update cockpit node")
		return
	}

	resp := cockpitNodeToResponse(node)
	h.publishCockpit(cc, "node", "updated", resp)
	writeJSON(w, http.StatusOK, resp)
}

// DeleteCockpitNode removes a leaf. A branch with children is refused rather
// than cascaded: the tree carries the programme's structure, and silently
// deleting a module's whole subtree on one mis-clicked row is not a recovery
// anyone has.
func (h *Handler) DeleteCockpitNode(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	children, err := h.Queries.ListCockpitNodeChildIDs(r.Context(), db.ListCockpitNodeChildIDsParams{
		CockpitID: cc.cockpit.ID,
		ParentID:  node.ID,
	})
	if err != nil {
		slog.Warn("ListCockpitNodeChildIDs failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if len(children) > 0 {
		writeError(w, http.StatusConflict, "this node still has children; delete or reparent them first")
		return
	}

	// No cascading deletes in the schema (repository rule), so the node's own
	// instalments and issue links are cleared here, in the same request, before
	// the row they belong to disappears.
	ctx := r.Context()
	if err := h.Queries.DeleteCockpitPaymentsByNode(ctx, db.DeleteCockpitPaymentsByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitPaymentsByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := h.Queries.DeleteCockpitNodeIssuesByNode(ctx, db.DeleteCockpitNodeIssuesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNodeIssuesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := h.Queries.DeleteCockpitNode(ctx, db.DeleteCockpitNodeParams{
		ID:          node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}

	h.publishCockpit(cc, "node", "deleted", map[string]any{"id": uuidToString(node.ID)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Issue links
// ---------------------------------------------------------------------------

type CockpitNodeIssuesRequest struct {
	// Issue identifiers, each either a UUID or a human-readable number
	// ("BIO-314") — the board's own vocabulary for the same thing.
	IssueIDs []string `json:"issue_ids"`
	// Replace swaps the node's whole link set for IssueIDs. The default adds to
	// it, which is what a picker does; replace is what a bulk import does.
	Replace bool `json:"replace"`
}

// SetCockpitNodeIssues links issues to a node. Multi-select is the point: the
// source board carried one free-text "BIO-176（待确认）" per task, which could
// neither be searched nor resolved to a live issue.
func (h *Handler) SetCockpitNodeIssues(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	var req CockpitNodeIssuesRequest
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
		// Resolved through a loader before any write sees it: the identifier
		// may be "BIO-314", and only issue.ID is ever stored.
		issue, found := h.resolveCockpitIssue(ctx, raw, uuidToString(cc.workspaceID))
		if !found {
			writeError(w, http.StatusBadRequest, "issue not found: "+raw)
			return
		}
		resolved = append(resolved, issue.ID)
	}

	if req.Replace {
		if err := h.Queries.DeleteCockpitNodeIssuesByNode(ctx, db.DeleteCockpitNodeIssuesByNodeParams{
			NodeID:      node.ID,
			WorkspaceID: cc.workspaceID,
		}); err != nil {
			slog.Warn("DeleteCockpitNodeIssuesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}

	for i, issueID := range resolved {
		if _, err := h.Queries.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{
			WorkspaceID: cc.workspaceID,
			NodeID:      node.ID,
			IssueID:     issueID,
			Position:    float64(i),
		}); err != nil {
			slog.Warn("CreateCockpitNodeIssue failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to link issues")
			return
		}
	}

	links, err := h.Queries.ListCockpitNodeIssues(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitNodeIssues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to link issues")
		return
	}
	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	nodeLinks := make([]CockpitNodeIssueResponse, 0, len(resolved))
	for _, l := range links {
		if l.NodeID != node.ID {
			continue
		}
		nodeLinks = append(nodeLinks, cockpitLinkToResponse(l, prefix))
	}

	payload := map[string]any{"node_id": uuidToString(node.ID), "links": nodeLinks}
	h.publishCockpit(cc, "issue_links", "replaced", payload)
	writeJSON(w, http.StatusOK, payload)
}

func (h *Handler) DeleteCockpitNodeIssue(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	node, ok := h.loadCockpitNode(w, r, cc, "id")
	if !ok {
		return
	}

	issue, found := h.resolveCockpitIssue(r.Context(), chi.URLParam(r, "issueId"), uuidToString(cc.workspaceID))
	if !found {
		writeError(w, http.StatusNotFound, "issue not found")
		return
	}

	if err := h.Queries.DeleteCockpitNodeIssue(r.Context(), db.DeleteCockpitNodeIssueParams{
		NodeID:      node.ID,
		IssueID:     issue.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitNodeIssue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to unlink issue")
		return
	}

	h.publishCockpit(cc, "issue_links", "removed", map[string]any{
		"node_id":  uuidToString(node.ID),
		"issue_id": uuidToString(issue.ID),
	})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

type CockpitPaymentRequest struct {
	Label    *string  `json:"label"`
	PayDate  *string  `json:"pay_date"`
	Amount   *float64 `json:"amount"`
	Position *float64 `json:"position"`
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
		Amount:      floatToNumeric(floatOrZero(req.Amount)),
		Position:    floatOrZero(req.Position),
	})
	if err != nil {
		slog.Warn("CreateCockpitPayment failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create payment")
		return
	}

	resp := cockpitPaymentToResponse(payment)
	h.publishCockpit(cc, "payment", "created", resp)
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
		params.Amount = floatToNumeric(*req.Amount)
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
	h.publishCockpit(cc, "payment", "updated", resp)
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
	h.publishCockpit(cc, "payment", "deleted", map[string]any{"id": uuidToString(id)})
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
	h.publishCockpit(cc, "milestone", "created", resp)
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
	h.publishCockpit(cc, "milestone", "updated", resp)
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
	h.publishCockpit(cc, "milestone", "deleted", map[string]any{"id": uuidToString(id)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

type CockpitMeetingRequest struct {
	MeetDate  *string `json:"meet_date"`
	TimeRange *string `json:"time_range"`
	Title     *string `json:"title"`
	Attendees *string `json:"attendees"`
	MeetNo    *string `json:"meet_no"`
	Link      *string `json:"link"`
	Note      *string `json:"note"`
}

func (h *Handler) CreateCockpitMeeting(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}

	var req CockpitMeetingRequest
	raw, ok := decodeCockpitBody(w, r, &req)
	if !ok {
		return
	}
	meetDate, _, ok := cockpitDate(w, raw, "meet_date", req.MeetDate)
	if !ok {
		return
	}

	meeting, err := h.Queries.CreateCockpitMeeting(r.Context(), db.CreateCockpitMeetingParams{
		WorkspaceID: cc.workspaceID,
		CockpitID:   cc.cockpit.ID,
		MeetDate:    meetDate,
		TimeRange:   textOrEmpty(req.TimeRange),
		Title:       textOrEmpty(req.Title),
		Attendees:   textOrEmpty(req.Attendees),
		MeetNo:      textOrEmpty(req.MeetNo),
		Link:        textOrEmpty(req.Link),
		Note:        textOrEmpty(req.Note),
	})
	if err != nil {
		slog.Warn("CreateCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create meeting")
		return
	}

	resp := cockpitMeetingToResponse(meeting)
	h.publishCockpit(cc, "meeting", "created", resp)
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

	meeting, err := h.Queries.UpdateCockpitMeeting(r.Context(), db.UpdateCockpitMeetingParams{
		ID:            id,
		WorkspaceID:   cc.workspaceID,
		MeetDate:      meetDate,
		ClearMeetDate: clearMeetDate,
		TimeRange:     optionalText(req.TimeRange),
		Title:         optionalText(req.Title),
		Attendees:     optionalText(req.Attendees),
		MeetNo:        optionalText(req.MeetNo),
		Link:          optionalText(req.Link),
		Note:          optionalText(req.Note),
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

	resp := cockpitMeetingToResponse(meeting)
	h.publishCockpit(cc, "meeting", "updated", resp)
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
	if err := h.Queries.DeleteCockpitMeeting(r.Context(), db.DeleteCockpitMeetingParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	h.publishCockpit(cc, "meeting", "deleted", map[string]any{"id": uuidToString(id)})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// CockpitImportNode is one node of an imported board. Parents are named by
// `parent_code`, not by id, because an import document is written before any id
// exists — and because a person editing that document thinks in "L1-02", not
// in UUIDs.
type CockpitImportNode struct {
	Code            string                 `json:"code"`
	ParentCode      string                 `json:"parent_code"`
	Name            string                 `json:"name"`
	Position        float64                `json:"position"`
	Color           string                 `json:"color"`
	Owner           string                 `json:"owner"`
	Collaborators   string                 `json:"collaborators"`
	StartDate       string                 `json:"start_date"`
	EndDate         string                 `json:"end_date"`
	Status          string                 `json:"status"`
	Progress        float64                `json:"progress"`
	Deliverable     string                 `json:"deliverable"`
	Dependencies    string                 `json:"dependencies"`
	Note            string                 `json:"note"`
	CurrentProgress string                 `json:"current_progress"`
	Vendor          string                 `json:"vendor"`
	BudgetCategory  string                 `json:"budget_category"`
	BudgetAmount    *float64               `json:"budget_amount"`
	ExecStatus      string                 `json:"exec_status"`
	Contract        string                 `json:"contract"`
	Source          string                 `json:"source"`
	Payments        []CockpitImportPayment `json:"payments"`
	// Issue identifiers ("BIO-314" or a UUID). Unresolvable ones are reported
	// back rather than failing the import: a plan routinely names issues that
	// have not been filed yet.
	IssueIDs []string `json:"issue_ids"`
}

type CockpitImportPayment struct {
	Label   string  `json:"label"`
	PayDate string  `json:"pay_date"`
	Amount  float64 `json:"amount"`
}

type CockpitImportMilestone struct {
	Name       string  `json:"name"`
	PlanDate   string  `json:"plan_date"`
	ActualDate string  `json:"actual_date"`
	Status     string  `json:"status"`
	NodeCode   string  `json:"node_code"`
	Condition  string  `json:"condition"`
	Guard      string  `json:"guard"`
	Position   float64 `json:"position"`
}

type CockpitImportMeeting struct {
	MeetDate  string `json:"meet_date"`
	TimeRange string `json:"time_range"`
	Title     string `json:"title"`
	Attendees string `json:"attendees"`
	MeetNo    string `json:"meet_no"`
	Link      string `json:"link"`
	Note      string `json:"note"`
}

type CockpitImportRequest struct {
	Title      string                   `json:"title"`
	GoalTitle  string                   `json:"goal_title"`
	GoalDate   string                   `json:"goal_date"`
	Basis      string                   `json:"basis"`
	Nodes      []CockpitImportNode      `json:"nodes"`
	Milestones []CockpitImportMilestone `json:"milestones"`
	Meetings   []CockpitImportMeeting   `json:"meetings"`
}

type CockpitImportResponse struct {
	Nodes      int `json:"nodes"`
	Payments   int `json:"payments"`
	IssueLinks int `json:"issue_links"`
	Milestones int `json:"milestones"`
	Meetings   int `json:"meetings"`
	// Issue identifiers named by the document that no issue in this workspace
	// answers to. Reported, not fatal.
	UnresolvedIssues []string `json:"unresolved_issues"`
}

func importDate(s string) (pgtype.Date, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.Date{}, nil
	}
	return util.ParseCalendarDate(s)
}

// ImportCockpit replaces the entire board in one transaction.
//
// Owner/admin only, and destructive by design: this is how a programme board
// authored elsewhere (a spreadsheet, the standalone HTML the feature replaces)
// becomes the live one. Partial application would leave a tree half-rewritten
// with dangling parents, so the whole document commits or none of it does.
func (h *Handler) ImportCockpit(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return
	}
	board, err := h.ensureCockpit(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ensureCockpit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	cc := cockpitContext{workspaceID: wsUUID, member: member, cockpit: board}

	var req CockpitImportRequest
	body := http.MaxBytesReader(w, r.Body, 32<<20)
	if err := json.NewDecoder(body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Nodes) > 5000 {
		writeError(w, http.StatusBadRequest, "at most 5000 nodes can be imported at once")
		return
	}

	// Resolve every issue reference BEFORE opening the transaction: issue
	// lookup is a read that does not belong inside a write lock, and an
	// unresolvable reference should not roll back a whole import.
	issueByRef := make(map[string]pgtype.UUID)
	var unresolved []string
	seenUnresolved := make(map[string]bool)
	for _, n := range req.Nodes {
		for _, ref := range n.IssueIDs {
			ref = strings.TrimSpace(ref)
			if ref == "" {
				continue
			}
			if _, done := issueByRef[ref]; done {
				continue
			}
			issue, found := h.resolveCockpitIssue(r.Context(), ref, workspaceID)
			if !found {
				if !seenUnresolved[ref] {
					seenUnresolved[ref] = true
					unresolved = append(unresolved, ref)
				}
				continue
			}
			issueByRef[ref] = issue.ID
		}
	}

	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start cockpit import transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	ctx := r.Context()

	goalDate, err := importDate(req.GoalDate)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid goal_date format, expected YYYY-MM-DD")
		return
	}
	if _, err := qtx.UpdateCockpit(ctx, db.UpdateCockpitParams{
		ID:            board.ID,
		WorkspaceID:   wsUUID,
		Title:         pgtype.Text{String: req.Title, Valid: true},
		GoalTitle:     pgtype.Text{String: req.GoalTitle, Valid: true},
		GoalDate:      goalDate,
		ClearGoalDate: !goalDate.Valid,
		Basis:         pgtype.Text{String: req.Basis, Valid: true},
	}); err != nil {
		slog.Warn("UpdateCockpit failed during import", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to import cockpit")
		return
	}

	// Replace order matters: children of the old tree carry payment and issue
	// rows that reference node ids about to disappear.
	for _, del := range []func() error{
		func() error {
			return qtx.DeleteCockpitPaymentsByCockpit(ctx, board.ID)
		},
		func() error {
			return qtx.DeleteCockpitNodeIssuesByCockpit(ctx, board.ID)
		},
		func() error { return qtx.DeleteCockpitNodes(ctx, board.ID) },
		func() error { return qtx.DeleteCockpitMilestones(ctx, board.ID) },
		func() error { return qtx.DeleteCockpitMeetings(ctx, board.ID) },
	} {
		if err := del(); err != nil {
			slog.Warn("cockpit import clear failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to import cockpit")
			return
		}
	}

	// Two passes over the nodes: create every row first, then wire parents.
	// One pass would require the document to be topologically sorted, which is
	// a constraint on the author for no gain.
	idByCode := make(map[string]pgtype.UUID, len(req.Nodes))
	paymentCount, linkCount := 0, 0
	for _, n := range req.Nodes {
		code := strings.TrimSpace(n.Code)
		if code == "" {
			writeError(w, http.StatusBadRequest, "every node needs a code")
			return
		}
		if _, dup := idByCode[code]; dup {
			writeError(w, http.StatusBadRequest, "duplicate node code: "+code)
			return
		}
		startDate, err := importDate(n.StartDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid start_date on node "+code)
			return
		}
		endDate, err := importDate(n.EndDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid end_date on node "+code)
			return
		}
		progress := n.Progress
		if progress < 0 || progress > 100 || math.IsNaN(progress) {
			writeError(w, http.StatusBadRequest, "progress on node "+code+" must be between 0 and 100")
			return
		}

		created, err := qtx.CreateCockpitNode(ctx, db.CreateCockpitNodeParams{
			WorkspaceID:     wsUUID,
			CockpitID:       board.ID,
			Code:            code,
			Name:            n.Name,
			Position:        n.Position,
			Color:           n.Color,
			Owner:           n.Owner,
			Collaborators:   n.Collaborators,
			StartDate:       startDate,
			EndDate:         endDate,
			Status:          n.Status,
			Progress:        progress,
			Deliverable:     n.Deliverable,
			Dependencies:    n.Dependencies,
			Note:            n.Note,
			CurrentProgress: n.CurrentProgress,
			Vendor:          n.Vendor,
			BudgetCategory:  n.BudgetCategory,
			BudgetAmount:    floatPtrToNumeric(n.BudgetAmount),
			ExecStatus:      n.ExecStatus,
			Contract:        n.Contract,
			Source:          n.Source,
			UpdatedByType:   "member",
			UpdatedByID:     member.UserID,
		})
		if err != nil {
			slog.Warn("cockpit import node failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to import cockpit")
			return
		}
		idByCode[code] = created.ID
	}

	for _, n := range req.Nodes {
		code := strings.TrimSpace(n.Code)
		nodeID := idByCode[code]

		if parentCode := strings.TrimSpace(n.ParentCode); parentCode != "" {
			parentID, found := idByCode[parentCode]
			if !found {
				writeError(w, http.StatusBadRequest, "node "+code+" names an unknown parent_code: "+parentCode)
				return
			}
			if parentID == nodeID {
				writeError(w, http.StatusBadRequest, "node "+code+" is its own parent")
				return
			}
			if _, err := qtx.UpdateCockpitNode(ctx, db.UpdateCockpitNodeParams{
				ID:            nodeID,
				WorkspaceID:   wsUUID,
				ParentID:      parentID,
				UpdatedByType: "member",
				UpdatedByID:   member.UserID,
			}); err != nil {
				slog.Warn("cockpit import parent failed", append(logger.RequestAttrs(r), "error", err)...)
				writeError(w, http.StatusInternalServerError, "failed to import cockpit")
				return
			}
		}

		for i, p := range n.Payments {
			payDate, err := importDate(p.PayDate)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid payment pay_date on node "+code)
				return
			}
			if _, err := qtx.CreateCockpitPayment(ctx, db.CreateCockpitPaymentParams{
				WorkspaceID: wsUUID,
				NodeID:      nodeID,
				Label:       p.Label,
				PayDate:     payDate,
				Amount:      floatToNumeric(p.Amount),
				Position:    float64(i),
			}); err != nil {
				slog.Warn("cockpit import payment failed", append(logger.RequestAttrs(r), "error", err)...)
				writeError(w, http.StatusInternalServerError, "failed to import cockpit")
				return
			}
			paymentCount++
		}

		position := 0
		for _, ref := range n.IssueIDs {
			issueID, found := issueByRef[strings.TrimSpace(ref)]
			if !found {
				continue
			}
			if _, err := qtx.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{
				WorkspaceID: wsUUID,
				NodeID:      nodeID,
				IssueID:     issueID,
				Position:    float64(position),
			}); err != nil {
				slog.Warn("cockpit import issue link failed", append(logger.RequestAttrs(r), "error", err)...)
				writeError(w, http.StatusInternalServerError, "failed to import cockpit")
				return
			}
			position++
			linkCount++
		}
	}

	for i, m := range req.Milestones {
		planDate, err := importDate(m.PlanDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid milestone plan_date: "+m.Name)
			return
		}
		actualDate, err := importDate(m.ActualDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid milestone actual_date: "+m.Name)
			return
		}
		var nodeID pgtype.UUID
		if code := strings.TrimSpace(m.NodeCode); code != "" {
			id, found := idByCode[code]
			if !found {
				writeError(w, http.StatusBadRequest, "milestone names an unknown node_code: "+code)
				return
			}
			nodeID = id
		}
		position := m.Position
		if position == 0 {
			position = float64(i)
		}
		if _, err := qtx.CreateCockpitMilestone(ctx, db.CreateCockpitMilestoneParams{
			WorkspaceID: wsUUID,
			CockpitID:   board.ID,
			Name:        m.Name,
			PlanDate:    planDate,
			ActualDate:  actualDate,
			Status:      m.Status,
			NodeID:      nodeID,
			Condition:   m.Condition,
			Guard:       m.Guard,
			Position:    position,
		}); err != nil {
			slog.Warn("cockpit import milestone failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to import cockpit")
			return
		}
	}

	for _, m := range req.Meetings {
		meetDate, err := importDate(m.MeetDate)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid meeting meet_date: "+m.Title)
			return
		}
		if _, err := qtx.CreateCockpitMeeting(ctx, db.CreateCockpitMeetingParams{
			WorkspaceID: wsUUID,
			CockpitID:   board.ID,
			MeetDate:    meetDate,
			TimeRange:   m.TimeRange,
			Title:       m.Title,
			Attendees:   m.Attendees,
			MeetNo:      m.MeetNo,
			Link:        m.Link,
			Note:        m.Note,
		}); err != nil {
			slog.Warn("cockpit import meeting failed", append(logger.RequestAttrs(r), "error", err)...)
			writeError(w, http.StatusInternalServerError, "failed to import cockpit")
			return
		}
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Warn("cockpit import commit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to import cockpit")
		return
	}

	resp := CockpitImportResponse{
		Nodes:            len(req.Nodes),
		Payments:         paymentCount,
		IssueLinks:       linkCount,
		Milestones:       len(req.Milestones),
		Meetings:         len(req.Meetings),
		UnresolvedIssues: unresolved,
	}
	if resp.UnresolvedIssues == nil {
		resp.UnresolvedIssues = []string{}
	}

	// One board-wide event: an import moved everything, so clients re-read
	// rather than trying to patch a few hundred rows out of a payload.
	h.publishCockpit(cc, "board", "imported", map[string]any{"nodes": resp.Nodes})
	writeJSON(w, http.StatusOK, resp)
}
