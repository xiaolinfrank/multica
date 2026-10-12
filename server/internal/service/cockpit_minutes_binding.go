package service

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// R1 (design-principles-2026-10-12): the minutes binding is an association.
// A meeting may bind several minutes tasks, unbind any of them at will, and
// move its focus pointer; tasks keep their ordinary issue lifecycle.

type CockpitMinutesBindingCommand struct {
	WorkspaceID, MeetingID, ActorID, IssueID pgtype.UUID
	ExpectedRevision                        int64
}

func (s *IssueService) beginMinutesBinding(ctx context.Context, p CockpitMinutesBindingCommand) (pgx.Tx, *db.Queries, cockpitMinutesState, error) {
	tx, q, work, err := s.beginCockpitWorkflow(ctx, CockpitWorkPackageCommand{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ActorID: p.ActorID, ExpectedRevision: p.ExpectedRevision})
	return tx, q, work, err
}

func (s *IssueService) BindCockpitMinutesIssue(ctx context.Context, p CockpitMinutesBindingCommand) error {
	tx, q, work, err := s.beginMinutesBinding(ctx, p)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return err
	}
	if err := RequireCockpitMeetingPreparationOpen(ctx, q, p.WorkspaceID, p.MeetingID); err != nil {
		return err
	}
	if err := cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); err != nil {
		return err
	}
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.IssueID})
	if err != nil {
		return cockpitWorkflowError(err)
	}
	if _, err := q.AttachCockpitMinutesIssueLink(ctx, db.AttachCockpitMinutesIssueLinkParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IssueID: issue.ID}); err != nil {
		return err
	}
	// An unconfigured meeting focuses its first binding automatically; an
	// explicit focus stays put unless the caller moves it.
	if !work.MinutesIssueID.Valid {
		if _, err := q.SetCockpitMinutesSetup(ctx, db.SetCockpitMinutesSetupParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, FocusIssueID: issue.ID, ReviewerID: work.ReviewerID, ActorID: p.ActorID, ExpectedRevision: work.Revision}); err != nil {
			return cockpitWorkflowError(err)
		}
	} else if _, err := q.AdvanceCockpitWorkflowRevision(ctx, db.AdvanceCockpitWorkflowRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, MinutesRevision: work.Revision}); err != nil {
		return cockpitWorkflowError(err)
	}
	return tx.Commit(ctx)
}

func (s *IssueService) UnbindCockpitMinutesIssue(ctx context.Context, p CockpitMinutesBindingCommand) error {
	tx, q, work, err := s.beginMinutesBinding(ctx, p)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return err
	}
	rows, err := q.DetachCockpitMinutesIssueLink(ctx, db.DetachCockpitMinutesIssueLinkParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, IssueID: p.IssueID})
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("%w: this issue is not bound as a minutes task", ErrCockpitWorkflowConflict)
	}
	if work.MinutesIssueID == p.IssueID {
		if _, err := q.ClearCockpitMinutesFocusIfIssue(ctx, db.ClearCockpitMinutesFocusIfIssueParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, MinutesFocusIssueID: p.IssueID, MinutesRevision: work.Revision}); err != nil {
			return cockpitWorkflowError(err)
		}
		// Unbinding the focus task is not a teardown: fall back to the
		// earliest remaining binding so the workflow keeps a live focus.
		remaining, err := q.ListCockpitMinutesIssueLinks(ctx, db.ListCockpitMinutesIssueLinksParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
		if err != nil {
			return err
		}
		if len(remaining) > 0 {
			if _, err := q.SetCockpitMinutesSetup(ctx, db.SetCockpitMinutesSetupParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, FocusIssueID: remaining[0].IssueID, ReviewerID: work.ReviewerID, ActorID: p.ActorID, ExpectedRevision: work.Revision + 1}); err != nil {
				return cockpitWorkflowError(err)
			}
		}
		return tx.Commit(ctx)
	}
	if _, err := q.AdvanceCockpitWorkflowRevision(ctx, db.AdvanceCockpitWorkflowRevisionParams{WorkspaceID: p.WorkspaceID, ID: p.MeetingID, MinutesRevision: work.Revision}); err != nil {
		return cockpitWorkflowError(err)
	}
	return tx.Commit(ctx)
}

func (s *IssueService) FocusCockpitMinutesIssue(ctx context.Context, p CockpitMinutesBindingCommand) error {
	tx, q, work, err := s.beginMinutesBinding(ctx, p)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := requireCockpitWorkflowManager(ctx, q, work, p.ActorID); err != nil {
		return err
	}
	bound := false
	links, err := q.ListCockpitMinutesIssueLinks(ctx, db.ListCockpitMinutesIssueLinksParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if err != nil {
		return err
	}
	for _, link := range links {
		if link.IssueID == p.IssueID {
			bound = true
			break
		}
	}
	if !bound {
		return fmt.Errorf("%w: bind the issue as a minutes task before focusing it", ErrCockpitWorkflowConflict)
	}
	if _, err := q.SetCockpitMinutesSetup(ctx, db.SetCockpitMinutesSetupParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, FocusIssueID: p.IssueID, ReviewerID: work.ReviewerID, ActorID: p.ActorID, ExpectedRevision: work.Revision}); err != nil {
		return cockpitWorkflowError(err)
	}
	return tx.Commit(ctx)
}
