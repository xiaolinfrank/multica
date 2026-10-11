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
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type preparationEffectIntent struct {
	Slot                  CockpitMeetingTemplateSlot       `json:"slot"`
	Binding               CockpitMeetingTemplateBinding    `json:"binding"`
	NodeID                *string                          `json:"node_id"`
	ProjectID             *string                          `json:"project_id"`
	ModuleID              *string                          `json:"module_id"`
	ExpectedIssueRevision int64                            `json:"expected_issue_revision"`
	IssueChoice           *CockpitCancellationIssueChoice  `json:"issue_choice,omitempty"`
	RunID                 *string                          `json:"run_id,omitempty"`
	FactsHash             string                           `json:"facts_hash"`
	DispositionFacts      *dispositionIssueFacts           `json:"disposition_facts,omitempty"`
	ExpectedRunStatus     string                           `json:"expected_run_status,omitempty"`
	SelectedRun           *CockpitDispositionRun           `json:"selected_run,omitempty"`
	Scope                 *CockpitPreparationResolvedScope `json:"scope,omitempty"`
	SelectedRunIDs        []string                         `json:"selected_run_ids,omitempty"`
}

type templatePreviewPlan struct {
	View     CockpitTemplateApplicationPreview
	Template db.CockpitMeetingTemplateVersion
	Intents  []preparationEffectIntent
}

func templateTargetError(e error) (string, error) {
	switch {
	case errors.Is(e, ErrCockpitWorkflowNotFound):
		return "target_unavailable", nil
	case errors.Is(e, ErrCockpitWorkflowForbidden):
		return "target_forbidden", nil
	case errors.Is(e, ErrCockpitWorkflowConflict):
		return "target_changed", nil
	case errors.Is(e, ErrCockpitWorkflowInput):
		return "target_invalid", nil
	default:
		return "", e
	}
}

