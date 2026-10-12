package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func IsCockpitPrimaryIntegrityError(err error) bool {
	var pgerr *pgconn.PgError
	return errors.As(err, &pgerr) && pgerr.ConstraintName == "cockpit_primary_integrity"
}
func planningError(err error) error {
	if IsCockpitArtifactIntegrityError(err) {
		return fmt.Errorf("%w: formal review retains its L3 context; use the artifact or acceptance workflow", ErrCockpitWorkflowConflict)
	}
	if IsCockpitPrimaryIntegrityError(err) {
		var pgerr *pgconn.PgError
		_ = errors.As(err, &pgerr)
		return fmt.Errorf("%w: %s", ErrCockpitWorkflowConflict, pgerr.Message)
	}
	return cockpitWorkflowError(err)
}
func planningHash(value any) string {
	body, _ := json.Marshal(value)
	return fmt.Sprintf("%x", sha256.Sum256(body))
}
func normalizeActionText(title, description, quote string) (string, string, string, error) {
	title, description = strings.TrimSpace(title), strings.TrimSpace(description)
	if strings.TrimSpace(quote) == "" {
		quote = ""
	}
	if title == "" || utf8.RuneCountInString(title) > 500 || len(description) > 16000 || len(quote) > 4096 {
		return "", "", "", fmt.Errorf("%w: action requires a title up to 500 characters, description up to 16000 bytes and quote up to 4096 bytes", ErrCockpitWorkflowInput)
	}
	return title, description, quote, nil
}
func checkActionSource(work cockpitMinutesState, version db.CockpitMinutesVersion, quote string, current bool) error {
	if minutesContentHash(version.Content) != version.ContentHash {
		return fmt.Errorf("%w: fixed source content does not match its fingerprint", ErrCockpitWorkflowConflict)
	}
	// R2: publication history stays on the version after a withdrawal, so
	// "currently published" means pointed to and not unpublished.
	if version.Decision != "approved" || !version.PublishedAt.Valid || version.UnpublishedAt.Valid || (current && work.PublishedVersionID != version.ID) {
		return fmt.Errorf("%w: action source must be the current published minutes version", ErrCockpitWorkflowConflict)
	}
	if quote != "" && !strings.Contains(version.Content, quote) {
		return fmt.Errorf("%w: source_quote must be an exact excerpt of the fixed minutes", ErrCockpitWorkflowInput)
	}
	return nil
}
func (s *IssueService) CreateCockpitMeetingAction(ctx context.Context, p CockpitActionDraft) (db.CockpitMeetingAction, error) {
	var err error
	p.Title, p.Description, p.SourceQuote, err = normalizeActionText(p.Title, p.Description, p.SourceQuote)
	if err != nil || !p.ProposalKey.Valid {
		if err == nil {
			err = fmt.Errorf("%w: proposal_key is required", ErrCockpitWorkflowInput)
		}
		return db.CockpitMeetingAction{}, err
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, CockpitWorkPackageCommand{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID})
	if err != nil {
		return db.CockpitMeetingAction{}, err
	}
	defer tx.Rollback(ctx)
	v, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.VersionID})
	if err != nil {
		return db.CockpitMeetingAction{}, planningError(err)
	}
	if err := authorizeCockpitMinutesExport(ctx, q, work, v, p.ActorID); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	hash := planningHash(p)
	old, err := q.GetCockpitActionProposal(ctx, db.GetCockpitActionProposalParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, VersionID: p.VersionID, ProposalKey: p.ProposalKey})
	if err == nil {
		if old.ProposalHash != hash || old.CreatedBy != p.ActorID {
			return db.CockpitMeetingAction{}, fmt.Errorf("%w: proposal key was used for another intent", ErrCockpitWorkflowConflict)
		}
		return old, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return db.CockpitMeetingAction{}, err
	}
	if err := checkActionSource(work, v, p.SourceQuote, true); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	row, err := q.CreateCockpitMeetingAction(ctx, db.CreateCockpitMeetingActionParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, VersionID: v.ID,
		VersionNumber: v.VersionNumber, SourceContentHash: v.ContentHash, ProposalKey: p.ProposalKey, ProposalHash: hash,
		Title: p.Title, Description: p.Description, SourceQuote: p.SourceQuote, CreatedBy: p.ActorID})
	if err != nil {
		return db.CockpitMeetingAction{}, planningError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	s.planningChanged(p.WorkspaceID, p.ActorID, "meeting_actions", map[string]any{"meeting_id": util.UUIDToString(p.MeetingID), "action_id": util.UUIDToString(row.ID)})
	return row, nil
}
func (s *IssueService) UpdateCockpitMeetingAction(ctx context.Context, p CockpitActionEdit) (db.CockpitMeetingAction, error) {
	var err error
	p.Title, p.Description, p.SourceQuote, err = normalizeActionText(p.Title, p.Description, p.SourceQuote)
	if err != nil {
		return db.CockpitMeetingAction{}, err
	}
	tx, q, work, err := s.beginCockpitWorkflow(ctx, CockpitWorkPackageCommand{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID})
	if err != nil {
		return db.CockpitMeetingAction{}, err
	}
	defer tx.Rollback(ctx)
	a, v, err := loadPlanningAction(ctx, q, work, p.ActionID, p.ActorID)
	if err != nil {
		return db.CockpitMeetingAction{}, err
	}
	if p.ExpectedRevision < 1 || a.Revision != p.ExpectedRevision || a.Status != "draft" {
		return db.CockpitMeetingAction{}, ErrCockpitWorkflowConflict
	}
	if err := checkActionSource(work, v, p.SourceQuote, true); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	row, err := q.UpdateCockpitMeetingAction(ctx, db.UpdateCockpitMeetingActionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ActionID,
		Title: p.Title, Description: p.Description, SourceQuote: p.SourceQuote, Revision: p.ExpectedRevision})
	if err != nil {
		return db.CockpitMeetingAction{}, planningError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	s.planningChanged(p.WorkspaceID, p.ActorID, "meeting_actions", map[string]any{"meeting_id": util.UUIDToString(p.MeetingID), "action_id": util.UUIDToString(row.ID)})
	return row, nil
}
func loadPlanningAction(ctx context.Context, q *db.Queries, work cockpitMinutesState, actionID, actor pgtype.UUID) (db.CockpitMeetingAction, db.CockpitMinutesVersion, error) {
	a, err := q.LockCockpitMeetingAction(ctx, db.LockCockpitMeetingActionParams{WorkspaceID: work.WorkspaceID, MeetingID: work.MeetingID, ID: actionID})
	if err != nil {
		return a, db.CockpitMinutesVersion{}, planningError(err)
	}
	v, err := q.GetCockpitMinutesVersion(ctx, db.GetCockpitMinutesVersionParams{WorkspaceID: work.WorkspaceID, MeetingID: work.MeetingID, ID: a.VersionID})
	if err != nil {
		return a, v, planningError(err)
	}
	if err := authorizeCockpitMinutesExport(ctx, q, work, v, actor); err != nil {
		return a, v, err
	}
	if a.SourceContentHash != v.ContentHash {
		return a, v, fmt.Errorf("%w: action source fingerprint changed", ErrCockpitWorkflowConflict)
	}
	// R2: revising rewrites a written decision; a draft suggestion is
	// confirmed, not revised. The marker keeps the shared create hook honest
	// because it cannot see the command channel any other way.
	if cockpitActionRevise(ctx) && a.Status != "accepted" && a.Status != "dismissed" {
		return a, v, fmt.Errorf("%w: only an accepted or dismissed resolution can be revised", ErrCockpitWorkflowConflict)
	}
	return a, v, nil
}

