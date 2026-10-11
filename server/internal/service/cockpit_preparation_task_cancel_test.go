package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func preparationCancelFixture(t *testing.T, status string) (*testutil.Fixture, *TaskService, pgtype.UUID, pgtype.UUID, pgtype.UUID) {
	t.Helper()
	f, agent, runtime := newArchiveCancelFixture(t)
	issue := util.MustParseUUID(f.Issue(t, "Unconfirmed receipt"))
	target := util.MustParseUUID(f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": status}))
	other := util.MustParseUUID(f.Task(t, agent, testutil.Cols{"issue_id": issue, "runtime_id": runtime, "status": "running"}))
	return f, NewTaskService(db.New(f.Pool), f.Pool, nil, events.New()), issue, target, other
}
func preparationCancelOptions(f *testutil.Fixture, hook *cockpitPreparationTaskCancel) CancelTaskOptions {
	return CancelTaskOptions{UserInitiated: true, ClientSupportsDraftRestore: true, CancelledBy: TaskCancellationActor{Type: "member", ID: util.MustParseUUID(f.UserID), Name: "Preparation reviewer"}, CockpitPreparation: hook}
}
func writePreparationTestReceipt(ctx context.Context, q *db.Queries, issue pgtype.UUID) error {
	_, err := q.UpdateIssue(ctx, db.UpdateIssueParams{ID: issue, Title: pgtype.Text{String: "Receipt confirmed", Valid: true}})
	return err
}

func TestPreparationTaskCancelCommitsWithReceiptBeforePublishing(t *testing.T) {
	ctx := context.Background()
	f, s, issue, target, other := preparationCancelFixture(t, "running")
	before, after, published := 0, 0, 0
	hook := &cockpitPreparationTaskCancel{testBefore: func(context.Context, *db.Queries, pgtype.UUID) (*db.AgentTaskQueue, error) { before++; return nil, nil }, testAfter: func(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, changed bool) error {
		after++
		if !changed || task.ID != target || task.Status != "cancelled" {
			t.Errorf("wrong transition delivered to receipt: changed=%t task=%+v", changed, task)
		}
		return writePreparationTestReceipt(ctx, q, issue)
	}}
	s.Bus.Subscribe(protocol.EventTaskCancelled, func(e events.Event) {
		published++
		if e.TaskID != util.UUIDToString(target) {
			t.Errorf("cancelled another task %s", e.TaskID)
		}
		var title, status string
		if err := f.Pool.QueryRow(ctx, "SELECT i.title,t.status FROM issue i JOIN agent_task_queue t ON t.issue_id=i.id WHERE t.id=$1", target).Scan(&title, &status); err != nil {
			t.Error(err)
		}
		if title != "Receipt confirmed" || status != "cancelled" {
			t.Errorf("published before receipt and cancellation committed: %q/%q", title, status)
		}
	})
	result, err := s.CancelTaskWithResult(ctx, target, preparationCancelOptions(f, hook))
	if err != nil {
		t.Fatal(err)
	}
	if result.Task.Status != "cancelled" || result.Task.CancelledByID != util.MustParseUUID(f.UserID) || before != 1 || after != 1 || published != 1 {
		t.Fatalf("canonical confirmation counts/result: %d %d %d %+v", before, after, published, result)
	}
	row, err := s.Queries.GetAgentTask(ctx, other)
	if err != nil || row.Status != "running" {
		t.Fatalf("unselected run changed: %+v %v", row, err)
	}
}

func TestPreparationTaskCancelRollsBackReceiptAndTaskTogether(t *testing.T) {
	for _, phase := range []string{"before", "after"} {
		t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			f, s, issue, target, _ := preparationCancelFixture(t, "running")
			sentinel := errors.New("fixture rejects effect confirmation")
			published := 0
			s.Bus.Subscribe(protocol.EventTaskCancelled, func(events.Event) { published++ })
			hook := &cockpitPreparationTaskCancel{testBefore: func(ctx context.Context, q *db.Queries, _ pgtype.UUID) (*db.AgentTaskQueue, error) {
				if phase == "before" {
					if err := writePreparationTestReceipt(ctx, q, issue); err != nil {
						return nil, err
					}
					return nil, sentinel
				}
				return nil, nil
			}, testAfter: func(ctx context.Context, q *db.Queries, _ db.AgentTaskQueue, changed bool) error {
				if !changed {
					t.Error("expected real cancellation before rollback")
				}
				if err := writePreparationTestReceipt(ctx, q, issue); err != nil {
					return err
				}
				return sentinel
			}}
			if _, err := s.CancelTaskWithResult(ctx, target, preparationCancelOptions(f, hook)); !errors.Is(err, sentinel) {
				t.Fatalf("lost hook failure: %v", err)
			}
			row, err := s.Queries.GetAgentTask(ctx, target)
			if err != nil {
				t.Fatal(err)
			}
			var title string
			if err = f.Pool.QueryRow(ctx, "SELECT title FROM issue WHERE id=$1", issue).Scan(&title); err != nil {
				t.Fatal(err)
			}
			if row.Status != "running" || row.CancelledByID.Valid || title != "Unconfirmed receipt" || published != 0 {
				t.Fatalf("rollback leaked mutation/notification: %+v title=%q events=%d", row, title, published)
			}
		})
	}
}

