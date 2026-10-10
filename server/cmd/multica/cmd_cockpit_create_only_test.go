package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"
)

const createOnlyCLIAttempt = "019f06d9-3020-7000-8000-000000000003"

func createOnlyCLIJob() map[string]any {
	return map[string]any{"id": workflowCLIExport, "version_id": workflowCLIVersion, "version_number": 35, "source_issue_id": workflowCLIProject,
		"root_id": workflowCLINASRoot, "directory": "/Volumes/team", "write_mode": "create_only", "content_hash": workflowCLIHash, "status": "queued", "revision": 1,
		"target_path": "/Volumes/team/已发布纪要/创建式副本/minutes-v0035-" + workflowCLIVersion + ".md"}
}

func createOnlyCLIReply(job map[string]any, compact bool) map[string]any {
	if compact {
		job["source_version"] = historyCLIMetadata()
		return map[string]any{"representation": "compact", "workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "workflow": historyCLISummary(),
			"receipt": map[string]any{"action": "nas_export_queued", "version": nil, "handoff": nil, "nas_export": job}}
	}
	return map[string]any{"meeting_id": workflowCLIMeeting, "nas_exports": []any{job}, "versions": []any{historyCLIMetadata()}}
}

func setCreateOnlyCLIProof(job map[string]any) {
	logical := job["target_path"].(string)
	base := path.Join(path.Dir(logical), workflowCLIExport, createOnlyCLIAttempt)
	job["status"], job["size_bytes"] = "succeeded", 42
	job["verified_attempt_id"], job["receipt_hash"] = createOnlyCLIAttempt, strings.Repeat("b", 64)
	job["verified_path"], job["receipt_path"] = path.Join(base, path.Base(logical)), path.Join(base, ".multica-complete.json")
}

func TestCockpitCreateOnlyCLIWireModeAndVerifiedEvidence(t *testing.T) {
	for _, action := range []string{"publish", "export-nas", "compact-export"} {
		t.Run(action, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				target := body
				if action == "publish" {
					target, _ = body["nas_export"].(map[string]any)
				}
				if r.Method != "POST" || target["write_mode"] != "create_only" || target["directory"] != "/Volumes/team" || target["root_id"] != workflowCLINASRoot {
					t.Errorf("wrong explicit mode request: %#v", body)
				}
				job := createOnlyCLIJob()
				setCreateOnlyCLIProof(job)
				_ = json.NewEncoder(w).Encode(createOnlyCLIReply(job, action == "compact-export"))
			}))
			defer server.Close()
			configureWorkflowCLIEnv(t, server.URL)
			args := []string{"export-nas", workflowCLIMeeting, workflowCLIVersion, "--root-id", workflowCLINASRoot, "--directory", "/Volumes/team", "--write-mode", "create_only"}
			if action == "publish" {
				args = []string{"publish", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--nas-root-id", workflowCLINASRoot, "--nas-directory", "/Volumes/team", "--nas-write-mode", "create_only"}
			}
			if action == "compact-export" {
				args = append(args, "--compact")
			}
			out, err := executeWorkflowCLI(t, args...)
			if err != nil || !strings.Contains(out, "verified_path") || calls.Load() != 1 {
				t.Fatalf("explicit mode not confirmed: %v %s", err, out)
			}
		})
	}
}

