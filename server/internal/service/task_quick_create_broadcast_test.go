package service

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// quickCreateSeq keeps generated names and emails unique across subtests.
var quickCreateSeq atomic.Int64

// quickCreateFixture provisions user + workspace + member + runtime + agent
// through testutil.Fixture, which registers its own cleanups, so this file
// open-codes no INSERT / DELETE pairs.
type quickCreateFixture struct {
	*testutil.Fixture
	svc     *TaskService
	agentID pgtype.UUID
	queued  func() map[string]int
}

func newQuickCreateFixture(t *testing.T) quickCreateFixture {
	t.Helper()
	pool := newTaskClaimRacePool(t)
	q := db.New(pool)
	bus := events.New()

	var mu sync.Mutex
	queued := map[string]int{}
	bus.Subscribe(protocol.EventTaskQueued, func(e events.Event) {
		payload, ok := e.Payload.(map[string]any)
		if !ok {
			return
		}
		id, ok := payload["task_id"].(string)
		if !ok {
			return
		}
		mu.Lock()
		queued[id]++
		mu.Unlock()
	})

	n := quickCreateSeq.Add(1)
	fx := testutil.New(pool, "", "")
	userID := fx.User(t, "quick-create requester", fmt.Sprintf("qc-user-%d@multica.test", n))
	workspaceID := fx.Workspace(t, "quick-create ws", fmt.Sprintf("qc-ws-%d", n))
	fx.Member(t, workspaceID, userID, "owner")
	fx.WorkspaceID = workspaceID
	fx.UserID = userID

	runtimeID := fx.Runtime(t, fmt.Sprintf("qc-rt-%d", n), testutil.Cols{"owner_id": userID})
	agentID := fx.Agent(t, fmt.Sprintf("qc-agent-%d", n), runtimeID, testutil.Cols{"owner_id": userID})

	return quickCreateFixture{
		Fixture: fx,
		svc:     NewTaskService(q, pool, nil, bus),
		agentID: util.MustParseUUID(agentID),
		queued: func() map[string]int {
			mu.Lock()
			defer mu.Unlock()
			out := make(map[string]int, len(queued))
			for k, v := range queued {
				out[k] = v
			}
			return out
		},
	}
}

// TestEnqueueQuickCreateTaskBroadcastsQueued is the regression test for the
// reported defect: "creating an issue through an agent shows nothing on the
// page, and no record appears anywhere but the agent's own tab".
//
// enqueueQuickCreateTask was the ONE Enqueue* path that called
// NotifyTaskEnqueued without a preceding task:queued broadcast. With no task:*
// event, no client cache was ever invalidated at submit time, so no surface
// could learn the creation existed. Without the broadcast this test sees zero
// events.
func TestEnqueueQuickCreateTaskBroadcastsQueued(t *testing.T) {
	ctx := context.Background()
	fx := newQuickCreateFixture(t)

	task, err := fx.svc.EnqueueQuickCreateTask(
		ctx,
		util.MustParseUUID(fx.WorkspaceID),
		util.MustParseUUID(fx.UserID),
		fx.agentID,
		pgtype.UUID{},
		"Draft the Q4 rollout plan",
		"", "",
		pgtype.UUID{}, pgtype.UUID{},
		nil,
	)
	if err != nil {
		t.Fatalf("enqueue quick-create: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fx.Pool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE id = $1", task.ID)
	})

	taskID := util.UUIDToString(task.ID)
	if got := fx.queued()[taskID]; got != 1 {
		t.Fatalf("expected exactly one task:queued broadcast for the quick-create task %s, got %d — "+
			"without it no client cache is invalidated and the creation is invisible until something else refetches",
			taskID, got)
	}

	// The whole point of a quick-create is that the issue does not exist yet;
	// a client keys "still pending" off exactly this.
	if issueID := util.UUIDToString(task.IssueID); issueID != "" {
		t.Fatalf("expected the quick-create task to carry no issue yet, got issue_id %q", issueID)
	}
}

// TestEnqueueQuickCreateTaskBroadcastsOnceNotTwice pins the announcement to the
// single shared private function. Both public wrappers funnel through it, so a
// second broadcast added to either wrapper would double-announce, and the
// source-context branch commits its transaction before reaching it, so a
// rolled-back task can never be announced at all.
func TestEnqueueQuickCreateTaskBroadcastsOnceNotTwice(t *testing.T) {
	ctx := context.Background()
	fx := newQuickCreateFixture(t)

	var ids []pgtype.UUID
	for i := range 2 {
		task, err := fx.svc.EnqueueQuickCreateTask(
			ctx,
			util.MustParseUUID(fx.WorkspaceID),
			util.MustParseUUID(fx.UserID),
			fx.agentID,
			pgtype.UUID{},
			fmt.Sprintf("prompt %d", i),
			"", "",
			pgtype.UUID{}, pgtype.UUID{},
			nil,
		)
		if err != nil {
			t.Fatalf("enqueue quick-create %d: %v", i, err)
		}
		ids = append(ids, task.ID)
	}
	t.Cleanup(func() {
		for _, id := range ids {
			_, _ = fx.Pool.Exec(context.Background(), "DELETE FROM agent_task_queue WHERE id = $1", id)
		}
	})

	broadcasts := fx.queued()
	for i, id := range ids {
		if got := broadcasts[util.UUIDToString(id)]; got != 1 {
			t.Fatalf("task %d (%s): expected exactly 1 task:queued broadcast, got %d",
				i, util.UUIDToString(id), got)
		}
	}
	if len(broadcasts) != 2 {
		t.Fatalf("expected broadcasts for exactly the 2 enqueued tasks, got %d distinct task ids", len(broadcasts))
	}
}
