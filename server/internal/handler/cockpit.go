package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"strings"
	"time"

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
	// Where a new meeting's task and folder go. Chosen once per board and
	// echoed here so the create-meeting form can show the destination before
	// anything is created. Null until someone picks one.
	MeetingProjectID *string `json:"meeting_project_id"`
	MeetingModuleID  *string `json:"meeting_module_id"`
	// The sub-item under the module that meeting material is archived in —
	// a node on this board's tree ("06.06.03 会议纪要与素材"). Its code opens
	// the meeting task's title and its folder holds the material.
	MeetingNodeID *string `json:"meeting_node_id"`
	MeetingDir    string  `json:"meeting_dir"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
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
	ID       string  `json:"id"`
	MeetDate *string `json:"meet_date"`
	// The span as free text, kept from the log this register grew out of. New
	// writes set start_time/end_time instead; a row that only ever carried
	// text still reads out of here.
	TimeRange string `json:"time_range"`
	// "HH:MM", or null for a meeting nobody has timed.
	StartTime *string `json:"start_time"`
	EndTime   *string `json:"end_time"`
	Title     string  `json:"title"`
	// The platform's own number for the meeting ("20260921-01"): the date and
	// that day's sequence. MeetNo is the conferencing system's dial-in number.
	Code      string `json:"code"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Parties   string `json:"parties"`
	Organizer string `json:"organizer"`
	Location  string `json:"location"`
	Attendees string `json:"attendees"`
	MeetNo    string `json:"meet_no"`
	Link      string `json:"link"`
	Note      string `json:"note"`
	Minutes   string `json:"minutes"`
	Decisions string `json:"decisions"`
	Actions   string `json:"actions"`
	NasDir    string `json:"nas_dir"`
	// True when the row was read off the share rather than typed: its date,
	// number, parties and subject are guesses from a folder name and want
	// checking. Cleared by whoever checks them.
	Detected bool `json:"detected"`
}

// CockpitMeetingIssueResponse is one issue a meeting is carried out through.
// The pair (meeting_id, issue_id) is the row's identity — there is no
// surrogate key — so a client keys on both.
type CockpitMeetingIssueResponse struct {
	MeetingID string `json:"meeting_id"`
	IssueID   string `json:"issue_id"`
	// "task" for the issue the platform opened with the meeting, "" for a
	// link someone made by hand.
	Role            string  `json:"role"`
	IssueNumber     int32   `json:"issue_number"`
	IssueIdentifier string  `json:"issue_identifier"`
	IssueTitle      string  `json:"issue_title"`
	IssueStatus     string  `json:"issue_status"`
	Position        float64 `json:"position"`
}

// CockpitMeetingNodeResponse is one work-breakdown item a meeting was about.
type CockpitMeetingNodeResponse struct {
	MeetingID string  `json:"meeting_id"`
	NodeID    string  `json:"node_id"`
	Position  float64 `json:"position"`
}

// CockpitBoardResponse is the single read every view starts from.
type CockpitBoardResponse struct {
	Cockpit    CockpitResponse            `json:"cockpit"`
	Nodes      []CockpitNodeResponse      `json:"nodes"`
	Payments   []CockpitPaymentResponse   `json:"payments"`
	IssueLinks []CockpitNodeIssueResponse `json:"issue_links"`
	Milestones []CockpitMilestoneResponse `json:"milestones"`
	Meetings   []CockpitMeetingResponse   `json:"meetings"`
	// What each meeting is attached to. Flat lists rather than nested inside
	// the meeting, matching issue_links: the client groups them once and the
	// realtime frame can replace one meeting's set without resending a
	// meeting row.
	MeetingIssues []CockpitMeetingIssueResponse `json:"meeting_issues"`
	MeetingNodes  []CockpitMeetingNodeResponse  `json:"meeting_nodes"`
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
		ID:               uuidToString(c.ID),
		WorkspaceID:      uuidToString(c.WorkspaceID),
		Title:            c.Title,
		GoalTitle:        c.GoalTitle,
		GoalDate:         dateToPtr(c.GoalDate),
		SummaryOverall:   c.SummaryOverall,
		SummaryNext:      c.SummaryNext,
		SummarySupport:   c.SummarySupport,
		Basis:            c.Basis,
		MeetingProjectID: uuidToPtr(c.MeetingProjectID),
		MeetingModuleID:  uuidToPtr(c.MeetingModuleID),
		MeetingNodeID:    uuidToPtr(c.MeetingNodeID),
		MeetingDir:       c.MeetingDir,
		CreatedAt:        timestampToString(c.CreatedAt),
		UpdatedAt:        timestampToString(c.UpdatedAt),
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
		StartTime: clockToPtr(m.StartTime),
		EndTime:   clockToPtr(m.EndTime),
		Title:     m.Title,
		Code:      m.Code,
		Kind:      m.Kind,
		Status:    m.Status,
		Parties:   m.Parties,
		Organizer: m.Organizer,
		Location:  m.Location,
		Attendees: m.Attendees,
		MeetNo:    m.MeetNo,
		Link:      m.Link,
		Note:      m.Note,
		Minutes:   m.Minutes,
		Decisions: m.Decisions,
		Actions:   m.Actions,
		NasDir:    m.NasDir,
		Detected:  m.Detected,
	}
}

func cockpitMeetingIssueToResponse(l db.ListCockpitMeetingIssuesRow, prefix string) CockpitMeetingIssueResponse {
	return CockpitMeetingIssueResponse{
		MeetingID:       uuidToString(l.MeetingID),
		IssueID:         uuidToString(l.IssueID),
		Role:            l.Role,
		IssueNumber:     l.IssueNumber,
		IssueIdentifier: fmt.Sprintf("%s-%d", prefix, l.IssueNumber),
		IssueTitle:      l.IssueTitle,
		IssueStatus:     l.IssueStatus,
		Position:        l.Position,
	}
}

