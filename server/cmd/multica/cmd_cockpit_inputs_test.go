package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func executeInputCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitInputCommand()
	cmd.SilenceErrors = true
	cmd.SilenceUsage = true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}
func TestCockpitInputCLIReadsOnlyOneExactMetadataPage(t *testing.T) {
	for _, defect := range []string{"none", "workspace", "input", "duplicate", "missing-cursor"} {
		t.Run(defect, func(t *testing.T) {
			row := map[string]any{"id": workflowCLIVersion, "workspace_id": "ws-1", "input_id": workflowCLIProject}
			out := map[string]any{"workspace_id": "ws-1", "input_id": workflowCLIProject, "items": []any{row}, "page_size": 2, "total": 38, "next_cursor": "continue"}
			switch defect {
			case "workspace":
				out["workspace_id"] = "another"
			case "input":
				row["input_id"] = workflowCLIMeeting
			case "duplicate":
				out["items"] = []any{row, row}
			case "missing-cursor":
				delete(out, "next_cursor")
			}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.ContentLength != 0 || r.URL.Path != "/api/cockpit/inputs/"+workflowCLIProject+"/versions" || r.URL.Query().Get("cursor") != "original+cursor" {
					t.Error("metadata query lost exact identity/cursor")
				}
				_ = json.NewEncoder(w).Encode(out)
			}))
			defer server.Close()
			configureWorkflowCLIEnv(t, server.URL)
			_, err := executeInputCLI(t, "versions", workflowCLIProject, "--page-size", "2", "--cursor", "original+cursor")
			if calls.Load() != 1 || (err == nil) != (defect == "none") {
				t.Fatalf("calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}
func TestCockpitInputCLIConfirmsFixedReceiptWithoutDependingOnLaterCurrent(t *testing.T) {
	for _, defect := range []string{"none", "body", "key", "workspace", "unknown"} {
		t.Run(defect, func(t *testing.T) {
			body := map[string]any{"command_key": meetingLifecycleCLIKey, "title": "Source material", "description": "  exact note\n", "project_id": nil, "origin_issue_id": nil}
			file := preparationCLIRequestFile(t, body)
			original, _ := os.ReadFile(file)
			receipt := map[string]any{"command_key": meetingLifecycleCLIKey, "request_hash": workflowCLIHash, "input_id": workflowCLIProject, "title": "Source material", "description": "  exact note\n", "project_id": nil, "origin_issue_id": nil}
			out := map[string]any{"workspace_id": "ws-1", "command_key": meetingLifecycleCLIKey, "action": "input_create", "receipt": receipt, "current": nil}
			switch defect {
			case "body":
				receipt["description"] = "edited later"
			case "key":
				out["command_key"] = workflowCLIUser
			case "workspace":
				out["workspace_id"] = "another"
			}
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var sent map[string]any
				if r.Method != "POST" || json.NewDecoder(r.Body).Decode(&sent) != nil || sent["command_key"] != meetingLifecycleCLIKey {
					t.Error("command intent changed")
				}
				if defect == "unknown" {
					w.WriteHeader(502)
					return
				}
				_ = json.NewEncoder(w).Encode(out)
			}))
			defer server.Close()
			configureWorkflowCLIEnv(t, server.URL)
			_, err := executeInputCLI(t, "create", "--request-file", file)
			after, _ := os.ReadFile(file)
			if calls.Load() != 1 || (err == nil) != (defect == "none") || string(after) != string(original) {
				t.Fatalf("calls=%d err=%v request changed=%v", calls.Load(), err, string(after) != string(original))
			}
		})
	}
}
func TestCockpitInputCLICommand404NeverBecomesCreation(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/commands/"+meetingLifecycleCLIKey) {
			t.Error("lookup became a write")
		}
		w.WriteHeader(404)
	}))
	defer server.Close()
	configureWorkflowCLIEnv(t, server.URL)
	if _, err := executeInputCLI(t, "create-command", meetingLifecycleCLIKey); err == nil || calls.Load() != 1 {
		t.Fatalf("unknown command lookup calls=%d err=%v", calls.Load(), err)
	}
}