func readTemplatePreview(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, x lifecycleState, in CockpitTemplateApplicationPreviewInput) (templatePreviewPlan, error) {
	var plan templatePreviewPlan
	version, e := util.ParseUUID(in.TemplateVersionID)
	if e != nil || !version.Valid {
		return plan, ErrCockpitWorkflowInput
	}
	v, e := q.GetCockpitMeetingTemplateVersionByID(ctx, db.GetCockpitMeetingTemplateVersionByIDParams{WorkspaceID: p.WorkspaceID, ID: version})
	if e != nil {
		return plan, cockpitWorkflowError(e)
	}
	d, e := readTemplateVersionReceipt(v)
	if e != nil {
		return plan, e
	}
	bindings, e := normalizeTemplateBindings(d.Config, in.Bindings)
	if e != nil {
		return plan, e
	}
	h, e := q.GetCockpitMeetingTemplateHeader(ctx, db.GetCockpitMeetingTemplateHeaderParams{WorkspaceID: p.WorkspaceID, ID: v.TemplateID})
	if e != nil {
		return plan, cockpitWorkflowError(e)
	}
	plan.Template = v
	plan.View = CockpitTemplateApplicationPreview{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), TemplateID: util.UUIDToString(v.TemplateID), TemplateVersionID: util.UUIDToString(v.ID), LifecycleRevision: x.meeting.LifecycleRevision, AgendaRevision: x.meeting.AgendaRevision, ConfigHash: v.ConfigHash, Effects: []CockpitPreparationPreviewEffect{}, CanConfirm: p.Human, BlockedReasons: []string{}}
	if !p.Human {
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "human_required")
	}
	if !h.CockpitMeetingTemplate.IsActive || !v.IsActive {
		plan.View.CanConfirm = false
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "template_inactive")
	}
	if e = requireMeetingPreparationOpen(x.meeting); e != nil {
		plan.View.CanConfirm = false
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "meeting_preparation_closed")
	}
	ordered := make([]CockpitMeetingTemplateSlot, 0, len(d.Config.Slots))
	for _, slot := range d.Config.Slots {
		if slot.Kind == "agenda" {
			ordered = append(ordered, slot)
		}
	}
	for _, slot := range d.Config.Slots {
		if slot.Kind != "agenda" {
			ordered = append(ordered, slot)
		}
	}
	agendaIntents := map[string]preparationEffectIntent{}
	facts := []any{x.meeting.LifecycleRevision, x.meeting.AgendaRevision, h.CockpitMeetingTemplate.Revision, v.ConfigHash}
	for _, slot := range ordered {
		b := bindings[slot.SlotID]
		item := CockpitPreparationPreviewEffect{SlotID: slot.SlotID, Kind: slot.Kind, Label: slot.Label, AgendaSlotID: slot.AgendaSlotID, Selected: b.Selected, Allowed: true, ReasonCodes: []string{}, Targets: []IssueOperationTarget{}}
		intent := preparationEffectIntent{Slot: slot, Binding: b}
		if b.Selected {
			plan.View.SelectedTotal++
			var targetErr error
			switch slot.Kind {
			case "agenda":
				if b.NodeID != nil {
					id, _ := preparationUUID(b.NodeID)
					node, project, module, err := requireExecutionLeaf(ctx, q, p.WorkspaceID, id)
					targetErr = err
					if err == nil {
						intent.NodeID = planningUUID(node.ID)
						intent.ProjectID = planningUUID(project)
						intent.ModuleID = planningUUID(module)
						item.Targets = append(item.Targets, IssueOperationTarget{Kind: "node", NodeID: *intent.NodeID, View: "details", Label: node.Name, Purpose: "preparation"})
						facts = append(facts, []any{node.ID, project, module})
					}
				}
				if targetErr == nil && b.FacilitatorUserID != nil {
					id, _ := preparationUUID(b.FacilitatorUserID)
					targetErr = cockpitWorkflowMember(ctx, q, p.WorkspaceID, id)
					facts = append(facts, b.FacilitatorUserID)
				}
				agendaIntents[slot.SlotID] = intent
			case "preparation_issue":
				parent := agendaIntents[*slot.AgendaSlotID]
				intent.NodeID = parent.NodeID
				intent.ProjectID = parent.ProjectID
				intent.ModuleID = parent.ModuleID
				project, _ := preparationUUID(b.ProjectID)
				module, _ := preparationUUID(b.ModuleID)
				if parent.NodeID != nil {
					pp, _ := preparationUUID(parent.ProjectID)
					pm, _ := preparationUUID(parent.ModuleID)
					if (project.Valid && project != pp) || (module.Valid && module != pm) {
						targetErr = ErrCockpitWorkflowConflict
					}
				} else {
					intent.ProjectID = b.ProjectID
					intent.ModuleID = b.ModuleID
					if module.Valid {
						m, err := q.GetModuleInWorkspace(ctx, db.GetModuleInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: module})
						targetErr = cockpitWorkflowError(err)
						if err == nil {
							if project.Valid && project != m.ProjectID {
								targetErr = ErrCockpitWorkflowConflict
							} else {
								project = m.ProjectID
								intent.ProjectID = planningUUID(project)
							}
						}
					}
					if targetErr == nil && project.Valid {
						_, err := q.GetProjectInWorkspace(ctx, db.GetProjectInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: project})
						targetErr = cockpitWorkflowError(err)
					}
				}
				if targetErr == nil && b.AssigneeID != nil {
					id, _ := preparationUUID(b.AssigneeID)
					targetErr = validateArtifactProducerAssignee(ctx, q, p.WorkspaceID, p.ActorID, *b.AssigneeType, id)
				}
				if b.DueDate != nil {
					if _, err := time.Parse("2006-01-02", *b.DueDate); err != nil {
						targetErr = ErrCockpitWorkflowInput
					}
				}
				facts = append(facts, []any{intent.NodeID, intent.ProjectID, intent.ModuleID, b.AssigneeID, b.AssigneeType})
			case "issue_reference":
				id, _ := preparationUUID(b.IssueID)
				i, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: id})
				targetErr = cockpitWorkflowError(err)
				if err == nil {
					intent.ExpectedIssueRevision = i.Revision
					item.Targets = append(item.Targets, IssueOperationTarget{Kind: "issue", IssueID: util.UUIDToString(i.ID), Label: i.Title, Purpose: slot.Purpose})
					facts = append(facts, []any{i.ID, i.Revision})
				}
			case "material_reference":
				id, _ := preparationUUID(b.MaterialReferenceID)
				rows, err := q.ListCockpitAgendaArtifactTargets(ctx, db.ListCockpitAgendaArtifactTargetsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Ids: []pgtype.UUID{id}})
				targetErr = err
				if err == nil {
					if len(rows) != 1 || rows[0].RemovedAt.Valid {
						targetErr = ErrCockpitWorkflowConflict
					} else {
						r := rows[0]
						item.Targets = append(item.Targets, IssueOperationTarget{Kind: "artifact", ArtifactID: util.UUIDToString(r.ArtifactID), VersionID: util.UUIDToString(r.VersionID), Label: r.Title, Purpose: "material"})
						facts = append(facts, []any{id, r.VersionID, r.ContentHash})
					}
				}
			}
			if targetErr != nil {
				reason, err := templateTargetError(targetErr)
				if err != nil {
					return plan, err
				}
				item.Allowed = false
				item.ReasonCodes = append(item.ReasonCodes, reason)
				plan.View.CanConfirm = false
			}
			if targetErr == nil && (slot.Kind == "agenda" || slot.Kind == "preparation_issue") {
				intent.Scope, e = readPreparationScope(ctx, q, p.WorkspaceID, intent.NodeID, intent.ProjectID, intent.ModuleID)
				if e != nil {
					return plan, e
				}
				item.Scope = intent.Scope
				if slot.Kind == "agenda" {
					agendaIntents[slot.SlotID] = intent
				}
			}
			intent.FactsHash = planningHash([]any{intent.NodeID, intent.ProjectID, intent.ModuleID, intent.ExpectedIssueRevision, b.IssueID, b.MaterialReferenceID})
			plan.Intents = append(plan.Intents, intent)
		}
		plan.View.Effects = append(plan.View.Effects, item)
	}
	if plan.View.SelectedTotal == 0 {
		plan.View.CanConfirm = false
		plan.View.BlockedReasons = append(plan.View.BlockedReasons, "select_preparation_effects")
	}
	plan.View.ContextToken = planningHash([]any{"meeting_template_preview_v1", p.WorkspaceID, p.MeetingID, p.ActorID, in, facts})
	return plan, nil
}

