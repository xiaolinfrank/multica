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
	"time"
)

func TestCockpitArtifactCLIDownloadLinkIsExactAndShortLived(t *testing.T) {
	path := "/api/cockpit/artifact-files/" + workflowCLIVersion + "/download?token=sample.capability"
	for _, tc := range []struct {
		name, address string
		good          bool
	}{
		{"relative capability", path, true},
		{"absolute capability", "https://api.example.test" + path, true},
		{"unrelated resource", "https://api.example.test/private-file?token=sample", false},
		{"other version", "/api/cockpit/artifact-files/" + workflowCLIExport + "/download?token=sample", false},
		{"ambiguous tokens", path + "&token=another", false},
		{"redirect parameter", path + "&redirect=https://other.example", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "artifact_id": actionCLIAction, "version_id": workflowCLIVersion, "url": tc.address, "expires_at": time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeActionCLI(t, newCockpitArtifactCommand(), "download-link", actionCLIAction, workflowCLIVersion)
			if (err == nil) != tc.good {
				t.Fatalf("good=%t error=%v", tc.good, err)
			}
		})
	}
}

func TestCockpitArtifactCLIMeetingFixedReferenceScope(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		t.Run(map[bool]string{false: "fixed reference", true: "other meeting"}[wrong], func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/cockpit/meetings/"+workflowCLIMeeting+"/artifact-references" || r.URL.Query().Get("page_size") != "25" || r.URL.Query().Get("include_removed") != "false" {
					t.Errorf("wrong scoped request: %s", r.URL)
				}
				meetingID := workflowCLIMeeting
				if wrong {
					meetingID = workflowCLIExport
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "meeting_id": workflowCLIMeeting, "include_removed": false, "items": []any{map[string]any{
					"id": actionCLIKey, "artifact_id": actionCLIAction, "version_id": workflowCLIVersion, "version_number": 1, "content_hash": workflowCLIHash, "meeting_id": meetingID, "artifact_title": "Fixed report", "removed_at": nil,
				}}, "total": 1, "next_cursor": nil})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeActionCLI(t, newCockpitMeetingArtifactReferencesCommand(), workflowCLIMeeting)
			if (err != nil) != wrong {
				t.Fatalf("wrong=%t error=%v", wrong, err)
			}
		})
	}
}

func artifactCLITestVersion() map[string]any {
	return map[string]any{"id": workflowCLIVersion, "artifact_id": actionCLIAction, "version_number": 1, "revision": 1, "submission_key": actionCLIKey,
		"producer_issue_id": actionCLIIssue, "producer_run_id": nil, "source_meeting_id": nil, "source_minutes_version_id": nil,
		"payload_kind": "text", "capture_status": "ready", "decision": "pending", "content_hash": workflowCLIHash, "size_bytes": 12,
		"review_issue": map[string]any{"id": workflowCLIExport}, "reviewer_id": workflowCLIUser}
}

func artifactCLITestHeader() map[string]any {
	return map[string]any{"id": actionCLIAction, "workspace_id": "ws-1", "creation_key": actionCLIKey, "node_id": actionCLINode, "revision": 2,
		"project_id": workflowCLIProject, "module_id": workflowCLIModule, "source_issue": map[string]any{"id": actionCLIIssue}, "producer_issue": map[string]any{"id": actionCLIIssue},
		"current_version": artifactCLITestVersion(), "approved_version": nil, "evidence_version": nil}
}

func artifactCLIRequestFile(t *testing.T, body map[string]any) string {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(t.TempDir(), "command.json")
	if err := os.WriteFile(filename, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestCockpitArtifactCLIExactTextReplay(t *testing.T) {
	content := "# Report\r\nExact whitespace  \n"
	body := map[string]any{"expected_revision": 1, "submission_key": actionCLIKey, "producer_issue_id": actionCLIIssue, "payload": map[string]any{"kind": "text", "content": content}}
	file := artifactCLIRequestFile(t, body)
	version := artifactCLITestVersion()
	hash := sha256.Sum256([]byte(content))
	version["content_hash"], version["size_bytes"] = hex.EncodeToString(hash[:]), len(content)
	header := artifactCLITestHeader()
	current := artifactCLITestVersion()
	current["id"], current["version_number"] = workflowCLINASRoot, 2
	header["current_version"] = current
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "POST" || r.URL.Path != "/api/cockpit/artifacts/"+actionCLIAction+"/versions" || r.Header.Get("X-Workspace-ID") != "ws-1" {
			t.Errorf("wrong scoped request: %s %s", r.Method, r.URL)
		}
		var input map[string]any
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || artifactCLIMap(input["payload"])["content"] != content || input["producer_issue_id"] != actionCLIIssue {
			t.Errorf("exact producer/text lost: %#v, %v", input, err)
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "artifact": header,
			"version": map[string]any{"workspace_id": "ws-1", "artifact_id": actionCLIAction, "version": version, "content": content, "content_available": true}})
	}))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	out, err := executeActionCLI(t, newCockpitArtifactCommand(), "submit", actionCLIAction, "--request-file", file)
	if err != nil || calls.Load() != 1 || !strings.Contains(out, workflowCLIVersion) {
		t.Fatalf("historical submission was not confirmed: calls=%d out=%s err=%v", calls.Load(), out, err)
	}
}

