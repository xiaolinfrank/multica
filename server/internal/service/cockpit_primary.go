package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type cockpitPlanningIssue struct {
	action  *CockpitActionResolution
	create  *CockpitNodeTaskCreate
	row     db.CockpitMeetingAction
	node    db.CockpitNode
	created bool
}

func planningUUID(id pgtype.UUID) *string {
	if !id.Valid {
		return nil
	}
	v := util.UUIDToString(id)
	return &v
}
func planningText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func executionLeaf(ctx context.Context, q *db.Queries, ws, id pgtype.UUID) (db.CockpitNode, CockpitExecutionEligibility, error) {
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: ws, ID: id})
	if err != nil {
		return node, CockpitExecutionEligibility{}, planningError(err)
	}
	fail := func(reason string) (db.CockpitNode, CockpitExecutionEligibility, error) {
		return node, CockpitExecutionEligibility{Reason: reason}, nil
	}
	if node.ProjectID.Valid || node.ModuleID.Valid {
		return fail("structural_node")
	}
	nodes, err := q.ListCockpitNodes(ctx, node.CockpitID)
	if err != nil {
		return node, CockpitExecutionEligibility{}, err
	}
	byID := make(map[pgtype.UUID]db.CockpitNode, len(nodes))
	for _, candidate := range nodes {
		byID[candidate.ID] = candidate
		if candidate.ParentID == node.ID {
			return fail("not_leaf")
		}
	}
	seen := map[pgtype.UUID]bool{node.ID: true}
	ancestor := node
	var project, module pgtype.UUID
	for ancestor.ParentID.Valid {
		if seen[ancestor.ParentID] {
			return fail("invalid_ancestry")
		}
		var found bool
		ancestor, found = byID[ancestor.ParentID]
		if !found {
			return fail("invalid_ancestry")
		}
		seen[ancestor.ID] = true
		if ancestor.ModuleID.Valid {
			if module.Valid || !ancestor.ProjectID.Valid {
				return fail("binding_conflict")
			}
			module = ancestor.ModuleID
		}
		if ancestor.ProjectID.Valid {
			if project.Valid && project != ancestor.ProjectID {
				return fail("binding_conflict")
			}
			project = ancestor.ProjectID
		}
	}
	if !project.Valid || !module.Valid {
		return fail("module_binding_required")
	}
	m, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: ws, ID: module})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && m.ProjectID != project) {
		return fail("binding_conflict")
	}
	if err != nil {
		return node, CockpitExecutionEligibility{}, err
	}
	if _, err = q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: ws, ID: project}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fail("binding_conflict")
		}
		return node, CockpitExecutionEligibility{}, err
	}
	return node, CockpitExecutionEligibility{Eligible: true, ProjectID: planningUUID(project), ModuleID: planningUUID(module)}, nil
}
func requireExecutionLeaf(ctx context.Context, q *db.Queries, ws, id pgtype.UUID) (db.CockpitNode, pgtype.UUID, pgtype.UUID, error) {
	node, eligibility, err := executionLeaf(ctx, q, ws, id)
	if err != nil {
		return node, pgtype.UUID{}, pgtype.UUID{}, err
	}
	if !eligibility.Eligible {
		return node, pgtype.UUID{}, pgtype.UUID{}, fmt.Errorf("%w: node is not an eligible L3 execution leaf (%s)", ErrCockpitWorkflowConflict, eligibility.Reason)
	}
	project, _ := util.ParseUUID(*eligibility.ProjectID)
	module, _ := util.ParseUUID(*eligibility.ModuleID)
	return node, project, module, nil
}

func beginPlanning(ctx context.Context, s *IssueService, ws, actor pgtype.UUID) (pgx.Tx, *db.Queries, error) {
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	q := s.Queries.WithTx(tx)
	fail := func(err error) (pgx.Tx, *db.Queries, error) {
		_ = tx.Rollback(ctx)
		return nil, nil, planningError(err)
	}
	if err := cockpitWorkflowMember(ctx, q, ws, actor); err != nil {
		return fail(err)
	}
	if _, err := q.LockWorkspaceForChatSessionCreate(ctx, ws); err != nil {
		return fail(err)
	}
	if _, err := q.LockCockpitForWorkspaceChanges(ctx, ws); err != nil {
		return fail(err)
	}
	return tx, q, nil
}

