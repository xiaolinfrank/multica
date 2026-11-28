package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// issueArtifactGCMux serves a workspace batch issue check that reports an open,
// recognized issue for every id in the request.
func issueArtifactGCMux(issueID string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/daemon/workspaces/ws/issues/gc-check", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"issues": []map[string]any{
			{"id": issueID, "found": true, "status": "in_review", "updated_at": time.Now()},
		}})
	})
	return mux
}

func readFileOrEmpty(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}

// A persistent issue workspace (CompletedTaskTTL disabled) must be preserved,
// artifact-swept once, and not re-walked on later cycles until the completed
// run changes. Advancing CompletedAt must allow exactly one more sweep.
func TestGC_IssueArtifactsSweptOncePerCompletedRun(t *testing.T) {
	t.Parallel()
	issueID := "dddddddd-0000-0000-0000-000000000001"
	d := newGCTestDaemon(t, issueArtifactGCMux(issueID))
	// Persistent NAS task dirs: no age-based removal by default.
	d.cfg.GCCompletedTaskTTL = 0
	d.cfg.GCArtifactTTL = 12 * time.Hour

	completedAt := time.Now().Add(-24 * time.Hour)
	meta := &execenv.GCMeta{
		Kind:        execenv.GCKindIssue,
		IssueID:     issueID,
		WorkspaceID: "ws",
		TaskID:      "task",
		CompletedAt: completedAt,
	}
	taskDir := createTaskDir(t, d.cfg.WorkspacesRoot, "ws", "issue-task", meta)
	writeFile(t, filepath.Join(taskDir, "node_modules/dep/index.js"), 16)
	writeFile(t, filepath.Join(taskDir, "output/result.md"), 32)
	wsDir := filepath.Dir(taskDir)
	markerPath := filepath.Join(taskDir, issueArtifactSweepFile)

	// --- First eligible cycle: preserve the dir, sweep artifacts, record it. ---
	d.gcWorkspace(context.Background(), wsDir, &gcStats{byPattern: map[string]int{}})
	assertKept(t, taskDir, ".gc_meta.json", ".task_owner", "output/result.md")
	assertGone(t, taskDir, "node_modules")
	firstMarker := readFileOrEmpty(t, markerPath)
	if len(firstMarker) != 32 {
		t.Fatalf("marker size = %d, want a sha256 digest", len(firstMarker))
	}

	// --- Second cycle, same CompletedAt: the marker must skip the walk. ---
	// An artifact recreated after the first sweep must survive untouched; if the
	// cycle walked again it would be removed.
	writeFile(t, filepath.Join(taskDir, "node_modules/dep/recreated.js"), 8)
	if got, _ := d.gcDecisionIssueResult(taskDir, meta, IssueGCCheckResult{
		ID: issueID, Found: true, Status: "in_review", UpdatedAt: time.Now(),
	}); got != gcActionSkip {
		t.Fatalf("decision after marker recorded = %d, want gcActionSkip (%d)", got, gcActionSkip)
	}
	d.gcWorkspace(context.Background(), wsDir, &gcStats{byPattern: map[string]int{}})
	assertKept(t, taskDir, "node_modules/dep/recreated.js", "output/result.md")
	if got := readFileOrEmpty(t, markerPath); !bytes.Equal(got, firstMarker) {
		t.Fatal("marker must not change when the completed run has not advanced")
	}

	// --- Third cycle after a re-run advances CompletedAt: sweep again. ---
	meta.CompletedAt = time.Now().Add(-24 * time.Hour)
	mustWriteMeta(t, taskDir, *meta)
	d.gcWorkspace(context.Background(), wsDir, &gcStats{byPattern: map[string]int{}})
	assertGone(t, taskDir, "node_modules")
	assertKept(t, taskDir, "output/result.md", ".gc_meta.json")
	if got := readFileOrEmpty(t, markerPath); bytes.Equal(got, firstMarker) {
		t.Fatal("marker must change once the completed run advances")
	}
}

