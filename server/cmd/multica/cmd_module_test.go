package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/multica-ai/multica/server/internal/cli"
)

const (
	testProjectUUID   = "33333333-3333-3333-3333-333333333333"
	testModuleUUID    = "22222222-2222-2222-2222-222222222222"
	testModuleAltUUID = "44444444-4444-4444-4444-444444444444"
)

func newModuleCreateTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "create"}
	cmd.Flags().String("project", "", "")
	cmd.Flags().String("title", "", "")
	cmd.Flags().String("description", "", "")
	cmd.Flags().String("output", "json", "")
	return cmd
}

func newModuleUpdateTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "update"}
	cmd.Flags().String("project", "", "")
	cmd.Flags().String("title", "", "")
	cmd.Flags().String("description", "", "")
	cmd.Flags().Float64("position", 0, "")
	cmd.Flags().String("output", "json", "")
	return cmd
}

func newModuleListTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "list"}
	cmd.Flags().String("project", "", "")
	cmd.Flags().String("output", "table", "")
	cmd.Flags().Bool("full-id", false, "")
	return cmd
}

// moduleRow is the shape ListModules/GetModule answer with, including the
// issue counters the CLI renders as done/total. There is no collab_path: a
// module's deliverables live in a folder named after it inside the project's
// collaboration space, so the module itself stores no path.
func moduleRow(id, title string) map[string]any {
	return map[string]any{
		"id":           id,
		"workspace_id": "ws-1",
		"project_id":   testProjectUUID,
		"title":        title,
		"description":  nil,
		"position":     0,
		"issue_count":  4,
		"done_count":   1,
	}
}

// TestRunModuleCreateSendsProjectAndTitle pins the create payload: only the
// flags the caller actually set are sent, and the CLI prints the module
// unwrapped from the {"module": ...} envelope the endpoint answers with.
func TestRunModuleCreateSendsProjectAndTitle(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/modules" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"module": moduleRow(testModuleUUID, "01高质量数据集"),
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newModuleCreateTestCmd()
	_ = cmd.Flags().Set("project", testProjectUUID)
	_ = cmd.Flags().Set("title", "01高质量数据集")

	out, err := captureStdout(t, func() error { return runModuleCreate(cmd, nil) })
	if err != nil {
		t.Fatalf("runModuleCreate: %v", err)
	}
	if body["project_id"] != testProjectUUID || body["title"] != "01高质量数据集" {
		t.Fatalf("body = %#v, want project_id and title", body)
	}
	if _, ok := body["collab_path"]; ok {
		t.Fatalf("body = %#v, a module has no collaboration-space path of its own", body)
	}
	if _, ok := body["description"]; ok {
		t.Fatalf("body = %#v, an unset --description must not be sent", body)
	}

	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("decode stdout JSON: %v\n%s", err, out)
	}
	if got["id"] != testModuleUUID || got["title"] != "01高质量数据集" {
		t.Fatalf("stdout = %#v, want the created module itself, not the envelope", got)
	}
}

// TestRunModuleCreateRequiresProject keeps the module/project invariant on the
// client: a module always belongs to a project, so the CLI must not POST a
// body the server can only answer with a 400.
func TestRunModuleCreateRequiresProject(t *testing.T) {
	cmd := newModuleCreateTestCmd()
	_ = cmd.Flags().Set("title", "01高质量数据集")

	err := runModuleCreate(cmd, nil)
	if err == nil || !strings.Contains(err.Error(), "--project is required") {
		t.Fatalf("error = %v, want --project is required", err)
	}
}

// TestRunModuleUpdateClearsDescription pins the presence semantics shared with
// `project update`: an explicit empty --description reaches the server as a
// clear, and flags the caller never typed stay out of the payload entirely.
func TestRunModuleUpdateClearsDescription(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/api/modules/"+testModuleUUID {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"module": moduleRow(testModuleUUID, "01高质量数据集"),
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newModuleUpdateTestCmd()
	_ = cmd.Flags().Set("description", "")

	if _, err := captureStdout(t, func() error { return runModuleUpdate(cmd, []string{testModuleUUID}) }); err != nil {
		t.Fatalf("runModuleUpdate: %v", err)
	}
	v, ok := body["description"]
	if !ok || v != "" {
		t.Fatalf("body = %#v, want description present and empty", body)
	}
	if len(body) != 1 {
		t.Fatalf("body = %#v, want only description", body)
	}
}

