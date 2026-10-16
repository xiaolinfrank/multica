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

func executeChangeCLI(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs(args)
	return captureStdout(t, cmd.Execute)
}

// TestCockpitChangeCLIIngest wires the batch funnel: a proposals document
// (file or stdin, bare array or {"changes": [...]}) lands on
// /api/cockpit/changes/ingest unchanged, and oversized batches never leave
// the client.
func TestCockpitChangeCLIIngest(t *testing.T) {
	proposals := []map[string]any{
		{"node": "L3-01-08", "field": "progress", "new_value": "60", "reason": "纪要确认 60%"},
		{"node": "L3-01-09", "field": "end_date", "new_value": "2026-11-30", "reason": "联调顺延一周"},
	}

	dir := t.TempDir()
	docPath := filepath.Join(dir, "proposals.json")
	raw, err := json.Marshal(proposals)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(docPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	wrappedPath := filepath.Join(dir, "wrapped.json")
	wrapped, err := json.Marshal(map[string]any{"changes": proposals})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wrappedPath, wrapped, 0o600); err != nil {
		t.Fatal(err)
	}
	bigPath := filepath.Join(dir, "big.json")
	big := make([]map[string]any, 0, 501)
	for i := 0; i < 501; i++ {
		big = append(big, map[string]any{"node": "L3-01-08", "field": "progress", "new_value": "60", "reason": "r"})
	}
	bigRaw, err := json.Marshal(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bigPath, bigRaw, 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, stdin, file string
	}{
		{"file bare array", "", docPath},
		{"file wrapped object", "", wrappedPath},
		{"stdin bare array", string(raw), "-"},
		{"stdin wrapped object", string(wrapped), "-"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.URL.RequestURI() != "/api/cockpit/changes/ingest" {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
				}
				var got map[string]any
				if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
					t.Error(err)
				}
				if len(got["changes"].([]any)) != 2 {
					t.Errorf("changes = %#v", got["changes"])
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{}})
			}))
			defer srv.Close()
			configureWorkflowCLIEnv(t, srv.URL)

			cmd := newCockpitChangeCommand()
			if tc.stdin != "" {
				cmd.SetIn(strings.NewReader(tc.stdin))
			}
			args := []string{"ingest"}
			if tc.file != "-" {
				args = append(args, "--file", tc.file)
			}
			out, err := executeChangeCLI(t, cmd, args...)
			if err != nil || !json.Valid([]byte(out)) || calls.Load() != 1 {
				t.Fatalf("ingest must post the document once: calls=%d out=%s err=%v", calls.Load(), out, err)
			}
		})
	}

	t.Run("oversized batch rejected before http", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("oversized batch must not reach the server")
		}))
		defer srv.Close()
		configureWorkflowCLIEnv(t, srv.URL)
		if _, err := executeChangeCLI(t, newCockpitChangeCommand(), "ingest", "--file", bigPath); err == nil || !strings.Contains(err.Error(), "500") {
			t.Fatalf("oversized batch err = %v", err)
		}
	})

	t.Run("empty document rejected", func(t *testing.T) {
		emptyPath := filepath.Join(dir, "empty.json")
		if err := os.WriteFile(emptyPath, []byte(`{"changes": []}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := executeChangeCLI(t, newCockpitChangeCommand(), "ingest", "--file", emptyPath); err == nil {
			t.Fatal("empty document must be rejected")
		}
	})
}
