package daemon

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

func TestReportWorkspaceInventory_PostsPerWorkspaceTasks(t *testing.T) {
	t.Parallel()

	var (
		mu      sync.Mutex
		gotBody map[string]any
		gotPath string
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/daemon/runtimes/rt-ws1/workspace-inventory", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotPath = r.URL.Path
		_ = json.Unmarshal(body, &gotBody)
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	d := newGCTestDaemon(t, mux)
	// One task dir for ws1 with an issue workspace.
	createTaskDir(t, d.cfg.WorkspacesRoot, "ws1", "task1", &execenv.GCMeta{
		Kind:        execenv.GCKindIssue,
		IssueID:     "issue-1",
		AgentID:     "agent-1",
		WorkspaceID: "ws1",
	})
	// The daemon watches ws1 via runtime rt-ws1.
	d.mu.Lock()
	d.workspaces["ws1"] = &workspaceState{workspaceID: "ws1", runtimeIDs: []string{"rt-ws1"}}
	d.mu.Unlock()

	d.reportWorkspaceInventory(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if gotPath == "" {
		t.Fatal("expected a workspace-inventory POST for ws1, got none")
	}
	if gotBody["workspace_id"] != "ws1" {
		t.Fatalf("workspace_id = %v, want ws1", gotBody["workspace_id"])
	}
	tasks, ok := gotBody["tasks"].([]any)
	if !ok || len(tasks) != 1 {
		t.Fatalf("expected 1 task in report, got %v", gotBody["tasks"])
	}
	task := tasks[0].(map[string]any)
	if task["issue_id"] != "issue-1" || task["agent_id"] != "agent-1" {
		t.Fatalf("task identity wrong: %v", task)
	}
}

func TestReportWorkspaceInventory_SkipsUnwatchedWorkspaces(t *testing.T) {
	t.Parallel()

	var hits int
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	d := newGCTestDaemon(t, mux)
	createTaskDir(t, d.cfg.WorkspacesRoot, "ws-orphan", "task1", &execenv.GCMeta{
		Kind: execenv.GCKindIssue, IssueID: "i1", WorkspaceID: "ws-orphan",
	})
	// No watched workspaces registered → nothing to authenticate a report with.

	d.reportWorkspaceInventory(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if hits != 0 {
		t.Fatalf("expected no reports when no workspace is watched, got %d", hits)
	}
}