// TestRunModuleUpdateWithoutFieldsNamesEveryFlag guards the failure mode the
// project command had: an error message that lists flags must list all of
// them, or it sends the caller looking for a flag it did not mention.
func TestRunModuleUpdateWithoutFieldsNamesEveryFlag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newModuleUpdateTestCmd()
	err := runModuleUpdate(cmd, []string{testModuleUUID})
	if err == nil {
		t.Fatal("expected an error when no field flag is set")
	}
	for _, flag := range []string{"--title", "--description", "--position"} {
		if !strings.Contains(err.Error(), flag) {
			t.Fatalf("error = %q, want it to name %s", err, flag)
		}
	}
}

// TestRunModuleListScopesAndShowsProgress covers the project scoping (the
// endpoint only reads project_id; the workspace rides on the header) and the
// table columns. There is deliberately no collaboration-space column: a module
// stores no path, so one could only ever render empty.
func TestRunModuleListScopesAndShowsProgress(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/modules" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if got := r.URL.Query().Get("project_id"); got != testProjectUUID {
			t.Errorf("project_id = %q, want %q", got, testProjectUUID)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"modules": []any{moduleRow(testModuleUUID, "01高质量数据集")},
			"total":   1,
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newModuleListTestCmd()
	_ = cmd.Flags().Set("project", testProjectUUID)

	out, err := captureStdout(t, func() error { return runModuleList(cmd, nil) })
	if err != nil {
		t.Fatalf("runModuleList: %v", err)
	}
	if strings.Contains(out, "COLLABORATION SPACE") {
		t.Fatalf("stdout = %q, a module has no collaboration-space path to show", out)
	}
	if !strings.Contains(out, "01高质量数据集") {
		t.Fatalf("stdout = %q, want the module title", out)
	}
	if !strings.Contains(out, "1/4") {
		t.Fatalf("stdout = %q, want done/total issue counts", out)
	}
}

// moduleResolverServer answers GET /api/modules for the resolver tests: two
// modules share a title across projects, which is legal, so only the
// project-scoped lookup can pick one.
func moduleResolverServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/modules" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		scoped := moduleRow(testModuleUUID, "回顾性队列数据集")
		other := moduleRow(testModuleAltUUID, "回顾性队列数据集")
		other["project_id"] = "55555555-5555-5555-5555-555555555555"
		if r.URL.Query().Get("project_id") == testProjectUUID {
			_ = json.NewEncoder(w).Encode(map[string]any{"modules": []any{scoped}, "total": 1})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"modules": []any{scoped, other}, "total": 2})
	}))
}

func TestResolveModuleIDAcceptsTitleAndPrefix(t *testing.T) {
	srv := moduleResolverServer(t)
	defer srv.Close()
	client := cli.NewAPIClient(srv.URL, "ws-1", "test-token")
	ctx := context.Background()

	t.Run("title inside a project", func(t *testing.T) {
		got, err := resolveModuleID(ctx, client, testProjectUUID, "回顾性队列数据集")
		if err != nil {
			t.Fatalf("resolveModuleID: %v", err)
		}
		if got.ID != testModuleUUID {
			t.Fatalf("id = %q, want %q", got.ID, testModuleUUID)
		}
	})

	t.Run("title colliding across projects", func(t *testing.T) {
		_, err := resolveModuleID(ctx, client, "", "回顾性队列数据集")
		if err == nil {
			t.Fatal("expected an ambiguity error without a project scope")
		}
		if !strings.Contains(err.Error(), "--project") {
			t.Fatalf("error = %q, want it to point at --project", err)
		}
	})

	t.Run("short id prefix", func(t *testing.T) {
		got, err := resolveModuleID(ctx, client, "", "22222222")
		if err != nil {
			t.Fatalf("resolveModuleID: %v", err)
		}
		if got.ID != testModuleUUID {
			t.Fatalf("id = %q, want %q", got.ID, testModuleUUID)
		}
	})

	t.Run("full uuid needs no lookup", func(t *testing.T) {
		got, err := resolveModuleID(ctx, client, "", testModuleAltUUID)
		if err != nil {
			t.Fatalf("resolveModuleID: %v", err)
		}
		if got.ID != testModuleAltUUID {
			t.Fatalf("id = %q, want %q", got.ID, testModuleAltUUID)
		}
	})

	t.Run("unknown title", func(t *testing.T) {
		_, err := resolveModuleID(ctx, client, testProjectUUID, "不存在的模块")
		if err == nil || !strings.Contains(err.Error(), "no module found") {
			t.Fatalf("error = %v, want a no-module-found error", err)
		}
	})
}