func normalizePlanningIssue(p *IssueCreateParams, actor pgtype.UUID) error {
	p.Priority = strings.TrimSpace(p.Priority)
	if p.Priority == "" {
		p.Priority = "none"
	}
	switch p.Priority {
	case "none", "urgent", "high", "medium", "low":
	default:
		return fmt.Errorf("%w: invalid issue priority", ErrCockpitWorkflowInput)
	}
	if !p.AssigneeType.Valid || p.AssigneeType.String == "" {
		if p.AssigneeID.Valid {
			return fmt.Errorf("%w: assignee type and ID must be provided together", ErrCockpitWorkflowInput)
		}
		p.AssigneeType = pgtype.Text{String: "member", Valid: true}
		p.AssigneeID = actor
	}
	if !p.AssigneeID.Valid || (p.AssigneeType.String != "member" && p.AssigneeType.String != "agent" && p.AssigneeType.String != "squad") {
		return fmt.Errorf("%w: invalid issue assignee", ErrCockpitWorkflowInput)
	}
	p.Status = "backlog"
	return nil
}
func resolutionHash(p CockpitActionResolution) string {
	if p.Outcome == "create" {
		// The generated Issue ID is a result, not part of the incoming command.
		p.IssueID = pgtype.UUID{}
	}
	return planningHash(struct {
		Actor, Action, Node, Issue                   pgtype.UUID
		Revision                                     int64
		Outcome, Reason, Priority, AssigneeType, Due string
		Assignee                                     pgtype.UUID
	}{p.ActorID, p.ActionID, p.NodeID, p.IssueID, p.ExpectedRevision, p.Outcome, p.Reason, p.NewIssue.Priority, p.NewIssue.AssigneeType.String, planningDate(p.NewIssue.DueDate), p.NewIssue.AssigneeID})
}
func planningDate(date pgtype.Date) string {
	if date.Valid {
		return date.Time.Format("2006-01-02")
	}
	return ""
}