// attachPlanningPrimary files an issue under a work item. issue.work_item_id
// is the filing; the legacy cockpit_issue_primary row is only the creation
// receipt (creation_key/hash), so its node_id is deliberately left NULL. A
// named work item supplies its own module and project, and the DB guard that
// used to refuse such a move is cleared first for the whole subtree (I4).
// It returns the changed subtree rows so the caller can broadcast each one.
func attachPlanningPrimary(ctx context.Context, q *db.Queries, issue db.Issue, node db.CockpitNode, actor pgtype.UUID, create *CockpitNodeTaskCreate) (db.CockpitIssuePrimary, pgtype.UUID, []db.RefileIssueSubtreeRow, error) {
	_, project, module, err := requireExecutionLeaf(ctx, q, issue.WorkspaceID, node.ID)
	if err != nil {
		return db.CockpitIssuePrimary{}, pgtype.UUID{}, nil, err
	}
	previous := issue.WorkItemID
	if previous == node.ID {
		receipt, err := ensureCockpitPrimaryReceipt(ctx, q, issue, actor, create)
		return receipt, previous, nil, err
	}
	// A sub-issue is filed where its parent is filed (I4). This is the same
	// rule the issue update path applies; the work item is not an independent
	// property a child may change on its own.
	if issue.ParentIssueID.Valid {
		parent, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issue.ParentIssueID, WorkspaceID: issue.WorkspaceID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return db.CockpitIssuePrimary{}, previous, nil, err
		}
		if err == nil && parent.WorkItemID != node.ID {
			return db.CockpitIssuePrimary{}, previous, nil, fmt.Errorf("%w: a sub-issue must stay in its parent's work item", ErrChildWorkItemMismatch)
		}
	}
	// The work item the issue leaves becomes a related node, the same way the
	// old primary row did: a refile changes the filing, not the history.
	if previous.Valid {
		if err := q.EnsureCockpitNodeReference(ctx, db.EnsureCockpitNodeReferenceParams{WorkspaceID: issue.WorkspaceID, NodeID: previous, IssueID: issue.ID}); err != nil {
			return db.CockpitIssuePrimary{}, previous, nil, err
		}
	}
	if err := q.ClearCockpitPrimaryNodeIDsForSubtree(ctx, db.ClearCockpitPrimaryNodeIDsForSubtreeParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID}); err != nil {
		return db.CockpitIssuePrimary{}, previous, nil, err
	}
	// The subtree write covers the descendants only; the issue itself is the
	// row being refiled. Both must move together (I4).
	if err := q.SetIssueWorkItem(ctx, db.SetIssueWorkItemParams{
		WorkspaceID: issue.WorkspaceID, IssueID: issue.ID,
		WorkItemID: node.ID, ProjectID: project, ModuleID: module,
	}); err != nil {
		return db.CockpitIssuePrimary{}, previous, nil, err
	}
	// RefileIssueSubtree returns exactly the descendant rows that changed, so
	// each one can be broadcast — a child whose revision bumped deserves its
	// own event, not just its parent's.
	refiled, err := q.RefileIssueSubtree(ctx, db.RefileIssueSubtreeParams{
		ParentIssueID: issue.ID,
		WorkspaceID:   issue.WorkspaceID,
		ProjectID:     project,
		ModuleID:      module,
		WorkItemID:    node.ID,
	})
	if err != nil {
		return db.CockpitIssuePrimary{}, previous, nil, err
	}
	receipt, err := ensureCockpitPrimaryReceipt(ctx, q, issue, actor, create)
	return receipt, previous, refiled, err
}

// fileCockpitIssueUnderNode files a just-created issue under the work item its
// artifact/acceptance flow belongs to, and writes its creation receipt. These
// flows used to write the legacy primary row directly; the filing now lives on
// issue.work_item_id so every reader sees one authority.
func fileCockpitIssueUnderNode(ctx context.Context, q *db.Queries, issue db.Issue, nodeID, actor pgtype.UUID) error {
	if !nodeID.Valid {
		return nil
	}
	node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: issue.WorkspaceID, ID: nodeID})
	if err != nil {
		return planningError(err)
	}
	_, _, _, err = attachPlanningPrimary(ctx, q, issue, node, actor, nil)
	return err
}

