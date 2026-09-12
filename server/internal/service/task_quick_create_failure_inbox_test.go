package service

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// enqueueThenSweepFail reproduces what every sweeper stage does to a task: one
// UPDATE flips the row to failed and RETURNINGs it, and HandleFailedTasks is
// handed that row afterwards. FailTask is never involved, which is exactly why
// its quick-create notification did not cover this path.
func enqueueThenSweepFail(t *testing.T, fx quickCreateFixture, prompt, failureReason, errText string) db.AgentTaskQueue {
	t.Helper()
	ctx := context.Background()

	task, err := fx.svc.EnqueueQuickCreateTask(
		ctx,
		util.MustParseUUID(fx.WorkspaceID),
		util.MustParseUUID(fx.UserID),
		fx.agentID,
		pgtype.UUID{},
		prompt,
		"", "",
		pgtype.UUID{}, pgtype.UUID{},
		nil,
	)
	if err != nil {
		t.Fatalf("enqueue quick-create: %v", err)
	}
	taskID := util.UUIDToString(task.ID)
	fx.Cleanup(t, "DELETE FROM inbox_item WHERE details->>'task_id' = $1", taskID)
	fx.Cleanup(t, "DELETE FROM agent_task_queue WHERE id = $1 OR parent_task_id = $1", task.ID)

	fx.Exec(t, `
		UPDATE agent_task_queue
		SET status = 'failed', completed_at = now(), error = $2, failure_reason = $3
		WHERE id = $1`, task.ID, errText, failureReason)

	failed, err := fx.svc.Queries.GetAgentTask(ctx, task.ID)
	if err != nil {
		t.Fatalf("reload swept task: %v", err)
	}
	return failed
}

// TestHandleFailedTasksWritesQuickCreateFailureInbox covers the half of the
// quick-create failure story that had no durable record at all.
//
// A plain quick-create carries no issue_id, no chat session and no source
// context, so retryEligible rejects it outright: when a sweeper retires it the
// row is terminal on the spot, with no retry child to report a later outcome.
// task:failed reaches whoever is looking at the time; a user whose tab was
// closed had nothing — no issue, no inbox row, and an agent task list that
// only says "failed". Without the HandleFailedTasks call this test finds zero
// inbox rows.
func TestHandleFailedTasksWritesQuickCreateFailureInbox(t *testing.T) {
	ctx := context.Background()
	fx := newQuickCreateFixture(t)

	const prompt = "Draft the Q4 rollout plan"
	failed := enqueueThenSweepFail(t, fx, prompt, "runtime_offline", "runtime went offline")
	taskID := util.UUIDToString(failed.ID)

	if retried := fx.svc.HandleFailedTasks(ctx, []db.AgentTaskQueue{failed}); retried != 0 {
		t.Fatalf("retried = %d, want 0: a quick-create with no source context is not retry-eligible, "+
			"so nothing else will ever report its outcome", retried)
	}

	var inboxType, recipientType, recipientID, severity, originalPrompt string
	var body pgtype.Text
	fx.QueryRow(t, `
		SELECT type, recipient_type, recipient_id::text, severity, body, details->>'original_prompt'
		FROM inbox_item WHERE details->>'task_id' = $1`, taskID).
		Scan(&inboxType, &recipientType, &recipientID, &severity, &body, &originalPrompt)

	if inboxType != "quick_create_failed" {
		t.Fatalf("inbox type = %q, want quick_create_failed", inboxType)
	}
	if recipientType != "member" || recipientID != fx.UserID {
		t.Fatalf("recipient = %s/%s, want member/%s — the notification must reach the requester, not the agent's owner",
			recipientType, recipientID, fx.UserID)
	}
	if severity != "action_required" {
		t.Fatalf("severity = %q, want action_required", severity)
	}
	// The prompt is what makes the row actionable: the frontend offers "edit as
	// advanced form" from it so the user does not retype what they asked for.
	if originalPrompt != prompt {
		t.Fatalf("details.original_prompt = %q, want %q", originalPrompt, prompt)
	}
	if body.String != "runtime went offline" {
		t.Fatalf("body = %q, want the sweeper's own failure text", body.String)
	}

	if n := fx.Count(t, `SELECT count(*) FROM inbox_item WHERE details->>'task_id' = $1`, taskID); n != 1 {
		t.Fatalf("inbox rows for the failed quick-create = %d, want exactly 1", n)
	}
}

// TestHandleFailedTasksReconcilesQuickCreateThatAlreadyCreatedItsIssue pins the
// reason the failure inbox is not written unconditionally.
//
// `multica issue create` commits on its own, so a run can produce the issue and
// only then lose its runtime — the very window the sweepers exist to close.
// Telling that user "Quick create failed" invites them to create the duplicate
// the active-duplicate guard exists to reject, so the origin stamp on the issue
// decides the outcome, not the status of the task.
func TestHandleFailedTasksReconcilesQuickCreateThatAlreadyCreatedItsIssue(t *testing.T) {
	ctx := context.Background()
	fx := newQuickCreateFixture(t)

	failed := enqueueThenSweepFail(t, fx, "File the incident review", "runtime_offline", "runtime went offline")
	taskID := util.UUIDToString(failed.ID)

	issueID := fx.Issue(t, "Incident review", testutil.Cols{
		"creator_type": "agent",
		"creator_id":   util.UUIDToString(fx.agentID),
		"origin_type":  "quick_create",
		"origin_id":    taskID,
	})

	fx.svc.HandleFailedTasks(ctx, []db.AgentTaskQueue{failed})

	var inboxType, inboxIssueID string
	fx.QueryRow(t, `
		SELECT type, issue_id::text FROM inbox_item WHERE details->>'task_id' = $1`, taskID).
		Scan(&inboxType, &inboxIssueID)
	if inboxType != "quick_create_done" {
		t.Fatalf("inbox type = %q, want quick_create_done — the issue the run created is proof it did not fail",
			inboxType)
	}
	if inboxIssueID != issueID {
		t.Fatalf("inbox issue_id = %q, want %q", inboxIssueID, issueID)
	}

	// The success path also links the task to the issue, which is what stops
	// the agent's task list from showing "Creating issue" forever.
	var linked pgtype.Text
	fx.QueryRow(t, `SELECT issue_id::text FROM agent_task_queue WHERE id = $1`, failed.ID).Scan(&linked)
	if linked.String != issueID {
		t.Fatalf("task.issue_id after reconcile = %q, want %q", linked.String, issueID)
	}
}
