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
// GET /api/cockpit preserves the full-board contract for installed clients.
// Native surfaces use explicit context, scoped plans and bounded object pages.
// Writes acknowledge the changed resource; realtime invalidates derived reads.
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
	// Who a new meeting's task is assigned to. Empty means the member filing
	// the meeting, which is the behaviour a board starts with.
	MeetingAssigneeType string  `json:"meeting_assignee_type"`
	MeetingAssigneeID   *string `json:"meeting_assignee_id"`
	CreatedAt           string  `json:"created_at"`
	UpdatedAt           string  `json:"updated_at"`
}

type CockpitNodeResponse struct {
	ID string `json:"id"`
	// Set by a reparent: what the move carried with it (§4.3).
	RefiledIssues   int      `json:"refiled_issues,omitempty"`
	StatusMapped    int      `json:"status_mapped,omitempty"`
	CockpitID       string   `json:"cockpit_id"`
	ParentID        *string  `json:"parent_id"`
	ProjectID       *string  `json:"project_id"`
	ModuleID        *string  `json:"module_id"`
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
	// DirectoryName is the folder this row owns in the collaboration space
	// (a module's and a work item's; a project owns none). The tree composes
	// paths from it without asking the disk.
	DirectoryName *string `json:"directory_name"`
	// DirectorySync reports what a rename/move/renumber did to the folder.
	DirectorySync *NodeDirectorySync `json:"directory_sync,omitempty"`
	CreatedAt     string             `json:"created_at"`
	UpdatedAt     string             `json:"updated_at"`
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
	Code   string `json:"code"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	// The line of the programme this meeting advances, in the board's own
	// words ("高质量数据集" …). The timeline lanes are these values.
	Track     string `json:"track"`
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
	Role            string   `json:"role"`
	Roles           []string `json:"roles"`
	RequiredRoles   []string `json:"required_roles"`
	IssueNumber     int32    `json:"issue_number"`
	IssueIdentifier string   `json:"issue_identifier"`
	IssueTitle      string   `json:"issue_title"`
	IssueStatus     string   `json:"issue_status"`
	Position        float64  `json:"position"`
}

// CockpitMeetingNodeResponse is one work-breakdown item a meeting was about.
type CockpitMeetingNodeResponse struct {
	MeetingID string  `json:"meeting_id"`
	NodeID    string  `json:"node_id"`
	Position  float64 `json:"position"`
}

// CockpitBoardResponse is the single read every view starts from.
type CockpitBoardResponse struct {
	HasMeetingWorkflows bool                       `json:"has_meeting_workflows"`
	Cockpit             CockpitResponse            `json:"cockpit"`
	Nodes               []CockpitNodeResponse      `json:"nodes"`
	Payments            []CockpitPaymentResponse   `json:"payments"`
	IssueLinks          []CockpitNodeIssueResponse `json:"issue_links"`
	Milestones          []CockpitMilestoneResponse `json:"milestones"`
	Meetings            []CockpitMeetingResponse   `json:"meetings"`
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

// numericPtrValue dereferences a wire-level numeric pointer; absent stays
// SQL NULL.
func numericPtrValue(n *pgtype.Numeric) pgtype.Numeric {
	if n == nil {
		return pgtype.Numeric{Valid: false}
	}
	return *n
}

// numericPtrOrZero keeps an omitted wire amount at the column's own zero
// rather than NULL — a payment row always carries an amount.
func numericPtrOrZero(n *pgtype.Numeric) pgtype.Numeric {
	if v := numericPtrValue(n); v.Valid {
		return v
	}
	return pgtype.Numeric{Int: big.NewInt(0), Exp: -6, Valid: true}
}

// floatToNumeric converts a float-path amount (import documents, the changes
// text flow) to NUMERIC(14,6). The interactive wire requests take
// pgtype.Numeric directly so their decimal text reaches Postgres unrounded;
// these two paths still carry float64s and accept their half-ulp rounding.
func floatToNumeric(f float64) pgtype.Numeric {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return pgtype.Numeric{Valid: false}
	}
	scaled := math.Round(f * 1000000)
	return pgtype.Numeric{Int: big.NewInt(int64(scaled)), Exp: -6, Valid: true}
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

		MeetingAssigneeType: c.MeetingAssigneeType,
		MeetingAssigneeID:   uuidToPtr(c.MeetingAssigneeID),

		CreatedAt: timestampToString(c.CreatedAt),
		UpdatedAt: timestampToString(c.UpdatedAt),
	}
}

func cockpitNodeToResponse(n db.CockpitNode) CockpitNodeResponse {
	return CockpitNodeResponse{
		ID:              uuidToString(n.ID),
		CockpitID:       uuidToString(n.CockpitID),
		ParentID:        uuidToPtr(n.ParentID),
		ProjectID:       uuidToPtr(n.ProjectID),
		ModuleID:        uuidToPtr(n.ModuleID),
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
		DirectoryName:   textToPtr(n.DirectoryName),
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
		Track:     m.Track,
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
		Roles:           append([]string{}, l.Roles...),
		RequiredRoles:   append([]string{}, l.RequiredRoles...),
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
// never open it buys nothing. "First use" is any board read — which, since the
// issue detail page grew a work-items section that reads the board, includes
// opening any issue; the row an empty board leaves behind sits inert until
// somebody builds a breakdown. CreateCockpit is idempotent, so a first visit
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
	if issue, ok, _ := h.resolveIssueByIdentifier(ctx, ref, workspaceID); ok {
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
	actorType, actorLabel := h.cockpitActor(r, cc)
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); err != nil {
		return
	}
	q := h.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, cc.workspaceID); err != nil {
		return
	}
	if _, err = q.LockCockpitSnapshotBoard(ctx, db.LockCockpitSnapshotBoardParams{WorkspaceID: cc.workspaceID, ID: cc.cockpit.ID}); err != nil {
		return
	}
	cc.cockpit, err = q.GetCockpitByWorkspace(ctx, cc.workspaceID)
	if err != nil {
		return
	}
	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, q, cc, true)
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
	if _, err := q.CreateCockpitSnapshot(ctx, db.CreateCockpitSnapshotParams{
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
	if _, err := q.PruneCockpitSnapshots(ctx, db.PruneCockpitSnapshotsParams{
		CockpitID: cc.cockpit.ID,
		Keep:      cockpitSnapshotKeep,
	}); err != nil {
		slog.Warn("PruneCockpitSnapshots failed", append(logger.RequestAttrs(r), "error", err)...)
	}
	if err = tx.Commit(ctx); err != nil {
		return
	}
	h.publishCockpit(r, cc, "snapshots", "created", nil)
}

// sameCockpitPayload answers whether a stored payload and a freshly
// marshalled document describe the same board.
func sameCockpitPayload(stored, fresh []byte) bool {
	if len(stored) == 0 {
		return false
	}
	var doc cockpitSnapshotDocument
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
	hasWorkflows, err := h.Queries.HasCockpitMinutesLinksForBoard(ctx, db.HasCockpitMinutesLinksForBoardParams{
		WorkspaceID: cc.workspaceID, CockpitID: cc.cockpit.ID,
	})
	if err != nil {
		slog.Warn("HasCockpitWorkPackagesForBoard failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to load cockpit")
		return
	}

	prefix := h.getIssuePrefix(ctx, cc.workspaceID)
	resp := CockpitBoardResponse{
		HasMeetingWorkflows: hasWorkflows,
		Cockpit:             cockpitToResponse(cc.cockpit),
		Nodes:               make([]CockpitNodeResponse, len(nodes)),
		Payments:            make([]CockpitPaymentResponse, len(payments)),
		IssueLinks:          make([]CockpitNodeIssueResponse, len(links)),
		Milestones:          make([]CockpitMilestoneResponse, len(milestones)),
		Meetings:            make([]CockpitMeetingResponse, len(meetings)),
		MeetingIssues:       make([]CockpitMeetingIssueResponse, len(meetingIssues)),
		MeetingNodes:        make([]CockpitMeetingNodeResponse, len(meetingNodes)),
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
	// Who new meetings assign their task to. The pair travels together: a
	// type with no id, or an id with no type, names nothing.
	MeetingAssigneeType *string `json:"meeting_assignee_type"`
	MeetingAssigneeID   *string `json:"meeting_assignee_id"`
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
	if dir == nil && (project.effective(cc.cockpit.MeetingProjectID) != cc.cockpit.MeetingProjectID || module.effective(cc.cockpit.MeetingModuleID) != cc.cockpit.MeetingModuleID || node.effective(cc.cockpit.MeetingNodeID) != cc.cockpit.MeetingNodeID) {
		blank := ""
		dir = &blank
	}
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

	assigneeType, assignee, ok := h.resolveMeetingAssignee(
		w, r, cc, raw, req.MeetingAssigneeType, req.MeetingAssigneeID)
	if !ok {
		return
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

		MeetingAssigneeType:  assigneeType,
		MeetingAssigneeID:    assignee.id,
		ClearMeetingAssignee: assignee.clear,
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