type cockpitActionReviseMarker struct{}

// The canonical issue-create hook is shared by confirming and revising an
// action decision; the command channel (this context marker), not the row
// state, picks which ledger write the hook performs.
func withCockpitActionRevise(ctx context.Context) context.Context {
	return context.WithValue(ctx, cockpitActionReviseMarker{}, true)
}
func cockpitActionRevise(ctx context.Context) bool {
	revise, _ := ctx.Value(cockpitActionReviseMarker{}).(bool)
	return revise
}
func checkActionResolution(a db.CockpitMeetingAction, p CockpitActionResolution) (bool, error) {
	if a.DecisionKey.Valid {
		if a.DecisionKey == p.DecisionKey && a.ResolvedBy == p.ActorID && a.DecisionHash == resolutionHash(p) && a.DecisionRevision.Int64 == p.ExpectedRevision {
			return true, nil
		}
		// R2 (design-principles-2026-10-12): a written decision is a value,
		// not a terminal fact. With a fresh key and the current revision the
		// write path decides: resolve refuses a written decision (see
		// resolvePlanningAction), revise rewrites it and trails the outgoing
		// one. A stale revision stays a conflict either way.
		if (a.Status == "accepted" || a.Status == "dismissed") && a.Revision == p.ExpectedRevision {
			return false, nil
		}
		return false, fmt.Errorf("%w: action was already resolved with another intent", ErrCockpitWorkflowConflict)
	}
	if a.Status != "draft" || a.Revision != p.ExpectedRevision {
		return false, ErrCockpitWorkflowConflict
	}
	return false, nil
}
func (s *IssueService) ResolveCockpitMeetingAction(ctx context.Context, p CockpitActionResolution, opts IssueCreateOpts) (db.CockpitMeetingAction, error) {
	p.Reason = strings.TrimSpace(p.Reason)
	if !p.DecisionKey.Valid || p.ExpectedRevision < 1 || len(p.Reason) > 16000 {
		return db.CockpitMeetingAction{}, fmt.Errorf("%w: decision key, positive revision and bounded reason are required", ErrCockpitWorkflowInput)
	}
	if p.Outcome == "create" {
		return s.createPlanningActionIssue(ctx, p, opts)
	}
	if (p.Outcome != "reuse" && p.Outcome != "dismiss") || (p.Outcome == "dismiss" && (p.Reason == "" || p.NodeID.Valid || p.IssueID.Valid)) || (p.Outcome == "reuse" && (!p.NodeID.Valid || !p.IssueID.Valid)) {
		return db.CockpitMeetingAction{}, fmt.Errorf("%w: choose create, reuse with a node and issue, or dismiss with a reason", ErrCockpitWorkflowInput)
	}
	return s.settlePlanningAction(ctx, p, resolvePlanningAction)
}

