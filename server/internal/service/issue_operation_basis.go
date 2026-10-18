package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func operationField(state string, reasons ...string) IssueOperationField {
	if reasons == nil {
		reasons = []string{}
	}
	return IssueOperationField{State: state, ReasonCodes: reasons}
}
func unknownIssueOperationBasis(id, availability string) IssueOperationBasis {
	f := operationField("unknown", "basis_unavailable")
	return IssueOperationBasis{IssueID: id, Availability: availability, Status: IssueStatusOperationField{IssueOperationField: f, AllowedCategories: []string{}}, Assignee: f, Scope: f, Parent: f, Primary: f, Delete: f, Execution: f, Targets: []IssueOperationTarget{}}
}

type issueOperationFacts struct {
	InputHistory            bool                   `json:"input_history"`
	ID                      string                 `json:"id"`
	Revision                int64                  `json:"revision"`
	ProjectID               *string                `json:"project_id"`
	ModuleID                *string                `json:"module_id"`
	ParentIssueID           *string                `json:"parent_issue_id"`
	TriageState             *string                `json:"triage_state"`
	FormalStage             string                 `json:"formal_stage"`
	RetainedSelf            bool                   `json:"retained_self"`
	RetainedScope           bool                   `json:"retained_scope"`
	PrimaryScope            bool                   `json:"primary_scope"`
	HasPrimary              bool                   `json:"has_primary"`
	MeetingHistory          bool                   `json:"meeting_history"`
	MeetingExecutionBlocked bool                   `json:"meeting_execution_blocked"`
	HierarchyCycle          bool                   `json:"hierarchy_cycle"`
	Targets                 []IssueOperationTarget `json:"targets"`
	TargetsTotal            int64                  `json:"targets_total"`
}

func projectIssueOperationBasis(f issueOperationFacts, human bool) IssueOperationBasis {
	allow := operationField("allowed")
	out := IssueOperationBasis{IssueID: f.ID, Availability: "available", IssueRevision: &f.Revision, Status: IssueStatusOperationField{IssueOperationField: allow, AllowedCategories: []string{"unstarted", "started", "done", "closed"}}, Assignee: allow, Scope: allow, Parent: allow, Primary: allow, Delete: allow, Execution: allow, Targets: f.Targets, TargetsTotal: f.TargetsTotal}
	if out.Targets == nil {
		out.Targets = []IssueOperationTarget{}
	}
	if f.ParentIssueID != nil {
		out.Scope = operationField("allowed", "parent_scope_requires_detach")
	}
	if f.PrimaryScope {
		out.Scope = operationField("blocked", "primary_scope")
	}
	if f.RetainedScope {
		out.Scope = operationField("blocked", "retained_artifact_scope")
	}
	if f.RetainedSelf {
		out.Delete = operationField("blocked", "retained_formal_history")
	}
	if f.MeetingHistory {
		out.Delete = operationField("blocked", "retained_meeting_history")
	}
	if f.InputHistory {
		out.Delete = operationField("blocked", "retained_input_history")
	}
	if f.MeetingExecutionBlocked {
		out.Execution = operationField("blocked", "meeting_execution_gate")
	}
	if f.TriageState != nil {
		out.Parent = operationField("blocked", "issue_in_triage")
		out.Execution = operationField("blocked", "issue_in_triage")
	}
	if (f.ProjectID == nil || f.ModuleID == nil) && !f.HasPrimary {
		out.Primary = operationField("blocked", "primary_scope_required")
	}
	if !human {
		out.Primary = operationField("blocked", "human_required")
	}
	if f.FormalStage != "" {
		out.Assignee = operationField("blocked", "formal_reviewer_binding")
		out.Scope = operationField("blocked", "formal_review_scope")
		out.Primary = operationField("blocked", "formal_review_scope")
		out.Delete = operationField("blocked", "retained_formal_history")
		out.Execution = operationField("blocked", "human_formal_review")
		out.Status.ReasonCodes = []string{"formal_review_status"}
		switch f.FormalStage {
		case "pending":
			out.Status.AllowedCategories = []string{"unstarted", "started"}
		case "done":
			out.Status.AllowedCategories = []string{"done"}
		case "closed":
			out.Status.AllowedCategories = []string{"closed"}
		default:
			out.Status = IssueStatusOperationField{IssueOperationField: operationField("unknown", "unknown_formal_stage"), AllowedCategories: []string{}}
		}
	}
	if f.HierarchyCycle {
		out.Scope = operationField("unknown", "hierarchy_cycle")
		out.Parent = operationField("unknown", "hierarchy_cycle")
	}
	return out
}

