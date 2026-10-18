package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const cliInputID = "10000000-0000-4000-8000-000000000001"
const cliVersionID = "10000000-0000-4000-8000-000000000002"
const cliTransferID = "10000000-0000-4000-8000-000000000003"

func TestCockpitInputStreamExactRevisionAndBytes(t *testing.T) {
	for _, bytes := range []string{"", "fixed input bytes"} {
		t.Run(bytes, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				data, err := io.ReadAll(r.Body)
				if err != nil || string(data) != bytes || r.ContentLength != int64(len(bytes)) || r.Method != "PUT" || r.Header.Get("X-Input-Transfer-Revision") != "7" || r.Header.Get("Authorization") != "Bearer mat_fixture" || r.Header.Get("X-Workspace-ID") != "ws-fixture" {
					t.Errorf("input stream changed its exact claim or bytes: %v", err)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"transfer_id": cliTransferID})
			}))
			defer server.Close()
			client := NewAPIClient(server.URL, "ws-fixture", "mat_fixture")
			var out map[string]any
			if err := client.UploadCockpitInputBytes(context.Background(), cliInputID, cliVersionID, cliTransferID, 7, int64(len(bytes)), strings.NewReader(bytes), &out); err != nil || out["transfer_id"] != cliTransferID || calls.Load() != 1 {
				t.Fatalf("stream result=%v err=%v calls=%d", out, err, calls.Load())
			}
		})
	}
}
func TestCockpitInputTransportDoesNotRedirectOrReplayUnknownCommands(t *testing.T) {
	for _, upload := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "stream"}[upload], func(t *testing.T) {
			var calls, redirected atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", target.URL+"/redirect")
				w.WriteHeader(http.StatusTemporaryRedirect)
			}))
			defer server.Close()
			client := NewAPIClient(server.URL, "ws-fixture", "secret-token")
			var out map[string]any
			var err error
			if upload {
				err = client.UploadCockpitInputBytes(context.Background(), cliInputID, cliVersionID, cliTransferID, 1, 4, strings.NewReader("data"), &out)
			} else {
				err = client.CockpitInputJSON(context.Background(), "POST", "/api/cockpit/inputs", map[string]any{"command_key": cliInputID}, &out)
			}
			if err == nil || calls.Load() != 1 || redirected.Load() != 0 {
				t.Fatalf("ambiguous redirect/replay: calls=%d redirected=%d err=%v", calls.Load(), redirected.Load(), err)
			}
		})
	}
}
func TestCockpitInputUploadRejectsUnboundedOrUnscopedIntentBeforeNetwork(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	client := NewAPIClient(server.URL, "ws", "token")
	for _, v := range []struct {
		id             string
		revision, size int64
	}{{"arbitrary/path", 1, 1}, {cliInputID, 0, 1}, {cliInputID, 1, -1}, {cliInputID, 1, 500<<20 + 1}} {
		if err := client.UploadCockpitInputBytes(context.Background(), v.id, cliVersionID, cliTransferID, v.revision, v.size, strings.NewReader("a"), nil); err == nil {
			t.Fatal("invalid upload was accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid uploads reached server: %d", calls.Load())
	}
}
