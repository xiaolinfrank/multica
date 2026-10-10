package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const meetingLifecycleCLIKey = "019f06d9-3020-7000-8000-000000000003"

func executeLifecycleCLI(t *testing.T, agenda bool, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitMeetingLifecycleCommand(agenda)
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func TestCockpitMeetingLifecycleCLIReadsOneBoundedRecord(t *testing.T) {
	for _, name := range []string{"lifecycle", "commands", "command", "agenda", "topic", "references"} {
		t.Run(name, func(t *testing.T) {
			isAgenda := name == "agenda" || name == "topic" || name == "references"
			args := []string{"show", workflowCLIMeeting}
			suffix := "lifecycle"
			row := map[string]any{"id": workflowCLIVersion, "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "agenda_id": workflowCLIProject}
			reply := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "lifecycle_revision": 2, "agenda_revision": 3,
				"occurrence": map[string]any{"state": "unconfirmed"}, "page_size": 1, "items": []any{row}, "total": 31, "next_cursor": "next", "include_removed": false, "q": "议题+复核"}
			switch name {
			case "commands":
				args = []string{"commands", workflowCLIMeeting, "--page-size", "1", "--cursor", "older+cursor"}
				suffix = "lifecycle/commands"
				row["command_key"] = meetingLifecycleCLIKey
			case "command":
				args = []string{"command", workflowCLIMeeting, meetingLifecycleCLIKey}
				suffix = "lifecycle/commands/" + meetingLifecycleCLIKey
				reply["command_key"], reply["receipt"] = meetingLifecycleCLIKey, map[string]any{"revision": 2}
			case "agenda":
				args = []string{"list", workflowCLIMeeting, "--page-size", "1", "--query", "议题+复核"}
				suffix = "agenda"
			case "topic":
				args = []string{"show", workflowCLIMeeting, workflowCLIProject}
				suffix = "agenda/" + workflowCLIProject
				reply["id"], reply["revision"], reply["notes"], reply["desired_outcome"] = workflowCLIProject, 4, "  仅请求这一题的正文\n", ""
			case "references":
				args = []string{"references", workflowCLIMeeting, workflowCLIProject, "--page-size", "1"}
				suffix = "agenda/" + workflowCLIProject + "/references"
				reply["agenda_id"] = workflowCLIProject
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/"+suffix || r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Errorf("unexpected scoped read: %s %s", r.Method, r.URL.String())
				}
				if name == "agenda" && r.URL.Query().Get("q") != "议题+复核" {
					t.Error("query changed")
				}
				if name == "commands" && r.URL.Query().Get("cursor") != "older+cursor" {
					t.Error("cursor changed")
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeLifecycleCLI(t, isAgenda, args...)
			if err != nil || calls.Load() != 1 || !json.Valid([]byte(out)) {
				t.Fatalf("bounded record failed: calls=%d err=%v output=%q", calls.Load(), err, out)
			}
		})
	}
}

func TestCockpitMeetingLifecycleCLIRetainsIntentAndRejectsWrongReceipt(t *testing.T) {
	for _, defect := range []string{"none", "workspace", "command", "agenda", "notes", "current-is-not-receipt"} {
		t.Run(defect, func(t *testing.T) {
			const notes = "  原始空白\n\n必须保留。\n"
			body := map[string]any{"command_key": meetingLifecycleCLIKey, "expected_revision": 1, "title": "  计划复核  ", "notes": notes}
			fixed := map[string]any{"id": workflowCLIProject, "title": "计划复核", "notes": notes}
			receipt := map[string]any{"revision": 2, "agenda_id": workflowCLIProject, "request_hash": workflowCLIHash, "agenda": fixed}
			reply := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "command_key": meetingLifecycleCLIKey,
				"action": "agenda_create", "replayed": true, "receipt": receipt,
				"current": map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "agenda_revision": 50}}
			switch defect {
			case "workspace":
				reply["workspace_id"] = "foreign"
			case "command":
				reply["command_key"] = workflowCLIUser
			case "agenda":
				fixed["id"] = workflowCLIUser
			case "notes":
				fixed["notes"] = strings.TrimSpace(notes)
			case "current-is-not-receipt":
				delete(reply, "receipt")
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var sent map[string]any
				if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
					t.Error(err)
				}
				if r.Method != "POST" || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/agenda" || sent["notes"] != notes || sent["command_key"] != meetingLifecycleCLIKey {
					t.Error("command intent was changed")
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			filename := filepath.Join(t.TempDir(), "agenda-request.json")
			data, _ := json.Marshal(body)
			if err := os.WriteFile(filename, data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := executeLifecycleCLI(t, true, "create", workflowCLIMeeting, "--request-file", filename)
			if calls.Load() != 1 || (err == nil) != (defect == "none") {
				t.Fatalf("receipt %s: calls=%d err=%v", defect, calls.Load(), err)
			}
		})
	}
}

func TestCockpitMeetingLifecycleCLIRejectsUnboundedOrCrossScopePages(t *testing.T) {
	for _, defect := range []string{"workspace", "nested-meeting", "wrong-filter", "too-many", "body-in-metadata", "missing-cursor"} {
		t.Run(defect, func(t *testing.T) {
			row := map[string]any{"id": workflowCLIProject, "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting}
			reply := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "agenda_revision": 3,
				"page_size": 1, "items": []any{row}, "total": 31, "next_cursor": "next", "include_removed": false, "q": ""}
			switch defect {
			case "workspace":
				reply["workspace_id"] = "foreign"
			case "nested-meeting":
				row["meeting_id"] = workflowCLIUser
			case "wrong-filter":
				reply["include_removed"] = true
			case "too-many":
				reply["items"] = []any{row, row}
			case "body-in-metadata":
				row["notes"] = "body must be read on demand"
			case "missing-cursor":
				delete(reply, "next_cursor")
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			if _, err := executeLifecycleCLI(t, true, "list", workflowCLIMeeting, "--page-size", "1"); err == nil {
				t.Fatalf("accepted %s", defect)
			}
		})
	}
}
