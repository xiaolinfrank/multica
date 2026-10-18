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

func executeDirectoryCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitMeetingDirectoryCommand()
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func TestCockpitDirectoryCLIReadsOneScopedPage(t *testing.T) {
	for _, defect := range []string{"none", "workspace", "step", "duplicate", "missing-cursor", "page-size"} {
		t.Run(defect, func(t *testing.T) {
			row := map[string]any{"id": workflowCLIUser, "step_id": workflowCLIProject, "attempt_number": 2}
			result := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "operation_id": workflowCLIVersion, "step_id": workflowCLIProject,
				"items": []any{row}, "total": 48, "page_size": 2, "next_cursor": "next"}
			switch defect {
			case "workspace":
				result["workspace_id"] = "foreign"
			case "step":
				row["step_id"] = workflowCLIUser
			case "duplicate":
				result["items"] = []any{row, row}
			case "missing-cursor":
				delete(result, "next_cursor")
			case "page-size":
				result["page_size"] = 100
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodGet || r.Header.Get("X-Workspace-ID") != "ws-1" || !strings.HasSuffix(r.URL.Path, "/steps/"+workflowCLIProject+"/attempts") || r.URL.Query().Get("cursor") != "older+page" {
					t.Error("directory read lost its exact scope or continuation")
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeDirectoryCLI(t, "attempts", workflowCLIMeeting, workflowCLIVersion, workflowCLIProject, "--page-size", "2", "--cursor", "older+page")
			if calls.Load() != 1 || (err == nil) != (defect == "none") || err == nil && !json.Valid([]byte(out)) {
				t.Fatalf("calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestCockpitDirectoryCLIKeepsFixedPrepareReceiptAndRequest(t *testing.T) {
	for _, defect := range []string{"none", "command", "target", "grant", "operation", "empty-steps", "unknown-response"} {
		t.Run(defect, func(t *testing.T) {
			body := map[string]any{"mode": "prepare", "root_id": workflowCLIProject, "relative_directory": "meetings/review", "partitions": []any{},
				"observed_nas_dir": "", "observed_binding_revision": 1, "bind_after_base": true, "command_key": meetingLifecycleCLIKey, "expected_revision": 1, "context_token": workflowCLIHash}
			target := map[string]any{"root_id": workflowCLIProject, "relative_directory": "meetings/review"}
			grant := map[string]any{"command_key": meetingLifecycleCLIKey}
			receipt := map[string]any{"directory_operation_id": workflowCLIVersion, "directory_step_ids": []any{workflowCLIUser}, "request_hash": workflowCLIHash, "plan_hash": workflowCLIHash,
				"context_token": workflowCLIHash, "target": target, "observed_binding": map[string]any{"nas_dir": "", "revision": 1}, "bind_after_base": true, "grant": grant, "state": "active"}
			current := map[string]any{"id": workflowCLIVersion, "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "plan_hash": workflowCLIHash, "state": "completed"}
			result := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "command_key": meetingLifecycleCLIKey, "action": "directory_prepare", "receipt": receipt, "current": current}
			switch defect {
			case "command":
				result["command_key"] = workflowCLIUser
			case "target":
				target["relative_directory"] = "meetings/other"
			case "grant":
				grant["command_key"] = workflowCLIUser
			case "operation":
				current["id"] = workflowCLIUser
			case "empty-steps":
				receipt["directory_step_ids"] = []any{}
			}
			filename := preparationCLIRequestFile(t, body)
			original, _ := os.ReadFile(filename)
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var submitted map[string]any
				if json.NewDecoder(r.Body).Decode(&submitted) != nil || submitted["command_key"] != meetingLifecycleCLIKey || r.Method != http.MethodPost || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/directory-preparations" {
					t.Error("prepare changed its retained command or target")
				}
				if defect == "unknown-response" {
					_, _ = io.WriteString(w, "{incomplete")
					return
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeDirectoryCLI(t, "prepare", workflowCLIMeeting, "--request-file", filename)
			after, readErr := os.ReadFile(filename)
			if readErr != nil || string(after) != string(original) || calls.Load() != 1 || (err == nil) != (defect == "none") {
				t.Fatalf("request retained=%t calls=%d err=%v readErr=%v", string(after) == string(original), calls.Load(), err, readErr)
			}
		})
	}
}

func TestCockpitDirectoryCLIRequiresExactRetrySteps(t *testing.T) {
	for _, defect := range []string{"none", "different-step", "duplicate-step", "old-grant", "foreign-operation"} {
		t.Run(defect, func(t *testing.T) {
			body := map[string]any{"command_key": meetingLifecycleCLIKey, "expected_revision": 7, "step_ids": []any{workflowCLIProject}, "context_token": workflowCLIHash, "reason": "Review the restored connection"}
			grant := map[string]any{"command_key": meetingLifecycleCLIKey}
			receipt := map[string]any{"directory_operation_id": workflowCLIVersion, "directory_step_ids": []any{workflowCLIProject}, "request_hash": workflowCLIHash, "plan_hash": workflowCLIHash, "context_token": workflowCLIHash, "reason": body["reason"], "grant": grant}
			current := map[string]any{"id": workflowCLIVersion, "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "plan_hash": workflowCLIHash}
			result := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "command_key": meetingLifecycleCLIKey, "action": "directory_retry", "receipt": receipt, "current": current}
			switch defect {
			case "different-step":
				receipt["directory_step_ids"] = []any{workflowCLIUser}
			case "duplicate-step":
				receipt["directory_step_ids"] = []any{workflowCLIProject, workflowCLIProject}
			case "old-grant":
				grant["command_key"] = workflowCLIUser
			case "foreign-operation":
				receipt["directory_operation_id"], current["id"] = workflowCLIUser, workflowCLIUser
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(result) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeDirectoryCLI(t, "retry", workflowCLIMeeting, workflowCLIVersion, "--request-file", preparationCLIRequestFile(t, body))
			if (err == nil) != (defect == "none") {
				t.Fatalf("retry err=%v", err)
			}
		})
	}
}

func TestCockpitDirectoryCLIRejectsUnobservedCommandsBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	for _, body := range []map[string]any{
		{"command_key": meetingLifecycleCLIKey, "expected_revision": 0, "context_token": workflowCLIHash},
		{"expected_revision": 1, "context_token": workflowCLIHash},
		{"command_key": meetingLifecycleCLIKey, "expected_revision": 1, "context_token": ""},
		{"command_key": meetingLifecycleCLIKey, "expected_revision": 1, "context_token": workflowCLIHash, "reason": strings.Repeat("x", 64<<10)},
	} {
		if _, err := executeDirectoryCLI(t, "prepare", workflowCLIMeeting, "--request-file", preparationCLIRequestFile(t, body)); err == nil {
			t.Fatal("unobserved or oversized command accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid commands issued %d requests", calls.Load())
	}
}
