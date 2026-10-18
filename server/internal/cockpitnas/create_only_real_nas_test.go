//go:build (darwin || linux) && nasintegration

package cockpitnas

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

// The exporter never removes or renames a file. Only this authorized test
// harness removes its fresh, identity-checked validation subtree afterwards.
func TestRealNASCreateOnly(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_NAS_TEST") != "1" {
		t.Skip("explicit real NAS validation authorization is required")
	}
	parent := os.Getenv("MULTICA_REAL_NAS_PARENT")
	resolved, err := filepath.EvalSymlinks(parent)
	if !validAbsolutePath(parent) || parent == "/" || err != nil || resolved != filepath.Clean(parent) {
		t.Fatal("expected an existing, canonical authorized NAS parent")
	}
	parentDir, err := os.Open(parent)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = parentDir.Close() })
	if network, err := isNetworkMount(parentDir); err != nil || !network {
		t.Fatal("refusing a non-network NAS fixture")
	}
	rootID, workspaceID := uuid.NewString(), uuid.NewString()
	root := filepath.Join(parent, ".multica-validation-"+rootID)
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	identity, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("create-only real NAS sandbox: %s", root)
	t.Cleanup(func() {
		current, err := os.Lstat(root)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(identity, current) {
			t.Errorf("refusing changed sandbox cleanup: %v", err)
			return
		}
		if network, err := isNetworkMount(parentDir); err != nil || !network {
			t.Errorf("NAS mount changed before cleanup: %v", err)
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("owned sandbox cleanup: %v", err)
			return
		}
		if _, err := os.Lstat(root); !os.IsNotExist(err) {
			t.Errorf("owned sandbox still exists: %v", err)
			return
		}
		t.Logf("removed owned create-only NAS sandbox: %s", root)
	})
	marker, err := os.OpenFile(filepath.Join(root, MarkerName), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := marker.WriteString(rootID + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := marker.Close(); err != nil {
		t.Fatal(err)
	}
	config := Root{WorkspaceID: workspaceID, RootID: rootID, Path: root, WriteMode: ModeCreateOnly}
	raw, _ := json.Marshal([]Root{config})
	fixture := func(t *testing.T) (*Files, Request) {
		t.Helper()
		files, err := New(string(raw))
		if err != nil {
			t.Fatal(err)
		}
		meeting := filepath.Join(root, "会议材料-"+uuid.NewString())
		if err := os.Mkdir(meeting, 0o700); err != nil {
			t.Fatal(err)
		}
		versionID := uuid.NewString()
		destination, err := files.Resolve(workspaceID, meeting, versionID, 1)
		if err != nil {
			t.Fatal(err)
		}
		content := "# 真实 NAS 创建式验证\r\n\n固定范围与人工批准的内容。\nNo trailing newline"
		lease := uuid.NewString()
		return files, Request{WorkspaceID: workspaceID, MeetingID: uuid.NewString(), VersionID: versionID, OperationID: uuid.NewString(),
			LeaseToken: lease, AttemptID: lease, Content: content, ContentHash: fmt.Sprintf("%x", sha256.Sum256([]byte(content))), Destination: destination}
	}
	t.Run("file_sync_handle_capability", func(t *testing.T) {
		path := filepath.Join(root, "sync-capability-"+uuid.NewString())
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteString("Create-only capability fixture"); err != nil {
			t.Fatal(err)
		}
		if err := file.Sync(); err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
		before, _ := os.Stat(path)
		read, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("read-only fsync result: %v", read.Sync())
		_ = read.Close()
		flush, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		if err := flush.Sync(); err != nil {
			t.Fatalf("non-truncating write-handle fsync: %v", err)
		}
		_ = flush.Close()
		after, _ := os.Stat(path)
		bytes, err := os.ReadFile(path)
		if err != nil || string(bytes) != "Create-only capability fixture" || !os.SameFile(before, after) {
			t.Fatal("flush changed file identity or content")
		}
	})
	t.Run("exact_bytes_complete_receipt_and_non_mutating_recovery", func(t *testing.T) {
		files, request := fixture(t)
		result, err := files.Write(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(result.Path)
		if err != nil || string(data) != request.Content {
			t.Fatalf("fixed bytes differ: %v", err)
		}
		before, _ := os.Stat(result.Path)
		receiptBefore, _ := os.Stat(result.ReceiptPath)
		request.LeaseToken = uuid.NewString()
		recovered, err := files.VerifyAttempt(context.Background(), request)
		if err != nil || recovered != result {
			t.Fatalf("recovery differs: %+v %v", recovered, err)
		}
		after, _ := os.Stat(result.Path)
		receiptAfter, _ := os.Stat(result.ReceiptPath)
		if !os.SameFile(before, after) || !os.SameFile(receiptBefore, receiptAfter) {
			t.Fatal("recovery replaced a completed file")
		}
	})
	for _, partial := range []string{"content", "receipt"} {
		t.Run("interrupted_"+partial+"_retained_and_new_attempt_verified", func(t *testing.T) {
			files, request := fixture(t)
			stop := func(file *os.File, data []byte) error {
				_, err := file.Write(data[:7])
				if err != nil {
					return err
				}
				return unix.EIO
			}
			if partial == "content" {
				files.writeCreateOnlyFile = stop
			} else {
				files.writeCreateOnlyReceipt = stop
			}
			_, err := files.Write(context.Background(), request)
			wantCode(t, err, "storage_unavailable")
			oldPath, _, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
			old, _ := os.ReadFile(oldPath)
			_, err = files.VerifyAttempt(context.Background(), request)
			wantCode(t, err, "attempt_incomplete")
			files.writeCreateOnlyFile, files.writeCreateOnlyReceipt = nil, nil
			request.AttemptID, request.LeaseToken = uuid.NewString(), uuid.NewString()
			result, err := files.Write(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			retained, err := os.ReadFile(oldPath)
			if err != nil || string(retained) != string(old) || result.Path == oldPath {
				t.Fatalf("failed attempt was altered: %v", err)
			}
		})
	}
	t.Run("different_existing_file_is_never_overwritten", func(t *testing.T) {
		files, request := fixture(t)
		target, completion, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			t.Fatal(err)
		}
		foreign := []byte("Validation-owned foreign content must remain")
		if err := os.WriteFile(target, foreign, 0o600); err != nil {
			t.Fatal(err)
		}
		receipt, _ := json.Marshal(expectedCompletion(request))
		if err := os.WriteFile(completion, receipt, 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := files.Write(context.Background(), request)
		wantCode(t, err, "file_conflict")
		after, err := os.ReadFile(target)
		if err != nil || string(after) != string(foreign) {
			t.Fatal("existing content was modified")
		}
	})
	t.Run("concurrent_attempts_keep_independent_completed_copies", func(t *testing.T) {
		files, request := fixture(t)
		var group sync.WaitGroup
		results := make(chan Result, 4)
		failures := make(chan error, 4)
		for range 4 {
			group.Add(1)
			go func() {
				defer group.Done()
				current := request
				current.AttemptID, current.LeaseToken = uuid.NewString(), uuid.NewString()
				result, err := files.Write(context.Background(), current)
				results <- result
				failures <- err
			}()
		}
		group.Wait()
		close(results)
		close(failures)
		for err := range failures {
			if err != nil {
				t.Fatal(err)
			}
		}
		paths := map[string]bool{}
		for result := range results {
			if paths[result.Path] {
				t.Fatal("independent attempts shared a content file")
			}
			paths[result.Path] = true
			data, err := os.ReadFile(result.Path)
			if err != nil || string(data) != request.Content {
				t.Fatal("concurrent attempt lost fixed content")
			}
		}
	})
	t.Run("wrong_root_identity_refuses_writes", func(t *testing.T) {
		_, request := fixture(t)
		invalid := config
		invalid.RootID = uuid.NewString()
		encoded, _ := json.Marshal([]Root{invalid})
		files, err := New(string(encoded))
		if err != nil {
			t.Fatal(err)
		}
		request.Destination, err = files.Resolve(workspaceID, request.Destination.Directory, request.VersionID, 1)
		if err != nil {
			t.Fatal(err)
		}
		_, err = files.Write(context.Background(), request)
		wantCode(t, err, "identity_mismatch")
		entries, _ := os.ReadDir(request.Destination.Directory)
		if len(entries) != 0 {
			t.Fatal("invalid root identity created output")
		}
	})
}