func (s *IssueService) ListIssueOperationBasis(ctx context.Context, p IssueOperationBasisQuery) (IssueOperationBasisPage, error) {
	out := IssueOperationBasisPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), SchemaVersion: 1, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Items: []IssueOperationBasis{}}
	if len(p.IssueIDs) == 0 || len(p.IssueIDs) > 100 {
		return out, fmt.Errorf("%w: issue_ids requires 1–100 distinct UUIDs", ErrCockpitWorkflowInput)
	}
	seen := map[pgtype.UUID]bool{}
	for _, id := range p.IssueIDs {
		if !id.Valid || seen[id] {
			return out, fmt.Errorf("%w: issue_ids must be distinct UUIDs", ErrCockpitWorkflowInput)
		}
		seen[id] = true
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
		return out, err
	}
	payload, err := q.ReadIssueOperationBasisFacts(ctx, db.ReadIssueOperationBasisFactsParams{WorkspaceID: p.WorkspaceID, IssueIds: p.IssueIDs})
	if err != nil {
		return out, err
	}
	var facts []issueOperationFacts
	if err = json.Unmarshal(payload, &facts); err != nil {
		return out, err
	}
	byID := make(map[string]IssueOperationBasis, len(facts))
	for _, f := range facts {
		byID[f.ID] = projectIssueOperationBasis(f, p.Human)
	}
	for _, id := range p.IssueIDs {
		key := util.UUIDToString(id)
		basis, ok := byID[key]
		if !ok {
			basis = unknownIssueOperationBasis(key, "unavailable")
		}
		out.Items = append(out.Items, basis)
	}
	return out, tx.Commit(ctx)
}

