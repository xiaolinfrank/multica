package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

const (
	workflowCLIMeeting = "93f93b24-638b-4c6d-8826-e6d4b4d6c7f8"
	workflowCLIVersion = "aa204289-1358-4fbc-bc8d-a5bf04ce8956"
	workflowCLIUser    = "893031ef-187a-4c6d-903d-839cd1c2ab2b"
	workflowCLIProject = "879841b8-32ec-4b4c-b18d-00ac59206f21"
	workflowCLIModule  = "91160e6d-0f63-43bd-988e-7b57a2d76460"
)

func configureWorkflowCLIEnv(t *testing.T, server string) {
	t.Helper()
	t.Chdir(t.TempDir())
	setCLITestServerEnv(t, server)
	for _, name := range []string{"MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_DAEMON_PORT"} {
		t.Setenv(name, "")
	}
}

func executeWorkflowCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	cmd := newCockpitMeetingWorkflowCommand()
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

func TestCockpitWorkflowCLIWireContract(t *testing.T) {
	const content = "# 会议纪要\n\n保留正文与真实换行。\n"
	path := filepath.Join(t.TempDir(), "minutes.md")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	base := "/api/cockpit/meetings/" + workflowCLIMeeting + "/workflow"
	for _, tc := range []struct {
		name, method, path string
		args               []string
		body               map[string]any
	}{
		{"show", http.MethodGet, base, []string{"show", workflowCLIMeeting}, nil},
		{"enable new", http.MethodPost, base,
			[]string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--project-id", workflowCLIProject, "--module-id", workflowCLIModule, "--node-id", "L3-01-01", "--assignee-type", "member", "--assignee-id", workflowCLIUser},
			map[string]any{"reviewer_id": workflowCLIUser, "project_id": workflowCLIProject, "module_id": workflowCLIModule, "node_id": "L3-01-01", "assignee_type": "member", "assignee_id": workflowCLIUser}},
		{"adopt", http.MethodPost, base,
			[]string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--existing-issue-id", "BIO-314"},
			map[string]any{"reviewer_id": workflowCLIUser, "existing_issue_id": "BIO-314"}},
		{"ready", http.MethodPatch, base,
			[]string{"ready", workflowCLIMeeting, "--revision", "2", "--ended", "--materials-ready"},
			map[string]any{"expected_revision": 2, "ended": true, "materials_ready": true}},
		{"withdraw materials only", http.MethodPatch, base,
			[]string{"ready", workflowCLIMeeting, "--revision", "3", "--materials-ready=false"},
			map[string]any{"expected_revision": 3, "materials_ready": false}},
		{"release", http.MethodPost, base + "/release",
			[]string{"release", workflowCLIMeeting, "--revision", "4"},
			map[string]any{"expected_revision": 4}},
		{"reassign reviewer", http.MethodPost, base + "/reviewer",
			[]string{"reassign-reviewer", workflowCLIMeeting, "--revision", "4", "--handoff-key", workflowCLIVersion, "--reviewer-id", workflowCLIUser, "--reason", "  Team ownership changed.  "},
			map[string]any{"expected_revision": 4, "handoff_key": workflowCLIVersion, "reviewer_id": workflowCLIUser, "reason": "Team ownership changed."}},
		{"submit", http.MethodPost, base + "/versions",
			[]string{"submit", workflowCLIMeeting, "--revision", "5", "--submission-key", workflowCLIVersion, "--content-file", path},
			map[string]any{"expected_revision": 5, "submission_key": workflowCLIVersion, "content": content}},
		{"review", http.MethodPost, base + "/versions/" + workflowCLIVersion + "/review",
			[]string{"review", workflowCLIMeeting, workflowCLIVersion, "--revision", "6", "--decision", "changes_requested", "--feedback", "  Clarify the scope.  "},
			map[string]any{"expected_revision": 6, "decision": "changes_requested", "feedback": "Clarify the scope."}},
		{"publish", http.MethodPost, base + "/versions/" + workflowCLIVersion + "/publish",
			[]string{"publish", workflowCLIMeeting, workflowCLIVersion, "--revision", "7"},
			map[string]any{"expected_revision": 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bodies := make(chan map[string]any, 1)
			reply := map[string]any{"enabled": tc.name != "show", "meeting_id": workflowCLIMeeting, "revision": 8, "versions": []any{}}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tc.method || r.URL.Path != tc.path {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.URL.Path, tc.method, tc.path)
				}
				if r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Error("request did not use the configured workspace")
				}
				var body map[string]any
				if tc.method != http.MethodGet {
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Errorf("request body: %v", err)
					}
				}
				bodies <- body
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeWorkflowCLI(t, tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			var wantBody, gotOutput, wantOutput map[string]any
			want, _ := json.Marshal(tc.body)
			_ = json.Unmarshal(want, &wantBody)
			if got := <-bodies; !reflect.DeepEqual(got, wantBody) {
				t.Fatalf("body = %#v, want %#v", got, wantBody)
			}
			want, _ = json.Marshal(reply)
			_ = json.Unmarshal(want, &wantOutput)
			if err := json.Unmarshal([]byte(out), &gotOutput); err != nil || !reflect.DeepEqual(gotOutput, wantOutput) {
				t.Fatalf("stdout did not retain the JSON read model: %q (%v)", out, err)
			}
		})
	}
}

