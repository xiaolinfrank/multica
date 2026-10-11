package service

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type cockpitPreparationIssue struct {
	command   lifecycleCommand
	input     CockpitPreparationIssueInput
	issue     IssueCreateParams
	node      db.CockpitNode
	primary   pgtype.UUID
	result    *CockpitLifecycleCommandResult
	created   bool
	execution *cockpitPreparationExecution
}

func preparationUUID(raw *string) (pgtype.UUID, error) {
	if raw == nil {
		return pgtype.UUID{}, nil
	}
	u, e := util.ParseUUID(*raw)
	if e != nil || !u.Valid {
		return u, fmt.Errorf("%w: selected identity must be a UUID or null", ErrCockpitWorkflowInput)
	}
	return u, nil
}
func (s *IssueService) CreateCockpitMeetingPreparationIssue(ctx context.Context, p CockpitLifecycleRead, agenda pgtype.UUID, in CockpitPreparationIssueInput, opts IssueCreateOpts) (CockpitLifecycleCommandResult, error) {
	return s.createCockpitPreparationIssue(ctx, p, agenda, in, opts, nil)
}
func (s *IssueService) createCockpitPreparationIssue(ctx context.Context, p CockpitLifecycleRead, agenda pgtype.UUID, in CockpitPreparationIssueInput, opts IssueCreateOpts, execution *cockpitPreparationExecution) (CockpitLifecycleCommandResult, error) {
	in.NewIssue.Title = strings.TrimSpace(in.NewIssue.Title)
	if in.NewIssue.Title == "" || utf8.RuneCountInString(in.NewIssue.Title) > 500 || len(in.NewIssue.Description) > 16000 {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	if in.NewIssue.Priority == "" {
		in.NewIssue.Priority = "none"
	}
	switch in.NewIssue.Priority {
	case "none", "urgent", "high", "medium", "low":
	default:
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	c, e := newLifecycleCommand(p, in.CockpitLifecycleCommandInput, "preparation_issue_create", agenda, pgtype.UUID{}, in)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	hook := &cockpitPreparationIssue{command: c, input: in, execution: execution}
	hook.primary, e = preparationUUID(in.PrimaryNodeID)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	v := IssueCreateParams{Title: in.NewIssue.Title, Description: pgtype.Text{String: in.NewIssue.Description, Valid: true}, Priority: in.NewIssue.Priority}
	v.ProjectID, e = preparationUUID(in.NewIssue.ProjectID)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	v.ModuleID, e = preparationUUID(in.NewIssue.ModuleID)
	if e != nil {
		return CockpitLifecycleCommandResult{}, e
	}
	if (in.NewIssue.AssigneeType == nil) != (in.NewIssue.AssigneeID == nil) {
		return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
	}
	if in.NewIssue.AssigneeType != nil {
		switch *in.NewIssue.AssigneeType {
		case "member", "agent", "squad":
		default:
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
		}
		v.AssigneeType = pgtype.Text{String: *in.NewIssue.AssigneeType, Valid: true}
		v.AssigneeID, e = preparationUUID(in.NewIssue.AssigneeID)
		if e != nil {
			return CockpitLifecycleCommandResult{}, e
		}
	}
	if in.NewIssue.DueDate != nil {
		t, e := time.Parse("2006-01-02", *in.NewIssue.DueDate)
		if e != nil {
			return CockpitLifecycleCommandResult{}, ErrCockpitWorkflowInput
		}
		v.DueDate = pgtype.Date{Time: t, Valid: true}
	}
	hook.issue = v
	opts.AssignedAgentRunFireAt = time.Time{}
	_, e = s.Create(ctx, IssueCreateParams{WorkspaceID: p.WorkspaceID, CreatorID: p.ActorID, CreatorType: "member", CockpitPreparation: hook}, opts)
	if e != nil {
		return CockpitLifecycleCommandResult{}, planningError(e)
	}
	if hook.result == nil {
		return CockpitLifecycleCommandResult{}, fmt.Errorf("preparation command committed without a receipt")
	}
	if hook.created {
		s.lifecycleChanged(c)
		if hook.primary.Valid {
			s.primaryChanged(p.WorkspaceID, p.ActorID, mustLifecycleUUID(hook.result.Receipt.IssueID), pgtype.UUID{}, hook.primary)
		}
	}
	return *hook.result, nil
}
func mustLifecycleUUID(s *string) pgtype.UUID {
	if s == nil {
		return pgtype.UUID{}
	}
	u, _ := util.ParseUUID(*s)
	return u
}
func prepareCockpitPreparationIssue(ctx context.Context, q *db.Queries, p *IssueCreateParams) (*db.Issue, error) {
	h := p.CockpitPreparation
	c := h.command
	if h.execution != nil {
		if e := h.execution.lock(ctx, q); e != nil {
			return nil, e
		}
		if h.execution.result != nil {
			r := h.execution.result.Receipt
			id, _ := preparationUUID(r.IssueID)
			issue, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: c.WorkspaceID, ID: id})
			if e != nil {
				return nil, e
			}
			h.result = &CockpitLifecycleCommandResult{WorkspaceID: util.UUIDToString(c.WorkspaceID), MeetingID: util.UUIDToString(c.MeetingID), CommandKey: util.UUIDToString(c.key), Replayed: true, Receipt: CockpitLifecycleReceipt{IssueID: r.IssueID, AgendaID: r.AgendaID, ReferenceID: r.ReferenceID}}
			return &issue, nil
		}
		c.agenda = h.execution.agenda
		current, e := q.GetCockpitMeetingAgenda(ctx, db.GetCockpitMeetingAgendaParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, ID: c.agenda})
		if e != nil {
			return nil, cockpitWorkflowError(e)
		}
		c.expected = current.Revision
		c.hash = h.execution.effect.RequestHash
		h.command = c
	} else {
		if e := lockLifecycleMember(ctx, q, c); e != nil {
			return nil, e
		}
		if old, e := lifecycleReplay(ctx, q, c); old != nil || e != nil {
			if e != nil {
				return nil, e
			}
			h.result = old
			i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: c.WorkspaceID, ID: mustLifecycleUUID(old.Receipt.IssueID)})
			return &i, e
		}
		if _, e := lockLifecycleMeeting(ctx, q, c.WorkspaceID, c.MeetingID); e != nil {
			return nil, e
		}
		if old, e := lifecycleReplay(ctx, q, c); old != nil || e != nil {
			if e != nil {
				return nil, e
			}
			h.result = old
			i, e := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: c.WorkspaceID, ID: mustLifecycleUUID(old.Receipt.IssueID)})
			return &i, e
		}

		if e := RequireCockpitMeetingPreparationOpen(ctx, q, c.WorkspaceID, c.MeetingID); e != nil {
			return nil, e
		}
	}
	a, e := loadActiveAgenda(ctx, q, c.CockpitLifecycleRead, c.agenda, c.expected)
	if e != nil {
		return nil, e
	}
	next := h.issue
	if h.execution != nil && h.primary.Valid {
		if e := h.execution.validateTemplateScope(ctx, q); e != nil {
			return nil, e
		}
		next.ProjectID, _ = preparationUUID(h.execution.grant.Scope.ProjectID)
		next.ModuleID, _ = preparationUUID(h.execution.grant.Scope.ModuleID)
	}
	if a.NodeID != h.primary {
		return nil, fmt.Errorf("%w: confirm the agenda's current L3 before creating its preparation issue", ErrCockpitWorkflowConflict)
	}
	if h.primary.Valid {
		node, project, module, e := requireExecutionLeaf(ctx, q, c.WorkspaceID, h.primary)
		if e != nil {
			return nil, e
		}
		h.node = node
		if (next.ProjectID.Valid && next.ProjectID != project) || (next.ModuleID.Valid && next.ModuleID != module) {
			return nil, fmt.Errorf("%w: preparation scope differs from the selected L3", ErrCockpitWorkflowConflict)
		}
		next.ProjectID = project
		next.ModuleID = module
	}
	if next.AssigneeID.Valid {
		if e = validateArtifactProducerAssignee(ctx, q, c.WorkspaceID, c.ActorID, next.AssigneeType.String, next.AssigneeID); e != nil {
			return nil, e
		}
	}
	next.WorkspaceID = c.WorkspaceID
	next.CreatorType = "member"
	next.CreatorID = c.ActorID
	next.Status = "backlog"
	next.AllowDuplicate = true
	next.CockpitPreparation = h
	*p = next
	return nil, nil
}
func linkCockpitPreparationIssue(ctx context.Context, q *db.Queries, p IssueCreateParams, issue db.Issue) error {
	h := p.CockpitPreparation
	c := h.command
	if h.primary.Valid {
		if _, _, e := attachPlanningPrimary(ctx, q, issue, h.node, c.ActorID, true, nil); e != nil {
			return e
		}
	}
	r, e := q.CreateCockpitAgendaReference(ctx, db.CreateCockpitAgendaReferenceParams{ID: dbid.NewV7(), WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, AgendaID: c.agenda, Kind: "issue", TargetID: issue.ID, Purpose: "preparation", ActorID: c.ActorID})
	if e != nil {
		return e
	}
	a, e := q.BumpCockpitAgendaItemRevision(ctx, db.BumpCockpitAgendaItemRevisionParams{WorkspaceID: c.WorkspaceID, MeetingID: c.MeetingID, ID: c.agenda, ExpectedRevision: c.expected, ActorID: c.ActorID})
	if e != nil {
		return e
	}
	rev, e := q.BumpCockpitAgendaRevision(ctx, db.BumpCockpitAgendaRevisionParams{WorkspaceID: c.WorkspaceID, ID: c.MeetingID})
	if e != nil {
		return e
	}
	refs, e := readAgendaReferences(ctx, q, c.CockpitLifecycleRead, []db.CockpitMeetingAgendaReference{r}, false)
	if e != nil {
		return e
	}
	receipt := CockpitLifecycleReceipt{Revision: a.Revision, AgendaRevision: rev, AgendaID: planningUUID(a.ID), ReferenceID: planningUUID(r.ID), IssueID: planningUUID(issue.ID), Reference: &refs[0], RequestHash: c.hash}
	if h.execution != nil {
		facts, e := readPlanningIssueFacts(ctx, q, c.WorkspaceID, []pgtype.UUID{issue.ID})
		if e != nil {
			return e
		}
		fixed, ok := facts[issue.ID]
		if !ok {
			return fmt.Errorf("created preparation issue facts are unavailable")
		}
		if e = h.execution.finish(ctx, q, CockpitPreparationEffectReceipt{AgendaID: planningUUID(a.ID), ReferenceID: planningUUID(r.ID), IssueID: planningUUID(issue.ID), Issue: &fixed, Changed: true}); e != nil {
			return e
		}
	} else if e = storeLifecycleReceipt(ctx, q, c, receipt); e != nil {
		return e
	}
	x, e := readLifecycleState(ctx, q, c.CockpitLifecycleRead)
	if e != nil {
		return e
	}
	header, e := lifecycleHeader(ctx, q, x, c.CockpitLifecycleRead)
	if e != nil {
		return e
	}
	h.result = &CockpitLifecycleCommandResult{WorkspaceID: util.UUIDToString(c.WorkspaceID), MeetingID: util.UUIDToString(c.MeetingID), CommandKey: util.UUIDToString(c.key), Action: c.action, Receipt: receipt, Current: header}
	h.created = true
	return nil
}
