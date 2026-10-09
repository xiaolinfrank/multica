package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
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
func attachPlanningPrimary(ctx context.Context, q *db.Queries, issue db.Issue, node db.CockpitNode, actor pgtype.UUID, refuseOther bool, create *CockpitNodeTaskCreate) (db.CockpitIssuePrimary, pgtype.UUID, error) {
	_, project, module, err := requireExecutionLeaf(ctx, q, issue.WorkspaceID, node.ID)
	if err != nil {
		return db.CockpitIssuePrimary{}, pgtype.UUID{}, err
	}
	if issue.ProjectID != project || issue.ModuleID != module {
		return db.CockpitIssuePrimary{}, pgtype.UUID{}, fmt.Errorf("%w: issue project/module does not match this L3; ownership never refiles an issue", ErrCockpitWorkflowConflict)
	}
	old, err := q.LockCockpitIssuePrimary(ctx, db.LockCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return old, pgtype.UUID{}, err
	}
	if err == nil {
		if old.NodeID == node.ID {
			return old, old.NodeID, nil
		}
		if refuseOther && old.NodeID.Valid {
			return old, old.NodeID, fmt.Errorf("%w: issue already belongs to another L3; move it explicitly first", ErrCockpitWorkflowConflict)
		}
		if old.NodeID.Valid {
			if err := q.EnsureCockpitNodeReference(ctx, db.EnsureCockpitNodeReferenceParams{WorkspaceID: issue.WorkspaceID, NodeID: old.NodeID, IssueID: issue.ID}); err != nil {
				return old, old.NodeID, err
			}
		}
		row, err := q.SetCockpitIssuePrimary(ctx, db.SetCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, NodeID: node.ID, ActorID: actor, ExpectedRevision: old.Revision})
		return row, old.NodeID, planningError(err)
	}
	params := db.CreateCockpitIssuePrimaryParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, NodeID: node.ID, CreatedBy: actor}
	if create != nil {
		params.CreationKey = create.CreationKey
		params.CreationNodeID = create.NodeID
		params.CreationHash = nodeTaskCreationHash(*create)
	}
	row, err := q.CreateCockpitIssuePrimary(ctx, params)
	return row, pgtype.UUID{}, planningError(err)
}
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
	old, err := q.LockCockpitIssuePrimary(ctx, db.LockCockpitIssuePrimaryParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return old, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		old = db.CockpitIssuePrimary{IssueID: p.IssueID, WorkspaceID: p.WorkspaceID}
	}
	if old.Revision != p.ExpectedRevision {
		return old, ErrCockpitWorkflowConflict
	}
	if old.NodeID == p.NodeID {
		return old, nil
	}
	var row db.CockpitIssuePrimary
	if p.NodeID.Valid {
		node, _, _, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, p.NodeID)
		if err != nil {
			return old, err
		}
		row, _, err = attachPlanningPrimary(ctx, q, issue, node, p.ActorID, false, nil)
		if err != nil {
			return old, err
		}
	} else {
		if err := q.EnsureCockpitNodeReference(ctx, db.EnsureCockpitNodeReferenceParams{WorkspaceID: p.WorkspaceID, NodeID: old.NodeID, IssueID: p.IssueID}); err != nil {
			return old, err
		}
		row, err = q.SetCockpitIssuePrimary(ctx, db.SetCockpitIssuePrimaryParams{WorkspaceID: p.WorkspaceID, IssueID: p.IssueID, NodeID: p.NodeID, ActorID: p.ActorID, ExpectedRevision: p.ExpectedRevision})
		if err != nil {
			return old, planningError(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return old, err
	}
	s.primaryChanged(p.WorkspaceID, p.ActorID, p.IssueID, old.NodeID, p.NodeID)
	return row, nil
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
		work, err := q.LockCockpitMeetingWorkPackage(ctx, db.LockCockpitMeetingWorkPackageParams{WorkspaceID: in.WorkspaceID, MeetingID: in.MeetingID})
		if err != nil {
			return nil, planningError(err)
		}
		a, v, err := loadPlanningAction(ctx, q, work, in.ActionID, in.ActorID)
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
		if err := checkActionSource(work, v, a.SourceQuote, true); err != nil {
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
	if _, _, err := attachPlanningPrimary(ctx, q, issue, hook.node, p.CreatorID, true, hook.create); err != nil {
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