func (s *IssueService) GetContainerOperationBasis(ctx context.Context, p ContainerOperationBasisQuery) (ContainerOperationBasis, error) {
	unknown := operationField("unknown", "basis_unavailable")
	out := ContainerOperationBasis{WorkspaceID: util.UUIDToString(p.WorkspaceID), SchemaVersion: 1, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), ResourceKind: p.ResourceKind, ResourceID: util.UUIDToString(p.ResourceID), Availability: "unavailable", Delete: unknown, StructuralEdit: unknown, AddChild: unknown, Targets: []IssueOperationTarget{}}
	if !p.ResourceID.Valid || (p.ResourceKind != "node" && p.ResourceKind != "project" && p.ResourceKind != "module") {
		return out, ErrCockpitWorkflowInput
	}
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	member, err := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: p.ActorID, WorkspaceID: p.WorkspaceID})
	if err != nil {
		return out, cockpitWorkflowError(err)
	}
	if p.ResourceKind == "node" {
		raw, e := q.ReadCockpitNodeOperationBasisFacts(ctx, db.ReadCockpitNodeOperationBasisFactsParams{WorkspaceID: p.WorkspaceID, NodeID: p.ResourceID})
		if e != nil {
			return out, e
		}
		var f struct {
			Exists         bool                   `json:"exists"`
			RetainedScope  bool                   `json:"retained_scope"`
			PrimaryScope   bool                   `json:"primary_scope"`
			ActionScope    bool                   `json:"action_scope"`
			RetainedSelf   bool                   `json:"retained_self"`
			PrimarySelf    bool                   `json:"primary_self"`
			HierarchyCycle bool                   `json:"hierarchy_cycle"`
			HasChildren    bool                   `json:"has_children"`
			Targets        []IssueOperationTarget `json:"targets"`
			TargetsTotal   int64                  `json:"targets_total"`
		}
		if e = json.Unmarshal(raw, &f); e != nil {
			return out, e
		}
		if !f.Exists {
			return out, tx.Commit(ctx)
		}
		out.Availability = "available"
		out.Delete = operationField("allowed")
		out.StructuralEdit = operationField("allowed")
		out.AddChild = operationField("allowed")
		out.Targets = f.Targets
		out.TargetsTotal = f.TargetsTotal
		if f.HasChildren {
			out.Delete = operationField("blocked", "node_has_children")
		}
		if f.ActionScope {
			out.Delete = operationField("blocked", "retained_meeting_action")
		}
		if f.PrimaryScope {
			out.Delete = operationField("blocked", "primary_scope")
			out.StructuralEdit = operationField("blocked", "primary_scope")
		}
		if f.RetainedScope {
			out.Delete = operationField("blocked", "retained_artifact_scope")
			out.StructuralEdit = operationField("blocked", "retained_artifact_scope")
		}
		if f.PrimarySelf {
			out.AddChild = operationField("blocked", "primary_execution_leaf")
		}
		if f.RetainedSelf {
			out.AddChild = operationField("blocked", "retained_execution_leaf")
		}
		if f.HierarchyCycle {
			out.Delete = operationField("unknown", "hierarchy_cycle")
			out.StructuralEdit = out.Delete
			out.AddChild = out.Delete
		}
		return out, tx.Commit(ctx)
	}
	var projectID, moduleID pgtype.UUID
	if p.ResourceKind == "project" {
		_, err = q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.ResourceID})
		projectID = p.ResourceID
	} else {
		_, err = q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.ResourceID})
		moduleID = p.ResourceID
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return out, tx.Commit(ctx)
	}
	if err != nil {
		return out, err
	}
	out.Availability = "available"
	out.Delete = operationField("allowed")
	out.StructuralEdit = operationField("unknown", "not_applicable")
	out.AddChild = operationField("unknown", "not_applicable")
	retained, err := q.HasCockpitArtifactScope(ctx, db.HasCockpitArtifactScopeParams{WorkspaceID: p.WorkspaceID, ProjectID: projectID, ModuleID: moduleID})
	if err != nil {
		return out, err
	}
	var primary bool
	if projectID.Valid {
		primary, err = q.HasCockpitPrimaryForProject(ctx, db.HasCockpitPrimaryForProjectParams{WorkspaceID: p.WorkspaceID, ProjectID: projectID})
	} else {
		primary, err = q.HasCockpitPrimaryForModule(ctx, db.HasCockpitPrimaryForModuleParams{WorkspaceID: p.WorkspaceID, ModuleID: moduleID})
	}
	if err != nil {
		return out, err
	}
	if primary {
		out.Delete = operationField("blocked", "primary_scope")
	}
	if retained {
		out.Delete = operationField("blocked", "retained_artifact_scope")
	}
	if member.Role != "owner" && member.Role != "admin" {
		out.Delete = operationField("blocked", "workspace_admin_required")
	}
	raw, err := q.ReadContainerOperationBasisTargets(ctx, db.ReadContainerOperationBasisTargetsParams{WorkspaceID: p.WorkspaceID, ProjectID: projectID, ModuleID: moduleID})
	if err != nil {
		return out, err
	}
	var targets struct {
		Items []IssueOperationTarget `json:"items"`
		Total int64                  `json:"total"`
	}
	if err = json.Unmarshal(raw, &targets); err != nil {
		return out, err
	}
	out.Targets = targets.Items
	out.TargetsTotal = targets.Total
	return out, tx.Commit(ctx)
}