// TestRunIssueCreateResolvesModuleTitle checks the whole --module path on
// `issue create`: the title is resolved within --project and the issue payload
// carries the module UUID, which is what the API accepts.
func TestRunIssueCreateResolvesModuleTitle(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/modules":
			if got := r.URL.Query().Get("project_id"); got != testProjectUUID {
				t.Errorf("module lookup project_id = %q, want %q", got, testProjectUUID)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"modules": []any{moduleRow(testModuleUUID, "回顾性队列数据集")},
				"total":   1,
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/issues":
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "issue-1", "identifier": "MUL-1", "title": "Load the cohort",
				"status": "todo", "priority": "none",
			})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newIssueCreateTestCmd()
	_ = cmd.Flags().Set("title", "Load the cohort")
	_ = cmd.Flags().Set("project", testProjectUUID)
	_ = cmd.Flags().Set("module", "回顾性队列数据集")

	if _, err := captureStdout(t, func() error { return runIssueCreate(cmd, nil) }); err != nil {
		t.Fatalf("runIssueCreate: %v", err)
	}
	if body["module_id"] != testModuleUUID {
		t.Fatalf("body[module_id] = %#v, want %q", body["module_id"], testModuleUUID)
	}
	if body["project_id"] != testProjectUUID {
		t.Fatalf("body[project_id] = %#v, want %q", body["project_id"], testProjectUUID)
	}
}

// TestRunIssueUpdateClearsModule pins the clear path: `--module ""` sends an
// explicit null, which the API reads as "file this issue directly under its
// project" rather than "leave the module alone".
func TestRunIssueUpdateClearsModule(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/issues/MUL-1":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "issue-1", "identifier": "MUL-1", "status": "todo",
			})
		case r.Method == http.MethodPut && r.URL.Path == "/api/issues/issue-1":
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode body: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "issue-1", "identifier": "MUL-1", "status": "todo", "module_id": nil,
			})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newIssueUpdateTestCmd()
	_ = cmd.Flags().Set("module", "")

	if _, err := captureStdout(t, func() error { return runIssueUpdate(cmd, []string{"MUL-1"}) }); err != nil {
		t.Fatalf("runIssueUpdate: %v", err)
	}
	v, ok := body["module_id"]
	if !ok {
		t.Fatalf("body = %#v, want module_id present", body)
	}
	if v != nil {
		t.Fatalf("body[module_id] = %#v, want null", v)
	}
}

// TestRunIssueListFiltersByModule covers the lane filter: the resolved module
// UUID travels as the module_id query parameter ListIssues already supports.
func TestRunIssueListFiltersByModule(t *testing.T) {
	var gotModuleID string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/modules":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"modules": []any{moduleRow(testModuleUUID, "回顾性队列数据集")},
				"total":   1,
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/issues":
			gotModuleID = r.URL.Query().Get("module_id")
			_ = json.NewEncoder(w).Encode(map[string]any{"issues": []any{}, "total": 0})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newIssueListTestCmd()
	_ = cmd.Flags().Set("project", testProjectUUID)
	_ = cmd.Flags().Set("module", "回顾性队列数据集")

	if _, err := captureStdout(t, func() error { return runIssueList(cmd, nil) }); err != nil {
		t.Fatalf("runIssueList: %v", err)
	}
	if gotModuleID != testModuleUUID {
		t.Fatalf("module_id = %q, want %q", gotModuleID, testModuleUUID)
	}
}