// createPlanningActionIssue is the create execution segment shared by resolve
// and revise: the decision rides the canonical Issue transaction so the new
// issue, its primary ownership and the decision write commit atomically.
func (s *IssueService) createPlanningActionIssue(ctx context.Context, p CockpitActionResolution, opts IssueCreateOpts) (db.CockpitMeetingAction, error) {
	if !p.NodeID.Valid || p.IssueID.Valid {
		return db.CockpitMeetingAction{}, fmt.Errorf("%w: creating an action issue requires a node and no existing issue", ErrCockpitWorkflowInput)
	}
	if err := normalizePlanningIssue(&p.NewIssue, p.ActorID); err != nil {
		return db.CockpitMeetingAction{}, err
	}
	hook := &cockpitPlanningIssue{action: &p}
	opts.AssignedAgentRunFireAt = time.Time{}
	if _, err := s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitPlanning: hook}, opts); err != nil {
		return db.CockpitMeetingAction{}, planningError(err)
	}
	row, err := s.Queries.GetCockpitMeetingAction(ctx, db.GetCockpitMeetingActionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: p.ActionID})
	if err == nil && hook.created {
		s.planningChanged(p.WorkspaceID, p.ActorID, "meeting_actions", map[string]any{"meeting_id": util.UUIDToString(p.MeetingID), "action_id": util.UUIDToString(p.ActionID)})
		s.primaryChanged(p.WorkspaceID, p.ActorID, row.IssueID, pgtype.UUID{}, row.NodeID)
	}
	return row, planningError(err)
}

type planningActionWrite func(ctx context.Context, q *db.Queries, a db.CockpitMeetingAction, p CockpitActionResolution, node db.CockpitNode) (db.CockpitMeetingAction, error)

// settlePlanningAction is the reuse/dismiss execution segment shared by
// resolve and revise: authorization and state checks, the reuse ownership
// move, the caller's ledger write, then the planning events.
func (s *IssueService) settlePlanningAction(ctx context.Context, p CockpitActionResolution, write planningActionWrite) (db.CockpitMeetingAction, error) {
	tx, q, work, err := s.beginCockpitWorkflow(ctx, CockpitWorkPackageCommand{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID})
	if err != nil {
		return db.CockpitMeetingAction{}, err
	}
	defer tx.Rollback(ctx)
	a, v, err := loadPlanningAction(ctx, q, work, p.ActionID, p.ActorID)
	if err != nil {
		return a, err
	}
	if replay, err := checkActionResolution(a, p); replay || err != nil {
		return a, err
	}
	var node db.CockpitNode
	if p.Outcome == "reuse" {
		if err := checkActionSource(work, v, a.SourceQuote, true); err != nil {
			return a, err
		}
		node, _, _, err = requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
		if err != nil {
			return a, err
		}
		issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID})
		if err != nil {
			return a, planningError(err)
		}
		governance, err := q.CockpitIssueHasWorkflow(ctx, issue.ID)
		if err != nil {
			return a, err
		}
		if governance {
			return a, fmt.Errorf("%w: minutes and formal review issues cannot be reused as action execution", ErrCockpitWorkflowConflict)
		}
		if _, _, err := attachPlanningPrimary(ctx, q, issue, node, p.ActorID, true, nil); err != nil {
			return a, err
		}
	}
	row, err := write(ctx, q, a, p, node)
	if err != nil {
		return a, planningError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return a, err
	}
	s.planningChanged(p.WorkspaceID, p.ActorID, "meeting_actions", map[string]any{"meeting_id": util.UUIDToString(p.MeetingID), "action_id": util.UUIDToString(p.ActionID)})
	if p.Outcome == "reuse" {
		s.primaryChanged(p.WorkspaceID, p.ActorID, row.IssueID, pgtype.UUID{}, row.NodeID)
	}
	return row, nil
}

