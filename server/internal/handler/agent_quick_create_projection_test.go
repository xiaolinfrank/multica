package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
)

var quickCreateProjectionSeq atomic.Int64

// quickCreateContextJSON builds the same jsonb blob enqueueQuickCreateTask
// writes, so the projection is exercised against the real on-disk shape rather
// than a hand-rolled approximation of it.
func quickCreateContextJSON(t *testing.T, requesterID string, over func(*service.QuickCreateContext)) []byte {
	t.Helper()
	qc := service.QuickCreateContext{
		Type:        service.QuickCreateContextType,
		Prompt:      "Draft the Q4 rollout plan",
		RequesterID: requesterID,
		WorkspaceID: testWorkspaceID,
	}
	if over != nil {
		over(&qc)
	}
	raw, err := json.Marshal(qc)
	if err != nil {
		t.Fatalf("marshal quick-create context: %v", err)
	}
	return raw
}

func findTask(tasks []AgentTaskResponse, id string) *AgentTaskResponse {
	for i := range tasks {
		if tasks[i].ID == id {
			return &tasks[i]
		}
	}
	return nil
}

// TestQuickCreateProjectionIsOriginatorOnly is the security guard on the
// quick-create projection. The prompt is user-authored free text that may name
// things other workspace members should not see, so it must reach exactly one
// viewer — the person who typed it — even though the snapshot endpoint is
// workspace-wide and polled by every client.
func TestQuickCreateProjectionIsOriginatorOnly(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	n := quickCreateProjectionSeq.Add(1)
	other := dbfx.User(t, "snapshot onlooker", fmt.Sprintf("qc-onlooker-%d@multica.test", n))
	dbfx.Member(t, testWorkspaceID, other, "member")

	agentID := createHandlerTestAgent(t, fmt.Sprintf("qc-projection-agent-%d", n), []byte(`{}`))
	projectID := dbfx.Project(t, fmt.Sprintf("qc-projection-project-%d", n))

	// A quick-create: no issue_id, prompt in the context blob, mine.
	mine := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"status":              "queued",
		"originator_user_id":  testUserID,
		"accountable_user_id": testUserID,
		"context": quickCreateContextJSON(t, testUserID, func(qc *service.QuickCreateContext) {
			qc.ProjectID = projectID
			qc.SourceContextID = "11111111-1111-1111-1111-111111111111"
		}),
	})
	// A quick-create somebody else submitted, on the same visible agent.
	theirs := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"status":              "queued",
		"originator_user_id":  other,
		"accountable_user_id": other,
		"context": quickCreateContextJSON(t, other, func(qc *service.QuickCreateContext) {
			qc.Prompt = "Their private prompt"
		}),
	})
	// A normal issue-linked run. Its kind is not quick_create, so the
	// projection must decline it whoever is asking.
	issueID := dbfx.Issue(t, fmt.Sprintf("qc-projection-issue-%d", n))
	linked := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"status":              "queued",
		"issue_id":            issueID,
		"originator_user_id":  testUserID,
		"accountable_user_id": testUserID,
		"context":             quickCreateContextJSON(t, testUserID, nil),
	})

	var asMe []AgentTaskResponse
	testutil.Call(t, testHandler.ListWorkspaceAgentTaskSnapshot,
		newRequest(http.MethodGet, "/api/agent-task-snapshot", nil)).
		Want(http.StatusOK).JSON(&asMe)

	row := findTask(asMe, mine)
	if row == nil {
		t.Fatalf("my own pending quick-create is missing from the snapshot; without it the creation is invisible")
	}
	if row.Kind != "quick_create" {
		t.Errorf("expected kind quick_create for an issue-less task, got %q", row.Kind)
	}
	if row.QuickCreatePrompt != "Draft the Q4 rollout plan" {
		t.Errorf("expected my own prompt to be projected back to me, got %q", row.QuickCreatePrompt)
	}
	if row.ProjectID != projectID {
		t.Errorf("expected the pending creation's project to be projected, got %q", row.ProjectID)
	}
	if row.QuickCreateSourceContextID != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("expected the captured source context id, got %q — without it the client cannot tell that retry must go through the source-context endpoint",
			row.QuickCreateSourceContextID)
	}

	if row := findTask(asMe, theirs); row == nil {
		t.Errorf("another member's quick-create should still appear as a presence row")
	} else if row.QuickCreatePrompt != "" {
		t.Errorf("another member's prompt leaked to me: %q", row.QuickCreatePrompt)
	}

	if row := findTask(asMe, linked); row == nil {
		t.Errorf("the issue-linked task should appear in the snapshot")
	} else if row.QuickCreatePrompt != "" {
		t.Errorf("a non-quick-create task carried a quick-create prompt: %q", row.QuickCreatePrompt)
	}

	// Same endpoint, different viewer: the row stays, the prompt does not.
	var asOther []AgentTaskResponse
	testutil.Call(t, testHandler.ListWorkspaceAgentTaskSnapshot,
		newRequestAs(other, http.MethodGet, "/api/agent-task-snapshot", nil)).
		Want(http.StatusOK).JSON(&asOther)

	if row := findTask(asOther, mine); row == nil {
		t.Errorf("my quick-create should still be a visible presence row for other members")
	} else {
		if row.QuickCreatePrompt != "" {
			t.Errorf("my prompt leaked to another member: %q", row.QuickCreatePrompt)
		}
		if row.QuickCreateSourceContextID != "" {
			t.Errorf("my source context id leaked to another member: %q", row.QuickCreateSourceContextID)
		}
		if row.ProjectID != "" {
			t.Errorf("my pending creation's project leaked to another member: %q", row.ProjectID)
		}
	}
	if row := findTask(asOther, theirs); row == nil {
		t.Errorf("the other member's own quick-create is missing from their snapshot")
	} else if row.QuickCreatePrompt != "Their private prompt" {
		t.Errorf("expected the other member's own prompt projected to them, got %q", row.QuickCreatePrompt)
	}
}

