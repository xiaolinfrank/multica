//go:build darwin || linux

package cockpitnas

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func fixture(t *testing.T) (*Files, Request) {
	t.Helper()
	root := t.TempDir()
	ws, id, version := uuid.NewString(), uuid.NewString(), uuid.NewString()
	config, _ := json.Marshal([]Root{{WorkspaceID: ws, RootID: id, Path: root, AllowLocal: true}})
	f, err := New(string(config))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, MarkerName), []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "会议材料")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	dest, err := f.Resolve(ws, dir, version, 1)
	if err != nil {
		t.Fatal(err)
	}
	content := "# Fixed minutes\n\n范围与验收边界已经人工确认。"
	return f, Request{WorkspaceID: ws, VersionID: version, OperationID: uuid.NewString(), LeaseToken: uuid.NewString(), Content: content,
		ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(content))), Destination: dest}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestExportUsesExactFixedBytesAndRecoversCommittedCopy(t *testing.T) {
	f, request := fixture(t)
	result, err := f.Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Path != request.Destination.TargetPath || result.ContentHash != request.ContentHash || result.Size != int64(len(request.Content)) {
		t.Fatalf("invalid receipt: %+v", result)
	}
	before, _ := os.Stat(result.Path)
	request.LeaseToken = uuid.NewString()
	if _, err := f.Write(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(result.Path)
	data, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != request.Content || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("retry changed the published file")
	}
	entries, _ := os.ReadDir(filepath.Dir(result.Path))
	if len(entries) != 1 {
		t.Fatalf("temporary files remained after successful commit: %v", entries)
	}
}

func TestExportRecoveryRepeatsDirectorySynchronization(t *testing.T) {
	f, request := fixture(t)
	var syncs int
	f.syncDirectory = func(*os.File) error {
		syncs++
		return unix.EIO
	}
	_, err := f.Write(context.Background(), request)
	wantCode(t, err, "storage_unavailable")
	before, err := os.Stat(request.Destination.TargetPath)
	if err != nil {
		t.Fatalf("rename should have completed before failed sync: %v", err)
	}
	request.LeaseToken = uuid.NewString()
	_, err = f.Write(context.Background(), request)
	wantCode(t, err, "storage_unavailable")
	if syncs != 2 {
		t.Fatal("existing-file recovery skipped the failed durability step")
	}
	f.syncDirectory = nil
	if _, err := f.Write(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(request.Destination.TargetPath)
	if err != nil || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("durability recovery replaced the fixed content")
	}
	f.syncDirectory = func(*os.File) error { return unix.ENOTSUP }
	_, err = f.Write(context.Background(), request)
	wantCode(t, err, "unsupported_sync")
	var typed *Error
	if !errors.As(err, &typed) || typed.Retryable {
		t.Fatal("unsupported synchronization should need operator attention")
	}
}

func TestExportRejectsDisplacedDirectoriesBeforeCommit(t *testing.T) {
	for _, directory := range []string{"root", "meeting", "published"} {
		t.Run(directory, func(t *testing.T) {
			f, request := fixture(t)
			original := request.Destination.RootPath
			switch directory {
			case "meeting":
				original = request.Destination.Directory
			case "published":
				original = filepath.Dir(request.Destination.TargetPath)
			}
			moved := filepath.Join(t.TempDir(), "moved")
			var hookErr error
			f.beforeCommit = func() {
				if hookErr = os.Rename(original, moved); hookErr != nil {
					return
				}
				hookErr = os.Mkdir(original, 0o755)
				// Even a copied identity marker cannot turn a different root
				// inode into the one whose descriptor the write holds.
				if hookErr == nil && directory == "root" {
					hookErr = os.WriteFile(filepath.Join(original, MarkerName), []byte(request.Destination.RootID), 0o600)
				}
			}
			_, err := f.Write(context.Background(), request)
			if hookErr != nil {
				t.Fatal(hookErr)
			}
			wantCode(t, err, "path_changed")
			if _, err := os.Stat(request.Destination.TargetPath); !os.IsNotExist(err) {
				t.Fatal("committed into a replaced destination")
			}
			rel, err := filepath.Rel(original, request.Destination.TargetPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(moved, rel)); !os.IsNotExist(err) {
				t.Fatal("committed into the displaced directory")
			}
		})
	}
}

func TestExportRejectsDirectoryMoveBeforeReceiptIncludingRecovery(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		t.Run(fmt.Sprintf("recovery=%t", recovery), func(t *testing.T) {
			f, request := fixture(t)
			if recovery {
				if _, err := f.Write(context.Background(), request); err != nil {
					t.Fatal(err)
				}
				request.LeaseToken = uuid.NewString()
			}
			published := filepath.Dir(request.Destination.TargetPath)
			moved := filepath.Join(t.TempDir(), "moved")
			var hookErr error
			f.beforeAck = func() {
				if hookErr = os.Rename(published, moved); hookErr == nil {
					hookErr = os.Mkdir(published, 0o755)
				}
			}
			result, err := f.Write(context.Background(), request)
			if hookErr != nil {
				t.Fatal(hookErr)
			}
			wantCode(t, err, "path_changed")
			if result.Path != "" {
				t.Fatal("a displaced file received a success receipt for its old path")
			}
			// Moving a committed copy does not authorize removing the human's
			// relocated file; the operation reports the conflict for recovery.
			data, err := os.ReadFile(filepath.Join(moved, filepath.Base(request.Destination.TargetPath)))
			if err != nil || string(data) != request.Content {
				t.Fatal("reporting displacement changed the committed copy")
			}
		})
	}
}

