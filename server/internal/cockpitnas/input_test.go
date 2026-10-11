//go:build darwin || linux

package cockpitnas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func inputFiles(t *testing.T, count int) (*Files, Root, InputBrowseRequest) {
	t.Helper()
	f, r := inputFixture(t, []string{"inputs"})
	if err := os.Mkdir(filepath.Join(r.Path, "inputs"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < count; i++ {
		if err := os.WriteFile(filepath.Join(r.Path, "inputs", fmt.Sprintf("file-%04d.txt", i)), []byte("fixed input bytes\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		if f.inputReader != nil {
			state := f.inputReader
			state.mu.Lock()
			all := map[string]*inputSession{}
			for id, s := range state.sessions {
				s.busy = true
				all[id] = s
			}
			state.mu.Unlock()
			for id, s := range all {
				state.discard(id, s)
			}
		}
	})
	return f, r, InputBrowseRequest{WorkspaceID: r.WorkspaceID, RootID: r.RootID, ActorScope: "authorized-human-scope", RelativeDirectory: "inputs", PageSize: 25}
}
func inputPage(t *testing.T, f *Files, r InputBrowseRequest) InputBrowsePage {
	t.Helper()
	page, err := f.BrowseInput(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	return page
}
func selectedInput(t *testing.T, f *Files, r InputBrowseRequest) InputObservation {
	t.Helper()
	page := inputPage(t, f, r)
	if len(page.Items) != 1 || !page.Items[0].CanSelect {
		t.Fatalf("expected selectable file: %+v", page)
	}
	v := page.Items[0]
	obs, err := f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, v.RelativePath, r.ActorScope, v.ObservationToken)
	if err != nil {
		t.Fatal(err)
	}
	return obs
}
func TestInputRootMetadataDoesNotTouchDisconnectedStorage(t *testing.T) {
	f, r, _ := inputFiles(t, 0)
	moved := r.Path + "-offline"
	if err := os.Rename(r.Path, moved); err != nil {
		t.Fatal(err)
	}
	defer os.Rename(moved, r.Path)
	info, err := f.InputRoot(r.WorkspaceID)
	if err != nil || info.Path != r.Path || info.RootID != r.RootID {
		t.Fatalf("metadata performed a filesystem probe: %+v %v", info, err)
	}
	info.Subpaths[0] = "other"
	again, err := f.InputRoot(r.WorkspaceID)
	if err != nil || again.Subpaths[0] != "inputs" {
		t.Fatal("metadata caller mutated configured scopes")
	}
}
func TestInputBrowserPagesExactlyAndReplaysBoundedContinuation(t *testing.T) {
	f, _, r := inputFiles(t, 63)
	page1 := inputPage(t, f, r)
	if len(page1.Items) != 25 || !page1.HasMore || page1.NextCursor == nil || page1.Total != nil {
		t.Fatalf("first page invented total or lost bound: %+v", page1)
	}
	cursor := *page1.NextCursor
	r.Cursor = cursor
	page2 := inputPage(t, f, r)
	replay := inputPage(t, f, r)
	if !reflect.DeepEqual(page2, replay) {
		t.Fatal("retrying a lost page response advanced the enumeration")
	}
	if len(page2.Items) != 25 || page2.NextCursor == nil {
		t.Fatal("wrong second page")
	}
	r.Cursor = *page2.NextCursor
	page3 := inputPage(t, f, r)
	if len(page3.Items) != 13 || page3.HasMore || page3.NextCursor != nil {
		t.Fatalf("wrong final page: %+v", page3)
	}
	if !reflect.DeepEqual(page3, inputPage(t, f, r)) {
		t.Fatal("final page response could not be recovered")
	}
	seen := map[string]bool{}
	for _, page := range []InputBrowsePage{page1, page2, page3} {
		for _, entry := range page.Items {
			if seen[entry.RelativePath] {
				t.Fatal("duplicate entry across pages")
			}
			seen[entry.RelativePath] = true
			if !entry.CanSelect || entry.ObservationToken == "" {
				t.Fatal("ordinary file lost its exact observation")
			}
		}
	}
	if len(seen) != 63 {
		t.Fatal("incomplete directory enumeration")
	}
	for _, change := range []func(*InputBrowseRequest){func(v *InputBrowseRequest) { v.ActorScope = "another-human" }, func(v *InputBrowseRequest) { v.Query = "different" }, func(v *InputBrowseRequest) { v.PageSize = 100 }} {
		bad := r
		bad.Cursor = cursor
		change(&bad)
		if _, err := f.BrowseInput(context.Background(), bad); err == nil {
			t.Fatal("cursor crossed actor/filter/page scope")
		}
	}
}
func TestInputBrowserSearchStopsAtItsEntryBudget(t *testing.T) {
	f, _, r := inputFiles(t, 600)
	r.Query = "no-such-prefix"
	pages := 0
	for {
		page := inputPage(t, f, r)
		pages++
		if len(page.Items) != 0 || page.Total != nil {
			t.Fatal("sparse prefix invented matches or an exact total")
		}
		if pages == 1 && !page.HasMore {
			t.Fatal("one sparse page scanned the entire directory")
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == nil || pages > 4 {
			t.Fatal("bounded continuation did not finish")
		}
		r.Cursor = *page.NextCursor
	}
	if pages != 3 {
		t.Fatalf("expected 256-entry budget over 600 names, got %d pages", pages)
	}
}
func TestInputBrowserRejectsChangedDirectoryAndReplacedMarker(t *testing.T) {
	f, root, r := inputFiles(t, 30)
	page := inputPage(t, f, r)
	r.Cursor = *page.NextCursor
	if err := os.WriteFile(filepath.Join(root.Path, "inputs", "new.txt"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := f.BrowseInput(context.Background(), r)
	wantCode(t, err, "cursor_changed")
	r.Cursor = ""
	page = inputPage(t, f, r)
	r.Cursor = *page.NextCursor
	if err = os.WriteFile(filepath.Join(root.Path, MarkerName), []byte("wrong-root\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = f.BrowseInput(context.Background(), r); err == nil {
		t.Fatal("replaced root marker did not invalidate enumeration")
	}
}
func TestInputBrowserRejectsLinksControlsPrivateAndSpecialEntries(t *testing.T) {
	f, root, r := inputFiles(t, 1)
	dir := filepath.Join(root.Path, "inputs")
	if err := os.WriteFile(filepath.Join(dir, ".MULTICA-COMPLETE.JSON"), []byte("operator control"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "InPuT-VeRsIoNs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "file-0000.txt"), filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := unix.Mkfifo(filepath.Join(dir, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	page := inputPage(t, f, r)
	selectable := 0
	for _, e := range page.Items {
		if e.CanSelect {
			selectable++
			if e.Name != "file-0000.txt" {
				t.Fatalf("unsafe input selectable: %+v", e)
			}
		} else if e.CanOpenDirectory || e.ObservationToken != "" {
			t.Fatalf("unsafe entry got traversal/observation authority: %+v", e)
		}
	}
	if selectable != 1 {
		t.Fatal("ordinary file became unavailable")
	}
	r.RelativeDirectory = "inputs/InPuT-VeRsIoNs"
	_, err := f.BrowseInput(context.Background(), r)
	wantCode(t, err, "input_path_outside_scope")
	r.RelativeDirectory = "inputs/link"
	if _, err = f.BrowseInput(context.Background(), r); err == nil {
		t.Fatal("symbolic-link traversal succeeded")
	}
}
func TestInputObservationIsExactAndSurvivesWorkerRestart(t *testing.T) {
	f, root, r := inputFiles(t, 1)
	page := inputPage(t, f, r)
	entry := page.Items[0]
	if _, err := f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, entry.RelativePath, "other-member", entry.ObservationToken); err == nil {
		t.Fatal("file observation crossed actor scope")
	}
	obs, err := f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, entry.RelativePath, r.ActorScope, entry.ObservationToken)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]Root{root})
	restarted, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, entry.RelativePath, r.ActorScope, entry.ObservationToken); err == nil {
		t.Fatal("ephemeral browser token survived server restart")
	}
	reader, err := restarted.OpenInput(context.Background(), obs)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || string(body) != "fixed input bytes\n" {
		t.Fatalf("persisted exact source failed after restart: %v %v %q", readErr, closeErr, body)
	}
	source := filepath.Join(root.Path, obs.RelativePath)
	if err = os.WriteFile(source, []byte(strings.Repeat("x", int(obs.SizeBytes))), 0600); err != nil {
		t.Fatal(err)
	}
	originalTime := time.Unix(0, obs.MtimeNS)
	if err = os.Chtimes(source, originalTime, originalTime); err != nil {
		t.Fatal(err)
	}
	_, err = restarted.OpenInput(context.Background(), obs)
	wantCode(t, err, "source_changed")
}
func TestInputReaderRejectsMutationAndPathReplacementAfterOpen(t *testing.T) {
	for _, kind := range []string{"bytes", "path", "root-marker"} {
		t.Run(kind, func(t *testing.T) {
			f, root, r := inputFiles(t, 1)
			obs := selectedInput(t, f, r)
			reader, err := f.OpenInput(context.Background(), obs)
			if err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(root.Path, obs.RelativePath)
			switch kind {
			case "bytes":
				err = os.WriteFile(source, []byte("different bytes!!"), 0600)
			case "path":
				err = os.Rename(source, source+".old")
				if err == nil {
					err = os.WriteFile(source, []byte("fixed input bytes\n"), 0600)
				}
			case "root-marker":
				err = os.WriteFile(filepath.Join(root.Path, MarkerName), []byte("other\n"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, readErr := io.ReadAll(reader)
			closeErr := reader.Close()
			if readErr == nil || closeErr == nil {
				t.Fatalf("mutation accepted: read=%v close=%v", readErr, closeErr)
			}
		})
	}
}
func TestInputBrowserAndReaderReservationsRemainBounded(t *testing.T) {
	f, _, r := inputFiles(t, 30)
	var first InputBrowsePage
	for i := 0; i < inputSessionLimit; i++ {
		page := inputPage(t, f, r)
		if i == 0 {
			first = page
		}
	}
	_, err := f.BrowseInput(context.Background(), r)
	wantCode(t, err, "input_io_busy")
	state := f.inputReader
	state.mu.Lock()
	var heldClosed io.Closer
	for _, session := range state.sessions {
		session.expires = time.Now().Add(-time.Second)
		heldClosed = session.directory
	}
	state.mu.Unlock()
	r.Cursor = *first.NextCursor
	_, err = f.BrowseInput(context.Background(), r)
	wantCode(t, err, "cursor_expired")
	if file, ok := heldClosed.(*os.File); ok {
		if _, err = file.Stat(); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("expired enumeration descriptor was not closed: %v", err)
		}
	}
	r.Cursor = ""
	page := inputPage(t, f, r)
	entry := page.Items[0]
	obs, err := f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, entry.RelativePath, r.ActorScope, entry.ObservationToken)
	if err != nil {
		t.Fatal(err)
	}
	one, err := f.OpenInput(context.Background(), obs)
	if err != nil {
		t.Fatal(err)
	}
	two, err := f.OpenInput(context.Background(), obs)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.OpenInput(context.Background(), obs)
	wantCode(t, err, "input_io_busy")
	if err = one.Close(); err != nil {
		t.Fatal(err)
	}
	three, err := f.OpenInput(context.Background(), obs)
	if err != nil {
		t.Fatal(err)
	}
	if err = two.Close(); err != nil {
		t.Fatal(err)
	}
	if err = three.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestInputObservationRejectsExpiredAndOversizedProofBeforeFilesystemAccess(t *testing.T) {
	f, root, r := inputFiles(t, 1)
	page := inputPage(t, f, r)
	entry := page.Items[0]
	state := f.inputReader
	scope := inputActorScope(r.WorkspaceID, r.ActorScope)
	original, err := state.decode(entry.ObservationToken, "file", scope, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	expired := original
	expired.Expires = time.Now().Add(-time.Minute).Unix()
	token, err := state.seal(expired)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root.Path, MarkerName)); err != nil {
		t.Fatal(err)
	}
	_, err = f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, entry.RelativePath, r.ActorScope, token)
	wantCode(t, err, "observation_expired")
	_, err = f.ObserveInput(context.Background(), r.WorkspaceID, r.RootID, "inputs/different.txt", r.ActorScope, entry.ObservationToken)
	wantCode(t, err, "source_changed")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = f.OpenInput(cancelled, *original.Observation)
	wantCode(t, err, "io_timeout")
	huge := original
	copyObservation := *original.Observation
	huge.Observation = &copyObservation
	huge.Observation.RootPath = strings.Repeat("<", 4096)
	huge.Observation.RelativePath = strings.Repeat("<", 4096)
	_, err = state.seal(huge)
	wantCode(t, err, "observation_too_large")
}
