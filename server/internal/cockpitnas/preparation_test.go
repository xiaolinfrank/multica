//go:build darwin || linux

package cockpitnas

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func preparationFixture(t *testing.T, scopes []string) (*Files, Root) {
	t.Helper()
	root := Root{WorkspaceID: uuid.NewString(), RootID: uuid.NewString(), Path: t.TempDir(), AllowLocal: true, WriteMode: ModeCreateOnly, PrepareSubpaths: scopes}
	raw, err := json.Marshal([]Root{root})
	if err != nil {
		t.Fatal(err)
	}
	f, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root.Path, MarkerName), []byte(root.RootID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return f, root
}
func preparationTarget(t *testing.T, f *Files, r Root, relative string) PreparationTarget {
	t.Helper()
	target, err := f.ResolvePreparation(r.WorkspaceID, r.RootID, relative)
	if err != nil {
		t.Fatal(err)
	}
	return target
}
func TestPreparationRequiresItsOwnExplicitScope(t *testing.T) {
	f, r := preparationFixture(t, nil)
	if _, err := f.Resolve(r.WorkspaceID, r.Path, uuid.NewString(), 1); err != nil {
		t.Fatalf("export fixture must be authorized independently: %v", err)
	}
	_, err := f.PreparationRoot(r.WorkspaceID)
	wantCode(t, err, "prepare_not_configured")
	_, err = f.ResolvePreparation(r.WorkspaceID, r.RootID, "meeting")
	wantCode(t, err, "prepare_not_configured")
	forged := PreparationTarget{WorkspaceID: r.WorkspaceID, RootID: r.RootID, RootPath: r.Path, PrepareSubpath: ".", RelativeDirectory: "meeting", Directory: filepath.Join(r.Path, "meeting")}
	_, err = f.EnsurePreparedDirectory(context.Background(), forged, "meeting")
	wantCode(t, err, "prepare_not_configured")
	if entries, err := os.ReadDir(r.Path); err != nil || len(entries) != 1 || entries[0].Name() != MarkerName {
		t.Fatal("export permission was used to prepare directories")
	}
}
func TestPreparationConfigurationAndFixedTargetBoundaries(t *testing.T) {
	f, r := preparationFixture(t, []string{"allowed"})
	for _, scope := range []string{"", "/absolute", "../escape", "allowed/../escape", "allowed//nested", "allowed\\nested", "allowed\nentry", strings.Repeat("x", 256), strings.Repeat("a/", 16) + "b"} {
		bad := r
		bad.PrepareSubpaths = []string{scope}
		raw, _ := json.Marshal([]Root{bad})
		if _, err := New(string(raw)); err == nil {
			t.Errorf("accepted unbounded/ambiguous preparation scope %q", scope)
		}
	}
	for _, scopes := range [][]string{{"allowed", "allowed"}, func() []string {
		out := make([]string, 33)
		for i := range out {
			out[i] = uuid.NewString()
		}
		return out
	}()} {
		bad := r
		bad.PrepareSubpaths = scopes
		raw, _ := json.Marshal([]Root{bad})
		if _, err := New(string(raw)); err == nil {
			t.Fatal("accepted duplicate or excessive scopes")
		}
	}
	for _, relative := range []string{"allowed-sibling/meeting", "elsewhere", "allowed/../escape", "allowed//meeting", "allowed\\meeting", "/absolute"} {
		_, err := f.ResolvePreparation(r.WorkspaceID, r.RootID, relative)
		wantCode(t, err, "prepare_path_outside_scope")
	}
	_, err := f.ResolvePreparation(uuid.NewString(), r.RootID, "allowed/meeting")
	wantCode(t, err, "prepare_not_configured")
	_, err = f.ResolvePreparation(r.WorkspaceID, uuid.NewString(), "allowed/meeting")
	wantCode(t, err, "prepare_path_outside_scope")
	target := preparationTarget(t, f, r, "allowed/meeting")
	_, err = f.EnsurePreparedDirectory(context.Background(), target, "allowed/other")
	wantCode(t, err, "prepare_path_outside_scope")
	changed := target
	changed.Directory = filepath.Join(r.Path, "elsewhere")
	_, err = f.EnsurePreparedDirectory(context.Background(), changed, "allowed/meeting")
	wantCode(t, err, "root_config_changed")
	metadata, err := f.PreparationRoot(r.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	metadata.Subpaths[0] = "."
	if _, err = f.ResolvePreparation(r.WorkspaceID, r.RootID, "elsewhere"); err == nil {
		t.Fatal("caller mutated the deployed scope through metadata")
	}
}
func TestPreparationCreatesOnlyOneDeclaredStepAndObservesExistingDirectories(t *testing.T) {
	f, r := preparationFixture(t, []string{"allowed"})
	scope := filepath.Join(r.Path, "allowed")
	if err := os.Mkdir(scope, 0o700); err != nil {
		t.Fatal(err)
	}
	target := preparationTarget(t, f, r, "allowed/parent/meeting")
	inspected, err := f.InspectPreparation(context.Background(), target, []string{"allowed/parent", "allowed/parent/meeting"})
	if err != nil || len(inspected) != 2 || inspected[0].State != "missing" || inspected[1].State != "missing" {
		t.Fatalf("read-only inspection: %+v %v", inspected, err)
	}
	if entries, err := os.ReadDir(scope); err != nil || len(entries) != 0 {
		t.Fatal("preview created a missing directory")
	}
	_, err = f.EnsurePreparedDirectory(context.Background(), target, "allowed/parent/meeting")
	wantCode(t, err, "directory_identity_changed")
	if entries, err := os.ReadDir(scope); err != nil || len(entries) != 0 {
		t.Fatal("one child step secretly created its missing ancestors")
	}
	for _, relative := range []string{"allowed/parent", "allowed/parent/meeting"} {
		got, err := f.EnsurePreparedDirectory(context.Background(), target, relative)
		if err != nil || got.Outcome != "created" || got.Directory != filepath.Join(r.Path, relative) || got.DirectoryIdentity == "" || got.RootIdentity == "" || got.ObservedAt == "" {
			t.Fatalf("single step %s: %+v %v", relative, got, err)
		}
	}
	kept := filepath.Join(target.Directory, "human-notes.txt")
	if err = os.WriteFile(kept, []byte("unchanged human content"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(target.Directory)
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
	if err != nil || got.Outcome != "observed_existing" {
		t.Fatalf("existing directory was claimed as newly created: %+v %v", got, err)
	}
	after, err := os.Stat(target.Directory)
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("existing directory was replaced")
	}
	if body, err := os.ReadFile(kept); err != nil || string(body) != "unchanged human content" {
		t.Fatal("preparation overwrote an existing file")
	}
	if entries, err := os.ReadDir(target.Directory); err != nil || len(entries) != 1 {
		t.Fatal("base step silently created unselected partitions")
	}
}
func TestPreparationRefusesMissingBoundaryRootMarkerAndLocalMountSubstitute(t *testing.T) {
	t.Run("boundary is not created", func(t *testing.T) {
		f, r := preparationFixture(t, []string{"operator-created"})
		target := preparationTarget(t, f, r, "operator-created/meeting")
		_, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
		wantCode(t, err, "root_unavailable")
		if _, err = os.Stat(filepath.Join(r.Path, "operator-created")); !os.IsNotExist(err) {
			t.Fatal("created the authorization boundary")
		}
	})
	t.Run("missing root is not recreated", func(t *testing.T) {
		f, r := preparationFixture(t, []string{"."})
		target := preparationTarget(t, f, r, "meeting")
		if err := os.RemoveAll(r.Path); err != nil {
			t.Fatal(err)
		}
		_, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
		wantCode(t, err, "root_unavailable")
		if _, err = os.Stat(r.Path); !os.IsNotExist(err) {
			t.Fatal("recreated a missing root")
		}
	})
	t.Run("wrong marker", func(t *testing.T) {
		f, r := preparationFixture(t, []string{"."})
		target := preparationTarget(t, f, r, "meeting")
		if err := os.WriteFile(filepath.Join(r.Path, MarkerName), []byte(uuid.NewString()), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
		wantCode(t, err, "root_identity_mismatch")
		if _, err = os.Stat(target.Directory); !os.IsNotExist(err) {
			t.Fatal("created below an unverified root")
		}
	})
	t.Run("local directory is not a mounted share", func(t *testing.T) {
		f, r := preparationFixture(t, []string{"."})
		r.AllowLocal = false
		f.roots[r.WorkspaceID] = r
		target := preparationTarget(t, f, r, "meeting")
		_, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
		wantCode(t, err, "mount_unavailable")
	})
	t.Run("final root symlink", func(t *testing.T) {
		f, r := preparationFixture(t, []string{"."})
		original := r.Path
		r.Path = filepath.Join(t.TempDir(), "root-link")
		if err := os.Symlink(original, r.Path); err != nil {
			t.Fatal(err)
		}
		f.roots[r.WorkspaceID] = r
		target := preparationTarget(t, f, r, "meeting")
		_, err := f.EnsurePreparedDirectory(context.Background(), target, target.RelativeDirectory)
		wantCode(t, err, "root_identity_mismatch")
		if _, err = os.Stat(filepath.Join(original, "meeting")); !os.IsNotExist(err) {
			t.Fatal("wrote through the root link")
		}
	})
}
func TestPreparationRejectsLinksAndRetainsPartialProgressWithoutRenaming(t *testing.T) {
	f, r := preparationFixture(t, []string{"."})
	target := preparationTarget(t, f, r, "meeting")
	base, err := f.EnsurePreparedDirectory(context.Background(), target, "meeting")
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	link := filepath.Join(target.Directory, "linked")
	if err = os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	inspect, err := f.InspectPreparation(context.Background(), target, []string{"meeting/linked"})
	if err != nil || len(inspect) != 1 || inspect[0].State != "conflict" || inspect[0].ErrorCode != "symlink_not_allowed" {
		t.Fatalf("symlink observation: %+v %v", inspect, err)
	}
	_, err = f.EnsurePreparedDirectory(context.Background(), target, "meeting/linked")
	wantCode(t, err, "symlink_not_allowed")
	blocker := filepath.Join(target.Directory, "material")
	if err = os.WriteFile(blocker, []byte("preserve this file"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = f.EnsurePreparedDirectory(context.Background(), target, "meeting/material")
	wantCode(t, err, "path_is_file")
	observed, err := f.EnsurePreparedDirectory(context.Background(), target, "meeting")
	if err != nil || observed.Outcome != "observed_existing" || observed.DirectoryIdentity != base.DirectoryIdentity {
		t.Fatalf("retry did not preserve the satisfied base: %+v %v", observed, err)
	}
	if bytes, err := os.ReadFile(blocker); err != nil || string(bytes) != "preserve this file" {
		t.Fatal("failure deleted or overwrote the blocker")
	}
	if got, err := os.Readlink(link); err != nil || got != outside {
		t.Fatal("preparation replaced or renamed the symlink")
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatal("preparation escaped through the link")
	}
}
func TestPreparationObservationRejectsDisplacedDescriptorsAndCancelledWaiters(t *testing.T) {
	f, r := preparationFixture(t, []string{"."})
	target := preparationTarget(t, f, r, "meeting")
	if _, err := f.EnsurePreparedDirectory(context.Background(), target, "meeting"); err != nil {
		t.Fatal(err)
	}
	h, err := openPreparationRoot(r)
	if err != nil {
		t.Fatal(err)
	}
	defer h.close()
	held, closeHeld, err := openPreparationPath(h.root, "meeting")
	if err != nil {
		t.Fatal(err)
	}
	defer closeHeld()
	moved := filepath.Join(r.Path, "moved-by-user")
	if err = os.Rename(target.Directory, moved); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(target.Directory, 0o700); err != nil {
		t.Fatal(err)
	}
	wantCode(t, h.verify("meeting", held), "directory_identity_changed")
	if _, err = os.Stat(moved); err != nil {
		t.Fatal("verification removed the user's moved directory")
	}
	workers := cap(f.preparationSlots)
	if workers == 0 {
		t.Fatal("filesystem worker capacity is unavailable")
	}
	for range workers {
		f.preparationSlots <- struct{}{}
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	queued := preparationTarget(t, f, r, "queued")
	_, err = f.EnsurePreparedDirectory(waitCtx, queued, "queued")
	wantCode(t, err, "io_timeout")
	if len(f.preparationSlots) != workers {
		t.Fatal("timed out waiter consumed another worker's slot")
	}
	for range workers {
		<-f.preparationSlots
	}
	if _, err = os.Stat(queued.Directory); !os.IsNotExist(err) {
		t.Fatal("timed out wait performed a late mkdir")
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	_, err = f.EnsurePreparedDirectory(cancelled, queued, "queued")
	wantCode(t, err, "io_timeout")
	if _, err = os.Stat(queued.Directory); !os.IsNotExist(err) {
		t.Fatal("already cancelled command wrote a directory")
	}
}