func (s *IssueService) PreviewCockpitTemplateApplication(ctx context.Context, p CockpitLifecycleRead, in CockpitTemplateApplicationPreviewInput) (CockpitTemplateApplicationPreview, error) {
	tx, q, x, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return CockpitTemplateApplicationPreview{}, e
	}
	defer tx.Rollback(ctx)
	plan, e := readTemplatePreview(ctx, q, p, x, in)
	return plan.View, e
}

func (s *IssueService) CreateCockpitTemplateApplication(ctx context.Context, p CockpitLifecycleRead, in CockpitTemplateApplicationInput) (CockpitPreparationCommandResult, error) {
	var out CockpitPreparationCommandResult
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, "template_apply", pgtype.UUID{}, pgtype.UUID{}, in)
	if e != nil {
		return out, e
	}
	tx, q, x, old, e := s.beginLifecycleWrite(ctx, c)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if old != nil {
		return readPreparationCommandResult(ctx, q, p, c, *old)
	}
	version, e := util.ParseUUID(in.TemplateVersionID)
	if e != nil || !version.Valid {
		return out, ErrCockpitWorkflowInput
	}
	prior, e := q.GetCockpitTemplateApplication(ctx, db.GetCockpitTemplateApplicationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, TemplateVersionID: version})
	if e == nil {
		return out, &CockpitPreparationExistsError{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), TemplateVersionID: in.TemplateVersionID, OperationID: util.UUIDToString(prior.ID), CommandKey: in.CommandKey}
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	plan, e := readTemplatePreview(ctx, q, p, x, in.CockpitTemplateApplicationPreviewInput)
	if e != nil {
		return out, e
	}
	if !plan.View.CanConfirm || in.ExpectedRevision != x.meeting.LifecycleRevision || in.ContextToken != plan.View.ContextToken {
		return out, ErrCockpitPreparationContextChanged
	}
	o, receipt, e := createPreparationOperation(ctx, q, p, c, x, "apply_template", plan.Template.TemplateID, plan.Template.ID, in.ContextToken, in, plan.Intents)
	if e != nil {
		return out, e
	}
	envelope := CockpitLifecycleReceipt{Revision: x.meeting.LifecycleRevision, AgendaRevision: x.meeting.AgendaRevision, RequestHash: c.hash, Preparation: &receipt}
	if e = storeLifecycleReceipt(ctx, q, c, envelope); e != nil {
		return out, e
	}
	h, e := preparationHeader(ctx, q, p, o)
	if e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e != nil {
		return out, e
	}
	s.lifecycleChanged(c)
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: in.CommandKey, Action: c.action, Receipt: receipt, Current: h}, nil
}

