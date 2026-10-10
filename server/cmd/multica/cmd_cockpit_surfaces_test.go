package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/spf13/cobra"
)

func surfaceCLIContext(project, module any) map[string]any {
	return map[string]any{"workspace_id": "ws-1", "scope": map[string]any{"project_id": project, "module_id": module, "project_title": "Project", "module_title": "Module"}, "cockpit": nil, "actor": map[string]any{"user_id": workflowCLIUser}}
}
func surfaceCLIPlan() map[string]any {
	value := surfaceCLIContext(workflowCLIProject, workflowCLIModule)
	value["complete"] = true
	for _, key := range []string{"nodes", "payments", "milestones", "node_index", "context_node_ids", "task_counts"} {
		value[key] = []any{}
	}
	value["counts"] = map[string]any{"nodes": 0, "payments": 0, "milestones": 0, "index_nodes": 0}
	return value
}
func surfaceCLIMeetings() map[string]any {
	value := surfaceCLIContext(nil, nil)
	delete(value, "actor")
	delete(value, "cockpit")
	value["items"] = []any{map[string]any{"id": workflowCLIMeeting, "title": "Bounded meeting", "workflow_stage": "review_pending", "status": "finished"}}
	value["total"], value["next_cursor"], value["node_id"], value["node_ids"], value["date_from"], value["date_to"] = 123, "next+cursor", nil, []any{}, nil, nil
	return value
}
func surfaceCLIDiff(comparable bool) map[string]any {
	counts := map[string]any{"nodes": 1, "payments": 0, "milestones": 0}
	value := map[string]any{"workspace_id": "ws-1", "snapshot_id": workflowCLIVersion, "scope": "workspace", "page_size": 25, "generated_at": "2026-10-10T00:00:00Z", "snapshot_created_at": "2026-10-09T00:00:00Z",
		"snapshot_cockpit_id": actionCLINode, "current_cockpit_id": actionCLINode, "comparable": comparable, "reason": "legacy_identity_missing", "snapshot_complete": false, "current_complete": false,
		"snapshot_counts": counts, "current_counts": counts, "counts": map[string]any{"added": 0, "removed": 0, "modified": 0, "unchanged": 0}, "items": []any{}, "total": 0, "next_cursor": nil, "comparison_token": ""}
	if comparable {
		value["reason"], value["snapshot_complete"], value["current_complete"], value["comparison_token"] = "", true, true, workflowCLIHash
		value["counts"] = map[string]any{"added": 1, "removed": 0, "modified": 0, "unchanged": 1}
		value["items"] = []any{map[string]any{"id": actionCLIIssue, "entity_kind": "node", "change": "added", "code": "L1-01", "name": "Added", "field_changes": []any{}}}
		value["total"] = 1
	}
	return value
}
func TestCockpitSurfaceCLIWireAndSinglePages(t *testing.T) {
	for _, tc := range []struct {
		name, path string
		command    func() *cobra.Command
		args       []string
		query      map[string][]string
		reply      map[string]any
	}{
		{"context", "/api/cockpit/context", func() *cobra.Command { return newCockpitSurfaceCommand("context") }, []string{"--json"}, map[string][]string{}, surfaceCLIContext(nil, nil)},
		{"plan scope", "/api/cockpit/plan", func() *cobra.Command { return newCockpitSurfaceCommand("plan") }, []string{"--project-id", workflowCLIProject, "--module-id", workflowCLIModule, "--output", "json"}, map[string][]string{"project_id": {workflowCLIProject}, "module_id": {workflowCLIModule}}, surfaceCLIPlan()},
		{"meeting exact filters", "/api/cockpit/meetings", newCockpitMeetingPageCommand, []string{"--q", " review ", "--from", "2026-10-01", "--to", "2026-10-31", "--node-id", actionCLINode, "--party", "Partner,A", "--party", "Partner B", "--track", "Delivery,Phase 1", "--kind", "Review", "--status", "finished", "--only", "consensus", "--cursor", "same+page", "--page-size", "2", "--json"}, map[string][]string{"q": {"review"}, "date_from": {"2026-10-01"}, "date_to": {"2026-10-31"}, "node_id": {actionCLINode}, "parties": {"Partner,A", "Partner B"}, "tracks": {"Delivery,Phase 1"}, "kinds": {"Review"}, "statuses": {"finished"}, "only": {"consensus"}, "cursor": {"same+page"}, "page_size": {"2"}}, nil},
		{"version compare", "/api/cockpit/snapshots/" + workflowCLIVersion + "/diff", newCockpitVersionCompareCommand, []string{workflowCLIVersion, "--cursor", "diff+page", "--json"}, map[string][]string{"cursor": {"diff+page"}, "page_size": {"25"}}, surfaceCLIDiff(true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply := tc.reply
			if reply == nil {
				reply = surfaceCLIMeetings()
				reply["node_id"], reply["date_from"], reply["date_to"] = actionCLINode, "2026-10-01", "2026-10-31"
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != tc.path || r.Header.Get("X-Workspace-ID") != "ws-1" || !reflect.DeepEqual(map[string][]string(r.URL.Query()), tc.query) {
					t.Errorf("unexpected read: %s %s", r.Method, r.URL.String())
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, tc.command(), tc.args...)
			if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
				t.Fatalf("single confirmed page: calls=%d out=%q err=%v", calls.Load(), out, err)
			}
		})
	}
}
func TestCockpitSurfaceCLIRejectsInvalidInputBeforeHTTP(t *testing.T) {
	for _, tc := range []struct {
		command func() *cobra.Command
		args    []string
	}{
		{func() *cobra.Command { return newCockpitSurfaceCommand("context") }, []string{"--module-id", workflowCLIModule}},
		{func() *cobra.Command { return newCockpitSurfaceCommand("plan") }, []string{"--project-id", "bad"}},
		{newCockpitMeetingPageCommand, []string{"--from", "2026-02-30"}},
		{newCockpitMeetingPageCommand, []string{"--from", "2026-10-10", "--to", "2026-10-09"}},
		{newCockpitMeetingPageCommand, []string{"--page-size", "101"}},
		{newCockpitMeetingPageCommand, []string{"--only", "links,folder"}},
		{newCockpitMeetingPageCommand, []string{"--q", strings.Repeat("a", 513)}},
		{newCockpitVersionCompareCommand, []string{"not-a-UUID"}},
		{newCockpitVersionCompareCommand, []string{workflowCLIVersion, "--project-id", workflowCLIProject}},
	} {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(500) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, tc.command(), tc.args...)
			if err == nil || calls.Load() != 0 || out != "" {
				t.Fatalf("invalid request reached network: %d %q %v", calls.Load(), out, err)
			}
		})
	}
}
func TestCockpitSurfaceCLIRefusesUnconfirmedReadReceipts(t *testing.T) {
	for _, defect := range []string{"wrong workspace", "wrong module", "partial plan", "wrong count", "meeting body", "missing cursor", "wrong date", "wrong snapshot", "false empty diff", "wrong digest"} {
		t.Run(defect, func(t *testing.T) {
			reply := surfaceCLIPlan()
			cmd := newCockpitSurfaceCommand("plan")
			args := []string{"--project-id", workflowCLIProject, "--module-id", workflowCLIModule, "--json"}
			switch defect {
			case "wrong workspace":
				reply["workspace_id"] = "other"
			case "wrong module":
				reply["scope"].(map[string]any)["module_id"] = nil
			case "partial plan":
				reply["complete"] = false
			case "wrong count":
				reply["counts"].(map[string]any)["nodes"] = 1
			case "meeting body", "missing cursor", "wrong date":
				reply = surfaceCLIMeetings()
				cmd = newCockpitMeetingPageCommand()
				args = []string{"--json"}
				if defect == "meeting body" {
					reply["items"].([]any)[0].(map[string]any)["minutes"] = "not bounded metadata"
				} else if defect == "missing cursor" {
					delete(reply, "next_cursor")
				} else {
					reply["date_from"] = "2026-10-10"
				}
			case "wrong snapshot", "false empty diff", "wrong digest":
				reply = surfaceCLIDiff(true)
				cmd = newCockpitVersionCompareCommand()
				args = []string{workflowCLIVersion, "--json"}
				if defect == "wrong snapshot" {
					reply["snapshot_id"] = actionCLIAction
				} else if defect == "false empty diff" {
					reply["comparable"] = false
					reply["reason"] = "legacy_identity_missing"
				} else {
					reply["comparison_token"] = "not a digest"
				}
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, cmd, args...)
			if err == nil || out != "" {
				t.Fatalf("unconfirmed receipt printed: %q/%v", out, err)
			}
		})
	}
}
func TestCockpitSurfaceCLITextExplainsLegacyAndContinuation(t *testing.T) {
	for _, legacy := range []bool{true, false} {
		t.Run(strconvBoolForSurfaceTest(legacy), func(t *testing.T) {
			reply := surfaceCLIMeetings()
			cmd := newCockpitMeetingPageCommand()
			args := []string{}
			if legacy {
				reply = surfaceCLIDiff(false)
				cmd = newCockpitVersionCompareCommand()
				args = []string{workflowCLIVersion}
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, cmd, args...)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, "Workspace: ws-1") || !strings.Contains(out, "Scope:") {
				t.Fatal(out)
			}
			if legacy {
				if !strings.Contains(out, "Not comparable: legacy_identity_missing") {
					t.Fatal(out)
				}
			} else if !strings.Contains(out, "This page: 1 of 123") || !strings.Contains(out, "No further pages were requested") || !strings.Contains(out, "next+cursor") {
				t.Fatal(out)
			}
		})
	}
}

