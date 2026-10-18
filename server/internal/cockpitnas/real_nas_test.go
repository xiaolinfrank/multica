//go:build (darwin || linux) && nasintegration

package cockpitnas

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestRealNASExport requires explicit authorization and an existing network
// directory. Every mutation stays inside the freshly created UUID subtree.
func TestRealNASExport(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_NAS_TEST") != "1" {
		t.Skip("set MULTICA_RUN_REAL_NAS_TEST=1 only after authorizing real NAS writes")
	}
	parent := os.Getenv("MULTICA_REAL_NAS_PARENT")
	if !validAbsolutePath(parent) || parent == "/" {
		t.Fatal("MULTICA_REAL_NAS_PARENT must identify an existing network directory")
	}
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil || resolved != filepath.Clean(parent) {
		t.Fatalf("NAS parent must exist without symlink traversal: %v", err)
	}
	parentDir, err := os.Open(parent)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = parentDir.Close() })
	if network, err := isNetworkMount(parentDir); err != nil || !network {
		t.Fatalf("refusing writes to a non-network parent: network=%t err=%v", network, err)
	}
	root := filepath.Join(parent, ".multica-validation-"+uuid.NewString())
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	owned, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("real NAS sandbox: %s", root)
	t.Cleanup(func() {
		current, err := os.Lstat(root)
		if err != nil || !os.SameFile(owned, current) || !current.IsDir() {
			t.Errorf("refusing cleanup of a changed sandbox: %s (%v)", root, err)
			return
		}
		if network, err := isNetworkMount(parentDir); err != nil || !network {
			t.Errorf("refusing cleanup after network mount changed: %v", err)
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("sandbox cleanup: %v", err)
			return
		}
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Errorf("sandbox still exists after cleanup: %v", err)
			return
		}
		t.Logf("removed owned NAS sandbox: %s", root)
	})
	ws, rootID := uuid.NewString(), uuid.NewString()
	if err := os.WriteFile(filepath.Join(root, MarkerName), []byte(rootID+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal([]Root{{WorkspaceID: ws, RootID: rootID, Path: root}})
	if err != nil {
		t.Fatal(err)
	}
	newRequest := func(t *testing.T) (*Files, Request) {
		t.Helper()
		files, err := New(string(raw))
		if err != nil {
			t.Fatal(err)
		}
		meeting := filepath.Join(root, "会议材料 "+uuid.NewString())
		if err := os.Mkdir(meeting, 0o700); err != nil {
			t.Fatal(err)
		}
		version := uuid.NewString()
		destination, err := files.Resolve(ws, meeting, version, 1)
		if err != nil {
			t.Fatal(err)
		}
		content := "# NAS 验证纪要\r\n\n范围、评审与下一步执行：已确认。\nNo trailing newline"
		return files, Request{WorkspaceID: ws, VersionID: version, OperationID: uuid.NewString(), LeaseToken: uuid.NewString(),
			Content: content, ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(content))), Destination: destination}
	}
	assertCopy := func(t *testing.T, request Request) {
		t.Helper()
		data, err := os.ReadFile(request.Destination.TargetPath)
		if err != nil || string(data) != request.Content {
			t.Fatalf("published bytes differ: %v", err)
		}
		entries, err := os.ReadDir(filepath.Dir(request.Destination.TargetPath))
		if err != nil || len(entries) != 1 {
			t.Fatalf("expected one final file and no temporary files: entries=%d err=%v", len(entries), err)
		}
	}

	t.Run("exact_bytes_and_idempotent_recovery", func(t *testing.T) {
		files, request := newRequest(t)
		result, err := files.Write(context.Background(), request)
		if err != nil {
			t.Fatalf("real NAS commit and sync: %v", err)
		}
		if result.Path != request.Destination.TargetPath || result.ContentHash != request.ContentHash || result.Size != int64(len(request.Content)) {
			t.Fatalf("incorrect receipt: %+v", result)
		}
		before, err := os.Stat(result.Path)
		if err != nil {
			t.Fatal(err)
		}
		request.LeaseToken = uuid.NewString()
		if _, err := files.Write(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		after, err := os.Stat(result.Path)
		if err != nil || !os.SameFile(before, after) {
			t.Fatalf("recovery replaced the committed file: %v", err)
		}
		// SMB may refresh cached write timestamps after the first read. File
		// identity and exact bytes, rather than timestamp equality, prove reuse.
		assertCopy(t, request)
	})

	t.Run("concurrent_exclusive_commits", func(t *testing.T) {
		files, request := newRequest(t)
		const writers = 4
		var ready atomic.Int32
		allReady := make(chan struct{})
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		files.beforeCommit = func() {
			if ready.Add(1) == writers {
				close(allReady)
			}
			select {
			case <-allReady:
			case <-ctx.Done():
			}
		}
		errors := make(chan error, writers)
		for range writers {
			go func() {
				attempt := request
				attempt.OperationID, attempt.LeaseToken = uuid.NewString(), uuid.NewString()
				_, err := files.Write(ctx, attempt)
				errors <- err
			}()
		}
		for range writers {
			if err := <-errors; err != nil {
				t.Error(err)
			}
		}
		assertCopy(t, request)
	})

	t.Run("recover_existing_matching_file", func(t *testing.T) {
		files, request := newRequest(t)
		if err := os.Mkdir(filepath.Dir(request.Destination.TargetPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(request.Destination.TargetPath, []byte(request.Content), 0o600); err != nil {
			t.Fatal(err)
		}
		before, err := os.Stat(request.Destination.TargetPath)
		if err != nil {
			t.Fatal(err)
		}
		result, err := files.Write(context.Background(), request)
		if err != nil || result.ContentHash != request.ContentHash || result.Size != int64(len(request.Content)) {
			t.Fatalf("existing-file verification and directory sync: %+v %v", result, err)
		}
		after, err := os.Stat(result.Path)
		if err != nil || !os.SameFile(before, after) {
			t.Fatalf("existing-file recovery replaced the file: %v", err)
		}
		assertCopy(t, request)
	})

	t.Run("foreign_file_created_during_commit", func(t *testing.T) {
		files, request := newRequest(t)
		const humanContent = "Human-owned fixture: must survive exclusive rename"
		files.beforeCommit = func() {
			file, err := os.OpenFile(request.Destination.TargetPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.WriteString(humanContent); err != nil {
				file.Close()
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
		}
		_, err := files.Write(context.Background(), request)
		wantCode(t, err, "file_conflict")
		request.Content = humanContent
		assertCopy(t, request)
	})

	t.Run("missing_meeting_and_recovery", func(t *testing.T) {
		files, request := newRequest(t)
		moved := request.Destination.Directory + "-offline"
		if err := os.Rename(request.Destination.Directory, moved); err != nil {
			t.Fatal(err)
		}
		_, err := files.Write(context.Background(), request)
		wantCode(t, err, "storage_unavailable")
		if _, err := os.Lstat(request.Destination.Directory); !os.IsNotExist(err) {
			t.Fatalf("exporter recreated the missing meeting directory: %v", err)
		}
		if err := os.Rename(moved, request.Destination.Directory); err != nil {
			t.Fatal(err)
		}
		request.LeaseToken = uuid.NewString()
		if _, err := files.Write(context.Background(), request); err != nil {
			t.Fatal(err)
		}
		assertCopy(t, request)
	})

	t.Run("root_identity_mismatch", func(t *testing.T) {
		files, request := newRequest(t)
		if err := os.WriteFile(filepath.Join(root, MarkerName), []byte(uuid.NewString()), 0o600); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := os.WriteFile(filepath.Join(root, MarkerName), []byte(rootID), 0o600); err != nil {
				t.Error(err)
			}
		}()
		_, err := files.Write(context.Background(), request)
		wantCode(t, err, "identity_mismatch")
		if _, err := os.Lstat(filepath.Dir(request.Destination.TargetPath)); !os.IsNotExist(err) {
			t.Fatalf("identity failure created an output directory: %v", err)
		}
	})

	t.Run("directory_displacement_before_commit", func(t *testing.T) {
		files, request := newRequest(t)
		published := filepath.Dir(request.Destination.TargetPath)
		moved := published + "-moved"
		files.beforeCommit = func() {
			if err := os.Rename(published, moved); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(published, 0o700); err != nil {
				t.Fatal(err)
			}
		}
		_, err := files.Write(context.Background(), request)
		wantCode(t, err, "path_changed")
		for _, directory := range []string{published, moved} {
			entries, err := os.ReadDir(directory)
			if err != nil || len(entries) != 0 {
				t.Fatalf("commit wrote to a displaced path or leaked a temp file: %v %v", entries, err)
			}
		}
	})
}
