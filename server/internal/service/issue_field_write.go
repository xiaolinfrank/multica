package service

import (
	"context"
	"fmt"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// UpdateIssueStoppingWakeups is the common final write for ordinary Issue
// updates and explicitly confirmed preparation dispositions. The caller locks
// the catalog and Issue, checks actor/revision/fields, and commits the result and
// its domain receipt together. Running tasks are deliberately not cancelled.
func UpdateIssueStoppingWakeups(ctx context.Context, q *db.Queries, params db.UpdateIssueParams) (db.Issue, []db.AgentTaskQueue, error) {
	issue, err := q.UpdateIssue(ctx, params)
	if err != nil || !params.Status.Valid {
		return issue, nil, err
	}
	cancelled, err := StopClosedIssueWakeups(ctx, q, issue)
	if err != nil {
		return db.Issue{}, nil, fmt.Errorf("stop closed issue wakeups: %w", err)
	}
	return issue, cancelled, nil
}

// RetainedIssueUpdateFields preserves all nullable fields which UpdateIssue
// treats as assignments. Callers must obtain this snapshot after the row lock.
func RetainedIssueUpdateFields(issue db.Issue) db.UpdateIssueParams {
	return db.UpdateIssueParams{ID: issue.ID, AssigneeType: issue.AssigneeType, AssigneeID: issue.AssigneeID,
		StartDate: issue.StartDate, DueDate: issue.DueDate, ParentIssueID: issue.ParentIssueID,
		ProjectID: issue.ProjectID, ModuleID: issue.ModuleID, Stage: issue.Stage, DuplicateOfIssueID: issue.DuplicateOfIssueID}
}