// ensureCockpitPrimaryReceipt locks the creation receipt, creating it when the
// issue predates the receipt table. Its node_id stays NULL: the filing lives on
// issue.work_item_id, and the receipt only keeps creation-key idempotency.
func ensureCockpitPrimaryReceipt(ctx context.Context, q *db.Queries, issue db.Issue, actor pgtype.UUID, create *CockpitNodeTaskCreate) (db.CockpitIssuePrimary, error) {
	receipt, err := q.LockCockpitIssuePrimary(ctx, db.LockCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID})
	if err == nil {
		return receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return receipt, err
	}
	params := db.CreateCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, CreatedBy: actor}
	if create != nil {
		params.CreationKey = create.CreationKey
		params.CreationNodeID = create.NodeID
		params.CreationHash = nodeTaskCreationHash(*create)
	}
	return q.CreateCockpitIssuePrimary(ctx, params)
}

// SetCockpitIssuePrimaryNode is the compatibility surface for the old primary
// endpoint: it now writes issue.work_item_id and uses the ISSUE's revision for
// the optimistic check (the receipt revision no longer guards a filing).
func (s *IssueService) SetCockpitIssuePrimaryNode(ctx context.Context, p CockpitPrimaryNodeCommand) (db.CockpitIssuePrimary, error) {
	if p.ExpectedRevision < 0 {
		return db.CockpitIssuePrimary{}, fmt.Errorf("%w: expected_revision must not be negative", ErrCockpitWorkflowInput)
	}
	tx, q, err := beginPlanning(ctx, s, p.WorkspaceID, p.ActorID)
	if err != nil {
		return db.CockpitIssuePrimary{}, err
	}
	defer tx.Rollback(ctx)
	issue, err := q.LockIssueForDescriptionUpdate(ctx, db.LockIssueForDescriptionUpdateParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID})
	if err != nil {
		return db.CockpitIssuePrimary{}, planningError(err)
	}
	if issue.Revision != p.ExpectedRevision {
		return db.CockpitIssuePrimary{}, ErrCockpitWorkflowConflict
	}
	if issue.WorkItemID == p.NodeID {
		receipt, err := ensureCockpitPrimaryReceipt(ctx, q, issue, p.ActorID, nil)
		if err != nil {
			return receipt, err
		}
		receipt.Revision = issue.Revision
		receipt.NodeID = issue.WorkItemID
		if err := tx.Commit(ctx); err != nil {
			return receipt, err
		}
		return receipt, nil
	}
	var receipt db.CockpitIssuePrimary
	if p.NodeID.Valid {
		node, _, _, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
		if err != nil {
			return db.CockpitIssuePrimary{}, err
		}
		var refiled []db.RefileIssueSubtreeRow
		receipt, _, refiled, err = attachPlanningPrimary(ctx, q, issue, node, p.ActorID, nil)
		if err != nil {
			return receipt, err
		}
		p.refiled = refiled
	} else {
		// Unfiling leaves the issue in its current project/module; the work
		// item was the only thing being withdrawn.
		//
		// I4 cuts both ways: a child may not keep a filing its parent lost.
		// The subtree unfile together, so a child's work item (and every
		// descendant's) is withdrawn with the parent's — the subtree query
		// clears each row's own work_item_id, not just the root's.
		if issue.ParentIssueID.Valid {
			parent, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: issue.ParentIssueID, WorkspaceID: p.WorkspaceID})
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return db.CockpitIssuePrimary{}, err
			}
			if err == nil && parent.WorkItemID != p.NodeID {
				// The parent is filed elsewhere; clearing this child's filing
				// would strand it outside its parent's work item.
				return db.CockpitIssuePrimary{}, fmt.Errorf("%w: a sub-issue must stay in its parent's work item", ErrChildWorkItemMismatch)
			}
		}
		if err := q.ClearCockpitPrimaryNodeIDsForSubtree(ctx, db.ClearCockpitPrimaryNodeIDsForSubtreeParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID}); err != nil {
			return db.CockpitIssuePrimary{}, err
		}
		// The root unfiles first; the descendants follow through the subtree
		// write, which returns exactly the rows that changed for broadcasting.
		if err := q.SetIssueWorkItem(ctx, db.SetIssueWorkItemParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, ProjectID: issue.ProjectID, ModuleID: issue.ModuleID}); err != nil {
			return db.CockpitIssuePrimary{}, err
		}
		refiled, err := q.RefileIssueSubtree(ctx, db.RefileIssueSubtreeParams{ParentIssueID: p.IssueID, WorkspaceID: p.WorkspaceID, ProjectID: issue.ProjectID, ModuleID: issue.ModuleID})
		if err != nil {
			return db.CockpitIssuePrimary{}, err
		}
		p.refiled = refiled
		receipt, err = ensureCockpitPrimaryReceipt(ctx, q, issue, p.ActorID, nil)
		if err != nil {
			return receipt, err
		}
	}
	updated, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID})
	if err != nil {
		return receipt, err
	}
	receipt.Revision = updated.Revision
	receipt.NodeID = updated.WorkItemID
	if err := tx.Commit(ctx); err != nil {
		return receipt, err
	}
	s.publishIssueFilingUpdate(ctx, updated, issue.ProjectID, issue.ModuleID, issue.WorkItemID, p.ActorID)
	s.publishRefiledSubtree(ctx, p.refiled, p.ActorID)
	s.primaryChanged(p.WorkspaceID, p.ActorID, p.IssueID, issue.WorkItemID, p.NodeID)
	return receipt, nil
}

