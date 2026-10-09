package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// Sharing this hook between handler and task transaction starters reproduces
// the old cancellation-before-delete window as well as the fixed single tx.
type cockpitDeleteRaceTxStarter struct {
	base   txStarter
	once   sync.Once
	before func() error
	err    error
}

func (s *cockpitDeleteRaceTxStarter) Begin(ctx context.Context) (pgx.Tx, error) {
	s.once.Do(func() { s.err = s.before() })
	if s.err != nil {
		return nil, s.err
	}
	return s.base.Begin(ctx)
}

func TestCockpitWorkflowDeleteRaceDoesNotCancelReleasedWork(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(fmt.Sprintf("batch_%t", batch), func(t *testing.T) {
			ws, meeting := newCockpitWorkflowHTTPFixture(t)
			ctx := context.Background()
			wsID := parseUUID(ws)
			runtime := dbfx.Runtime(t, "Delete-race fake runtime", testutil.Cols{"workspace_id": ws})
			agent := dbfx.Agent(t, "Delete-race fake agent", runtime, testutil.Cols{"workspace_id": ws})
			minutes := dbfx.Issue(t, "Adopt during delete", testutil.Cols{"workspace_id": ws, "status": "backlog", "assignee_type": "agent", "assignee_id": agent})
			ids := []string{minutes}
			var plainTask, autopilotRun string
			if batch {
				plain := dbfx.Issue(t, "Unprotected batch member", testutil.Cols{"workspace_id": ws})
				plainTask = dbfx.Task(t, agent, testutil.Cols{"issue_id": plain, "runtime_id": runtime, "status": "queued"})
				ids = []string{plain, minutes}
				ap := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": ws, "title": "Batch delete preserves automation", "assignee_id": agent, "created_by_type": "member", "created_by_id": testUserID})
				autopilotRun = dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "issue_id": plain, "source": "manual", "status": "issue_created"})
			}
			hook := &cockpitDeleteRaceTxStarter{base: testPool}
			hook.before = func() error {
				init := service.CockpitWorkPackageInit{WorkspaceID: wsID, MeetingID: parseUUID(meeting.ID), ActorID: parseUUID(testUserID), ReviewerID: parseUUID(testUserID), ExistingIssueID: parseUUID(minutes)}
				if err := testHandler.IssueService.EnableCockpitMeetingWorkPackage(ctx, init, service.IssueCreateOpts{}); err != nil {
					return err
				}
				work, err := testHandler.Queries.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: wsID, MeetingID: init.MeetingID})
				if err != nil {
					return err
				}
				yes := true
				command := service.CockpitWorkPackageCommand{WorkspaceID: wsID, MeetingID: init.MeetingID, ActorID: parseUUID(testUserID), ExpectedRevision: work.Revision}
				if err := testHandler.IssueService.SetCockpitMeetingReadiness(ctx, service.CockpitWorkPackageReadiness{CockpitWorkPackageCommand: command, Ended: &yes, MaterialsReady: &yes}); err != nil {
					return err
				}
				command.ExpectedRevision++
				return testHandler.IssueService.ReleaseCockpitMeetingMinutes(ctx, command)
			}
			h := *testHandler
			h.TxStarter = hook
			h.TaskService = service.NewTaskService(testHandler.Queries, hook, testHandler.Hub, testHandler.Bus)
			if batch {
				testutil.Call(t, h.BatchDeleteIssues, cockpitRequest(http.MethodPost, "/api/issues/batch-delete", ws, map[string]any{"issue_ids": ids})).Want(http.StatusConflict)
			} else {
				testutil.Call(t, h.DeleteIssue, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/issues/"+minutes, ws, nil), "id", minutes)).Want(http.StatusConflict)
			}
			work, err := testHandler.Queries.GetCockpitMeetingWorkPackage(ctx, db.GetCockpitMeetingWorkPackageParams{WorkspaceID: wsID, MeetingID: parseUUID(meeting.ID)})
			if err != nil {
				t.Fatal(err)
			}
			if !work.ReleaseTaskID.Valid {
				t.Fatal("race did not actually enqueue the fake agent")
			}
			task, err := testHandler.Queries.GetAgentTask(ctx, work.ReleaseTaskID)
			if err != nil {
				t.Fatal(err)
			}
			if task.Status != "queued" {
				t.Fatalf("rejected delete cancelled workflow run: %s", task.Status)
			}
			if dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1", minutes) != 1 {
				t.Fatal("protected issue was deleted")
			}
			if batch {
				plain, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(plainTask))
				if err != nil {
					t.Fatal(err)
				}
				if plain.Status != "queued" {
					t.Fatalf("rejected batch cancelled unprotected sibling: %s", plain.Status)
				}
				var status string
				if err := testPool.QueryRow(ctx, "SELECT status FROM autopilot_run WHERE id=$1", autopilotRun).Scan(&status); err != nil {
					t.Fatal(err)
				}
				if status != "issue_created" {
					t.Fatalf("rejected batch changed autopilot: %s", status)
				}
			}
		})
	}
}

