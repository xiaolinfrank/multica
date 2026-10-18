package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func overviewCLIPage(project any) map[string]any {
	return map[string]any{"workspace_id": "ws-1", "project_id": project, "project_title": "", "as_of": "2026-10-10",
		"generated_at": "2026-10-10T03:04:05Z", "items": []any{}, "total": 0, "next_cursor": nil, "view": "mine", "kind": "",
		"range_start": "2026-09-11", "range_end": "2026-10-17"}
}

func overviewCLISnapshot(project any, view string) map[string]any {
	out := overviewCLIPage(project)
	delete(out, "items")
	delete(out, "total")
	delete(out, "next_cursor")
	counts := map[string]any{"total": 0, "active": 0, "unstarted": 0, "started": 0, "done": 0, "closed": 0, "unknown": 0, "overdue": 0, "blocked": 0, "unassigned": 0}
	kinds := map[string]any{"workflow": 0, "action": 0, "nas": 0, "issue": 0}
	out["board"], out["actor"], out["summary"] = nil, map[string]any{"user_id": workflowCLIUser, "role": "member", "is_human": true}, map[string]any{
		"primary_issues": counts, "my_primary_issues": counts, "execution_nodes": map[string]any{"total": 0, "with_active_issues": 0},
		"attention": map[string]any{"team_total": 0, "mine_total": 0, "team_by_kind": kinds, "mine_by_kind": kinds},
	}
	for _, key := range []string{"attention", "execution_nodes", "recent_meetings"} {
		page := overviewCLIPage(project)
		page["view"] = view
		out[key] = page
	}
	return out
}

func TestCockpitOverviewCLIUsesScopedBoundedReads(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		args       []string
		query      map[string]string
		reply      map[string]any
	}{
		{"snapshot", "/api/cockpit/overview", []string{"--as-of", "2026-10-10", "--project-id", workflowCLIProject, "--view", "team"},
			map[string]string{"as_of": "2026-10-10", "project_id": workflowCLIProject, "attention_view": "team"}, overviewCLISnapshot(workflowCLIProject, "team")},
		{"attention", "/api/cockpit/overview/attention", []string{"attention", "--as-of", "2026-10-10", "--kind", "issue", "--cursor", "next+cursor"},
			map[string]string{"as_of": "2026-10-10", "view": "mine", "kind": "issue", "page_size": "25", "cursor": "next+cursor"}, nil},
		{"execution", "/api/cockpit/overview/execution", []string{"execution", "--as-of", "2026-10-10", "--page-size", "6"},
			map[string]string{"as_of": "2026-10-10", "page_size": "6"}, nil},
		{"meetings", "/api/cockpit/overview/meetings", []string{"meetings", "--as-of", "2026-10-10", "--days", "14"},
			map[string]string{"as_of": "2026-10-10", "page_size": "25", "days": "14"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply := tc.reply
			if reply == nil {
				reply = overviewCLIPage(nil)
				if tc.name == "attention" {
					reply["kind"], reply["next_cursor"] = "issue", "opaque-continuation"
				} else if tc.name == "meetings" {
					reply["range_start"] = "2026-09-27"
				}
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != tc.path || r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Errorf("unexpected overview request: %s %s", r.Method, r.URL.String())
				}
				if len(r.URL.Query()) != len(tc.query) {
					t.Errorf("unexpected query: %s", r.URL.RawQuery)
				}
				for key, value := range tc.query {
					if r.URL.Query().Get(key) != value {
						t.Errorf("%s = %q, want %q", key, r.URL.Query().Get(key), value)
					}
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, newCockpitOverviewCommand(), tc.args...)
			if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
				t.Fatalf("expected one JSON read: calls=%d out=%s err=%v", calls.Load(), out, err)
			}
			if tc.name == "attention" && !strings.Contains(out, "opaque-continuation") {
				t.Fatal("continuation was dropped")
			}
		})
	}
}

func TestCockpitOverviewCLIRejectsAmbiguousDatesAndBounds(t *testing.T) {
	for _, args := range [][]string{
		{}, {"--as-of", "2026-02-30"}, {"--as-of", "2026-10-10T00:00:00Z"},
		{"--as-of", "2026-10-10", "--project-id", ""}, {"--as-of", "2026-10-10", "--view", "all-users"},
		{"attention", "--as-of", "2026-10-10", "--kind", "unknown"},
		{"attention", "--as-of", "2026-10-10", "--page-size", "101"},
		{"execution", "--as-of", "2026-10-10", "--view", "team"},
		{"meetings", "--as-of", "2026-10-10", "--days", "0"},
		{"meetings", "--as-of", "2026-10-10", "--days", "91"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(500) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			if _, err := executeActionCLI(t, newCockpitOverviewCommand(), args...); err == nil || calls.Load() != 0 {
				t.Fatalf("invalid scope reached HTTP: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestCockpitOverviewCLIDoesNotClaimMalformedCountsOrScope(t *testing.T) {
	for _, defect := range []string{"workspace", "date", "project", "missing scope", "wrong preview", "too many", "negative total", "missing cursor", "missing summary counts", "negative summary", "wrong meeting window", "wrong kind"} {
		t.Run(defect, func(t *testing.T) {
			reply := overviewCLISnapshot(nil, "mine")
			page := reply["attention"].(map[string]any)
			switch defect {
			case "workspace":
				reply["workspace_id"] = "foreign"
			case "date":
				reply["as_of"] = "2026-10-09"
			case "project":
				reply["project_id"] = workflowCLIProject
			case "missing scope":
				delete(reply, "project_id")
			case "wrong preview":
				page["workspace_id"] = "foreign"
			case "too many":
				page["items"], page["total"] = make([]any, 9), 9
			case "negative total":
				page["total"] = -1
			case "missing cursor":
				delete(page, "next_cursor")
			case "missing summary counts":
				reply["summary"] = map[string]any{}
			case "negative summary":
				reply["summary"].(map[string]any)["primary_issues"].(map[string]any)["active"] = -1
			case "wrong meeting window":
				reply["recent_meetings"].(map[string]any)["range_start"] = "2020-01-01"
			case "wrong kind":
				page["kind"] = "issue"
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, newCockpitOverviewCommand(), "--as-of", "2026-10-10")
			if err == nil || out != "" {
				t.Fatalf("unconfirmed overview was printed: %q, %v", out, err)
			}
		})
	}
}
