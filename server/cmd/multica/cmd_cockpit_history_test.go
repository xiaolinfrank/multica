package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func historyCLIMetadata() map[string]any {
	return map[string]any{"id": workflowCLIVersion, "version_number": 35, "content_hash": workflowCLIHash, "source_issue_id": workflowCLIProject, "has_feedback": true}
}

func historyCLISummary() map[string]any {
	return map[string]any{"representation": "summary", "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting,
		"enabled": true, "revision": 90, "reviewer_id": workflowCLIUser, "current_version_id": workflowCLIVersion, "published_version_id": nil,
		"minutes_issue":   map[string]any{"id": workflowCLIProject, "identifier": "CLI-1"},
		"current_version": historyCLIMetadata(), "published_version": nil,
		"history_counts": map[string]any{"versions": 35, "reviewer_handoffs": 30, "nas_exports": 40, "nas_active": 2}}
}

func historyCLIPage(items []any) map[string]any {
	return map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "workflow_revision": 90, "items": items, "total": 35, "next_cursor": "opaque"}
}

func TestCockpitHistoryCLIUsesOnlyRequestedBoundedRead(t *testing.T) {
	for _, action := range []string{"summary", "versions", "version", "handoffs", "exports"} {
		t.Run(action, func(t *testing.T) {
			args := []string{action, workflowCLIMeeting}
			path := "/api/cockpit/meetings/" + workflowCLIMeeting + "/workflow/" + action
			query := ""
			var reply map[string]any
			switch action {
			case "summary":
				reply = historyCLISummary()
			case "version":
				args = append(args, workflowCLIVersion)
				path = strings.TrimSuffix(path, "version") + "versions/" + workflowCLIVersion
				reply = historyCLIPage([]any{})
				reply["version"] = map[string]any{"id": workflowCLIVersion, "content": "one historical document"}
			case "versions":
				args = append(args, "--page-size", "1", "--cursor", "older+cursor")
				query = "cursor=older%2Bcursor&page_size=1"
				reply = historyCLIPage([]any{historyCLIMetadata()})
			case "handoffs":
				path = strings.TrimSuffix(path, "handoffs") + "reviewer-handoffs"
				query, reply = "page_size=25", historyCLIPage([]any{map[string]any{"id": workflowCLIProject}})
			case "exports":
				args = append(args, "--version-id", workflowCLIVersion, "--status", "active")
				query = "page_size=25&status=active&version_id=" + workflowCLIVersion
				reply = historyCLIPage([]any{map[string]any{"id": workflowCLIExport, "source_version": historyCLIMetadata()}})
				reply["version_id"], reply["status"] = workflowCLIVersion, "active"
			}
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" || r.URL.Path != path || r.URL.RawQuery != query || r.Header.Get("X-Workspace-ID") != "ws-1" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeWorkflowCLI(t, args...)
			if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
				t.Fatalf("bounded read failed: calls=%d err=%v out=%q", calls.Load(), err, out)
			}
		})
	}
}

