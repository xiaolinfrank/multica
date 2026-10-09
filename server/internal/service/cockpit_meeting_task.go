package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// CockpitMeetingTask is the stable identity of a meeting's provisioned work.
// It is not a generic Issue API input and only accepts resolved workspace IDs.
type CockpitMeetingTask struct {
	MeetingID pgtype.UUID
	NodeID    pgtype.UUID
}

func beginCockpitMeetingTask(ctx context.Context, q *db.Queries, workspaceID pgtype.UUID, task CockpitMeetingTask) (*db.Issue, error) {
	// Board replacement and relation edits acquire locks in this same order.
	if _, err := q.LockCockpitForWorkspaceChanges(ctx, workspaceID); err != nil {
		return nil, fmt.Errorf("lock cockpit for provisioning: %w", err)
	}
	meeting, err := q.LockCockpitMeetingForWork(ctx, db.LockCockpitMeetingForWorkParams{
		ID: task.MeetingID, WorkspaceID: workspaceID,
	})
	if err != nil {
		return nil, fmt.Errorf("lock meeting for provisioning: %w", err)
	}
	if task.NodeID.Valid {
		node, err := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{ID: task.NodeID, WorkspaceID: workspaceID})
		if err != nil || node.CockpitID != meeting.CockpitID {
			return nil, errors.New("meeting archive node is not in the meeting's cockpit")
		}
	}
	issue, err := q.GetCockpitMeetingTaskIssue(ctx, db.GetCockpitMeetingTaskIssueParams{
		WorkspaceID: workspaceID, MeetingID: task.MeetingID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find provisioned meeting issue: %w", err)
	}
	return &issue, nil
}

func linkCockpitMeetingTask(ctx context.Context, q *db.Queries, issue db.Issue, task CockpitMeetingTask) error {
	if _, err := q.CreateCockpitMeetingIssue(ctx, db.CreateCockpitMeetingIssueParams{
		WorkspaceID: issue.WorkspaceID, MeetingID: task.MeetingID, IssueID: issue.ID,
		Role: "task", Position: -1,
	}); err != nil {
		return fmt.Errorf("link provisioned meeting issue: %w", err)
	}
	if task.NodeID.Valid {
		if _, err := q.CreateCockpitNodeIssue(ctx, db.CreateCockpitNodeIssueParams{
			WorkspaceID: issue.WorkspaceID, NodeID: task.NodeID, IssueID: issue.ID,
		}); err != nil {
			return fmt.Errorf("file provisioned meeting issue: %w", err)
		}
	}
	return nil
}
