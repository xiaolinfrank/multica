package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

func fixedInputTestID(n int) string { return fmt.Sprintf("10000000-0000-4000-8000-%012d", n) }
func fixedInputTestHash(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}

type fixedInputFixture struct {
	busy                           bool
	previouslyReady                bool
	task                           Task
	items                          []fixedInputManifestItem
	contents                       map[string]string
	badVersion, unavailableVersion string
	wrongSecondPage                bool
	mu                             sync.Mutex
	states                         []string
	readyIDs                       []string
	downloads, starts, pages       int
	startCapabilities              []string
}

func privateFixedInputTestDir(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	return directory
}
func newFixedInputFixture(count int) *fixedInputFixture {
	f := &fixedInputFixture{task: Task{ID: fixedInputTestID(1), WorkspaceID: fixedInputTestID(2), IssueID: fixedInputTestID(3), RuntimeID: fixedInputTestID(4), AgentID: fixedInputTestID(5), StartClaimSupported: true, DispatchedAt: "2026-10-11T12:00:00Z", InputManifestVersionID: fixedInputTestID(6), InputPreparationState: "pending", InputManifestItemTotal: int64(count)}, contents: map[string]string{}}
	f.task.Agent = &AgentData{ID: f.task.AgentID, Name: "Fixture agent"}
	for i := 0; i < count; i++ {
		v := fixedInputTestID(1000 + i)
		body := fmt.Sprintf("fixed %d", i)
		f.items = append(f.items, fixedInputManifestItem{Position: i, InputID: fixedInputTestID(2000 + i), InputTitle: fmt.Sprintf("Material %d", i), InputVersionID: v, InputVersionNumber: 2, PayloadKind: "file", Filename: "same-name.txt", ContentType: "text/plain", SizeBytes: int64(len(body)), ContentHash: fixedInputTestHash(body), Purpose: "material", Required: true})
		f.contents[v] = body
	}
	f.refreshHash()
	return f
}
func (f *fixedInputFixture) refreshHash() {
	values := []protocol.FixedInputManifestHashItem{}
	f.task.InputManifestRequiredTotal = 0
	for _, v := range f.items {
		values = append(values, protocol.FixedInputManifestHashItem{InputVersionID: v.InputVersionID, ContentHash: v.ContentHash, SizeBytes: v.SizeBytes, Purpose: v.Purpose, Required: v.Required})
		if v.Required {
			f.task.InputManifestRequiredTotal++
		}
	}
	f.task.InputManifestHash = protocol.FixedInputManifestHash(values)
}
func (f *fixedInputFixture) summary(state string) fixedRunInputManifest {
	out := fixedRunInputManifest{WorkspaceID: f.task.WorkspaceID, TaskID: f.task.ID, IssueID: f.task.IssueID, RuntimeSupported: true, PreparationState: state, ManifestVersion: &fixedInputManifestMetadata{ID: f.task.InputManifestVersionID, WorkspaceID: f.task.WorkspaceID, IssueID: f.task.IssueID, ManifestHash: f.task.InputManifestHash, ItemTotal: f.task.InputManifestItemTotal, RequiredTotal: f.task.InputManifestRequiredTotal}}
	if state == "required_ready" {
		hash := f.task.InputManifestHash
		out.PreparationHash = &hash
	}
	return out
}
func (f *fixedInputFixture) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := func(value any) { _ = json.NewEncoder(w).Encode(value) }
		if strings.Contains(r.URL.Path, "/input-files/") {
			if r.Header.Get("Authorization") != "" {
				t.Error("signed file request leaked daemon credential")
			}
			parts := strings.Split(r.URL.Path, "/")
			version := parts[len(parts)-2]
			f.mu.Lock()
			f.downloads++
			f.mu.Unlock()
			if f.busy {
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			if version == f.unavailableVersion {
				w.WriteHeader(404)
				return
			}
			body, ok := f.contents[version]
			if !ok {
				w.WriteHeader(404)
				return
			}
			if version == f.badVersion {
				body = strings.Repeat("x", len(body))
			}
			_, _ = io.WriteString(w, body)
			return
		}
		if strings.Contains(r.URL.Path, "/input-") || strings.HasSuffix(r.URL.Path, "/download-link") || strings.HasSuffix(r.URL.Path, "/items") {
			if r.Header.Get("Authorization") != "Bearer mdt_fixture" || r.Header.Get("X-Workspace-ID") != f.task.WorkspaceID {
				t.Error("metadata request lost exact runtime credential/workspace")
			}
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/input-manifest"):
			if r.URL.Query().Get("runtime_id") != f.task.RuntimeID || r.URL.Query().Get("dispatched_at") != f.task.DispatchedAt {
				t.Error("manifest read lost dispatch claim")
			}
			if f.previouslyReady {
				write(f.summary("required_ready"))
			} else {
				write(f.summary("pending"))
			}
		case strings.HasSuffix(r.URL.Path, "/input-preparation"):
			var body struct {
				State      string   `json:"state"`
				ManifestID string   `json:"manifest_version_id"`
				Hash       string   `json:"manifest_hash"`
				Dispatched string   `json:"dispatched_at"`
				Prepared   []string `json:"prepared_input_version_ids"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.ManifestID != f.task.InputManifestVersionID || body.Hash != f.task.InputManifestHash || body.Dispatched != f.task.DispatchedAt {
				t.Error("ACK lost fixed manifest/dispatch")
			}
			f.mu.Lock()
			f.states = append(f.states, body.State)
			if body.State == "required_ready" {
				f.readyIDs = append([]string{}, body.Prepared...)
			}
			f.mu.Unlock()
			if f.previouslyReady && body.State != "required_ready" {
				w.WriteHeader(http.StatusConflict)
				return
			}
			write(f.summary(body.State))
		case strings.HasSuffix(r.URL.Path, "/items"):
			if r.URL.Query().Get("task_id") != f.task.ID || r.URL.Query().Get("runtime_id") != f.task.RuntimeID || r.URL.Query().Get("page_size") != "100" {
				t.Error("item read lost exact claim or bounded page")
			}
			start := 0
			if r.URL.Query().Get("cursor") != "" {
				start = 100
			}
			end := start + 100
			if end > len(f.items) {
				end = len(f.items)
			}
			page := fixedInputManifestPage{WorkspaceID: f.task.WorkspaceID, IssueID: f.task.IssueID, ManifestVersionID: f.task.InputManifestVersionID, ManifestHash: f.task.InputManifestHash, PageSize: 100, Total: int64(len(f.items)), Items: f.items[start:end]}
			if end < len(f.items) {
				next := "page-2"
				page.NextCursor = &next
			}
			if start > 0 && f.wrongSecondPage {
				page.ManifestVersionID = fixedInputTestID(999)
			}
			f.mu.Lock()
			f.pages++
			f.mu.Unlock()
			write(page)
		case strings.HasSuffix(r.URL.Path, "/download-link"):
			parts := strings.Split(r.URL.Path, "/")
			version := parts[len(parts)-2]
			for _, item := range f.items {
				if item.InputVersionID == version {
					write(fixedInputDownloadLink{WorkspaceID: f.task.WorkspaceID, InputID: item.InputID, VersionID: version, ContentHash: item.ContentHash, SizeBytes: item.SizeBytes, URL: "/api/cockpit/input-files/" + version + "/download?token=fixture", ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)})
					return
				}
			}
			w.WriteHeader(404)
		case strings.HasSuffix(r.URL.Path, "/start"):
			var body struct {
				Capabilities []string `json:"capabilities"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.starts++
			f.startCapabilities = body.Capabilities
			f.mu.Unlock()
			write(map[string]any{})
		default:
			write(map[string]any{})
		}
	}))
	t.Cleanup(server.Close)
	return server
}
func (f *fixedInputFixture) client(t *testing.T) *Client {
	client := NewClient(f.server(t).URL)
	client.SetToken("mdt_fixture")
	return client
}
func TestFixedInputPreparationKeepsDuplicateFilenamesDistinctAndOptionalFailureExplicit(t *testing.T) {
	f := newFixedInputFixture(3)
	f.items[2].Required = false
	f.unavailableVersion = f.items[2].InputVersionID
	f.refreshHash()
	client := f.client(t)
	out, err := client.prepareFixedInputs(context.Background(), f.task, privateFixedInputTestDir(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if out.PreparedCount != 2 || out.OptionalMissingCount != 1 || len(out.Items) != 3 || out.Items[2].LocalPath != "" || out.Items[2].State != "unavailable" || len(f.readyIDs) != 2 {
		t.Fatalf("optional input became prepared: %+v ACK=%v", out, f.readyIDs)
	}
	if out.Items[0].LocalPath == out.Items[1].LocalPath {
		t.Fatal("duplicate filenames overwrote a different fixed version")
	}
	for _, item := range out.Items[:2] {
		data, err := os.ReadFile(item.LocalPath)
		if err != nil || string(data) != f.contents[item.InputVersionID] {
			t.Fatalf("prepared bytes changed: %v", err)
		}
	}
	index, err := os.ReadFile(out.IndexPath)
	if err != nil || !json.Valid(index) {
		t.Fatalf("missing usable local index: %v", err)
	}
	task := f.task
	task.preparedInputs = out
	prompt := buildFixedInputManifestBlock(task)
	if !strings.Contains(prompt, "2 files were prepared; 1 optional") || !strings.Contains(prompt, out.IndexPath) || strings.Contains(prompt, "mdt_fixture") {
		t.Fatalf("misleading or credential-bearing prompt: %s", prompt)
	}
}
func TestFixedInputPreparationRejectsChangedSecondPageBeforeAnyFileRead(t *testing.T) {
	f := newFixedInputFixture(101)
	f.wrongSecondPage = true
	_, err := f.client(t).prepareFixedInputs(context.Background(), f.task, privateFixedInputTestDir(t), nil)
	var failure *fixedInputPreparationError
	if !errors.As(err, &failure) || failure.Code != "input_manifest_incomplete" || f.pages != 2 || f.downloads != 0 || len(f.readyIDs) != 0 {
		t.Fatalf("mixed manifest pages accepted: %v pages=%d reads=%d ready=%v", err, f.pages, f.downloads, f.readyIDs)
	}
}
func TestFixedInputPreparationRejectsHashMismatchAndDoesNotLeavePartialFiles(t *testing.T) {
	f := newFixedInputFixture(1)
	f.badVersion = f.items[0].InputVersionID
	root := privateFixedInputTestDir(t)
	_, err := f.client(t).prepareFixedInputs(context.Background(), f.task, root, nil)
	var failure *fixedInputPreparationError
	if !errors.As(err, &failure) || failure.Code != "required_input_unavailable" || failure.VersionID != f.badVersion || f.downloads != 1 || len(f.readyIDs) != 0 || len(f.states) != 2 || f.states[1] != "failed" {
		t.Fatalf("bad bytes path was not reached or was acknowledged: %v states=%v downloads=%d", err, f.states, f.downloads)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed preparation left partial source copies: %v %v", entries, err)
	}
}
func TestFixedInputPreparationDistinguishesExplicitEmptySelectionFromOldRun(t *testing.T) {
	f := newFixedInputFixture(0)
	client := f.client(t)
	out, err := client.prepareFixedInputs(context.Background(), f.task, privateFixedInputTestDir(t), nil)
	if err != nil || out == nil || out.PreparedCount != 0 || f.pages != 1 || len(f.states) != 2 || f.states[1] != "required_ready" {
		t.Fatalf("saved empty selection lost its pin: %+v %v", out, err)
	}
	old := Task{ID: "old-run", WorkspaceID: "old-workspace"}
	out, err = client.prepareFixedInputs(context.Background(), old, "does-not-need-a-directory", nil)
	if err != nil || out != nil || f.pages != 1 {
		t.Fatalf("old Run fabricated input facts: %+v %v", out, err)
	}
}
func TestFixedInputPreparationNeverFollowsSignedRedirect(t *testing.T) {
	var redirected bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", destination.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := NewClient(server.URL)
	client.SetToken("mdt_fixture")
	reader, err := client.openFixedInputBytes(context.Background(), "/api/cockpit/input-files/"+fixedInputTestID(1)+"/download?token=private-proof")
	if reader != nil {
		reader.Close()
	}
	if err == nil || redirected || strings.Contains(err.Error(), "private-proof") {
		t.Fatalf("unsafe signed-file redirect/error: %v redirected=%v", err, redirected)
	}
}
func TestRunTaskFixedInputGatePrecedesStartWithMissingProviderExecutable(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(fmt.Sprint(mismatch), func(t *testing.T) {
			f := newFixedInputFixture(1)
			if mismatch {
				f.badVersion = f.items[0].InputVersionID
			}
			client := f.client(t)
			log := slog.New(slog.NewTextHandler(io.Discard, nil))
			missing := filepath.Join(t.TempDir(), "deliberately-missing-provider")
			d := &Daemon{client: client, logger: log, workspaces: make(map[string]*workspaceState), runtimeIndex: map[string]Runtime{f.task.RuntimeID: {ID: f.task.RuntimeID, Provider: "claude"}}, activeEnvRoots: make(map[string]int), cfg: Config{WorkspacesRoot: t.TempDir(), Agents: map[string]AgentEntry{"claude": {Path: missing}}}}
			_, err := d.runTask(context.Background(), f.task, "claude", 0, log)
			f.mu.Lock()
			starts := f.starts
			caps := append([]string{}, f.startCapabilities...)
			states := append([]string{}, f.states...)
			f.mu.Unlock()
			if mismatch {
				if starts != 0 || err == nil || len(states) != 2 || states[1] != "failed" {
					t.Fatalf("invalid required bytes crossed StartTask: starts=%d states=%v err=%v", starts, states, err)
				}
			} else {
				found := false
				for _, capability := range caps {
					if capability == protocol.DaemonCapabilityFixedInputManifestV1 {
						found = true
					}
				}
				if starts != 1 || !found || len(states) != 2 || states[1] != "required_ready" {
					t.Fatalf("fixed preparation was not negotiated before Start: starts=%d states=%v caps=%v err=%v", starts, states, caps, err)
				}
			}
		})
	}
}

func TestFixedInputReadCapacityWaitEndsWithPreparationDeadline(t *testing.T) {
	f := newFixedInputFixture(1)
	f.busy = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := f.client(t).prepareFixedInputs(ctx, f.task, privateFixedInputTestDir(t), nil)
	var failure *fixedInputPreparationError
	if !errors.As(err, &failure) || failure.Code != "input_preparation_timeout" || f.downloads != 1 || len(f.readyIDs) != 0 {
		t.Fatalf("capacity wait escaped its claim deadline: %v reads=%d ready=%v", err, f.downloads, f.readyIDs)
	}
}

func TestFixedInputRetryPreservesReadyHistoryWhileRecheckingLocalFiles(t *testing.T) {
	for _, mismatch := range []bool{false, true} {
		t.Run(fmt.Sprint(mismatch), func(t *testing.T) {
			f := newFixedInputFixture(1)
			f.previouslyReady = true
			if mismatch {
				f.badVersion = f.items[0].InputVersionID
			}
			root := privateFixedInputTestDir(t)
			out, err := f.client(t).prepareFixedInputs(context.Background(), f.task, root, nil)
			if f.downloads != 1 {
				t.Fatalf("retry did not verify its own local bytes: reads=%d err=%v", f.downloads, err)
			}
			if mismatch {
				var failure *fixedInputPreparationError
				if !errors.As(err, &failure) || failure.Code != "required_input_unavailable" || len(f.states) != 0 {
					t.Fatalf("failed local retry rewrote historical preparation: err=%v states=%v", err, f.states)
				}
				entries, readErr := os.ReadDir(root)
				if readErr != nil || len(entries) != 0 {
					t.Fatalf("failed retry retained partial copies: %v %v", entries, readErr)
				}
			} else if err != nil || out == nil || out.PreparedCount != 1 || len(f.states) != 1 || f.states[0] != "required_ready" {
				t.Fatalf("ready retry was not idempotently acknowledged: out=%+v err=%v states=%v", out, err, f.states)
			}
		})
	}
}