func TestCockpitHistoryCLIRejectsUnconfirmedHistory(t *testing.T) {
	for _, defect := range []string{"workspace", "meeting", "body in metadata", "negative count", "oversized page", "missing cursor", "wrong NAS filter"} {
		t.Run(defect, func(t *testing.T) {
			version := historyCLIMetadata()
			reply := historyCLIPage([]any{version})
			args := []string{"versions", workflowCLIMeeting, "--page-size", "1"}
			switch defect {
			case "workspace":
				reply["workspace_id"] = "foreign"
			case "meeting":
				reply["meeting_id"] = workflowCLIUser
			case "body in metadata":
				version["content"] = strings.Repeat("large body", 5000)
			case "negative count":
				reply["total"] = -1
			case "oversized page":
				reply["items"] = []any{version, version}
			case "missing cursor":
				delete(reply, "next_cursor")
			case "wrong NAS filter":
				args = []string{"exports", workflowCLIMeeting, "--status", "active"}
				reply = historyCLIPage([]any{})
				reply["status"], reply["version_id"] = "succeeded", nil
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(reply) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeWorkflowCLI(t, args...)
			if err == nil || out != "" {
				t.Fatalf("unconfirmed response printed: %v %q", err, out)
			}
		})
	}
}

func TestCockpitCompactCLIAcknowledgesExactOldSubmission(t *testing.T) {
	content := "  fixed older minutes\n"
	storedContent := strings.TrimSpace(content)
	hash := sha256.Sum256([]byte(storedContent))
	file := filepath.Join(t.TempDir(), "minutes.md")
	if err := os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	for _, defect := range []string{"none", "legacy", "key", "content", "scope", "action"} {
		t.Run(defect, func(t *testing.T) {
			version := map[string]any{"id": workflowCLIProject, "version_number": 1, "submission_key": workflowCLIModule, "content": storedContent, "content_hash": hex.EncodeToString(hash[:])}
			receipt := map[string]any{"action": "submitted", "version": version, "handoff": nil, "nas_export": nil}
			reply := map[string]any{"representation": "compact", "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "workflow": historyCLISummary(), "receipt": receipt}
			switch defect {
			case "legacy":
				reply = map[string]any{"meeting_id": workflowCLIMeeting, "versions": []any{version}}
			case "key":
				version["submission_key"] = workflowCLIUser
			case "content":
				version["content"] = "unexpected content"
			case "scope":
				reply["workspace_id"] = "foreign"
			case "action":
				receipt["action"] = "published"
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Query().Get("response") != "compact" || !strings.HasSuffix(r.URL.Path, "/versions") {
					t.Errorf("unexpected compact request: %s %s", r.Method, r.URL)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if body["content"] != content || body["submission_key"] != workflowCLIModule {
					t.Error("submission intent changed")
				}
				_ = json.NewEncoder(w).Encode(reply)
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			out, err := executeWorkflowCLI(t, "submit", workflowCLIMeeting, "--revision", "1", "--submission-key", workflowCLIModule, "--content-file", file, "--compact")
			if defect == "none" {
				if err != nil || !json.Valid([]byte(out)) {
					t.Fatalf("old receipt not acknowledged: %v %q", err, out)
				}
			} else if err == nil || out != "" {
				t.Fatalf("unconfirmed compact output: %v %q", err, out)
			}
		})
	}
}

func TestCockpitCompactCLIRequiresFormalReviewAndFixedNASReceipt(t *testing.T) {
	for _, action := range []string{"review", "export-nas", "retry-nas"} {
		for _, broken := range []bool{false, true} {
			t.Run(action+map[bool]string{false: "/confirmed", true: "/wrong-receipt"}[broken], func(t *testing.T) {
				receipt := map[string]any{"action": cockpitCompactActions[action], "version": nil, "handoff": nil, "nas_export": nil}
				args := []string{action, workflowCLIMeeting, workflowCLIVersion, "--compact"}
				if action == "review" {
					args = append(args, "--revision", "3", "--decision", "approved", "--feedback", "fixed feedback")
					version := map[string]any{"id": workflowCLIVersion, "decision": "approved", "feedback": "fixed feedback", "reviewed_at": "2026-10-10T03:00:00Z"}
					if broken {
						version["feedback"] = "another decision's feedback"
					}
					receipt["version"] = version
				} else {
					job := map[string]any{"id": workflowCLIExport, "version_id": workflowCLIVersion, "version_number": 35, "source_issue_id": workflowCLIProject,
						"content_hash": workflowCLIHash, "source_version": historyCLIMetadata(), "root_id": workflowCLINASRoot, "directory": "/Volumes/team", "revision": 6, "status": "queued"}
					if action == "retry-nas" {
						args[2] = workflowCLIExport
						args = append(args, "--revision", "5")
					} else {
						args = append(args, "--root-id", workflowCLINASRoot, "--directory", "/Volumes/team")
					}
					if broken {
						job["content_hash"] = strings.Repeat("b", 64)
					}
					receipt["nas_export"] = job
				}
				reply := map[string]any{"representation": "compact", "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "workflow": historyCLISummary(), "receipt": receipt}
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Query().Get("response") != "compact" {
						t.Error("compact response not requested")
					}
					_ = json.NewEncoder(w).Encode(reply)
				}))
				defer srv.Close()
				configureWorkflowCLIEnv(t, srv.URL)
				out, err := executeWorkflowCLI(t, args...)
				if broken {
					if err == nil || out != "" {
						t.Fatalf("unconfirmed receipt printed: %v %q", err, out)
					}
				} else if err != nil || !json.Valid([]byte(out)) {
					t.Fatalf("confirmed receipt rejected: %v %q", err, out)
				}
			})
		}
	}
}