func TestCockpitSurfaceCLIJSONPreservesExactFieldDecimals(t *testing.T) {
	reply := surfaceCLIDiff(true)
	reply["counts"] = map[string]any{"added": 0, "removed": 0, "modified": 1, "unchanged": 1}
	item := reply["items"].([]any)[0].(map[string]any)
	item["entity_kind"], item["change"] = "payment", "modified"
	item["field_changes"] = []any{map[string]any{"field": "amount", "before": map[string]any{"value": json.Number("9007199254740993.0001"), "truncated": false, "sha256": workflowCLIHash}, "after": map[string]any{"value": json.Number("9007199254740993.0002"), "truncated": false, "sha256": workflowCLIHash}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	out, err := executeActionCLI(t, newCockpitVersionCompareCommand(), workflowCLIVersion, "--json")
	if err != nil || !strings.Contains(out, "9007199254740993.0001") || !strings.Contains(out, "9007199254740993.0002") {
		t.Fatalf("wire decimals rounded: %q/%v", out, err)
	}
}
func strconvBoolForSurfaceTest(value bool) string {
	if value {
		return "legacy"
	}
	return "one page"
}

func TestCockpitOverviewCLIModuleScopeIsExplicitAndConfirmed(t *testing.T) {
	for _, defect := range []string{"", "missing project", "wrong nested module", "module omitted"} {
		t.Run(defect, func(t *testing.T) {
			reply := overviewCLISnapshot(workflowCLIProject, "mine")
			reply["module_id"] = workflowCLIModule
			for _, key := range []string{"attention", "execution_nodes", "recent_meetings"} {
				reply[key].(map[string]any)["module_id"] = workflowCLIModule
			}
			if defect == "wrong nested module" {
				reply["attention"].(map[string]any)["module_id"] = nil
			}
			if defect == "module omitted" {
				delete(reply, "module_id")
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Query().Get("module_id") != workflowCLIModule || r.URL.Query().Get("project_id") != workflowCLIProject {
					t.Errorf("module scope dropped: %s", r.URL.String())
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			args := []string{"--as-of", "2026-10-10", "--project-id", workflowCLIProject, "--module-id", workflowCLIModule}
			if defect == "missing project" {
				args = []string{"--as-of", "2026-10-10", "--module-id", workflowCLIModule}
			}
			out, err := executeActionCLI(t, newCockpitOverviewCommand(), args...)
			if defect == "" {
				if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
					t.Fatalf("valid module scope rejected: %q %v", out, err)
				}
			} else if err == nil || out != "" {
				t.Fatalf("unconfirmed module scope: %q %v", out, err)
			}
			if defect == "missing project" && calls.Load() != 0 {
				t.Fatal("missing project reached HTTP")
			}
		})
	}
}
