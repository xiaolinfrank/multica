package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

const meetingLifecycleCLIKey = "019f06d9-3020-7000-8000-000000000003"

func executeLifecycleCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitMeetingLifecycleCommand()
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func TestCockpitMeetingLifecycleCLIReadsOneBoundedRecord(t *testing.T) {
	for _, name := range []string{"lifecycle", "commands", "command"} {
		t.Run(name, func(t *testing.T) {
			args := []string{"show", workflowCLIMeeting}
			suffix := "lifecycle"
			row := map[string]any{"id": workflowCLIVersion, "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting}
			reply := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "lifecycle_revision": 2,
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
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/"+suffix || r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Errorf("unexpected scoped read: %s %s", r.Method, r.URL.String())
				}
				if name == "commands" && r.URL.Query().Get("cursor") != "older+cursor" {
					t.Error("cursor changed")
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeLifecycleCLI(t, args...)
			if err != nil || calls.Load() != 1 || !json.Valid([]byte(out)) {
				t.Fatalf("bounded record failed: calls=%d err=%v output=%q", calls.Load(), err, out)
			}
		})
	}
}
