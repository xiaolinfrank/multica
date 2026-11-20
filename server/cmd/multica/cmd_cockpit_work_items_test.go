package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// workItemCLIServer answers the three calls a work-item command makes: the node
// lookup a code needs, the create, and the move.
func workItemCLIServer(t *testing.T, calls *[]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, r.Method+" "+r.URL.Path)
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/cockpit/nodes/01.01":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "module-row-1", "code": "01.01", "module_id": "module-1"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/cockpit/nodes/01.01.01":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "work-1", "code": "01.01.01"})
		case r.Method == http.MethodPost && r.URL.Path == "/api/cockpit/work-items":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["module_id"] != "module-1" || body["name"] != "注册路径设计" {
				t.Errorf("create body = %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "work-9", "code": "01.01.02", "module_id": "module-1"})
		case r.Method == http.MethodPatch && r.URL.Path == "/api/cockpit/nodes/01.01.01":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "work-1", "code": "01.02.01", "parent_id": "module-row-2", "refiled_issues": 3, "status_mapped": 1})
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/renumber"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "module-row-1", "changed": 2})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
}

func runWorkItemCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	full := append([]string{"cockpit", "work-item"}, args...)
	rootCmd.SilenceUsage, rootCmd.SilenceErrors = true, true
	rootCmd.SetArgs(nil)
	t.Cleanup(func() { rootCmd.SetArgs(nil) })
	rootCmd.SetArgs(full)
	return captureStdout(t, rootCmd.Execute)
}

// A module given by code is resolved to its module_id, and --after is resolved
// to the row id.
func TestCockpitWorkItemCLICreate(t *testing.T) {
	var calls []string
	srv := workItemCLIServer(t, &calls)
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	out, err := runWorkItemCLI(t, "create", "--module", "01.01", "--name", "注册路径设计", "--after", "01.01.01", "--creation-key", "8f9c7b6a-0000-4000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "01.01.02") {
		t.Fatalf("create output = %q", out)
	}
	if len(calls) != 3 { // module lookup, after lookup, create
		t.Fatalf("calls = %v", calls)
	}
}

// Move reports the new code, the refiled issue count and the mapped statuses.
func TestCockpitWorkItemCLIMoveReportsWhatItCarried(t *testing.T) {
	var calls []string
	srv := workItemCLIServer(t, &calls)
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	const target = "11111111-2222-4333-8444-555555555555"
	out, err := runWorkItemCLI(t, "move", "01.01.01", "--to", target)
	if err != nil {
		t.Fatal(err)
	}
	var node map[string]any
	if err := json.Unmarshal([]byte(out), &node); err != nil {
		t.Fatalf("move must print JSON by default: %v (%q)", err, out)
	}
	if node["code"] != "01.02.01" || node["refiled_issues"] != float64(3) || node["status_mapped"] != float64(1) {
		t.Fatalf("move json = %v", node)
	}
	// The prose summary is opt-in.
	rootCmd.SetArgs([]string{"cockpit", "work-item", "move", "01.01.01", "--to", target, "--output", "table"})
	table, err := captureStdout(t, rootCmd.Execute)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(table, "issues refiled: 3") {
		t.Fatalf("table output = %q", table)
	}
}

// Delete says the issues are unfiled and the directory kept.
func TestCockpitWorkItemCLIDeleteExplains(t *testing.T) {
	var calls []string
	srv := workItemCLIServer(t, &calls)
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	out, err := runWorkItemCLI(t, "delete", "01.01.01")
	if err != nil {
		t.Fatal(err)
	}
	var deleted map[string]any
	if err := json.Unmarshal([]byte(out), &deleted); err != nil {
		t.Fatalf("delete must print JSON by default: %v (%q)", err, out)
	}
	if deleted["deleted"] != true || deleted["directory_kept"] != true {
		t.Fatalf("delete json = %v", deleted)
	}
}

func TestCockpitWorkItemCLIRenumber(t *testing.T) {
	var calls []string
	srv := workItemCLIServer(t, &calls)
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	out, err := runWorkItemCLI(t, "renumber", "01.01")
	if err != nil {
		t.Fatal(err)
	}
	var renumbered map[string]any
	if err := json.Unmarshal([]byte(out), &renumbered); err != nil {
		t.Fatalf("renumber must print JSON by default: %v (%q)", err, out)
	}
	if renumbered["changed"] != float64(2) {
		t.Fatalf("renumber json = %v", renumbered)
	}
}