// TestQuickCreateProjectionSurvivesUnreadableContext pins the best-effort
// parse: a context blob this server cannot read costs that one row its prompt,
// never the whole snapshot. The snapshot backs every presence read in the app,
// so a 500 here would blank agent activity workspace-wide.
func TestQuickCreateProjectionSurvivesUnreadableContext(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	n := quickCreateProjectionSeq.Add(1)
	agentID := createHandlerTestAgent(t, fmt.Sprintf("qc-badctx-agent-%d", n), []byte(`{}`))

	garbled := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"status":              "queued",
		"originator_user_id":  testUserID,
		"accountable_user_id": testUserID,
		"context":             []byte(`{"type":"quick_create","prompt":{"not":"a string"}}`),
	})
	healthy := dbfx.Task(t, agentID, testutil.Cols{
		"runtime_id":          testRuntimeID,
		"status":              "queued",
		"originator_user_id":  testUserID,
		"accountable_user_id": testUserID,
		"context":             quickCreateContextJSON(t, testUserID, nil),
	})

	var tasks []AgentTaskResponse
	testutil.Call(t, testHandler.ListWorkspaceAgentTaskSnapshot,
		newRequest(http.MethodGet, "/api/agent-task-snapshot", nil)).
		Want(http.StatusOK).JSON(&tasks)

	if row := findTask(tasks, garbled); row == nil {
		t.Errorf("an unreadable context must cost the row its prompt, not the row itself")
	} else if row.QuickCreatePrompt != "" {
		t.Errorf("expected no prompt from an unreadable context, got %q", row.QuickCreatePrompt)
	}
	if row := findTask(tasks, healthy); row == nil || row.QuickCreatePrompt == "" {
		t.Errorf("a neighbouring healthy row must keep its prompt")
	}
}