func TestPreparationTaskCancelObservationsDoNotPublishNewCancellation(t *testing.T) {
	for _, replay := range []bool{true, false} {
		name := "terminal"
		if replay {
			name = "retained receipt"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			f, s, issue, target, _ := preparationCancelFixture(t, "completed")
			after, published := 0, 0
			s.Bus.Subscribe(protocol.EventTaskCancelled, func(events.Event) { published++ })
			hook := &cockpitPreparationTaskCancel{testBefore: func(ctx context.Context, q *db.Queries, id pgtype.UUID) (*db.AgentTaskQueue, error) {
				if !replay {
					return nil, nil
				}
				task, err := q.GetAgentTask(ctx, id)
				if err != nil {
					return nil, err
				}
				if err = writePreparationTestReceipt(ctx, q, issue); err != nil {
					return nil, err
				}
				return &task, nil
			}, testAfter: func(ctx context.Context, q *db.Queries, task db.AgentTaskQueue, changed bool) error {
				after++
				if changed || task.Status != "completed" {
					t.Error("terminal observation was presented as newly cancelled")
				}
				return writePreparationTestReceipt(ctx, q, issue)
			}}
			result, err := s.CancelTaskWithResult(ctx, target, preparationCancelOptions(f, hook))
			if err != nil {
				t.Fatal(err)
			}
			wantAfter := 1
			if replay {
				wantAfter = 0
			}
			var title string
			if err = f.Pool.QueryRow(ctx, "SELECT title FROM issue WHERE id=$1", issue).Scan(&title); err != nil {
				t.Fatal(err)
			}
			if result.Task.Status != "completed" || after != wantAfter || published != 0 || title != "Receipt confirmed" {
				t.Fatalf("wrong observed result: %+v after=%d events=%d title=%q", result, after, published, title)
			}
		})
	}
}

func TestPreparationTaskCancelRejectsMissingAuthorizationAndQueuedChatMode(t *testing.T) {
	ctx := context.Background()
	f, s, _, target, _ := preparationCancelFixture(t, "running")
	after := 0
	hook := &cockpitPreparationTaskCancel{testBefore: func(context.Context, *db.Queries, pgtype.UUID) (*db.AgentTaskQueue, error) { return nil, pgx.ErrNoRows }, testAfter: func(context.Context, *db.Queries, db.AgentTaskQueue, bool) error { after++; return nil }}
	if _, err := s.CancelTaskWithResult(ctx, target, preparationCancelOptions(f, hook)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing preparation was swallowed by existing-task fallback: %v", err)
	}
	hook.testBefore = func(context.Context, *db.Queries, pgtype.UUID) (*db.AgentTaskQueue, error) { return nil, nil }
	if _, err := s.CancelTaskWithResult(ctx, util.MustParseUUID(uuid.NewString()), preparationCancelOptions(f, hook)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing task was treated as a confirmed effect: %v", err)
	}
	opts := preparationCancelOptions(f, hook)
	opts.QueuedOnly = true
	opts.QueueAction = "remove"
	if _, err := s.CancelTaskWithResult(ctx, target, opts); err == nil {
		t.Fatal("preparation hook entered queued-chat cancellation")
	}
	noTransaction := NewTaskService(s.Queries, nil, nil, events.New())
	opts.QueuedOnly = false
	if _, err := noTransaction.CancelTaskWithResult(ctx, target, opts); err == nil {
		t.Fatal("preparation cancellation ran without an atomic transaction")
	}
	row, err := s.Queries.GetAgentTask(ctx, target)
	if err != nil || row.Status != "running" || after != 0 {
		t.Fatalf("rejected hook changed task or confirmed receipt: %+v after=%d %v", row, after, err)
	}
}
