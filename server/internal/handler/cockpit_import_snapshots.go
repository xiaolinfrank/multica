package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitImportNode struct {
	ProjectID       *string                `json:"project_id,omitempty"`
	ModuleID        *string                `json:"module_id,omitempty"`
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
	// Workflow purposes are keyed by the same issue reference as IssueIDs.
	IssueRoles map[string][]string `json:"issue_roles,omitempty"`
}

type CockpitImportRequest struct {
	nodeBindings []cockpitNodeBindingPatch
	Title        string                   `json:"title"`
	GoalTitle    string                   `json:"goal_title"`
	GoalDate     string                   `json:"goal_date"`
	Basis        string                   `json:"basis"`
	Nodes        []CockpitImportNode      `json:"nodes"`
	Milestones   []CockpitImportMilestone `json:"milestones"`
	Meetings     []CockpitImportMeeting   `json:"meetings"`
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

	if !parseCockpitImportBindings(w, &req) {
		return
	}
	resp, impErr := h.runCockpitImport(r, cc, req, "import")
	if impErr != nil {
		writeError(w, impErr.status, impErr.msg)
		return
	}
	h.publishCockpit(r, cc, "changes", "withdrawn", nil)
	writeJSON(w, http.StatusOK, resp)
}

// runCockpitImport replaces the board with `req` atomically. When `trigger` is
// non-empty it names the operation for the automatic snapshot taken of the
// outgoing board ("import", "restore") — the caller has already decided this
// run is allowed to destroy the board. Empty trigger skips the snapshot: it is
// used by paths that have already frozen the board themselves.
func (h *Handler) runCockpitImport(r *http.Request, cc cockpitContext, req CockpitImportRequest, trigger string) (CockpitImportResponse, *cockpitImportError) {
	actorType, _ := h.cockpitActor(r, cc)
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

	if err := lockCockpitBindings(ctx, qtx, cc.workspaceID); err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to lock cockpit bindings"}
	}
	if protected, err := qtx.HasCockpitLifecycleForBoard(ctx, db.HasCockpitLifecycleForBoardParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID}); err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect meeting lifecycle"}
	} else if protected {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "meeting agendas or occurrence facts protect this board; open the meeting instead of replacing its identities"}
	}
	if protected, err := qtx.HasCockpitMeetingPreparation(ctx, cc.workspaceID); err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect meeting preparation history"}
	} else if protected {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "meeting templates and preparation history protect this board; preserve their stable identities"}
	}
	if protected, err := qtx.HasCockpitDirectoryWorkspaceHistory(ctx, cc.workspaceID); err != nil || !protected.Valid {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect directory preparation history"}
	} else if protected.Bool {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "directory preparation history protects meeting identities; open its Resources instead of replacing the board"}
	}
	if protected, err := qtx.HasCockpitInputReferencesForBoard(ctx, db.HasCockpitInputReferencesForBoardParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID}); err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect meeting input references"}
	} else if protected {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "meeting input references protect this board; open meeting Resources to remove their exact references before replacing meeting identities"}
	}
	if protected, err := qtx.HasCockpitPlanningForBoard(ctx, db.HasCockpitPlanningForBoardParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID}); err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect work-item filings and meeting actions"}
	} else if protected {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "work-item filings or meeting action history protect this board from full replacement"}
	}
	bound, err := qtx.CockpitHasBoundNodes(ctx, db.CockpitHasBoundNodesParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID})
	if err != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to inspect cockpit bindings"}
	}
	if bound {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "this cockpit has stable project/module bindings; whole-board import or restore would replace node identities; edit existing nodes instead"}
	}

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

	protectedWorkflow, workflowErr := qtx.HasCockpitMinutesLinksForBoard(ctx, db.HasCockpitMinutesLinksForBoardParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID})
	if workflowErr != nil {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to check meeting workflows"}
	}
	if protectedWorkflow {
		return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "meeting work packages protect this board from full replacement; edit the existing plan instead"}
	}

	// Replace order matters: children of the old tree carry payment and issue
	// rows that reference node ids about to disappear.
	for _, del := range []func() error{
		func() error {
			return qtx.DeleteRemovedCockpitInputReferencesByBoard(ctx, db.DeleteRemovedCockpitInputReferencesByBoardParams{WorkspaceID: cc.workspaceID, CockpitID: board.ID})
		},
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
		// Pending proposals name node ids that are about to stop existing;
		// they are closed as system withdrawals (decided history is kept).
		func() error {
			note := "board replaced by import"
			if trigger == "restore" {
				note = "board restored from snapshot"
			}
			_, err := qtx.SystemWithdrawCockpitPendingChangesByCockpit(ctx, db.SystemWithdrawCockpitPendingChangesByCockpitParams{
				CockpitID:    board.ID,
				DecisionNote: note,
			})
			return err
		},
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
	for nodeIndex, n := range req.Nodes {
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

		projectID, moduleID, bindErr := resolveCockpitNodeBinding(ctx, qtx, cc.workspaceID, db.CockpitNode{}, req.nodeBindings[nodeIndex])
		if bindErr != nil {
			return CockpitImportResponse{}, bindErr
		}
		created, err := qtx.CreateCockpitNode(ctx, db.CreateCockpitNodeParams{
			WorkspaceID:     cc.workspaceID,
			CockpitID:       board.ID,
			ProjectID:       projectID,
			ModuleID:        moduleID,
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
			UpdatedByType:   actorType,
			UpdatedByID:     cc.member.UserID,
		})
		if err != nil {
			if isUniqueViolation(err) {
				return CockpitImportResponse{}, &cockpitImportError{http.StatusConflict, "a node with this project/module binding already exists"}
			}
			slog.Warn("cockpit import node failed", append(logger.RequestAttrs(r), "error", err)...)
			return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import cockpit"}
		}
		// The rebuilt board's codes join the used-code ledger (migration
		// 948): a snapshot restore reintroduces codes that must not read as
		// free once the restored rows are deleted again. Imports alone skip
		// the spent-code gate — replaying a snapshot must reuse its own
		// codes, so an already-recorded code is fine here.
		if _, err := qtx.RecordCockpitUsedCode(ctx, db.RecordCockpitUsedCodeParams{
			WorkspaceID: cc.workspaceID,
			CockpitID:   board.ID,
			Code:        code,
		}); err != nil {
			slog.Warn("cockpit import used-code record failed", append(logger.RequestAttrs(r), "error", err)...)
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
				UpdatedByType: actorType,
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
			Track:       m.Track,
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
			// Snapshots never carried occurrence facts; a restored meeting is
			// human data, so it lands scheduled (the detected flag still asks
			// for its folder-guess check).
			OccurrenceState: "scheduled",
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
			if purposes, present := m.IssueRoles[ref]; present {
				// Imports preserve unknown future purpose values in snapshots while
				// validating shape and size. They never interpret those purposes.
				roles, err := normalizeCockpitMeetingRoles(purposes, purposes)
				if err != nil {
					return CockpitImportResponse{}, &cockpitImportError{http.StatusBadRequest, err.Error()}
				}
				if _, err := qtx.UpdateCockpitMeetingIssueRoles(ctx, db.UpdateCockpitMeetingIssueRolesParams{
					WorkspaceID: cc.workspaceID, MeetingID: meeting.ID, IssueID: issueID, Roles: roles,
				}); err != nil {
					return CockpitImportResponse{}, &cockpitImportError{http.StatusInternalServerError, "failed to import meeting issue roles"}
				}
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

	if err := checkCockpitBindingTree(ctx, qtx, board.ID); err != nil {
		return CockpitImportResponse{}, err
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

// Comparison metadata belongs to snapshot storage, never to the import contract.
type cockpitSnapshotDocument struct {
	CockpitImportRequest
	PlanIdentity *service.CockpitPlanSnapshotIdentity `json:"plan_identity,omitempty"`
}

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

func (h *Handler) snapshotCockpitBoard(ctx context.Context, qtx *db.Queries, r *http.Request, cc cockpitContext, trigger, label string) *cockpitImportError {
	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, qtx, cc, false)
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
func buildCockpitSnapshotDocument(ctx context.Context, qtx *db.Queries, cc cockpitContext, stableIdentity bool) (cockpitSnapshotDocument, bool, error) {
	board := cc.cockpit
	nodes, err := qtx.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	payments, err := qtx.ListCockpitPayments(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	links, err := qtx.ListCockpitNodeIssues(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	milestones, err := qtx.ListCockpitMilestones(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	meetings, err := qtx.ListCockpitMeetings(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	meetingIssues, err := qtx.ListCockpitMeetingIssues(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}
	meetingNodes, err := qtx.ListCockpitMeetingNodes(ctx, board.ID)
	if err != nil {
		return cockpitSnapshotDocument{}, false, err
	}

	empty := len(nodes) == 0 && len(milestones) == 0 && len(meetings) == 0 &&
		board.Title == "" && board.GoalTitle == "" && !board.GoalDate.Valid &&
		board.Basis == "" && board.SummaryOverall == "" &&
		board.SummaryNext == "" && board.SummarySupport == ""
	if empty {
		return cockpitSnapshotDocument{}, false, nil
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
	rolesByMeeting := make(map[pgtype.UUID]map[string][]string)
	taskByMeeting := make(map[pgtype.UUID]string)
	for _, l := range meetingIssues {
		issuesByMeeting[l.MeetingID] = append(issuesByMeeting[l.MeetingID], uuidToString(l.IssueID))
		if len(l.Roles) > 0 {
			if rolesByMeeting[l.MeetingID] == nil {
				rolesByMeeting[l.MeetingID] = make(map[string][]string)
			}
			rolesByMeeting[l.MeetingID][uuidToString(l.IssueID)] = l.Roles
		}
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

	doc := cockpitSnapshotDocument{CockpitImportRequest: CockpitImportRequest{
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
	}}
	for _, n := range nodes {
		parentCode := ""
		if n.ParentID.Valid {
			parentCode = codeByID[n.ParentID]
		}
		doc.Nodes = append(doc.Nodes, CockpitImportNode{
			ProjectID:       uuidToPtr(n.ProjectID),
			ModuleID:        uuidToPtr(n.ModuleID),
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
			Track:       m.Track,
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
			IssueRoles:  rolesByMeeting[m.ID],
		})
	}
	if stableIdentity {
		doc.PlanIdentity, err = service.BuildCockpitPlanSnapshotIdentity(board, nodes, payments, milestones)
		if err != nil {
			return cockpitSnapshotDocument{}, false, err
		}
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

	actorType, actorLabel := h.cockpitActor(r, cc)
	ctx := r.Context()
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save cockpit snapshot")
		return
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); err != nil {
		writeError(w, 500, "failed to save cockpit snapshot")
		return
	}
	qtx := h.Queries.WithTx(tx)
	if _, err = qtx.LockWorkspaceForChatSessionCreate(ctx, cc.workspaceID); err != nil {
		writeError(w, 404, "workspace no longer exists")
		return
	}
	if _, err = qtx.LockCockpitSnapshotBoard(ctx, db.LockCockpitSnapshotBoardParams{WorkspaceID: cc.workspaceID, ID: cc.cockpit.ID}); err != nil {
		writeError(w, 409, "cockpit changed; reload before saving a snapshot")
		return
	}
	cc.cockpit, err = qtx.GetCockpitByWorkspace(ctx, cc.workspaceID)
	if err != nil {
		writeError(w, 404, "cockpit no longer exists")
		return
	}
	doc, hasContent, err := buildCockpitSnapshotDocument(ctx, qtx, cc, true)
	if err != nil {
		if writeCockpitSnapshotDiffLimit(w, err) {
			return
		}
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
	if !parseCockpitImportBindings(w, &req) {
		return
	}
	resp, impErr := h.runCockpitImport(r, cc, req, "restore")
	if impErr != nil {
		writeError(w, impErr.status, impErr.msg)
		return
	}
	h.publishCockpit(r, cc, "changes", "withdrawn", nil)
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