// ReviseCockpitMeetingActionResolution replaces the current decision on an
// accepted or dismissed action (R2, design-principles-2026-10-12). The SQL
// appends the outgoing decision to previous_resolutions, tasks created by an
// earlier decision keep their ordinary issue lifecycle, and a revision
// reason is mandatory in every direction.
func (s *IssueService) ReviseCockpitMeetingActionResolution(ctx context.Context, p CockpitActionResolution, opts IssueCreateOpts) (db.CockpitMeetingAction, error) {
	p.Reason = strings.TrimSpace(p.Reason)
	if !p.DecisionKey.Valid || p.ExpectedRevision < 1 || p.Reason == "" || len(p.Reason) > 16000 {
		return db.CockpitMeetingAction{}, fmt.Errorf("%w: decision key, positive revision and a revision reason are required", ErrCockpitWorkflowInput)
	}
	if p.Outcome == "create" {
		return s.createPlanningActionIssue(withCockpitActionRevise(ctx), p, opts)
	}
	if (p.Outcome != "reuse" && p.Outcome != "dismiss") || (p.Outcome == "dismiss" && (p.NodeID.Valid || p.IssueID.Valid)) || (p.Outcome == "reuse" && (!p.NodeID.Valid || !p.IssueID.Valid)) {
		return db.CockpitMeetingAction{}, fmt.Errorf("%w: choose create, reuse with a node and issue, or dismiss with a reason", ErrCockpitWorkflowInput)
	}
	return s.settlePlanningAction(withCockpitActionRevise(ctx), p, revisePlanningAction)
}

func planningActionStatus(outcome string) string {
	if outcome == "dismiss" {
		return "dismissed"
	}
	return "accepted"
}
func resolvePlanningAction(ctx context.Context, q *db.Queries, a db.CockpitMeetingAction, p CockpitActionResolution, node db.CockpitNode) (db.CockpitMeetingAction, error) {
	if cockpitActionRevise(ctx) {
		return revisePlanningAction(ctx, q, a, p, node)
	}
	if a.Status != "draft" {
		// Confirming never rewrites a written decision; R2's revise channel
		// does. Reaching here means a fresh key raced past the shared check.
		return a, fmt.Errorf("%w: action was already resolved with another intent; revise the decision to change it", ErrCockpitWorkflowConflict)
	}
	return q.ResolveCockpitMeetingAction(ctx, db.ResolveCockpitMeetingActionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: a.ID,
		ExpectedRevision: p.ExpectedRevision, Status: planningActionStatus(p.Outcome), Resolution: p.Outcome, IssueID: p.IssueID, NodeID: node.ID,
		NodeCode: node.Code, NodeName: node.Name, Reason: p.Reason, DecisionKey: p.DecisionKey, DecisionHash: resolutionHash(p), ActorID: p.ActorID})
}
func revisePlanningAction(ctx context.Context, q *db.Queries, a db.CockpitMeetingAction, p CockpitActionResolution, node db.CockpitNode) (db.CockpitMeetingAction, error) {
	return q.ReviseCockpitMeetingActionResolution(ctx, db.ReviseCockpitMeetingActionResolutionParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: a.ID,
		ExpectedRevision: p.ExpectedRevision, Status: planningActionStatus(p.Outcome), Resolution: p.Outcome, IssueID: p.IssueID, NodeID: node.ID,
		NodeCode: node.Code, NodeName: node.Name, Reason: p.Reason, DecisionKey: p.DecisionKey, DecisionHash: resolutionHash(p), ActorID: p.ActorID})
}
func (s *IssueService) planningChanged(ws, actor pgtype.UUID, scope string, entity any) {
	if s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(ws), ActorType: "member", ActorID: util.UUIDToString(actor),
			Payload: map[string]any{"scope": scope, "action": "updated", "entity": entity}})
	}
}
func (s *IssueService) primaryChanged(ws, actor, issue, previous, node pgtype.UUID) {
	s.planningChanged(ws, actor, "primary_node", map[string]any{"issue_id": util.UUIDToString(issue), "previous_node_id": planningUUID(previous), "node_id": planningUUID(node)})
}
