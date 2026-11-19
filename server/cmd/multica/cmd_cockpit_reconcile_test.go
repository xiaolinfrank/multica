package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// reconcileCLIServer records the posted body and answers with a report shaped
// like the handler's: a merge group, a new project, one filing and a dangling
// link, so every renderer the command uses is exercised.
func reconcileCLIServer(t *testing.T, report map[string]any) (*httptest.Server, *map[string]any) {
	t.Helper()
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/cockpit/plan/reconcile" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		reply := map[string]any{"workspace_id": "ws-1", "generated_at": "2026-11-19T10:00:00Z"}
		for k, v := range report {
			reply[k] = v
		}
		if apply, _ := body["apply"].(bool); apply {
			reply["apply"] = true
		}
		_ = json.NewEncoder(w).Encode(reply)
	}))
	return srv, &body
}

func runReconcileCLI(t *testing.T, args ...string) string {
	t.Helper()
	// cobra resolves every Execute() through the root command, so the args have
	// to spell out the full path from there.
	full := append([]string{"cockpit", "reconcile"}, args...)
	rootCmd.SilenceUsage, rootCmd.SilenceErrors = true, true
	reset := func() {
		rootCmd.SetArgs(nil)
		_ = cockpitReconcileCmd.Flags().Set("apply", "false")
		_ = cockpitReconcileCmd.Flags().Set("json", "false")
	}
	reset()
	t.Cleanup(reset)
	rootCmd.SetArgs(full)
	out, err := captureStdout(t, rootCmd.Execute)
	if err != nil {
		t.Fatalf("reconcile %v: %v", args, err)
	}
	return out
}

func TestCockpitReconcileCLIDryRunApplyAndEmptyReport(t *testing.T) {
	report := map[string]any{
		"groups": []any{map[string]any{"id": "02.02-09", "name": "平台架构与开发", "kept": "node-a", "kept_code": "02.02", "removed": []any{"node-b", "node-c"}}},
		"new_projects": []any{
			map[string]any{"node_id": "node-a", "project_id": "project-1", "code": "01", "title": "高质量数据集"},
		},
		"issues": []any{
			map[string]any{"issue_id": "issue-1", "identifier": "TES-1", "rule": "single_work_item", "new_work_item": "node-c"},
		},
		"dangling_links": 2,
	}
	srv, body := reconcileCLIServer(t, report)
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	out := runReconcileCLI(t)
	if apply, ok := (*body)["apply"]; !ok || apply != false {
		t.Fatalf("dry run body = %v, want apply=false", *body)
	}
	for _, want := range []string{
		"Plan reconcile (dry run)",
		"structure groups: 1",
		"02.02-09 → kept 02.02, removed 2",
		"new projects: 1",
		"01 高质量数据集",
		"issue filings: 1",
		"TES-1 single_work_item → node-c",
		"dangling links: 2",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("dry run output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "snapshot:") {
		t.Fatalf("dry run printed a snapshot:\n%s", out)
	}

	out = runReconcileCLI(t, "--json")
	if strings.Contains(out, "Plan reconcile") {
		t.Fatalf("--json printed the human summary:\n%s", out)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(out), &decoded); err != nil {
		t.Fatalf("--json output is not JSON: %v\n%s", err, out)
	}
	if decoded["groups"] == nil {
		t.Fatalf("--json lost the report fields: %v", decoded)
	}

	// A second server answers with the applied report, because only the server
	// decides the snapshot id.
	srvApplied, bodyApplied := reconcileCLIServer(t, map[string]any{"snapshot_id": "snap-1"})
	defer srvApplied.Close()
	setCLITestServerEnv(t, srvApplied.URL)
	out = runReconcileCLI(t, "--apply")
	if apply, ok := (*bodyApplied)["apply"]; !ok || apply != true {
		t.Fatalf("apply body = %v, want apply=true", *bodyApplied)
	}
	if !strings.Contains(out, "Plan reconcile (applied)") || !strings.Contains(out, "snapshot: snap-1") {
		t.Fatalf("apply output = %s", out)
	}

	srvEmpty, _ := reconcileCLIServer(t, nil)
	defer srvEmpty.Close()
	setCLITestServerEnv(t, srvEmpty.URL)
	out = runReconcileCLI(t)
	if !strings.Contains(out, "no structure, binding, or filing changes") {
		t.Fatalf("empty report output = %s", out)
	}
}
