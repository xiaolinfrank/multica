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

	"github.com/spf13/cobra"
)

func executePreparationCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitMeetingPreparationCommand()
	cmd.SilenceErrors, cmd.SilenceUsage = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func preparationCLIRequestFile(t *testing.T, body map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "request.json")
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCockpitPreparationCLIReadsBoundedScopedEffects(t *testing.T) {
	for _, defect := range []string{"none", "workspace", "operation", "nested-operation", "duplicate", "empty-next", "missing-cursor"} {
		t.Run(defect, func(t *testing.T) {
			row := map[string]any{"id": workflowCLIProject, "operation_id": workflowCLIVersion, "state": "pending"}
			result := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "operation_id": workflowCLIVersion, "items": []any{row}, "page_size": 2, "total": 80, "next_cursor": "more"}
			switch defect {
			case "workspace":
				result["workspace_id"] = "foreign"
			case "operation":
				result["operation_id"] = workflowCLIUser
			case "nested-operation":
				row["operation_id"] = workflowCLIUser
			case "duplicate":
				result["items"] = []any{row, row}
			case "empty-next":
				result["items"] = []any{}
			case "missing-cursor":
				delete(result, "next_cursor")
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/preparation-operations/"+workflowCLIVersion+"/effects" || r.Header.Get("X-Workspace-ID") != "ws-1" || r.URL.Query().Get("page_size") != "2" || r.URL.Query().Get("cursor") != "older+page" {
					t.Error("wrong request scope")
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executePreparationCLI(t, "effects", workflowCLIMeeting, workflowCLIVersion, "--page-size", "2", "--cursor", "older+page")
			if calls.Load() != 1 || (err == nil) != (defect == "none") || err == nil && !json.Valid([]byte(out)) {
				t.Fatalf("%s: calls=%d err=%v", defect, calls.Load(), err)
			}
		})
	}
}

func TestCockpitPreparationCLIRequiresExactGrantAndTerminalRunReceipt(t *testing.T) {
	for _, defect := range []string{"none", "new-grant", "new-revision", "wrong-effect", "current-is-not-receipt", "running", "unknown-status", "false-cancel"} {
		t.Run(defect, func(t *testing.T) {
			body := map[string]any{"command_key": meetingLifecycleCLIKey, "authorization_key": workflowCLIUser, "authorization_revision": 2}
			receipt := map[string]any{"effect_id": workflowCLIProject, "command_key": meetingLifecycleCLIKey, "authorization_key": workflowCLIUser, "authorization_revision": 2, "request_hash": workflowCLIHash, "facts_hash": workflowCLIHash, "applied_at": "2026-10-11T01:00:00Z", "run_id": workflowCLIUser, "kind": "stop_run", "changed": false, "run_status": "completed"}
			result := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "operation_id": workflowCLIVersion, "effect_id": workflowCLIProject, "command_key": meetingLifecycleCLIKey, "replayed": true, "receipt": receipt,
				"current": map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "id": workflowCLIVersion, "revision": 99, "state": "completed"}}
			switch defect {
			case "new-grant":
				receipt["authorization_key"] = workflowCLIVersion
			case "new-revision":
				receipt["authorization_revision"] = 3
			case "wrong-effect":
				receipt["effect_id"] = workflowCLIUser
			case "current-is-not-receipt":
				delete(result, "receipt")
			case "running":
				receipt["run_status"] = "running"
			case "unknown-status":
				receipt["run_status"] = "future_status"
			case "false-cancel":
				receipt["changed"] = true
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var sent map[string]any
				_ = json.NewDecoder(r.Body).Decode(&sent)
				if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/effects/"+workflowCLIProject+"/apply") || sent["authorization_key"] != workflowCLIUser || sent["authorization_revision"] != float64(2) || sent["command_key"] != meetingLifecycleCLIKey {
					t.Error("grant was changed")
				}
				_ = json.NewEncoder(w).Encode(result)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executePreparationCLI(t, "execute", workflowCLIMeeting, workflowCLIVersion, workflowCLIProject, "--request-file", preparationCLIRequestFile(t, body))
			if calls.Load() != 1 || (err == nil) != (defect == "none") {
				t.Fatalf("%s: calls=%d err=%v", defect, calls.Load(), err)
			}
		})
	}
}

func TestCockpitPreparationCLIRejectsMissingAuthorizationBeforeRequest(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	body := map[string]any{"command_key": meetingLifecycleCLIKey}
	_, err := executePreparationCLI(t, "execute", workflowCLIMeeting, workflowCLIVersion, workflowCLIProject, "--request-file", preparationCLIRequestFile(t, body))
	if err == nil || calls.Load() != 0 {
		t.Fatalf("missing grant must not be sent: calls=%d err=%v", calls.Load(), err)
	}
}

func TestCockpitMeetingPageRequiresArchiveFilterEcho(t *testing.T) {
	for _, mode := range []string{"active", "archived", "all"} {
		for _, echo := range []string{"missing", "active", "archived", "all"} {
			t.Run(mode+"/"+echo, func(t *testing.T) {
				result := surfaceCLIMeetings()
				if echo != "missing" {
					result["archive"] = echo
				}
				var calls atomic.Int32
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					want := mode
					if want == "active" {
						want = ""
					}
					if r.URL.Query().Get("archive") != want {
						t.Error("archive filter changed")
					}
					_ = json.NewEncoder(w).Encode(result)
				}))
				defer srv.Close()
				configureWorkflowCLIEnv(t, srv.URL)
				_, err := executeActionCLI(t, newCockpitMeetingPageCommand(), "--archive", mode, "--json")
				accepted := echo == mode || mode == "active" && echo == "missing"
				if calls.Load() != 1 || (err == nil) != accepted {
					t.Fatalf("scope echo: calls=%d err=%v accepted=%v", calls.Load(), err, accepted)
				}
			})
		}
	}
}

func TestCockpitMeetingRetirementRemovesDeadCLICommands(t *testing.T) {
	for _, tc := range []struct {
		name     string
		command  *cobra.Command
		retired  []string
		retained []string
	}{
		{"meeting", cockpitMeetingCmd, []string{"agenda", "templates", "artifact-references"}, []string{"lifecycle", "directory", "preparation", "workflow"}},
		{"disposition", newCockpitMeetingPreparationCommand(), []string{"preview", "apply"}, []string{"impact", "cancel", "dispose", "execute", "disposition"}},
		{"artifact", newCockpitArtifactCommand(), []string{"meeting-references", "reference-meeting", "remove-meeting-reference"}, []string{"node-references", "reference-node", "remove-node-reference"}},
		{"input", newCockpitInputCommand(), []string{"references", "reference", "remove-reference", "reference-command"}, []string{"manifest", "save-manifest", "run-manifest", "submit"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			commands := map[string]bool{}
			for _, command := range tc.command.Commands() {
				commands[command.Name()] = true
			}
			for _, name := range tc.retired {
				if commands[name] {
					t.Errorf("retired command %s remains registered", name)
				}
			}
			for _, name := range tc.retained {
				if !commands[name] {
					t.Errorf("shared command %s was removed", name)
				}
			}
		})
	}
}