func cockpitMeetingNodeToResponse(l db.ListCockpitMeetingNodesRow) CockpitMeetingNodeResponse {
	return CockpitMeetingNodeResponse{
		MeetingID: uuidToString(l.MeetingID),
		NodeID:    uuidToString(l.NodeID),
		Position:  l.Position,
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
func (h *Handler) publishCockpit(r *http.Request, cc cockpitContext, scope, action string, entity any) {
	h.publish(protocol.EventCockpitChanged, uuidToString(cc.workspaceID), "member", uuidToString(cc.member.UserID), map[string]any{
		"scope":  scope,
		"action": action,
		"entity": entity,
	})
	// Every board mutation funnels through here, which makes it the single
	// place to give small edits their throttled checkpoint. The "snapshots"
	// scope guard keeps the checkpoint's own publish from recursing.
	if scope != "snapshots" {
		h.autoSnapshotCockpitAfterEdit(r, cc)
	}
}

// autoSnapshotCockpitAfterEdit is the small-edit safety net. Snapshots are
// milestone checkpoints, and one per edit would bury them, so an ordinary
// edit refreshes history instead of creating it: it freezes at most one
// 'auto' version per cockpitAutoSnapshotInterval, only when the board content
// actually moved, and never on a board with no version history at all (the
// first entry stays deliberate — an import or a manual save; a one-node
// scratch board's first edit is not history). Imports and restores that
// displace a non-empty board have just written their own pre-snapshot inside
// their transaction, so the interval check skips them. Failures are logged
// and swallowed: a background checkpoint must never fail the edit it
// follows.
func (h *Handler) autoSnapshotCockpitAfterEdit(r *http.Request, cc cockpitContext) {
	ctx := r.Context()
	latest, latestErr := h.Queries.GetLatestCockpitSnapshot(ctx, cc.cockpit.ID)
	if latestErr != nil {
		// No history yet: an automatic checkpoint would be the noise the
		// deliberate-first-entry rule exists to avoid.
		return
	}
	if time.Since(latest.CreatedAt.Time) < cockpitAutoSnapshotInterval {
		return
	}
	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, h.Queries, cc)
	if err != nil {
		slog.Warn("cockpit auto snapshot read failed", append(logger.RequestAttrs(r), "error", err)...)
		return
	}
	if !hasContent {
		return
	}
	payload, err := json.Marshal(doc)
	if err != nil {
		return
	}
	// Content dedupe: a no-op edit must not mint a version identical to the
	// newest one. The stored payload is re-marshalled through the same
	// struct, so JSONB's key reordering cannot fake a difference.
	if sameCockpitPayload(latest.Payload, payload) {
		return
	}
	actorType, actorLabel := h.cockpitActor(r, cc)
	if _, err := h.Queries.CreateCockpitSnapshot(ctx, db.CreateCockpitSnapshotParams{
		WorkspaceID:    cc.workspaceID,
		CockpitID:      cc.cockpit.ID,
		TriggerKind:    "auto",
		Payload:        payload,
		NodeCount:      int32(len(doc.Nodes)),
		CreatedByType:  actorType,
		CreatedByLabel: actorLabel,
	}); err != nil {
		slog.Warn("CreateCockpitSnapshot(auto) failed", append(logger.RequestAttrs(r), "error", err)...)
		return
	}
	if _, err := h.Queries.PruneCockpitSnapshots(ctx, db.PruneCockpitSnapshotsParams{
		CockpitID: cc.cockpit.ID,
		Keep:      cockpitSnapshotKeep,
	}); err != nil {
		slog.Warn("PruneCockpitSnapshots failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	h.publishCockpit(r, cc, "snapshots", "created", nil)
}

// sameCockpitPayload answers whether a stored payload and a freshly
// marshalled document describe the same board.
func sameCockpitPayload(stored, fresh []byte) bool {
	if len(stored) == 0 {
		return false
	}
	var doc CockpitImportRequest
	if err := json.Unmarshal(stored, &doc); err != nil {
		return false
	}
	normalized, err := json.Marshal(doc)
	if err != nil {
		return false
	}
	return bytes.Equal(normalized, fresh)
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

// clockToPtr renders a stored wall-clock time as "HH:MM". Seconds are dropped
// deliberately: a meeting is scheduled to the minute, and rendering ":00" on
// every row is noise the reader has to skip.
func clockToPtr(t pgtype.Time) *string {
	if !t.Valid {
		return nil
	}
	total := t.Microseconds / 1_000_000
	s := fmt.Sprintf("%02d:%02d", total/3600, (total%3600)/60)
	return &s
}

// cockpitClock reads one optional "HH:MM" field out of a partial update, with
// the same three states as cockpitDate: absent leaves it, empty clears it, set
// writes it. A meeting whose time is withdrawn goes back to the all-day lane,
// which is an edit rather than the absence of one.
func cockpitClock(w http.ResponseWriter, raw map[string]json.RawMessage, key string, value *string) (pgtype.Time, bool, bool) {
	if _, touched := raw[key]; !touched {
		return pgtype.Time{}, false, true
	}
	if value == nil || strings.TrimSpace(*value) == "" {
		return pgtype.Time{}, true, true
	}
	parsed, err := time.Parse("15:04", strings.TrimSpace(*value))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid "+key+" format, expected HH:MM")
		return pgtype.Time{}, false, false
	}
	micros := int64(parsed.Hour())*3600_000_000 + int64(parsed.Minute())*60_000_000
	return pgtype.Time{Microseconds: micros, Valid: true}, false, true
}

func optionalText(v *string) pgtype.Text {
	if v == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *v, Valid: true}
}

func optionalBool(v *bool) pgtype.Bool {
	if v == nil {
		return pgtype.Bool{}
	}
	return pgtype.Bool{Bool: *v, Valid: true}
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
	meetingIssues, err := h.Queries.ListCockpitMeetingIssues(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetingIssues failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	meetingNodes, err := h.Queries.ListCockpitMeetingNodes(ctx, cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitMeetingNodes failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}

	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	resp := CockpitBoardResponse{
		Cockpit:       cockpitToResponse(cc.cockpit),
		Nodes:         make([]CockpitNodeResponse, len(nodes)),
		Payments:      make([]CockpitPaymentResponse, len(payments)),
		IssueLinks:    make([]CockpitNodeIssueResponse, len(links)),
		Milestones:    make([]CockpitMilestoneResponse, len(milestones)),
		Meetings:      make([]CockpitMeetingResponse, len(meetings)),
		MeetingIssues: make([]CockpitMeetingIssueResponse, len(meetingIssues)),
		MeetingNodes:  make([]CockpitMeetingNodeResponse, len(meetingNodes)),
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
	for i, l := range meetingIssues {
		resp.MeetingIssues[i] = cockpitMeetingIssueToResponse(l, prefix)
	}
	for i, l := range meetingNodes {
		resp.MeetingNodes[i] = cockpitMeetingNodeToResponse(l)
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
	// Where new meetings file their task and their folder. Sent as an empty
	// string to clear, like every other optional field on this endpoint.
	MeetingProjectID *string `json:"meeting_project_id"`
	MeetingModuleID  *string `json:"meeting_module_id"`
	MeetingNodeID    *string `json:"meeting_node_id"`
	MeetingDir       *string `json:"meeting_dir"`
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

	// The meeting destination is validated before it is stored: a project or
	// module id that names nothing, or a module belonging to another project,
	// would only fail later at the moment someone files a meeting — with a
	// board setting they cannot see as the cause.
	project, module, node, ok := h.resolveMeetingDestination(
		w, r, cc, raw, req.MeetingProjectID, req.MeetingModuleID, req.MeetingNodeID)
	if !ok {
		return
	}
	dir := req.MeetingDir
	if dir != nil {
		normalized, err := normalizeCollabPath(*dir)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		blank := ""
		if normalized.Valid {
			dir = &normalized.String
		} else {
			dir = &blank
		}
	}

	board, err := h.Queries.UpdateCockpit(r.Context(), db.UpdateCockpitParams{
		ID:                  cc.cockpit.ID,
		WorkspaceID:         cc.workspaceID,
		Title:               optionalText(req.Title),
		GoalTitle:           optionalText(req.GoalTitle),
		GoalDate:            goalDate,
		ClearGoalDate:       clearGoalDate,
		SummaryOverall:      optionalText(req.SummaryOverall),
		SummaryNext:         optionalText(req.SummaryNext),
		SummarySupport:      optionalText(req.SummarySupport),
		Basis:               optionalText(req.Basis),
		MeetingProjectID:    project.id,
		ClearMeetingProject: project.clear,
		MeetingModuleID:     module.id,
		ClearMeetingModule:  module.clear,
		MeetingNodeID:       node.id,
		ClearMeetingNode:    node.clear,
		MeetingDir:          optionalText(dir),
	})
	if err != nil {
		slog.Warn("UpdateCockpit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update cockpit")
		return
	}

	resp := cockpitToResponse(board)
	h.publishCockpit(r, cc, "cockpit", "updated", resp)
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
	h.publishCockpit(r, cc, "node", "created", resp)
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
	h.publishCockpit(r, cc, "node", "updated", resp)
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
	if err := h.Queries.DeleteCockpitMeetingNodesByNode(ctx, db.DeleteCockpitMeetingNodesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNodesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete cockpit node")
		return
	}
	if err := h.Queries.DeleteCockpitChangesByNode(ctx, db.DeleteCockpitChangesByNodeParams{
		NodeID:      node.ID,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitChangesByNode failed", append(logger.RequestAttrs(r), "error", err)...)
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

	h.publishCockpit(r, cc, "node", "deleted", map[string]any{"id": uuidToString(node.ID)})
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
	h.publishCockpit(r, cc, "issue_links", "replaced", payload)
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

	h.publishCockpit(r, cc, "issue_links", "removed", map[string]any{
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

type CockpitMeetingRequest struct {
	MeetDate  *string `json:"meet_date"`
	TimeRange *string `json:"time_range"`
	StartTime *string `json:"start_time"`
	EndTime   *string `json:"end_time"`
	Title     *string `json:"title"`
	Code      *string `json:"code"`
	Kind      *string `json:"kind"`
	Status    *string `json:"status"`
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
	// The meeting's folder on the shared NAS. Set by provisioning rather than
	// typed, but writable so a folder that already existed can be adopted.
	NasDir *string `json:"nas_dir"`
	// Sent as false by whoever has checked a row the scan guessed at. Only
	// the scan sets it to true.
	Detected *bool `json:"detected"`
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

	meeting, err := h.Queries.CreateCockpitMeeting(r.Context(), db.CreateCockpitMeetingParams{
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
	})
	if err != nil {
		slog.Warn("CreateCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to create meeting")
		return
	}

	resp := cockpitMeetingToResponse(meeting)
	h.publishCockpit(r, cc, "meeting", "created", resp)
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
	if req.NasDir != nil {
		if _, ok := h.meetingDirOrError(w, cc, req.NasDir); !ok {
			return
		}
	}

	meeting, err := h.Queries.UpdateCockpitMeeting(r.Context(), db.UpdateCockpitMeetingParams{
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
		NasDir:         optionalText(req.NasDir),
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
	// links go first, in the same request, so a re-used UUID can never adopt
	// another meeting's attachments.
	ctx := r.Context()
	if err := h.Queries.DeleteCockpitMeetingIssuesByMeeting(ctx, db.DeleteCockpitMeetingIssuesByMeetingParams{
		MeetingID:   id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingIssuesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	if err := h.Queries.DeleteCockpitMeetingNodesByMeeting(ctx, db.DeleteCockpitMeetingNodesByMeetingParams{
		MeetingID:   id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeetingNodesByMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to delete meeting")
		return
	}
	if err := h.Queries.DeleteCockpitMeeting(ctx, db.DeleteCockpitMeetingParams{
		ID:          id,
		WorkspaceID: cc.workspaceID,
	}); err != nil {
		slog.Warn("DeleteCockpitMeeting failed", append(logger.RequestAttrs(r), "error", err)...)
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
	StartTime string `json:"start_time"`
	EndTime   string `json:"end_time"`
	Title     string `json:"title"`
	Code      string `json:"code"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Parties   string `json:"parties"`
	Organizer string `json:"organizer"`
	Location  string `json:"location"`
	Attendees string `json:"attendees"`
	MeetNo    string `json:"meet_no"`
	Link      string `json:"link"`
	Note      string `json:"note"`
	Minutes   string `json:"minutes"`
	Decisions string `json:"decisions"`
	Actions   string `json:"actions"`
	NasDir    string `json:"nas_dir"`
	// Whether the row was read off the share rather than typed, and still
	// unchecked. A restore that dropped it would present guesses as facts.
	Detected bool `json:"detected"`
	// What the meeting was attached to, named the way the document names
	// everything else: issues by identifier, work items by code. Unresolvable
	// issue references are reported alongside the node ones rather than
	// failing the import.
	IssueIDs  []string `json:"issue_ids"`
	NodeCodes []string `json:"node_codes"`
	// Which of IssueIDs is the task the platform opened WITH the meeting.
	// Carried separately because the role is what tells "the meeting's own
	// task" from "an issue someone attached", and a restore that forgot it
	// would quietly demote the task to an ordinary link.
	TaskIssueID string `json:"task_issue_id"`
}

type CockpitImportRequest struct {
	Title      string                   `json:"title"`
	GoalTitle  string                   `json:"goal_title"`
	GoalDate   string                   `json:"goal_date"`
	Basis      string                   `json:"basis"`
	Nodes      []CockpitImportNode      `json:"nodes"`
	Milestones []CockpitImportMilestone `json:"milestones"`
	Meetings   []CockpitImportMeeting   `json:"meetings"`
	// The three summary cards. Pointers because absent and empty differ here:
	// an authored plan has no card text and its import must leave whatever the
	// board already says, while a snapshot always carries the values it froze
	// so a restore puts the board back exactly.
	SummaryOverall *string `json:"summary_overall"`
	SummaryNext    *string `json:"summary_next"`
	SummarySupport *string `json:"summary_support"`
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

// cockpitImportError carries the status a failed import answers with, now that
// the import body serves both the HTTP endpoint and snapshot restore.
type cockpitImportError struct {
	status int
	msg    string
}

func (e *cockpitImportError) Error() string { return e.msg }

// cockpitSnapshotKeep bounds how many snapshots a board retains. Imports and
// restores snapshot automatically, so without a bound a scripted import loop
// would grow the table without end.
const cockpitSnapshotKeep = 50

// cockpitAutoSnapshotInterval bounds how often ordinary board edits freeze an
// 'auto' version: dense editing sessions get at most one checkpoint per
// interval, so milestone snapshots (imports, restores, manual saves) are not
// evicted from the keep window by field-level churn.
const cockpitAutoSnapshotInterval = 5 * time.Minute

func importClock(s string) (pgtype.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.Time{}, nil
	}
	parsed, err := time.Parse("15:04", s)
	if err != nil {
		return pgtype.Time{}, err
	}
	micros := int64(parsed.Hour())*3600_000_000 + int64(parsed.Minute())*60_000_000
	return pgtype.Time{Microseconds: micros, Valid: true}, nil
}

func importDate(s string) (pgtype.Date, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.Date{}, nil
	}
	return util.ParseCalendarDate(s)
}

func strPtrToText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *s, Valid: true}
}

// ImportCockpit replaces the entire board in one transaction.
//
// Owner/admin only, and destructive by design: this is how a programme board
// authored elsewhere (a spreadsheet, the standalone HTML the feature replaces)
// becomes the live one. Partial application would leave a tree half-rewritten
// with dangling parents, so the whole document commits or none of it does.
// The board it displaces is frozen into a version snapshot first, so a bad
// import is undoable from the product rather than from a database backup.
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

	resp, impErr := h.runCockpitImport(r, cc, req, "import")
	if impErr != nil {
		writeError(w, impErr.status, impErr.msg)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// runCockpitImport replaces the board with `req` atomically. When `trigger` is
// non-empty it names the operation for the automatic snapshot taken of the
// outgoing board ("import", "restore") — the caller has already decided this
// run is allowed to destroy the board. Empty trigger skips the snapshot: it is
// used by paths that have already frozen the board themselves.
func (h *Handler) runCockpitImport(r *http.Request, cc cockpitContext, req CockpitImportRequest, trigger string) (CockpitImportResponse, *cockpitImportError) {
	ctx := r.Context()
	board := cc.cockpit

	// Resolve every issue reference BEFORE opening the transaction: issue
	// lookup is a read that does not belong inside a write lock, and an
	// unresolvable reference should not roll back a whole import.
	issueByRef := make(map[string]pgtype.UUID)
	var unresolved []string
	seenUnresolved := make(map[string]bool)
	resolveRefs := func(refs []string) {
		for _, ref := range refs {
			ref = strings.TrimSpace(ref)
			if ref == "" {
				continue
			}
			if _, done := issueByRef[ref]; done {
				continue
			}
			issue, found := h.resolveCockpitIssue(ctx, ref, uuidToString(cc.workspaceID))
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
	for _, n := range req.Nodes {
		resolveRefs(n.IssueIDs)
	}
	for _, m := range req.Meetings {
		resolveRefs(m.IssueIDs)
	}

	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to start cockpit import transaction"}
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	if trigger != "" {
		if err := h.snapshotCockpitBoard(ctx, qtx, r, cc, trigger, ""); err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, err.msg}
		}
	}

	goalDate, err := importDate(req.GoalDate)
	if err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid goal_date format, expected YYYY-MM-DD"}
	}
	if _, err := qtx.UpdateCockpit(ctx, db.UpdateCockpitParams{
		ID:             board.ID,
		WorkspaceID:    cc.workspaceID,
		Title:          pgtype.Text{String: req.Title, Valid: true},
		GoalTitle:      pgtype.Text{String: req.GoalTitle, Valid: true},
		GoalDate:       goalDate,
		ClearGoalDate:  !goalDate.Valid,
		SummaryOverall: strPtrToText(req.SummaryOverall),
		SummaryNext:    strPtrToText(req.SummaryNext),
		SummarySupport: strPtrToText(req.SummarySupport),
		Basis:          pgtype.Text{String: req.Basis, Valid: true},
	}); err != nil {
		slog.Warn("UpdateCockpit failed during import", append(logger.RequestAttrs(r), "error", err)...)
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
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
		func() error {
			return qtx.DeleteCockpitMeetingIssuesByCockpit(ctx, board.ID)
		},
		func() error {
			return qtx.DeleteCockpitMeetingNodesByCockpit(ctx, board.ID)
		},
		// Pending changes and their history name node ids that are about to
		// stop existing; the review queue restarts empty with the new board.
		func() error { return qtx.DeleteCockpitChangesByCockpit(ctx, board.ID) },
		func() error { return qtx.DeleteCockpitNodes(ctx, board.ID) },
		func() error { return qtx.DeleteCockpitMilestones(ctx, board.ID) },
		func() error { return qtx.DeleteCockpitMeetings(ctx, board.ID) },
	} {
		if err := del(); err != nil {
			slog.Warn("cockpit import clear failed", append(logger.RequestAttrs(r), "error", err)...)
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
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
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "every node needs a code"}
		}
		if _, dup := idByCode[code]; dup {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "duplicate node code: " + code}
		}
		startDate, err := importDate(n.StartDate)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid start_date on node " + code}
		}
		endDate, err := importDate(n.EndDate)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid end_date on node " + code}
		}
		progress := n.Progress
		if progress < 0 || progress > 100 || math.IsNaN(progress) {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "progress on node " + code + " must be between 0 and 100"}
		}

		created, err := qtx.CreateCockpitNode(ctx, db.CreateCockpitNodeParams{
			WorkspaceID:     cc.workspaceID,
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
			UpdatedByID:     cc.member.UserID,
		})
		if err != nil {
			slog.Warn("cockpit import node failed", append(logger.RequestAttrs(r), "error", err)...)
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
		}
		idByCode[code] = created.ID
	}

	for _, n := range req.Nodes {
		code := strings.TrimSpace(n.Code)
		nodeID := idByCode[code]

		if parentCode := strings.TrimSpace(n.ParentCode); parentCode != "" {
			parentID, found := idByCode[parentCode]
			if !found {
				return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "node " + code + " names an unknown parent_code: " + parentCode}
			}
			if parentID == nodeID {
				return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "node " + code + " is its own parent"}
			}
			if _, err := qtx.UpdateCockpitNode(ctx, db.UpdateCockpitNodeParams{
				ID:            nodeID,
				WorkspaceID:   cc.workspaceID,
				ParentID:      parentID,
				UpdatedByType: "member",
				UpdatedByID:   cc.member.UserID,
			}); err != nil {
				slog.Warn("cockpit import parent failed", append(logger.RequestAttrs(r), "error", err)...)
				return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
			}
		}

		for i, p := range n.Payments {
			payDate, err := importDate(p.PayDate)
			if err != nil {
				return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid payment pay_date on node " + code}
			}
			if _, err := qtx.CreateCockpitPayment(ctx, db.CreateCockpitPaymentParams{
				WorkspaceID: cc.workspaceID,
				NodeID:      nodeID,
				Label:       p.Label,
				PayDate:     payDate,
				Amount:      floatToNumeric(p.Amount),
				Position:    float64(i),
			}); err != nil {
				slog.Warn("cockpit import payment failed", append(logger.RequestAttrs(r), "error", err)...)
				return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
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
				WorkspaceID: cc.workspaceID,
				NodeID:      nodeID,
				IssueID:     issueID,
				Position:    float64(position),
			}); err != nil {
				slog.Warn("cockpit import issue link failed", append(logger.RequestAttrs(r), "error", err)...)
				return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
			}
			position++
			linkCount++
		}
	}

	for i, m := range req.Milestones {
		planDate, err := importDate(m.PlanDate)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid milestone plan_date: " + m.Name}
		}
		actualDate, err := importDate(m.ActualDate)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid milestone actual_date: " + m.Name}
		}
		var nodeID pgtype.UUID
		if code := strings.TrimSpace(m.NodeCode); code != "" {
			id, found := idByCode[code]
			if !found {
				return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "milestone names an unknown node_code: " + code}
			}
			nodeID = id
		}
		position := m.Position
		if position == 0 {
			position = float64(i)
		}
		if _, err := qtx.CreateCockpitMilestone(ctx, db.CreateCockpitMilestoneParams{
			WorkspaceID: cc.workspaceID,
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
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
		}
	}

	for _, m := range req.Meetings {
		meetDate, err := importDate(m.MeetDate)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid meeting meet_date: " + m.Title}
		}
		startTime, err := importClock(m.StartTime)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid meeting start_time: " + m.Title}
		}
		endTime, err := importClock(m.EndTime)
		if err != nil {
			return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, "invalid meeting end_time: " + m.Title}
		}
		meeting, err := qtx.CreateCockpitMeeting(ctx, db.CreateCockpitMeetingParams{
			WorkspaceID: cc.workspaceID,
			CockpitID:   board.ID,
			MeetDate:    meetDate,
			TimeRange:   m.TimeRange,
			StartTime:   startTime,
			EndTime:     endTime,
			Title:       m.Title,
			Code:        m.Code,
			Kind:        m.Kind,
			Status:      m.Status,
			Parties:     m.Parties,
			Organizer:   m.Organizer,
			Location:    m.Location,
			Attendees:   m.Attendees,
			MeetNo:      m.MeetNo,
			Link:        m.Link,
			Note:        m.Note,
			Minutes:     m.Minutes,
			Decisions:   m.Decisions,
			Actions:     m.Actions,
			NasDir:      m.NasDir,
			Detected:    m.Detected,
		})
		if err != nil {
			slog.Warn("cockpit import meeting failed", append(logger.RequestAttrs(r), "error", err)...)
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
		}
		taskRef := strings.TrimSpace(m.TaskIssueID)
		position := 0
		for _, ref := range m.IssueIDs {
			ref = strings.TrimSpace(ref)
			issueID, found := issueByRef[ref]
			if !found {
				continue
			}
			// The meeting's own task keeps its role and its lead position, the
			// same two things openMeetingTask wrote when it opened it.
			role, at := "", float64(position)
			if taskRef != "" && ref == taskRef {
				role, at = "task", -1
			}
			if _, err := qtx.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
				WorkspaceID: cc.workspaceID,
				MeetingID:   meeting.ID,
				IssueID:     issueID,
				Role:        role,
				Position:    at,
			}); err != nil {
				slog.Warn("cockpit import meeting issue failed", append(logger.RequestAttrs(r), "error", err)...)
				return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
			}
			position++
		}
		position = 0
		for _, code := range m.NodeCodes {
			nodeID, found := idByCode[strings.TrimSpace(code)]
			if !found {
				continue
			}
			if _, err := qtx.CreateCockpitMeetingNode(ctx, db.CreateCockpitMeetingNodeParams{
				WorkspaceID: cc.workspaceID,
				MeetingID:   meeting.ID,
				NodeID:      nodeID,
				Position:    float64(position),
			}); err != nil {
				slog.Warn("cockpit import meeting node failed", append(logger.RequestAttrs(r), "error", err)...)
				return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
			}
			position++
		}
	}

	if err := tx.Commit(ctx); err != nil {
		slog.Warn("cockpit import commit failed", append(logger.RequestAttrs(r), "error", err)...)
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
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

	// One board-wide event: the import moved everything, so clients re-read
	// rather than trying to patch a few hundred rows out of a payload.
	action := "imported"
	if trigger == "restore" {
		action = "restored"
	}
	h.publishCockpit(r, cc, "board", action, map[string]any{"nodes": resp.Nodes})
	h.publishCockpit(r, cc, "snapshots", action, nil)
	return resp, nil
}

// ---------------------------------------------------------------------------
// Version snapshots
// ---------------------------------------------------------------------------

type CockpitSnapshotResponse struct {
	ID             string `json:"id"`
	TriggerKind    string `json:"trigger_kind"`
	Label          string `json:"label"`
	NodeCount      int    `json:"node_count"`
	CreatedByType  string `json:"created_by_type"`
	CreatedByLabel string `json:"created_by_label"`
	CreatedAt      string `json:"created_at"`
}

// cockpitActor resolves who is acting — a member, or the agent whose task
// token the CLI presented — with the display name frozen at write time so the
// version list stays readable after the actor leaves.
func (h *Handler) cockpitActor(r *http.Request, cc cockpitContext) (actorType, label string) {
	actorType, actorID := h.resolveActor(r, uuidToString(cc.member.UserID), uuidToString(cc.workspaceID))
	id, err := util.ParseUUID(actorID)
	if err != nil {
		return actorType, ""
	}
	if actorType == "agent" {
		if agent, err := h.Queries.GetAgent(r.Context(), id); err == nil {
			return actorType, agent.Name
		}
		return actorType, ""
	}
	if user, err := h.Queries.GetUser(r.Context(), id); err == nil {
		return actorType, user.Name
	}
	return actorType, ""
}

// snapshotCockpitBoard freezes the board as it stands on `q` into a version
// snapshot, then prunes. Called from inside the caller transaction: a snapshot
// of a board the accompanying write then rejected is noise, and committing
// them together means the undo record can never lag the change it undoes.
func (h *Handler) snapshotCockpitBoard(ctx context.Context, qtx *db.Queries, r *http.Request, cc cockpitContext, trigger, label string) *cockpitImportError {
	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, qtx, cc)
	if err != nil {
		slog.Warn("cockpit snapshot read failed", append(logger.RequestAttrs(r), "error", err)...)
		return &cockpitImportError{http.StatusInternalServerError, "failed to freeze cockpit snapshot"}
	}
	if !hasContent {
		return nil
	}
	payload, err := json.Marshal(doc)
	if err != nil {
		return &cockpitImportError{http.StatusInternalServerError, "failed to freeze cockpit snapshot"}
	}
	actorType, actorLabel := h.cockpitActor(r, cc)
	if _, err := qtx.CreateCockpitSnapshot(ctx, db.CreateCockpitSnapshotParams{
		WorkspaceID:    cc.workspaceID,
		CockpitID:      cc.cockpit.ID,
		TriggerKind:    trigger,
		Label:          label,
		Payload:        payload,
		NodeCount:      int32(len(doc.Nodes)),
		CreatedByType:  actorType,
		CreatedByLabel: actorLabel,
	}); err != nil {
		slog.Warn("CreateCockpitSnapshot failed", append(logger.RequestAttrs(r), "error", err)...)
		return &cockpitImportError{http.StatusInternalServerError, "failed to freeze cockpit snapshot"}
	}
	if _, err := qtx.PruneCockpitSnapshots(ctx, db.PruneCockpitSnapshotsParams{
		CockpitID: cc.cockpit.ID,
		Keep:      cockpitSnapshotKeep,
	}); err != nil {
		slog.Warn("PruneCockpitSnapshots failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	return nil
}

// buildCockpitSnapshotDocument reads the live board through `q` (the caller's
// transaction, so the freeze is consistent with the write beside it) and
// renders it as an import document. Issue links serialize as issue UUIDs:
// identity-stable across project-prefix changes, and the import resolver
// accepts them exactly as it accepts "BIO-314". The second return is false
// when the board carries no content at all — freezing an empty board protects
// nothing and buries the real history.
func buildCockpitSnapshotDocument(ctx context.Context, qtx *db.Queries, cc cockpitContext) (CockpitImportRequest, bool, error) {
	board := cc.cockpit
	nodes, err := qtx.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	payments, err := qtx.ListCockpitPayments(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	links, err := qtx.ListCockpitNodeIssues(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	milestones, err := qtx.ListCockpitMilestones(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	meetings, err := qtx.ListCockpitMeetings(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	meetingIssues, err := qtx.ListCockpitMeetingIssues(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}
	meetingNodes, err := qtx.ListCockpitMeetingNodes(ctx, board.ID)
	if err != nil {
		return CockpitImportRequest{}, false, err
	}

	empty := len(nodes) == 0 && len(milestones) == 0 && len(meetings) == 0 &&
		board.Title == "" && board.GoalTitle == "" && !board.GoalDate.Valid &&
		board.Basis == "" && board.SummaryOverall == "" &&
		board.SummaryNext == "" && board.SummarySupport == ""
	if empty {
		return CockpitImportRequest{}, false, nil
	}

	codeByID := make(map[pgtype.UUID]string, len(nodes))
	for _, n := range nodes {
		codeByID[n.ID] = n.Code
	}
	paymentsByNode := make(map[pgtype.UUID][]CockpitImportPayment)
	for _, p := range payments {
		date := ""
		if d := dateToPtr(p.PayDate); d != nil {
			date = *d
		}
		paymentsByNode[p.NodeID] = append(paymentsByNode[p.NodeID], CockpitImportPayment{
			Label:   p.Label,
			PayDate: date,
			Amount:  numericToFloat(p.Amount),
		})
	}
	issuesByNode := make(map[pgtype.UUID][]string)
	for _, l := range links {
		issuesByNode[l.NodeID] = append(issuesByNode[l.NodeID], uuidToString(l.IssueID))
	}
	issuesByMeeting := make(map[pgtype.UUID][]string)
	taskByMeeting := make(map[pgtype.UUID]string)
	for _, l := range meetingIssues {
		issuesByMeeting[l.MeetingID] = append(issuesByMeeting[l.MeetingID], uuidToString(l.IssueID))
		if l.Role == "task" {
			taskByMeeting[l.MeetingID] = uuidToString(l.IssueID)
		}
	}
	nodesByMeeting := make(map[pgtype.UUID][]string)
	for _, l := range meetingNodes {
		if code, ok := codeByID[l.NodeID]; ok {
			nodesByMeeting[l.MeetingID] = append(nodesByMeeting[l.MeetingID], code)
		}
	}

	dateStr := func(d pgtype.Date) string {
		if s := dateToPtr(d); s != nil {
			return *s
		}
		return ""
	}

	doc := CockpitImportRequest{
		Title:          board.Title,
		GoalTitle:      board.GoalTitle,
		GoalDate:       dateStr(board.GoalDate),
		Basis:          board.Basis,
		SummaryOverall: &board.SummaryOverall,
		SummaryNext:    &board.SummaryNext,
		SummarySupport: &board.SummarySupport,
		Nodes:          make([]CockpitImportNode, 0, len(nodes)),
		Milestones:     make([]CockpitImportMilestone, 0, len(milestones)),
		Meetings:       make([]CockpitImportMeeting, 0, len(meetings)),
	}
	for _, n := range nodes {
		parentCode := ""
		if n.ParentID.Valid {
			parentCode = codeByID[n.ParentID]
		}
		doc.Nodes = append(doc.Nodes, CockpitImportNode{
			Code:            n.Code,
			ParentCode:      parentCode,
			Name:            n.Name,
			Position:        n.Position,
			Color:           n.Color,
			Owner:           n.Owner,
			Collaborators:   n.Collaborators,
			StartDate:       dateStr(n.StartDate),
			EndDate:         dateStr(n.EndDate),
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
			Payments:        paymentsByNode[n.ID],
			IssueIDs:        issuesByNode[n.ID],
		})
	}
	for _, m := range milestones {
		nodeCode := ""
		if m.NodeID.Valid {
			nodeCode = codeByID[m.NodeID]
		}
		doc.Milestones = append(doc.Milestones, CockpitImportMilestone{
			Name:       m.Name,
			PlanDate:   dateStr(m.PlanDate),
			ActualDate: dateStr(m.ActualDate),
			Status:     m.Status,
			NodeCode:   nodeCode,
			Condition:  m.Condition,
			Guard:      m.Guard,
			Position:   m.Position,
		})
	}
	clockStr := func(t pgtype.Time) string {
		if s := clockToPtr(t); s != nil {
			return *s
		}
		return ""
	}
	for _, m := range meetings {
		doc.Meetings = append(doc.Meetings, CockpitImportMeeting{
			MeetDate:    dateStr(m.MeetDate),
			TimeRange:   m.TimeRange,
			StartTime:   clockStr(m.StartTime),
			EndTime:     clockStr(m.EndTime),
			Title:       m.Title,
			Code:        m.Code,
			Kind:        m.Kind,
			Status:      m.Status,
			Parties:     m.Parties,
			Organizer:   m.Organizer,
			Location:    m.Location,
			Attendees:   m.Attendees,
			MeetNo:      m.MeetNo,
			Link:        m.Link,
			Note:        m.Note,
			Minutes:     m.Minutes,
			Decisions:   m.Decisions,
			Actions:     m.Actions,
			NasDir:      m.NasDir,
			Detected:    m.Detected,
			IssueIDs:    issuesByMeeting[m.ID],
			NodeCodes:   nodesByMeeting[m.ID],
			TaskIssueID: taskByMeeting[m.ID],
		})
	}
	return doc, true, nil
}

// ListCockpitSnapshots returns the version history, newest first. Any member
// may read it: a board people cannot see the history of is a board people are
// afraid to edit.
func (h *Handler) ListCockpitSnapshots(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.ListCockpitSnapshots(r.Context(), cc.cockpit.ID)
	if err != nil {
		slog.Warn("ListCockpitSnapshots failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit snapshots")
		return
	}
	resp := make([]CockpitSnapshotResponse, 0, len(rows))
	for _, s := range rows {
		resp = append(resp, CockpitSnapshotResponse{
			ID:             uuidToString(s.ID),
			TriggerKind:    s.TriggerKind,
			Label:          s.Label,
			NodeCount:      int(s.NodeCount),
			CreatedByType:  s.CreatedByType,
			CreatedByLabel: s.CreatedByLabel,
			CreatedAt:      timestampToString(s.CreatedAt),
		})
	}
	writeJSON(w, http.StatusOK, resp)
}

type CreateCockpitSnapshotRequest struct {
	Label string `json:"label"`
}

// CreateCockpitSnapshot saves the board as it stands, on demand.
func (h *Handler) CreateCockpitSnapshot(w http.ResponseWriter, r *http.Request) {
	cc, ok := h.requireCockpit(w, r)
	if !ok {
		return
	}
	var req CreateCockpitSnapshotRequest
	// An empty body is a complete request here: the label is optional, and a
	// bare `POST /snapshots` (the CLI, a quick curl) means "save it now".
	if r.ContentLength != 0 {
		if _, ok := decodeCockpitBody(w, r, &req); !ok {
			return
		}
	}

	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}
	defer tx.Rollback(ctx)
	qtx := h.Queries.WithTx(tx)

	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, qtx, cc)
	if err != nil {
		slog.Warn("cockpit snapshot read failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}
	if !hasContent {
		writeError(w, http.StatusBadRequest, "the board is empty; there is nothing to save yet")
		return
	}
	payload, marshalErr := json.Marshal(doc)
	if marshalErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}
	actorType, actorLabel := h.cockpitActor(r, cc)
	snap, err := qtx.CreateCockpitSnapshot(ctx, db.CreateCockpitSnapshotParams{
		WorkspaceID:    cc.workspaceID,
		CockpitID:      cc.cockpit.ID,
		TriggerKind:    "manual",
		Label:          strings.TrimSpace(req.Label),
		Payload:        payload,
		NodeCount:      int32(len(doc.Nodes)),
		CreatedByType:  actorType,
		CreatedByLabel: actorLabel,
	})
	if err != nil {
		slog.Warn("CreateCockpitSnapshot failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}
	if _, err := qtx.PruneCockpitSnapshots(ctx, db.PruneCockpitSnapshotsParams{
		CockpitID: cc.cockpit.ID,
		Keep:      cockpitSnapshotKeep,
	}); err != nil {
		slog.Warn("PruneCockpitSnapshots failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}

	h.publishCockpit(r, cc, "snapshots", "created", nil)
	writeJSON(w, http.StatusCreated, CockpitSnapshotResponse{
		ID:             uuidToString(snap.ID),
		TriggerKind:    snap.TriggerKind,
		Label:          snap.Label,
		NodeCount:      int(snap.NodeCount),
		CreatedByType:  snap.CreatedByType,
		CreatedByLabel: snap.CreatedByLabel,
		CreatedAt:      timestampToString(snap.CreatedAt),
	})
}

// RestoreCockpitSnapshot puts a frozen board back. Owner/admin, like import:
// restore IS an import, one that happens to have been authored by this board's
// own past. The board being replaced is itself frozen first, so a restore can
// always be undone by restoring the snapshot it displaced.
func (h *Handler) RestoreCockpitSnapshot(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return
	}
	snapUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "snapshotId"), "snapshot id")
	if !ok {
		return
	}
	board, err := h.ensureCockpit(r.Context(), wsUUID)
	if err != nil {
		slog.Warn("ensureCockpit failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	snap, err := h.Queries.GetCockpitSnapshot(r.Context(), db.GetCockpitSnapshotParams{
		ID:          snapUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "snapshot not found")
		return
	}

	var req CockpitImportRequest
	if err := json.Unmarshal(snap.Payload, &req); err != nil {
		// A snapshot we wrote ourselves should always parse; failing here
		// means the row is corrupt, which no client can fix by retrying.
		slog.Error("cockpit snapshot payload unreadable", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "snapshot payload is unreadable")
		return
	}

	cc := cockpitContext{workspaceID: wsUUID, member: member, cockpit: board}
	resp, impErr := h.runCockpitImport(r, cc, req, "restore")
	if impErr != nil {
		writeError(w, impErr.status, impErr.msg)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// DeleteCockpitSnapshot removes one version from the history. Owner/admin:
// history is the board's safety net, and thinning it is not a routine edit.
func (h *Handler) DeleteCockpitSnapshot(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
	if !ok {
		return
	}
	snapUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "snapshotId"), "snapshot id")
	if !ok {
		return
	}
	board, err := h.ensureCockpit(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}
	if err := h.Queries.DeleteCockpitSnapshot(r.Context(), db.DeleteCockpitSnapshotParams{
		ID:          snapUUID,
		WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete snapshot")
		return
	}
	cc := cockpitContext{workspaceID: wsUUID, member: member, cockpit: board}
	h.publishCockpit(r, cc, "snapshots", "deleted", nil)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