func createPreparationOperation(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, c lifecycleCommand, x lifecycleState, kind string, template, version pgtype.UUID, token string, input any, intents []preparationEffectIntent) (db.CockpitMeetingPreparationOperation, CockpitPreparationCommandReceipt, error) {
	var receipt CockpitPreparationCommandReceipt
	if len(intents) > 50 {
		return db.CockpitMeetingPreparationOperation{}, receipt, ErrCockpitWorkflowInput
	}
	body, e := json.Marshal(input)
	if e != nil || len(body) > cockpitTemplateInputLimit {
		return db.CockpitMeetingPreparationOperation{}, receipt, ErrCockpitWorkflowInput
	}
	state := "active"
	if len(intents) == 0 {
		state = "completed"
	}
	o, e := q.CreateCockpitPreparationOperation(ctx, db.CreateCockpitPreparationOperationParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Kind: kind, CommandKey: c.key, RequestHash: c.hash, ContextToken: token, TemplateID: template, TemplateVersionID: version, Input: body, State: state, AuthorizedLifecycleRevision: x.meeting.LifecycleRevision, AuthorizedAgendaRevision: x.meeting.AgendaRevision, CreatedBy: p.ActorID})
	if e != nil {
		return o, receipt, e
	}
	effectIDs := []string{}
	dependencies := map[string]pgtype.UUID{}
	for i, intent := range intents {
		id := dbid.NewV7()
		key := dbid.NewV7()
		slot, e := util.ParseUUID(intent.Slot.SlotID)
		if e != nil {
			return o, receipt, e
		}
		var dependency pgtype.UUID
		if intent.Slot.AgendaSlotID != nil {
			dependency = dependencies[*intent.Slot.AgendaSlotID]
			if !dependency.Valid {
				return o, receipt, ErrCockpitWorkflowInput
			}
		}
		encoded, _ := json.Marshal(intent)
		grant := preparationAuthorizationFacts{CockpitPreparationAuthorization: CockpitPreparationAuthorization{Key: util.UUIDToString(c.key), Revision: 1, ContextToken: token, FactsHash: intent.FactsHash, ConfirmedBy: util.UUIDToString(p.ActorID), ConfirmedAt: o.CreatedAt.Time.UTC().Format(time.RFC3339Nano)}, IssueRevision: intent.ExpectedIssueRevision}
		grant.Scope = intent.Scope
		grant.SelectedRun = intent.SelectedRun
		grant.RunStatus = intent.ExpectedRunStatus
		if intent.DispositionFacts != nil {
			impact := intent.DispositionFacts.View
			impact.EvaluatesParentRules = intent.Slot.Kind == "cancel_issue" && impact.ParentIssueID != nil
			grant.Impact = &impact
			grant.WakeupHash = intent.DispositionFacts.Automation.WakeupHash
			grant.TaskHash = intent.DispositionFacts.Automation.TaskHash
		}
		grantBody, _ := json.Marshal(grant)
		issue, _ := preparationUUID(intent.Binding.IssueID)
		run, _ := preparationUUID(intent.RunID)
		var targetMeeting pgtype.UUID
		if intent.IssueChoice != nil {
			targetMeeting, _ = preparationUUID(intent.IssueChoice.TargetMeetingID)
		}
		_, e = q.CreateCockpitPreparationEffect(ctx, db.CreateCockpitPreparationEffectParams{ID: id, WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: o.ID, SlotID: slot, Position: int32(i), Kind: intent.Slot.Kind, Label: intent.Slot.Label, CommandKey: key, DependencyID: dependency, RequestHash: planningHash(intent), Input: encoded, IssueID: issue, RunID: run, TargetMeetingID: targetMeeting, AuthorizationKey: c.key, AuthorizationHash: grant.FactsHash, AuthorizationSnapshot: grantBody})
		if e != nil {
			return o, receipt, e
		}
		dependencies[intent.Slot.SlotID] = id
		effectIDs = append(effectIDs, util.UUIDToString(id))
	}
	receipt = CockpitPreparationCommandReceipt{OperationID: util.UUIDToString(o.ID), Kind: kind, Revision: o.Revision, State: state, EffectIDs: effectIDs, RequestHash: c.hash, ContextToken: token, TemplateVersionID: planningUUID(version)}
	return o, receipt, nil
}

func readPreparationCommandResult(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, c lifecycleCommand, old CockpitLifecycleCommandResult) (CockpitPreparationCommandResult, error) {
	if old.Receipt.Preparation == nil {
		return CockpitPreparationCommandResult{}, fmt.Errorf("preparation command is missing its fixed receipt")
	}
	id, e := util.ParseUUID(old.Receipt.Preparation.OperationID)
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	o, e := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id})
	if errors.Is(e, pgx.ErrNoRows) {
		return CockpitPreparationCommandResult{}, ErrCockpitLifecycleGone
	}
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	h, e := preparationHeader(ctx, q, p, o)
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: util.UUIDToString(c.key), Action: c.action, Replayed: true, Receipt: *old.Receipt.Preparation, Current: h}, nil
}