func TestExportRechecksRootMarkerBeforeCommit(t *testing.T) {
	f, request := fixture(t)
	var hookErr error
	f.beforeCommit = func() {
		hookErr = os.WriteFile(filepath.Join(request.Destination.RootPath, MarkerName), []byte(uuid.NewString()), 0o600)
	}
	_, err := f.Write(context.Background(), request)
	if hookErr != nil {
		t.Fatal(hookErr)
	}
	wantCode(t, err, "identity_mismatch")
	if _, err := os.Stat(request.Destination.TargetPath); !os.IsNotExist(err) {
		t.Fatal("committed after root identity changed")
	}
}

func TestExportNeverOverwritesForeignFilesOrFollowsLinks(t *testing.T) {
	for _, kind := range []string{"different", "symlink", "fifo", "directory"} {
		t.Run(kind, func(t *testing.T) {
			f, request := fixture(t)
			dir, target := filepath.Dir(request.Destination.TargetPath), request.Destination.TargetPath
			if err := os.Mkdir(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			outside := filepath.Join(t.TempDir(), "original.md")
			if err := os.WriteFile(outside, []byte(request.Content), 0o600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "different":
				if err := os.WriteFile(target, []byte("Human work"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(outside, target); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := unix.Mkfifo(target, 0o600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(target, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			_, err := f.Write(context.Background(), request)
			if kind == "symlink" {
				wantCode(t, err, "unsafe_path")
			} else {
				wantCode(t, err, "file_conflict")
			}
			original, _ := os.ReadFile(outside)
			if string(original) != request.Content {
				t.Fatal("outside file was modified")
			}
			if kind == "different" {
				data, _ := os.ReadFile(target)
				if string(data) != "Human work" {
					t.Fatal("human work was overwritten")
				}
			}
		})
	}
}

func TestExportFailsClosedOnRootIdentityAndMissingMount(t *testing.T) {
	t.Run("root missing is not recreated", func(t *testing.T) {
		f, r := fixture(t)
		if err := os.RemoveAll(r.Destination.RootPath); err != nil {
			t.Fatal(err)
		}
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "storage_unavailable")
		if _, err := os.Stat(r.Destination.RootPath); !os.IsNotExist(err) {
			t.Fatal("missing root was recreated")
		}
	})
	t.Run("wrong identity", func(t *testing.T) {
		f, r := fixture(t)
		if err := os.WriteFile(filepath.Join(r.Destination.RootPath, MarkerName), []byte(uuid.NewString()), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "identity_mismatch")
	})
	t.Run("local placeholder is not a network mount", func(t *testing.T) {
		f, r := fixture(t)
		root := f.roots[r.WorkspaceID]
		root.AllowLocal = false
		f.roots[r.WorkspaceID] = root
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "mount_unavailable")
	})
	t.Run("meeting missing is not recreated", func(t *testing.T) {
		f, r := fixture(t)
		if err := os.Remove(r.Destination.Directory); err != nil {
			t.Fatal(err)
		}
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "storage_unavailable")
		if _, err := os.Stat(r.Destination.Directory); !os.IsNotExist(err) {
			t.Fatal("missing meeting directory was recreated")
		}
	})
	t.Run("meeting directory link is rejected", func(t *testing.T) {
		f, r := fixture(t)
		if err := os.Remove(r.Destination.Directory); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(t.TempDir(), r.Destination.Directory); err != nil {
			t.Fatal(err)
		}
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "unsafe_path")
	})
	t.Run("root mapping change", func(t *testing.T) {
		f, r := fixture(t)
		root := f.roots[r.WorkspaceID]
		root.Path = t.TempDir()
		f.roots[r.WorkspaceID] = root
		_, err := f.Write(context.Background(), r)
		wantCode(t, err, "root_changed")
	})
}

func TestConcurrentExportsConvergeWithoutReplacement(t *testing.T) {
	f, request := fixture(t)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := request
			r.OperationID = uuid.NewString()
			r.LeaseToken = uuid.NewString()
			_, err := f.Write(context.Background(), r)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(request.Destination.TargetPath)
	if err != nil || string(data) != request.Content {
		t.Fatalf("wrong final file: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(request.Destination.TargetPath))
	if len(entries) != 1 {
		t.Fatal("temporary files remained")
	}
}

func TestExportConfigurationAndUntrustedDestination(t *testing.T) {
	f, r := fixture(t)
	for _, directory := range []string{filepath.Dir(r.Destination.RootPath), r.Destination.RootPath + "/../elsewhere", r.Destination.RootPath + "/x\n", "relative"} {
		_, err := f.Preview(r.WorkspaceID, directory)
		wantCode(t, err, "outside_root")
	}
	_, err := f.Preview(uuid.NewString(), r.Destination.Directory)
	wantCode(t, err, "not_configured")
	bad := r
	bad.Content += "changed"
	_, err = f.Write(context.Background(), bad)
	wantCode(t, err, "content_mismatch")
	bad = r
	bad.LeaseToken = "../../escape"
	_, err = f.Write(context.Background(), bad)
	wantCode(t, err, "invalid_identity")
	for _, raw := range []string{"[] {}", `[{"unknown":true}]`, fmt.Sprintf(`[{"workspace_id":%q,"root_id":%q,"path":"/"}]`, r.WorkspaceID, r.Destination.RootID)} {
		if _, err := New(raw); err == nil {
			t.Fatalf("accepted invalid config %s", raw)
		}
	}
	root := f.roots[r.WorkspaceID]
	nested := root
	nested.WorkspaceID = uuid.NewString()
	nested.RootID = uuid.NewString()
	nested.Path = filepath.Join(root.Path, "nested")
	raw, _ := json.Marshal([]Root{root, nested})
	if _, err := New(string(raw)); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatalf("accepted overlapping workspace roots: %v", err)
	}
}