func TestCockpitArtifactCLIRejectsAmbiguousIntent(t *testing.T) {
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"submit", map[string]any{"expected_revision": 1, "submission_key": actionCLIKey, "payload": map[string]any{"kind": "text", "content": "text"}}},
		{"submit", map[string]any{"expected_revision": 1, "submission_key": actionCLIKey, "producer_issue_id": actionCLIIssue, "payload": map[string]any{"kind": "text", "content": "text", "attachment_id": workflowCLIExport}}},
		{"submit", map[string]any{"expected_revision": 1, "submission_key": actionCLIKey, "producer_issue_id": actionCLIIssue, "source_minutes_version_id": workflowCLIVersion, "payload": map[string]any{"kind": "text", "content": "text"}}},
		{"assign-producer", map[string]any{"expected_revision": 1, "command_key": actionCLIKey, "issue_id": actionCLIIssue, "new_issue": map[string]any{"title": "Revise", "description": ""}, "reason": "Transfer"}},
		{"assign-producer", map[string]any{"expected_revision": 1, "command_key": actionCLIKey, "new_issue": map[string]any{"title": "Revise", "description": "", "assignee_type": "agent"}, "reason": "Transfer"}},
		{"archive", map[string]any{"expected_revision": 0}},
		{"archive", map[string]any{"expected_revision": 2, "force": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := artifactCLIRequestFile(t, tc.body)
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			if _, err := executeActionCLI(t, newCockpitArtifactCommand(), tc.name, actionCLIAction, "--request-file", file); err == nil || calls.Load() != 0 {
				t.Fatalf("ambiguous input reached the server: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestCockpitArtifactCLIBoundedSelectedEvidence(t *testing.T) {
	for _, malformed := range []bool{false, true} {
		t.Run(map[bool]string{false: "exact set", true: "wrong set"}[malformed], func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Query().Get("ids") != actionCLIAction || r.URL.Query().Get("page_size") != "100" || r.URL.Query().Get("node_id") != actionCLINode || r.URL.Query().Get("relation") != "all" {
					t.Errorf("wrong evidence query: %s", r.URL)
				}
				ids := []string{actionCLIAction}
				if malformed {
					ids = []string{workflowCLIExport}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "scope": map[string]any{"project_id": nil, "module_id": nil, "node_id": actionCLINode, "source_issue_id": nil, "q": "", "status": "", "relation": "all", "ids": ids}, "items": []any{artifactCLITestHeader()}, "total": 1, "filtered_total": 1, "next_cursor": nil})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeActionCLI(t, newCockpitArtifactCommand(), "list", "--node-id", actionCLINode, "--relation", "all", "--ids", actionCLIAction, "--page-size", "100")
			if (err != nil) != malformed || calls.Load() != 1 {
				t.Fatalf("scope result: calls=%d malformed=%t err=%v", calls.Load(), malformed, err)
			}
		})
	}
}

func TestCockpitArtifactCLIProducerHistoricalReceipt(t *testing.T) {
	body := map[string]any{"expected_revision": 2, "command_key": actionCLIKey, "new_issue": map[string]any{"title": "Revision task", "description": ""}, "reason": "Revise evidence"}
	file := artifactCLIRequestFile(t, body)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "artifact": artifactCLITestHeader(), "assignment": map[string]any{"artifact_id": actionCLIAction, "command_key": actionCLIKey, "to_issue_id": workflowCLIExport, "reason": "Revise evidence"}, "to_issue": map[string]any{"id": workflowCLIExport, "title": "Later renamed"}})
	}))
	defer srv.Close()
	configureWorkflowCLIEnv(t, srv.URL)
	if _, err := executeActionCLI(t, newCockpitArtifactCommand(), "assign-producer", actionCLIAction, "--request-file", file); err != nil {
		t.Fatal(err)
	}
}

func TestCockpitAcceptanceCLIRefusesReplacedEvidence(t *testing.T) {
	for _, wrong := range []bool{false, true} {
		t.Run(map[bool]string{false: "frozen evidence", true: "wrong evidence"}[wrong], func(t *testing.T) {
			body := map[string]any{"request_key": actionCLIKey, "expected_criteria_revision": 1, "reviewer_id": workflowCLIUser, "note": "Review this evidence", "evidence": []any{map[string]any{"criterion_id": workflowCLINASRoot, "version_ids": []string{workflowCLIVersion}}}}
			file := artifactCLIRequestFile(t, body)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				version := artifactCLITestVersion()
				version["decision"] = "approved"
				if wrong {
					version["id"] = workflowCLIExport
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"workspace_id": "ws-1", "node_id": actionCLINode, "request": map[string]any{"id": actionCLIAction, "node_id": actionCLINode, "request_key": actionCLIKey, "criteria_revision": 1, "evidence_hash": workflowCLIHash, "supersedes_request_id": nil}, "note": "Review this evidence", "evidence": []any{map[string]any{"criterion": map[string]any{"id": workflowCLINASRoot}, "versions": []any{version}}}})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)
			_, err := executeActionCLI(t, newCockpitAcceptanceCommand(), "submit", actionCLINode, "--request-file", file)
			if (err != nil) != wrong {
				t.Fatalf("wrong=%t err=%v", wrong, err)
			}
		})
	}
}