func TestCockpitWorkflowCLIRejectsInvalidCommandsBeforeRequest(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"meeting identity", []string{"show", "not-a-uuid"}, "meeting-id must be a UUID"},
		{"revision missing", []string{"release", workflowCLIMeeting}, "--revision"},
		{"handover revision missing", []string{"reassign-reviewer", workflowCLIMeeting}, "--revision"},
		{"handover key missing", []string{"reassign-reviewer", workflowCLIMeeting, "--revision", "1", "--reviewer-id", workflowCLIUser, "--reason", "New owner"}, "--handoff-key"},
		{"handover reviewer invalid", []string{"reassign-reviewer", workflowCLIMeeting, "--revision", "1", "--handoff-key", workflowCLIVersion, "--reviewer-id", "invalid", "--reason", "New owner"}, "--reviewer-id"},
		{"handover reason empty", []string{"reassign-reviewer", workflowCLIMeeting, "--revision", "1", "--handoff-key", workflowCLIVersion, "--reviewer-id", workflowCLIUser, "--reason", " "}, "--reason"},
		{"revision zero", []string{"release", workflowCLIMeeting, "--revision", "0"}, "--revision"},
		{"revision negative", []string{"release", workflowCLIMeeting, "--revision", "-2"}, "--revision"},
		{"empty readiness", []string{"ready", workflowCLIMeeting, "--revision", "1"}, "--ended or --materials-ready"},
		{"withdraw ended", []string{"ready", workflowCLIMeeting, "--revision", "1", "--ended=false"}, "--ended cannot be false"},
		{"missing reviewer", []string{"enable", workflowCLIMeeting}, "--reviewer-id"},
		{"missing assignee id", []string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--assignee-type", "agent"}, "supplied together"},
		{"missing assignee type", []string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--assignee-id", workflowCLIUser}, "supplied together"},
		{"adoption cannot reassign", []string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--existing-issue-id", "BIO-314", "--assignee-id", workflowCLIUser}, "cannot be used"},
		{"invalid project", []string{"enable", workflowCLIMeeting, "--reviewer-id", workflowCLIUser, "--project-id", "missing"}, "--project-id must be a UUID"},
		{"missing submission key", []string{"submit", workflowCLIMeeting, "--revision", "1"}, "--submission-key"},
		{"missing file", []string{"submit", workflowCLIMeeting, "--revision", "1", "--submission-key", workflowCLIVersion}, "--content-file"},
		{"done is not approval", []string{"review", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--decision", "done"}, "--decision"},
		{"return needs feedback", []string{"review", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--decision", "changes_requested"}, "--feedback"},
		{"reject needs feedback", []string{"review", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--decision", "rejected"}, "--feedback"},
		{"version identity", []string{"publish", workflowCLIMeeting, "wrong-version", "--revision", "1"}, "version-id must be a UUID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := executeWorkflowCLI(t, tc.args...)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
			if out != "" {
				t.Fatalf("invalid input printed a success response: %q", out)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid commands sent %d requests", calls.Load())
	}
}

func TestCockpitWorkflowCLIValidatesMinutesFile(t *testing.T) {
	configureWorkflowCLIEnv(t, "http://127.0.0.1:1")
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"blank", []byte(" \n\t ")},
		{"binary", []byte{0xff, 0xfe}},
		{"oversized", []byte(strings.Repeat("a", cockpitMinutesContentLimit+1))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "minutes.md")
			if err := os.WriteFile(path, tc.data, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := executeWorkflowCLI(t, "submit", workflowCLIMeeting, "--revision", "1", "--submission-key", workflowCLIVersion, "--content-file", path)
			if err == nil || !strings.Contains(err.Error(), "nonempty UTF-8") {
				t.Fatalf("unexpected file validation error: %v", err)
			}
		})
	}
}

func TestCockpitWorkflowCLIPreservesServerHumanGateAndConflict(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusConflict} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Authorization") != "Bearer mat_workflow_test" {
					t.Error("CLI replaced the supplied credential")
				}
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "workflow requires an authorized human and the current revision"})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			t.Setenv("MULTICA_TOKEN", "mat_workflow_test")
			t.Setenv("MULTICA_AGENT_ID", workflowCLIUser)
			t.Setenv("MULTICA_TASK_ID", workflowCLIVersion)
			out, err := executeWorkflowCLI(t, "review", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--decision", "approved")
			if err == nil || !strings.Contains(err.Error(), "authorized human") {
				t.Fatalf("server refusal was not returned: %v", err)
			}
			if calls.Load() != 1 || out != "" {
				t.Fatalf("refusal must not retry or print success: calls=%d output=%q", calls.Load(), out)
			}
		})
	}
}