// Inject failure at the deletion transaction's commit, after its cancellation
// and autopilot updates ran. Neither row state nor notifications may escape.
type cockpitDeleteRejectCommit struct {
	base txStarter
	err  error
}

func (s cockpitDeleteRejectCommit) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := s.base.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return cockpitDeleteRejectTx{Tx: tx, err: s.err}, nil
}

type cockpitDeleteRejectTx struct {
	pgx.Tx
	err error
}

func (tx cockpitDeleteRejectTx) Commit(ctx context.Context) error {
	_ = tx.Tx.Rollback(ctx)
	return tx.err
}

func TestCockpitWorkflowIssueDeleteCancellationCommitsWithDelete(t *testing.T) {
	ws, _ := newCockpitWorkflowHTTPFixture(t)
	ctx := context.Background()
	runtime := dbfx.Runtime(t, "Delete fake runtime", testutil.Cols{"workspace_id": ws})
	agent := dbfx.Agent(t, "Delete fake agent", runtime, testutil.Cols{"workspace_id": ws, "status": "working"})
	issue := dbfx.Issue(t, "Atomic deletion", testutil.Cols{"workspace_id": ws})
	taskID := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": issue, "status": "queued"})
	ap := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": ws, "title": "Delete automation", "assignee_id": agent, "created_by_type": "member", "created_by_id": testUserID})
	runID := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "issue_id": issue, "source": "manual", "status": "issue_created"})
	bus := events.New()
	var mu sync.Mutex
	cancelledEvents := 0
	bus.Subscribe(protocol.EventTaskCancelled, func(event events.Event) {
		if event.WorkspaceID == ws {
			mu.Lock()
			cancelledEvents++
			mu.Unlock()
		}
	})
	h := *testHandler
	h.TxStarter = cockpitDeleteRejectCommit{base: testPool, err: errors.New("injected delete commit failure")}
	h.TaskService = service.NewTaskService(testHandler.Queries, testPool, nil, bus)
	req := func() *http.Request {
		return testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/issues/"+issue, ws, nil), "id", issue)
	}
	testutil.Call(t, h.DeleteIssue, req()).Want(http.StatusInternalServerError)
	task, err := testHandler.Queries.GetAgentTask(ctx, parseUUID(taskID))
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "queued" {
		t.Fatalf("cancel escaped rollback: %s", task.Status)
	}
	var status string
	if err := testPool.QueryRow(ctx, "SELECT status FROM autopilot_run WHERE id=$1", runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "issue_created" {
		t.Fatalf("autopilot failure escaped rollback: %s", status)
	}
	mu.Lock()
	before := cancelledEvents
	mu.Unlock()
	if before != 0 {
		t.Fatal("rollback emitted cancellation")
	}
	h.TxStarter = testPool
	testutil.Call(t, h.DeleteIssue, req()).Want(http.StatusNoContent)
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE id=$1", issue) != 0 {
		t.Fatal("successful delete kept issue")
	}
	if err := testPool.QueryRow(ctx, "SELECT status FROM autopilot_run WHERE id=$1", runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("autopilot not settled on delete: %s", status)
	}
	mu.Lock()
	after := cancelledEvents
	mu.Unlock()
	if after != 1 {
		t.Fatalf("committed delete emitted %d scoped cancellations", after)
	}
	currentAgent, err := testHandler.Queries.GetAgent(ctx, parseUUID(agent))
	if err != nil {
		t.Fatal(err)
	}
	if currentAgent.Status == "working" {
		t.Fatal("deleted issue left agent working")
	}
}
