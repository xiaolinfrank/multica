package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/spf13/cobra"
)

// The cockpit CLI's own logic is flag → request body. Only flags the caller
// actually passed may reach the wire: a partial update that sent every flag's
// zero value would blank a task's owner because nobody mentioned it.

func newCockpitNodeTestCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "update"}
	cmd.Flags().String("code", "", "")
	cmd.Flags().String("parent", "", "")
	cmd.Flags().String("name", "", "")
	cmd.Flags().String("owner", "", "")
	cmd.Flags().String("collaborators", "", "")
	cmd.Flags().String("color", "", "")
	cmd.Flags().String("start-date", "", "")
	cmd.Flags().String("end-date", "", "")
	cmd.Flags().String("status", "", "")
	cmd.Flags().Float64("progress", 0, "")
	cmd.Flags().String("deliverable", "", "")
	cmd.Flags().String("dependencies", "", "")
	cmd.Flags().String("note", "", "")
	cmd.Flags().String("current-progress", "", "")
	cmd.Flags().String("vendor", "", "")
	cmd.Flags().String("budget-category", "", "")
	cmd.Flags().Float64("budget", 0, "")
	cmd.Flags().Bool("clear-budget", false, "")
	cmd.Flags().String("exec-status", "", "")
	cmd.Flags().String("contract", "", "")
	cmd.Flags().String("source", "", "")
	cmd.Flags().Float64("position", 0, "")
	cmd.Flags().String("output", "json", "")
	return cmd
}

func TestCockpitNodeBodyCarriesOnlyPassedFlags(t *testing.T) {
	cmd := newCockpitNodeTestCmd()
	_ = cmd.Flags().Set("progress", "60")
	_ = cmd.Flags().Set("status", "进行中")

	body := cockpitNodeBody(cmd)
	if len(body) != 2 {
		t.Fatalf("body = %#v, want exactly progress and status", body)
	}
	if body["progress"] != 60.0 || body["status"] != "进行中" {
		t.Fatalf("body = %#v", body)
	}
	if _, present := body["owner"]; present {
		t.Error("an unpassed --owner reached the wire and would blank the field")
	}
}

// An empty string is how the CLI says "withdraw this date", which is a real
// edit and must not be mistaken for "flag not passed".
func TestCockpitNodeBodySendsAnEmptyDateToClearIt(t *testing.T) {
	cmd := newCockpitNodeTestCmd()
	_ = cmd.Flags().Set("end-date", "")

	body := cockpitNodeBody(cmd)
	value, present := body["end_date"]
	if !present || value != "" {
		t.Fatalf("body = %#v, want end_date present and empty", body)
	}
}

func TestCockpitNodeBodyClearBudgetWinsOverBudget(t *testing.T) {
	cmd := newCockpitNodeTestCmd()
	_ = cmd.Flags().Set("budget", "30")
	_ = cmd.Flags().Set("clear-budget", "true")

	body := cockpitNodeBody(cmd)
	value, present := body["budget_amount"]
	if !present || value != nil {
		t.Fatalf("body = %#v, want budget_amount present and null", body)
	}
}

func TestRunCockpitNodeUpdateAddressesTheNodeByCode(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			t.Errorf("method = %s, want PATCH", r.Method)
		}
		if r.URL.Path != "/api/cockpit/nodes/L3-01-08" {
			t.Errorf("path = %q, want the node addressed by its code", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "n-1", "code": "L3-01-08"})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := newCockpitNodeTestCmd()
	_ = cmd.Flags().Set("owner", "李青娇")

	if _, err := captureStdout(t, func() error {
		return runCockpitNodeUpdate(cmd, []string{"L3-01-08"})
	}); err != nil {
		t.Fatalf("runCockpitNodeUpdate: %v", err)
	}
	if body["owner"] != "李青娇" {
		t.Fatalf("body = %#v", body)
	}
}

func TestRunCockpitNodeUpdateRefusesAnEmptyPatch(t *testing.T) {
	setCLITestServerEnv(t, "http://127.0.0.1:1")
	cmd := newCockpitNodeTestCmd()

	if err := runCockpitNodeUpdate(cmd, []string{"L3-01-08"}); err == nil {
		t.Fatal("an update with no field flags should fail before any request")
	}
}

func TestRunCockpitNodeLinkSendsEveryIssueReference(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s, want PUT", r.Method)
		}
		if r.URL.Path != "/api/cockpit/nodes/L3-01-08/issues" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"node_id": "n-1", "links": []any{}})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	cmd := &cobra.Command{Use: "link"}
	cmd.Flags().Bool("replace", false, "")
	cmd.Flags().String("output", "json", "")
	_ = cmd.Flags().Set("replace", "true")

	if _, err := captureStdout(t, func() error {
		return runCockpitNodeLink(cmd, []string{"L3-01-08", "BIO-314", "BIO-320"})
	}); err != nil {
		t.Fatalf("runCockpitNodeLink: %v", err)
	}

	ids, _ := body["issue_ids"].([]any)
	if len(ids) != 2 || ids[0] != "BIO-314" || ids[1] != "BIO-320" {
		t.Fatalf("issue_ids = %#v", body["issue_ids"])
	}
	if body["replace"] != true {
		t.Fatalf("replace = %#v, want true", body["replace"])
	}
}

func TestRunCockpitImportPostsTheDocumentAndReportsUnresolved(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cockpit/import" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"nodes":             2,
			"unresolved_issues": []string{"BIO-404"},
		})
	}))
	defer srv.Close()
	setCLITestServerEnv(t, srv.URL)

	path := filepath.Join(t.TempDir(), "board.json")
	document := `{"title":"Board","nodes":[{"code":"L1-01"},{"code":"L1-02","parent_code":"L1-01"}]}`
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatalf("write import document: %v", err)
	}

	cmd := &cobra.Command{Use: "import"}
	cmd.Flags().String("output", "json", "")

	out, err := captureStdout(t, func() error { return runCockpitImport(cmd, []string{path}) })
	if err != nil {
		t.Fatalf("runCockpitImport: %v", err)
	}
	if body["title"] != "Board" {
		t.Fatalf("body = %#v", body)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatalf("decode stdout JSON: %v\n%s", err, out)
	}
	// The unresolved list stays in the response body, not only on stderr, so a
	// script can act on it.
	unresolved, _ := result["unresolved_issues"].([]any)
	if len(unresolved) != 1 || unresolved[0] != "BIO-404" {
		t.Fatalf("unresolved_issues = %#v", result["unresolved_issues"])
	}
}