// If an issue runs again between the server gc-check and acquiring the env-root
// reservation, cleanIssueTaskArtifacts must abort instead of removing the new
// run's artifacts or stamping a stale marker.
func TestGC_IssueArtifactsSkipsStaleCheckedMetaAfterRerun(t *testing.T) {
	t.Parallel()
	issueID := "dddddddd-0000-0000-0000-000000000003"
	d := newGCTestDaemon(t, issueArtifactGCMux(issueID))
	d.cfg.GCCompletedTaskTTL = 0
	d.cfg.GCArtifactTTL = 12 * time.Hour

	stale := &execenv.GCMeta{
		Kind:        execenv.GCKindIssue,
		IssueID:     issueID,
		WorkspaceID: "ws",
		TaskID:      "task-old",
		CompletedAt: time.Now().Add(-24 * time.Hour),
	}
	taskDir := createTaskDir(t, d.cfg.WorkspacesRoot, "ws", "rerun-issue", stale)

	// Simulate a new run finishing with fresh artifacts before applyGCAction runs.
	fresh := *stale
	fresh.TaskID = "task-new"
	fresh.CompletedAt = time.Now()
	mustWriteMeta(t, taskDir, fresh)
	writeFile(t, filepath.Join(taskDir, "node_modules/fresh/index.js"), 16)

	d.applyGCActionWithChatMeta(context.Background(), taskDir, gcActionCleanArtifacts, &gcStats{byPattern: map[string]int{}}, stale, gcRemovalDetails{})
	assertKept(t, taskDir, "node_modules/fresh/index.js")
	if _, err := os.Stat(filepath.Join(taskDir, issueArtifactSweepFile)); !os.IsNotExist(err) {
		t.Fatalf("stale sweep must not write a marker, stat err = %v", err)
	}
}

// An unowned legacy directory (no .task_owner) is never mutated: no artifact
// removal, no marker, no deletion, and the ownership warning fires only once
// across repeated cycles.
func TestGC_UnownedLegacyDirNeverSweptOrMarked(t *testing.T) {
	t.Parallel()
	issueID := "dddddddd-0000-0000-0000-000000000002"
	d := newGCTestDaemon(t, issueArtifactGCMux(issueID))
	d.cfg.GCCompletedTaskTTL = 0
	d.cfg.GCArtifactTTL = 12 * time.Hour

	var logs bytes.Buffer
	d.logger = slog.New(slog.NewJSONHandler(&logs, nil))

	meta := &execenv.GCMeta{
		Kind:        execenv.GCKindIssue,
		IssueID:     issueID,
		WorkspaceID: "ws",
		CompletedAt: time.Now().Add(-24 * time.Hour),
	}
	taskDir := createTaskDir(t, d.cfg.WorkspacesRoot, "ws", "legacy-task", meta)
	if err := os.Remove(filepath.Join(taskDir, ".task_owner")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(taskDir, "node_modules/dep/index.js"), 16)
	writeFile(t, filepath.Join(taskDir, "output/result.md"), 32)
	wsDir := filepath.Dir(taskDir)

	for range 3 {
		d.gcWorkspace(context.Background(), wsDir, &gcStats{byPattern: map[string]int{}})
		assertKept(t, taskDir, "node_modules/dep/index.js", "output/result.md", ".gc_meta.json")
		if _, err := os.Stat(filepath.Join(taskDir, issueArtifactSweepFile)); !os.IsNotExist(err) {
			t.Fatalf("unowned dir must never get a sweep marker, stat err = %v", err)
		}
	}

	warnings := 0
	for _, line := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("parse log %q: %v", line, err)
		}
		if record["msg"] == "gc: skipping directory without valid task ownership" {
			warnings++
		}
	}
	if warnings != 1 {
		t.Fatalf("ownership warnings = %d across three cycles, want exactly 1", warnings)
	}
}