// publishIssueFilingUpdate tells issue subscribers that the filing moved. The
// flags mirror the update handler: a derived project/module move still sets
// them, unlike a work-item change made through UpdateIssue.
func (s *IssueService) publishIssueFilingUpdate(ctx context.Context, issue db.Issue, previousProject, previousModule, previousWorkItem, actor pgtype.UUID) {
	if s.Bus == nil {
		return
	}
	workspace, err := s.Queries.GetWorkspace(ctx, issue.WorkspaceID)
	if err != nil {
		return
	}
	s.Bus.Publish(events.Event{Type: protocol.EventIssueUpdated, WorkspaceID: util.UUIDToString(issue.WorkspaceID), ActorType: "member", ActorID: util.UUIDToString(actor), Payload: map[string]any{
		"issue":             IssueToMapResolved(ctx, s.Queries, issue, workspace.IssuePrefix),
		"work_item_changed": previousWorkItem != issue.WorkItemID,
		"project_changed":   previousProject != issue.ProjectID,
		"module_changed":    previousModule != issue.ModuleID,
		"prev_work_item_id": planningUUID(previousWorkItem),
	}})
}

// publishRefiledSubtree broadcasts each descendant row a subtree refile
// changed. The rows come back from the same write that bumped their
// revisions, so every listener learns its own issue moved.
func (s *IssueService) publishRefiledSubtree(ctx context.Context, rows []db.RefileIssueSubtreeRow, actor pgtype.UUID) {
	if s.Bus == nil {
		return
	}
	for _, row := range rows {
		s.Bus.Publish(events.Event{Type: protocol.EventIssueUpdated, WorkspaceID: util.UUIDToString(row.WorkspaceID), ActorType: "member", ActorID: util.UUIDToString(actor), Payload: map[string]any{
			"issue": map[string]any{
				"id": util.UUIDToString(row.ID), "workspace_id": util.UUIDToString(row.WorkspaceID),
				"project_id": planningUUID(row.ProjectID), "module_id": planningUUID(row.ModuleID),
				"work_item_id": planningUUID(row.WorkItemID), "revision": row.Revision, "updated_at": row.UpdatedAt.Time,
			},
			"work_item_changed": true, "project_changed": true, "module_changed": true,
		}})
	}
}

func nodeTaskCreationHash(p CockpitNodeTaskCreate) string {
	return planningHash(struct {
		Node, Actor                                     pgtype.UUID
		Title, Description, Priority, AssigneeType, Due string
		Assignee                                        pgtype.UUID
	}{
		p.NodeID, p.ActorID, p.NewIssue.Title, p.NewIssue.Description.String, p.NewIssue.Priority, p.NewIssue.AssigneeType.String, planningDate(p.NewIssue.DueDate), p.NewIssue.AssigneeID})
}
func (s *IssueService) CreateCockpitNodeTask(ctx context.Context, p CockpitNodeTaskCreate, opts IssueCreateOpts) (IssueCreateResult, error) {
	if !p.CreationKey.Valid {
		return IssueCreateResult{}, fmt.Errorf("%w: creation_key is required", ErrCockpitWorkflowInput)
	}
	title, description, _, err := normalizeActionText(p.NewIssue.Title, p.NewIssue.Description.String, "")
	if err != nil {
		return IssueCreateResult{}, err
	}
	p.NewIssue.Title = title
	p.NewIssue.Description = pgtype.Text{String: description, Valid: true}
	if err := normalizePlanningIssue(&p.NewIssue, p.ActorID); err != nil {
		return IssueCreateResult{}, err
	}
	opts.AssignedAgentRunFireAt = time.Time{}
	hook := &cockpitPlanningIssue{create: &p}
	result, err := s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitPlanning: hook}, opts)
	if err == nil && hook.created {
		s.primaryChanged(p.WorkspaceID, p.ActorID, result.Issue.ID, pgtype.UUID{}, p.NodeID)
	}
	return result, planningError(err)
}

func prepareCockpitPlanningIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	hook := p.CockpitPlanning
	if err := cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.CreatorID); err != nil {
		return nil, err
	}
	var nodeID pgtype.UUID
	var next IssueCreateParams
	if hook.action != nil {
		in := *hook.action
		if _, err := lockCockpitWorkflowMeeting(ctx, q, in.WorkspaceID, in.MeetingID); err != nil {
			return nil, err
		}
		work, err := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: in.WorkspaceID, ID: in.MeetingID})
		if err != nil {
			return nil, planningError(err)
		}
		a, v, err := loadPlanningAction(ctx, q, minutesStateFromLock(in.WorkspaceID, work), in.ActionID, in.ActorID)
		if err != nil {
			return nil, err
		}
		if replay, err := checkActionResolution(a, in); replay || err != nil {
			if err != nil {
				return nil, err
			}
			issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: a.IssueID})
			if err != nil {
				return nil, fmt.Errorf("%w: confirmed action issue is unavailable", ErrCockpitWorkflowConflict)
			}
			return &issue, nil
		}
		if err := checkActionSource(minutesStateFromLock(in.WorkspaceID, work), v, a.SourceQuote, true); err != nil {
			return nil, err
		}
		hook.row = a
		nodeID = in.NodeID
		next = in.NewIssue
		next.Title = a.Title
		description := a.Description
		if a.SourceQuote != "" {
			description += "\n\nSource quote:\n> " + strings.ReplaceAll(a.SourceQuote, "\n", "\n> ")
		}
		description += fmt.Sprintf("\n\nMeeting: %s\nPublished minutes version: %s\nAction: %s", util.UUIDToString(a.MeetingID), util.UUIDToString(a.VersionID), util.UUIDToString(a.ID))
		next.Description = pgtype.Text{String: strings.TrimSpace(description), Valid: true}
	} else {
		in := *hook.create
		if _, err := q.LockWorkspaceForChatSessionCreate(ctx, in.WorkspaceID); err != nil {
			return nil, planningError(err)
		}
		if _, err := q.LockCockpitForWorkspaceChanges(ctx, in.WorkspaceID); err != nil {
			return nil, planningError(err)
		}
		prior, err := q.GetCockpitNodeTaskCreation(ctx, db.GetCockpitNodeTaskCreationParams{WorkspaceID: in.WorkspaceID, CreationKey: in.CreationKey})
		if err == nil {
			if prior.CreatedBy != in.ActorID || prior.CreationNodeID != in.NodeID || prior.CreationHash != nodeTaskCreationHash(in) {
				return nil, fmt.Errorf("%w: creation key was already used for another intent", ErrCockpitWorkflowConflict)
			}
			if prior.IssueDeletedAt.Valid {
				return nil, fmt.Errorf("%w: issue created by this key was deleted", ErrCockpitWorkflowConflict)
			}
			issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: in.WorkspaceID, ID: prior.IssueID})
			if err != nil {
				return nil, fmt.Errorf("%w: issue created by this key is unavailable", ErrCockpitWorkflowConflict)
			}
			return &issue, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		nodeID = in.NodeID
		next = in.NewIssue
	}
	node, project, module, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, nodeID)
	if err != nil {
		return nil, err
	}
	hook.node = node
	next.WorkspaceID = p.WorkspaceID
	next.CreatorID = p.CreatorID
	next.CreatorType = "member"
	// The work item is the filing authority; Create derives (and verifies)
	// project/module from it. The pair is passed too so the request is
	// explicit about the scope the node resolved to.
	next.WorkItemID = node.ID
	next.ProjectID = project
	next.ModuleID = module
	next.Status = "backlog"
	next.AllowDuplicate = true
	next.CockpitPlanning = hook
	*p = next
	return nil, nil
}
func linkCockpitPlanningIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	hook := p.CockpitPlanning
	if _, _, _, err := attachPlanningPrimary(ctx, q, issue, hook.node, p.CreatorID, hook.create); err != nil {
		return err
	}
	if hook.action != nil {
		in := *hook.action
		in.IssueID = issue.ID
		_, err := resolvePlanningAction(ctx, q, hook.row, in, hook.node)
		if err == nil {
			hook.created = true
		}
		return planningError(err)
	}
	hook.created = true
	return nil
}
