package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type taskReadSpy struct {
	db.DBTX
	taskReads, messageReads int
	unboundedTaskRead       bool
	failQuery               string
}

func (s *taskReadSpy) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if s.failQuery != "" && strings.Contains(sql, "-- name: "+s.failQuery+" ") {
		return taskReadFailureRow{}
	}
	if strings.Contains(sql, "FROM agent_task_queue") {
		s.taskReads++
		if len(args) != 2 {
			s.unboundedTaskRead = true
		}
	}
	return s.DBTX.QueryRow(ctx, sql, args...)
}

func (s *taskReadSpy) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "FROM agent_task_queue") {
		s.unboundedTaskRead = true
	}
	if strings.Contains(sql, "FROM task_message") {
		s.messageReads++
	}
	return s.DBTX.Query(ctx, sql, args...)
}

type taskReadFailureRow struct{}

func (taskReadFailureRow) Scan(...any) error { return errors.New("injected task read failure") }

func taskReadFixture(t *testing.T) (workspaceID, agentID, ownerID, runtimeID string) {
	t.Helper()
	if testHandler == nil {
		t.Skip("database not available")
	}
	workspaceID = dbfx.Workspace(t, "Run read", "run-read-"+uuid.NewString())
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", workspaceID)
	ownerID = dbfx.User(t, "Run owner", uuid.NewString()+"@example.test")
	dbfx.Member(t, workspaceID, ownerID, "owner")
	dbfx.Member(t, workspaceID, testUserID, "member")
	runtimeID = dbfx.Runtime(t, "Run read runtime", testutil.Cols{"workspace_id": workspaceID, "owner_id": ownerID})
	agentID = dbfx.Agent(t, "Run read agent", runtimeID, testutil.Cols{"workspace_id": workspaceID, "owner_id": ownerID})
	return
}

func taskReadCall(t *testing.T, fn http.HandlerFunc, userID, workspaceID, taskID, suffix string) *testutil.Response {
	t.Helper()
	req := testutil.WithURLParams(testutil.WithHeaders(testutil.JSONRequest(http.MethodGet, "/api/tasks/"+taskID+suffix, nil),
		"X-Workspace-ID", workspaceID, "X-User-ID", userID), "taskId", taskID)
	return testutil.Call(t, cockpitHandler(fn), req)
}

func TestTaskReadHTTPUsesOneExactRunAndWorkspace(t *testing.T) {
	ws, agent, owner, runtime := taskReadFixture(t)
	issue := dbfx.Issue(t, "Run history", testutil.Cols{"workspace_id": ws})
	for range 26 {
		dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": issue, "status": "completed"})
	}
	task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "issue_id": issue, "status": "cancelled", "result": testutil.Raw(`'{"summary":"fixed run result"}'::jsonb`)})
	dbfx.Insert(t, "task_message", testutil.Cols{"task_id": task, "seq": 1, "type": "text", "content": "Private transcript"})
	spy := &taskReadSpy{DBTX: testPool}
	h := *testHandler
	h.Queries = db.New(spy)
	var got AgentTaskResponse
	taskReadCall(t, h.GetTaskByUser, owner, ws, task, "").Want(200).JSON(&got)
	if got.ID != task || got.WorkspaceID != ws || got.AgentID != agent || got.IssueID != issue || got.Status != "cancelled" {
		t.Fatalf("wrong exact run: %+v", got)
	}
	if result, ok := got.Result.(map[string]any); !ok || result["summary"] != "fixed run result" {
		t.Fatalf("existing task serializer lost result: %#v", got.Result)
	}
	if spy.taskReads != 1 || spy.unboundedTaskRead || spy.messageReads != 0 {
		t.Fatalf("metadata read scanned history/body: %+v", spy)
	}
	foreign := dbfx.Workspace(t, "Other run read", "other-run-read-"+uuid.NewString())
	dbfx.Member(t, foreign, owner, "owner")
	for _, reader := range []struct {
		fn     http.HandlerFunc
		suffix string
	}{{h.GetTaskByUser, ""}, {h.ListTaskMessagesByUser, "/messages"}} {
		taskReadCall(t, reader.fn, owner, foreign, task, reader.suffix).Want(404)
		taskReadCall(t, reader.fn, owner, ws, uuid.NewString(), reader.suffix).Want(404)
	}
}

