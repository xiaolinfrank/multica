package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCockpitMeetingRelationCLIUsesScopedAppendAndCompactRoleReceipts(t *testing.T) {
	for _, action := range []string{"link", "roles", "unlink", "list"} {
		t.Run(action, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				base := "/api/cockpit/meetings/" + workflowCLIMeeting + "/issues"
				path, method := base, http.MethodPost
				if action == "roles" {
					path, method = base+"/"+actionCLIIssue+"/roles", http.MethodPut
					if r.URL.Query().Get("response") != "compact" {
						t.Error("role command did not request the single-link receipt")
					}
				} else if action == "unlink" {
					path, method = base+"/"+actionCLIIssue, http.MethodDelete
				} else if action == "list" {
					method = http.MethodGet
					if r.URL.Query().Get("page_size") != "1" || r.URL.Query().Get("cursor") != "same+scope" {
						t.Errorf("wrong page query: %s", r.URL)
					}
				}
				if r.Method != method || r.URL.Path != path {
					t.Errorf("request %s %s, want %s %s", r.Method, r.URL, method, path)
				}
				if action == "link" || action == "roles" {
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if action == "link" && (len(body) != 1 || body["issue_id"] != actionCLIIssue) {
						t.Errorf("append replaced more than one link: %#v", body)
					}
					if action == "roles" && len(body["roles"].([]any)) != 2 {
						t.Errorf("missing purposes: %#v", body)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting,
					"link": map[string]any{"meeting_id": workflowCLIMeeting, "issue_id": actionCLIIssue, "roles": []string{"preparation", "reference"}}, "items": []any{}, "next_cursor": "next"})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			args := []string{action, workflowCLIMeeting, actionCLIIssue}
			if action == "roles" {
				args = append(args, "--role", "preparation", "--role", "reference")
			} else if action == "list" {
				args = []string{action, workflowCLIMeeting, "--page-size", "1", "--cursor", "same+scope"}
			}
			_, err := executeActionCLI(t, newCockpitMeetingRelationCommand("issue"), args...)
			if err != nil || calls != 1 {
				t.Fatalf("calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestCockpitMeetingRelationCLIRejectsImplicitClearingAndBadReceipts(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if roles, ok := body["roles"].([]any); !ok || len(roles) != 0 {
			t.Errorf("explicit clearing did not send an empty array: %#v", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"meeting_id": workflowCLIExport, "link": map[string]any{"meeting_id": workflowCLIExport, "issue_id": actionCLIIssue}})
	}))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	for _, args := range [][]string{
		{"roles", workflowCLIMeeting, actionCLIIssue},
		{"roles", workflowCLIMeeting, actionCLIIssue, "--role", "agenda"},
		{"link", "not-a-uuid", actionCLIIssue},
		{"roles", workflowCLIMeeting, actionCLIIssue, "--role", "minutes", "--clear"},
		{"list", workflowCLIMeeting, "--page-size", "101"},
	} {
		if _, err := executeActionCLI(t, newCockpitMeetingRelationCommand("issue"), args...); err == nil {
			t.Fatalf("invalid command accepted: %v", args)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid input reached the server %d times", calls)
	}
	if _, err := executeActionCLI(t, newCockpitMeetingRelationCommand("issue"), "roles", workflowCLIMeeting, actionCLIIssue, "--clear"); err == nil || !strings.Contains(err.Error(), "may have committed") {
		t.Fatalf("mismatched committed receipt was accepted: %v", err)
	}
}

func TestCockpitChangeCLIProposesOnlyPassedValueAndUsesBoundedReads(t *testing.T) {
	for _, action := range []string{"propose", "list", "preview", "withdraw"} {
		t.Run(action, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch action {
				case "propose":
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["node"] != "01.02.03" || body["field"] != "end_date" || body["new_value"] != "" || r.Method != "POST" {
						t.Errorf("wrong partial proposal: %#v %s", body, r.Method)
					}
				case "list":
					if r.URL.Path != "/api/cockpit/changes/page" || r.URL.Query().Get("page_size") != "2" || r.URL.Query().Get("status") != "decided" {
						t.Errorf("wrong bounded request: %s", r.URL)
					}
				default:
					if r.URL.Path != "/api/cockpit/changes/"+actionCLIKey+"/"+action {
						t.Errorf("wrong exact command: %s", r.URL)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": actionCLIKey, "status": "pending"})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			args := []string{action, actionCLIKey}
			if action == "propose" {
				args = []string{action, "--node", "01.02.03", "--field", "end_date", "--value", ""}
			} else if action == "list" {
				args = []string{action, "--status", "decided", "--page-size", "2"}
			}
			if _, err := executeActionCLI(t, newCockpitChangeCommand(), args...); err != nil {
				t.Fatal(err)
			}
		})
	}
}