func TestCockpitCreateOnlyCLIRejectsUnconfirmedModeOrCompletion(t *testing.T) {
	for _, compact := range []bool{false, true} {
		for _, bad := range []string{"ignored_mode", "wrong_mode", "missing_proof", "foreign_path", "invalid_receipt"} {
			t.Run(bad+map[bool]string{true: "_compact", false: "_full"}[compact], func(t *testing.T) {
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					job := createOnlyCLIJob()
					switch bad {
					case "ignored_mode":
						delete(job, "write_mode")
					case "wrong_mode":
						job["write_mode"] = "atomic"
					case "missing_proof":
						job["status"] = "succeeded"
					case "foreign_path":
						setCreateOnlyCLIProof(job)
						job["verified_path"] = "/other/file.md"
					case "invalid_receipt":
						setCreateOnlyCLIProof(job)
						job["receipt_hash"] = "short"
					}
					_ = json.NewEncoder(w).Encode(createOnlyCLIReply(job, compact))
				}))
				defer server.Close()
				configureWorkflowCLIEnv(t, server.URL)
				args := []string{"export-nas", workflowCLIMeeting, workflowCLIVersion, "--root-id", workflowCLINASRoot, "--directory", "/Volumes/team", "--write-mode", "create_only"}
				if compact {
					args = append(args, "--compact")
				}
				out, err := executeWorkflowCLI(t, args...)
				if err == nil || out != "" || calls.Load() != 1 {
					t.Fatalf("ambiguous NAS receipt accepted or retried: %v %s", err, out)
				}
			})
		}
	}
}

func TestCockpitNASAttemptCLIRequestsOneScopedMetadataPage(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/workflow/exports/"+workflowCLIExport+"/attempts" || r.URL.Query().Get("page_size") != "1" || r.URL.Query().Get("cursor") != "next+cursor" {
			t.Errorf("unexpected page request: %s %s", r.Method, r.URL)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "export_id": workflowCLIExport, "total": 3, "next_cursor": "next-page", "items": []any{map[string]any{"id": createOnlyCLIAttempt, "attempt_number": 3, "status": "planned", "content_hash": workflowCLIHash}}})
	}))
	defer server.Close()
	configureWorkflowCLIEnv(t, server.URL)
	if out, err := executeWorkflowCLI(t, "export-attempts", workflowCLIMeeting, workflowCLIExport, "--page-size", "1", "--cursor", "next+cursor"); err != nil || calls.Load() != 1 || !strings.Contains(out, "next-page") {
		t.Fatalf("bounded attempt page failed: %v %s", err, out)
	}
}

func TestCockpitNASAttemptCLIRejectsIncorrectScopeAndUnboundedBodies(t *testing.T) {
	for _, bad := range []string{"workspace", "operation", "too_many", "body", "number", "cursor"} {
		t.Run(bad, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				row := map[string]any{"id": createOnlyCLIAttempt, "attempt_number": 3, "content_hash": workflowCLIHash}
				page := map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "export_id": workflowCLIExport, "total": 3, "next_cursor": nil, "items": []any{row}}
				switch bad {
				case "workspace":
					page["workspace_id"] = "ws-2"
				case "operation":
					page["export_id"] = workflowCLIVersion
				case "too_many":
					page["items"] = []any{row, row}
				case "body":
					row["content"] = "unexpected document body"
				case "number":
					row["attempt_number"] = 0
				case "cursor":
					page["next_cursor"] = 42
				}
				_ = json.NewEncoder(w).Encode(page)
			}))
			defer server.Close()
			configureWorkflowCLIEnv(t, server.URL)
			if out, err := executeWorkflowCLI(t, "export-attempts", workflowCLIMeeting, workflowCLIExport, "--page-size", "1"); err == nil || out != "" {
				t.Fatalf("invalid page was accepted: %s", out)
			}
		})
	}
}

func TestCockpitCreateOnlyCLIRejectsInvalidFlagsBeforeRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer server.Close()
	configureWorkflowCLIEnv(t, server.URL)
	for _, args := range [][]string{
		{"publish", workflowCLIMeeting, workflowCLIVersion, "--revision", "1", "--nas-write-mode", "create_only"},
		{"export-nas", workflowCLIMeeting, workflowCLIVersion, "--root-id", workflowCLINASRoot, "--directory", "/Volumes/team", "--write-mode", "best_effort"},
		{"export-attempts", workflowCLIMeeting, workflowCLIExport, "--page-size", "101"},
	} {
		if _, err := executeWorkflowCLI(t, args...); err == nil {
			t.Fatalf("invalid command accepted: %v", args)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid arguments reached the server")
	}
}
