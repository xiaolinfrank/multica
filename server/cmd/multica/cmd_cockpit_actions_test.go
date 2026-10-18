package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/spf13/cobra"
)

const (
	actionCLIAction = "d6b4074c-662b-4418-a1f8-9e53e69373ac"
	actionCLIIssue  = "4870358e-ff77-4e49-9028-1b17ed6f9f7e"
	actionCLINode   = "be38a7e4-965c-4d82-a601-b3d95b26f384"
	actionCLIKey    = "7037ed4c-a0d0-42c5-8126-a6fa50f1604b"
)

func executeActionCLI(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func actionCLIReceipt() map[string]any {
	return map[string]any{"id": actionCLIAction, "meeting_id": workflowCLIMeeting, "version_id": workflowCLIVersion,
		"revision": 2, "proposal_key": actionCLIKey, "title": "Confirm the boundary", "description": "", "source_quote": "", "status": "draft"}
}

func TestCockpitActionCLIWireAndScope(t *testing.T) {
	base := "/api/cockpit/meetings/" + workflowCLIMeeting + "/workflow"
	for _, tc := range []struct {
		name, method, path string
		args               []string
		body, reply        map[string]any
	}{
		{"single action", "GET", base + "/actions/" + actionCLIAction,
			[]string{"show", workflowCLIMeeting, actionCLIAction}, nil, actionCLIReceipt()},
		{"bounded list", "GET", base + "/actions?cursor=next%2Bpage&page_size=25&q=boundary&status=draft&version_id=" + workflowCLIVersion,
			[]string{"list", workflowCLIMeeting, "--version-id", workflowCLIVersion, "--query", "boundary", "--status", "draft", "--cursor", "next+page"}, nil,
			map[string]any{"meeting_id": workflowCLIMeeting, "items": []any{}, "total": 120, "filtered_total": 35, "next_cursor": "keep-this-cursor"}},
		{"add", "POST", base + "/versions/" + workflowCLIVersion + "/actions",
			[]string{"add", workflowCLIMeeting, workflowCLIVersion, "--proposal-key", actionCLIKey, "--title", " Confirm the boundary "},
			map[string]any{"proposal_key": actionCLIKey, "title": "Confirm the boundary", "description": "", "source_quote": ""}, actionCLIReceipt()},
		{"edit explicit clearing", "PATCH", base + "/actions/" + actionCLIAction,
			[]string{"edit", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--title", "Confirm the boundary", "--description", "", "--source-quote", ""},
			map[string]any{"expected_revision": 1, "title": "Confirm the boundary", "description": "", "source_quote": ""}, actionCLIReceipt()},
		{"create without dispatch", "POST", base + "/actions/" + actionCLIAction + "/resolve",
			[]string{"resolve", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--decision-key", actionCLIKey, "--outcome", "create", "--node-id", actionCLINode,
				"--assignee-type", "member", "--assignee-id", workflowCLIUser, "--priority", "high", "--due-date", "2026-12-31"},
			map[string]any{"expected_revision": 1, "decision_key": actionCLIKey, "outcome": "create", "node_id": actionCLINode,
				"assignee_type": "member", "assignee_id": workflowCLIUser, "priority": "high", "due_date": "2026-12-31"}, nil},
		{"reuse preserves fields", "POST", base + "/actions/" + actionCLIAction + "/resolve",
			[]string{"resolve", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--decision-key", actionCLIKey, "--outcome", "reuse", "--node-id", actionCLINode, "--issue-id", actionCLIIssue},
			map[string]any{"expected_revision": 1, "decision_key": actionCLIKey, "outcome": "reuse", "node_id": actionCLINode, "issue_id": actionCLIIssue}, nil},
		{"dismiss", "POST", base + "/actions/" + actionCLIAction + "/resolve",
			[]string{"resolve", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--decision-key", actionCLIKey, "--outcome", "dismiss", "--reason", " Already handled "},
			map[string]any{"expected_revision": 1, "decision_key": actionCLIKey, "outcome": "dismiss", "reason": "Already handled"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reply := tc.reply
			if reply == nil {
				reply = actionCLIReceipt()
				reply["decision_key"], reply["resolution"] = actionCLIKey, tc.body["outcome"]
				if tc.body["outcome"] == "dismiss" {
					reply["status"], reply["reason"] = "dismissed", "Already handled"
				} else {
					reply["status"], reply["node_id"], reply["issue"] = "accepted", actionCLINode, map[string]any{"id": actionCLIIssue}
				}
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != tc.method || r.URL.RequestURI() != tc.path || r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
				}
				if tc.body != nil {
					var got, want map[string]any
					if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
						t.Error(err)
					}
					data, _ := json.Marshal(tc.body)
					_ = json.Unmarshal(data, &want)
					if !reflect.DeepEqual(got, want) {
						t.Errorf("body = %#v, want %#v", got, want)
					}
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, newCockpitMeetingActionCommand(), tc.args...)
			if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
				t.Fatalf("one scoped request must retain JSON output: calls=%d out=%s err=%v", calls.Load(), out, err)
			}
			if tc.name == "bounded list" && !strings.Contains(out, "keep-this-cursor") {
				t.Fatal("list dropped its continuation token")
			}
		})
	}
}

func TestCockpitActionCLIRejectsAmbiguousWritesBeforeHTTP(t *testing.T) {
	resolve := []string{"resolve", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--decision-key", actionCLIKey}
	for _, args := range [][]string{
		{"list", workflowCLIMeeting, "--page-size", "101"},
		{"list", workflowCLIMeeting, "--page-size", "0"},
		{"add", workflowCLIMeeting, workflowCLIVersion, "--title", "Missing idempotency"},
		{"edit", workflowCLIMeeting, actionCLIAction, "--revision", "1", "--title", "Do not clear hidden text"},
		append(append([]string{}, resolve...), "--outcome", "dismiss"),
		append(append([]string{}, resolve...), "--outcome", "dismiss", "--reason", "No work", "--node-id", actionCLINode),
		append(append([]string{}, resolve...), "--outcome", "reuse", "--node-id", actionCLINode),
		append(append([]string{}, resolve...), "--outcome", "reuse", "--node-id", actionCLINode, "--issue-id", actionCLIIssue, "--priority", "high"),
		append(append([]string{}, resolve...), "--outcome", "create", "--node-id", actionCLINode, "--due-date", "2026-02-30"),
		append(append([]string{}, resolve...), "--outcome", "create", "--node-id", actionCLINode, "--assignee-type", "member"),
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(500) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			if _, err := executeActionCLI(t, newCockpitMeetingActionCommand(), args...); err == nil || calls.Load() != 0 {
				t.Fatalf("invalid intent reached HTTP: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestCockpitActionCLIRejectsUnconfirmedReceipts(t *testing.T) {
	for _, problem := range []string{"wrong meeting", "wrong action", "wrong decision", "wrong node", "missing issue", "still draft"} {
		t.Run(problem, func(t *testing.T) {
			reply := actionCLIReceipt()
			reply["decision_key"], reply["resolution"], reply["status"] = actionCLIKey, "create", "accepted"
			reply["node_id"], reply["issue"] = actionCLINode, map[string]any{"id": actionCLIIssue}
			switch problem {
			case "wrong meeting":
				reply["meeting_id"] = workflowCLIVersion
			case "wrong action":
				reply["id"] = workflowCLIVersion
			case "wrong decision":
				reply["decision_key"] = workflowCLIVersion
			case "wrong node":
				reply["node_id"] = workflowCLIVersion
			case "missing issue":
				reply["issue"] = nil
			case "still draft":
				reply["status"] = "draft"
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeActionCLI(t, newCockpitMeetingActionCommand(), "resolve", workflowCLIMeeting, actionCLIAction,
				"--revision", "1", "--decision-key", actionCLIKey, "--outcome", "create", "--node-id", actionCLINode)
			if err == nil || !strings.Contains(err.Error(), "receipt was not confirmed") || out != "" {
				t.Fatalf("unconfirmed action printed success: out=%s err=%v", out, err)
			}
		})
	}
}

func TestCockpitNodeTaskCLIUsesBoundedPagesAndAtomicCreation(t *testing.T) {
	for _, create := range []bool{false, true} {
		t.Run(map[bool]string{false: "list", true: "create"}[create], func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/api/cockpit/nodes/"+actionCLINode+"/tasks" {
					t.Errorf("unexpected endpoint (must not fetch the board): %s", r.URL.Path)
				}
				if create {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if r.Method != "POST" || body["creation_key"] != actionCLIKey || body["title"] != "One task" || body["status"] != nil {
						t.Errorf("creation intent: %s %v", r.Method, body)
					}
					// A replay keeps its creation identity even after an explicit move.
					_ = json.NewEncoder(w).Encode(map[string]any{"id": actionCLIIssue, "creation_key": actionCLIKey, "primary_node_id": workflowCLIProject, "primary_revision": 3})
				} else {
					if r.Method != "GET" || r.URL.Query().Get("category") != "active" || r.URL.Query().Get("page_size") != "25" {
						t.Errorf("query: %s %s", r.Method, r.URL.RawQuery)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"node_id": actionCLINode, "items": []any{}, "total": 125, "filtered_total": 0, "next_cursor": nil})
				}
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			cmd, args := newCockpitNodeTasksCommand(), []string{actionCLINode, "--category", "active"}
			if create {
				cmd, args = newCockpitNodeCreateTaskCommand(), []string{actionCLINode, "--creation-key", actionCLIKey, "--title", "One task"}
			}
			if _, err := executeActionCLI(t, cmd, args...); err != nil || calls.Load() != 1 {
				t.Fatalf("unexpected calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestCockpitPrimaryCLIReadsAndExplicitlyChangesOwnership(t *testing.T) {
	for _, mode := range []string{"show", "set", "clear", "unconfirmed"} {
		t.Run(mode, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/cockpit/issues/"+actionCLIIssue+"/primary-node" {
					t.Errorf("endpoint %s", r.URL.Path)
				}
				var node any
				revision := 0
				if mode != "show" {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if r.Method != "PUT" || body["expected_revision"] != float64(0) {
						t.Errorf("missing observed ownership revision: %s %v", r.Method, body)
					}
					node, revision = body["node_id"], 1
				} else if r.Method != "GET" {
					t.Error("reading ownership performed a write")
				}
				if mode == "unconfirmed" {
					node = workflowCLIVersion
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"issue_id": actionCLIIssue, "node_id": node, "revision": revision})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			args := []string{"primary", actionCLIIssue}
			if mode == "set" || mode == "unconfirmed" {
				args = append(args, "--node-id", actionCLINode, "--revision", "0")
			} else if mode == "clear" {
				args = append(args, "--clear", "--revision", "0")
			}
			_, err := executeActionCLI(t, newCockpitIssueCommand(), args...)
			if (err != nil) != (mode == "unconfirmed") {
				t.Fatalf("mode=%s err=%v", mode, err)
			}
		})
	}
}