func TestTaskReadHTTPMetadataAndMessagesSharePrivateAgentViewPolicy(t *testing.T) {
	ws, agent, owner, runtime := taskReadFixture(t)
	task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime})
	dbfx.Insert(t, "task_message", testutil.Cols{"task_id": task, "seq": 1, "type": "text", "content": "Private transcript"})
	for _, reader := range []struct {
		name, suffix string
		fn           http.HandlerFunc
	}{{"metadata", "", testHandler.GetTaskByUser}, {"messages", "/messages", testHandler.ListTaskMessagesByUser}} {
		t.Run(reader.name, func(t *testing.T) {
			taskReadCall(t, reader.fn, testUserID, ws, task, reader.suffix).Want(403)
			taskReadCall(t, reader.fn, owner, ws, task, reader.suffix).Want(200)
		})
	}
	// VIEW governance access remains independent of private-agent INVOKE.
	dbfx.Exec(t, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", ws, testUserID)
	taskReadCall(t, testHandler.GetTaskByUser, testUserID, ws, task, "").Want(200)
	taskReadCall(t, testHandler.ListTaskMessagesByUser, testUserID, ws, task, "/messages").Want(200)
	dbfx.Exec(t, "UPDATE member SET role='member' WHERE workspace_id=$1 AND user_id=$2", ws, testUserID)
	dbfx.Exec(t, "UPDATE agent SET permission_mode='public_to' WHERE id=$1", agent)
	dbfx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": agent, "target_type": "member", "target_id": testUserID})
	taskReadCall(t, testHandler.GetTaskByUser, testUserID, ws, task, "").Want(200)
	taskReadCall(t, testHandler.ListTaskMessagesByUser, testUserID, ws, task, "/messages").Want(200)
}

func TestTaskReadHTTPChatCreatorAndRunOnlyRemainDistinct(t *testing.T) {
	ws, agent, owner, runtime := taskReadFixture(t)
	session := dbfx.ChatSession(t, agent, testutil.Cols{"workspace_id": ws, "creator_id": testUserID})
	chatTask := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "chat_session_id": session, "status": "completed"})
	// The chat creator may read their transcript even without agent INVOKE;
	// the workspace/agent owner cannot read somebody else's private chat.
	for _, reader := range []struct {
		fn     http.HandlerFunc
		suffix string
	}{{testHandler.GetTaskByUser, ""}, {testHandler.ListTaskMessagesByUser, "/messages"}} {
		taskReadCall(t, reader.fn, testUserID, ws, chatTask, reader.suffix).Want(200)
		taskReadCall(t, reader.fn, owner, ws, chatTask, reader.suffix).Want(403)
	}
	autopilot := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": ws, "title": "Run read only", "assignee_id": agent,
		"execution_mode": "run_only", "created_by_type": "member", "created_by_id": owner})
	run := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": autopilot, "source": "manual", "status": "completed"})
	task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime, "autopilot_run_id": run, "status": "completed"})
	var got AgentTaskResponse
	taskReadCall(t, testHandler.GetTaskByUser, owner, ws, task, "").Want(200).JSON(&got)
	if got.ID != task || got.IssueID != "" || got.Status != "completed" {
		t.Fatalf("run-only read depends on an Issue or write eligibility: %+v", got)
	}
	taskReadCall(t, testHandler.ListTaskMessagesByUser, owner, ws, task, "/messages").Want(200)
}

func TestTaskReadHTTPInvalidInputAndReadFailureStayExplicit(t *testing.T) {
	ws, agent, owner, runtime := taskReadFixture(t)
	task := dbfx.Task(t, agent, testutil.Cols{"runtime_id": runtime})
	for _, name := range []string{"GetAgentTaskInWorkspace", "GetAgentInWorkspace", "GetMemberByUserAndWorkspace"} {
		t.Run(name, func(t *testing.T) {
			h := *testHandler
			h.Queries = db.New(&taskReadSpy{DBTX: testPool, failQuery: name})
			actor := owner
			if name == "GetMemberByUserAndWorkspace" {
				actor = testUserID
			}
			taskReadCall(t, h.GetTaskByUser, actor, ws, task, "").Want(500)
			taskReadCall(t, h.ListTaskMessagesByUser, actor, ws, task, "/messages").Want(500)
		})
	}
	for _, fn := range []http.HandlerFunc{testHandler.GetTaskByUser, testHandler.ListTaskMessagesByUser} {
		taskReadCall(t, fn, owner, ws, "not-a-uuid", "").Want(400)
		req := testutil.WithURLParams(testutil.JSONRequest("GET", "/api/tasks/"+task, nil), "taskId", task)
		testutil.Call(t, fn, req).Want(401)
	}
}
