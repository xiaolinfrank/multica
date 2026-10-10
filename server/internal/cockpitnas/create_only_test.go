//go:build darwin || linux

package cockpitnas

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

func createOnlyFixture(t *testing.T) (*Files, Request) {
	t.Helper()
	f, request := fixture(t)
	root := f.roots[request.WorkspaceID]
	root.WriteMode = ModeCreateOnly
	raw, err := json.Marshal([]Root{root})
	if err != nil {
		t.Fatal(err)
	}
	f, err = New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	request.Destination, err = f.Resolve(request.WorkspaceID, request.Destination.Directory, request.VersionID, 1)
	if err != nil {
		t.Fatal(err)
	}
	request.MeetingID = uuid.NewString()
	request.AttemptID = request.LeaseToken
	return f, request
}

func TestCreateOnlyExactEvidenceAndIdempotentVerification(t *testing.T) {
	f, request := createOnlyFixture(t)
	preview, err := f.Preview(request.WorkspaceID, request.Destination.Directory)
	if err != nil || preview.WriteMode != ModeCreateOnly {
		t.Fatalf("missing explicit mode: %+v %v", preview, err)
	}
	result, err := f.Write(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	wantPath, wantReceipt, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
	if result.Path != wantPath || result.ReceiptPath != wantReceipt || result.AttemptID != request.AttemptID || len(result.ReceiptHash) != 64 || result.ContentHash != request.ContentHash {
		t.Fatalf("unconfirmed evidence: %+v", result)
	}
	if _, err := os.Stat(request.Destination.TargetPath); !os.IsNotExist(err) {
		t.Fatal("logical target was incorrectly written as a confirmed file")
	}
	body, err := os.ReadFile(result.Path)
	if err != nil || string(body) != request.Content {
		t.Fatalf("fixed bytes lost: %v", err)
	}
	before, _ := os.Stat(result.Path)
	receiptBefore, _ := os.Stat(result.ReceiptPath)
	request.LeaseToken = uuid.NewString()
	for _, verify := range []func(context.Context, Request) (Result, error){f.VerifyAttempt, f.Write} {
		repeated, err := verify(context.Background(), request)
		if err != nil || repeated != result {
			t.Fatalf("recovery did not reuse exact evidence: %+v %v", repeated, err)
		}
	}
	after, _ := os.Stat(result.Path)
	receiptAfter, _ := os.Stat(result.ReceiptPath)
	if !os.SameFile(before, after) || !os.SameFile(receiptBefore, receiptAfter) {
		t.Fatal("idempotent verification replaced an existing file")
	}
	entries, _ := os.ReadDir(filepath.Dir(result.Path))
	if len(entries) != 2 {
		t.Fatalf("expected content and completion record only: %v", entries)
	}
	missing := request
	missing.AttemptID = uuid.NewString()
	_, err = f.VerifyAttempt(context.Background(), missing)
	wantCode(t, err, "attempt_incomplete")
	missingPath, _, _ := AttemptPaths(missing.Destination, missing.OperationID, missing.AttemptID)
	if _, err := os.Stat(filepath.Dir(missingPath)); !os.IsNotExist(err) {
		t.Fatal("verification created an unrecorded attempt")
	}
}

func TestCreateOnlyRetainsPartialFilesAndUsesANewAttempt(t *testing.T) {
	for _, partial := range []string{"content", "receipt"} {
		t.Run(partial, func(t *testing.T) {
			f, request := createOnlyFixture(t)
			writePrefix := func(file *os.File, data []byte) error {
				_, err := file.Write(data[:7])
				if err != nil {
					return err
				}
				return unix.EIO
			}
			if partial == "content" {
				f.writeCreateOnlyFile = writePrefix
			} else {
				f.writeCreateOnlyReceipt = writePrefix
			}
			_, err := f.Write(context.Background(), request)
			wantCode(t, err, "storage_unavailable")
			bodyPath, receiptPath, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
			body, _ := os.ReadFile(bodyPath)
			if partial == "content" && string(body) != request.Content[:7] {
				t.Fatal("interrupted body did not remain for inspection")
			}
			if partial == "content" {
				if _, err := os.Stat(receiptPath); !os.IsNotExist(err) {
					t.Fatal("partial content gained a completion record")
				}
			}
			_, err = f.VerifyAttempt(context.Background(), request)
			wantCode(t, err, "attempt_incomplete")
			f.writeCreateOnlyFile, f.writeCreateOnlyReceipt = nil, nil
			_, err = f.Write(context.Background(), request)
			wantCode(t, err, "attempt_incomplete")
			after, _ := os.ReadFile(bodyPath)
			if string(after) != string(body) {
				t.Fatal("retry altered a retained attempt")
			}
			next := request
			next.AttemptID, next.LeaseToken = uuid.NewString(), uuid.NewString()
			result, err := f.Write(context.Background(), next)
			if err != nil || result.Path == bodyPath {
				t.Fatalf("new attempt failed: %+v %v", result, err)
			}
			after, _ = os.ReadFile(bodyPath)
			if string(after) != string(body) {
				t.Fatal("new attempt removed or rewrote the old content")
			}
		})
	}
}

func TestCreateOnlyRejectsIncorrectCompletionEvidence(t *testing.T) {
	for _, invalid := range []string{"version", "size", "schema", "unknown_field", "trailing_json", "body"} {
		t.Run(invalid, func(t *testing.T) {
			f, request := createOnlyFixture(t)
			result, err := f.Write(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			raw, _ := os.ReadFile(result.ReceiptPath)
			var receipt map[string]any
			if err := json.Unmarshal(raw, &receipt); err != nil {
				t.Fatal(err)
			}
			want := "receipt_conflict"
			switch invalid {
			case "version":
				receipt["version_id"] = uuid.NewString()
			case "size":
				receipt["size_bytes"] = 0
			case "schema":
				receipt["schema_version"] = 99
			case "unknown_field":
				receipt["pretend_approved"] = true
			case "body":
				want = "file_conflict"
				if err := os.WriteFile(result.Path, []byte("External change"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			changed, _ := json.Marshal(receipt)
			if invalid == "trailing_json" {
				changed = append(changed, []byte(" {}")...)
			}
			if err := os.WriteFile(result.ReceiptPath, changed, 0o644); err != nil {
				t.Fatal(err)
			}
			_, err = f.VerifyAttempt(context.Background(), request)
			wantCode(t, err, want)
			_, err = f.Write(context.Background(), request)
			wantCode(t, err, want)
			after, _ := os.ReadFile(result.ReceiptPath)
			if string(after) != string(changed) {
				t.Fatal("verification repaired an existing receipt in place")
			}
		})
	}
}

func TestCreateOnlyRecoversCompletedReceiptAfterSyncFailure(t *testing.T) {
	f, request := createOnlyFixture(t)
	f.syncDirectory = func(*os.File) error { return unix.EIO }
	_, err := f.Write(context.Background(), request)
	wantCode(t, err, "storage_unavailable")
	path, receipt, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
	if _, err := os.Stat(receipt); err != nil {
		t.Fatal("completed receipt was deleted after uncertain sync")
	}
	before, _ := os.Stat(path)
	f.syncDirectory = nil
	result, err := f.VerifyAttempt(context.Background(), request)
	if err != nil || result.Path != path {
		t.Fatalf("sync recovery failed: %+v %v", result, err)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) {
		t.Fatal("sync recovery replaced the content")
	}
}

func TestCreateOnlyRefusesLinksAndDisplacedAttempts(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		f, request := createOnlyFixture(t)
		target, _, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
		if err := os.MkdirAll(filepath.Dir(filepath.Dir(target)), 0o755); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		if err := os.Symlink(outside, filepath.Dir(target)); err != nil {
			t.Fatal(err)
		}
		_, err := f.Write(context.Background(), request)
		wantCode(t, err, "unsafe_path")
		entries, _ := os.ReadDir(outside)
		if len(entries) != 0 {
			t.Fatal("export escaped through an attempt link")
		}
	})
	for _, point := range []string{"before_receipt", "before_ack"} {
		t.Run(point, func(t *testing.T) {
			f, request := createOnlyFixture(t)
			target, receipt, _ := AttemptPaths(request.Destination, request.OperationID, request.AttemptID)
			moved := filepath.Join(t.TempDir(), "moved-attempt")
			var hookErr error
			move := func() {
				if hookErr = os.Rename(filepath.Dir(target), moved); hookErr == nil {
					hookErr = os.Mkdir(filepath.Dir(target), 0o755)
				}
			}
			if point == "before_receipt" {
				f.beforeCommit = move
			} else {
				f.beforeAck = move
			}
			_, err := f.Write(context.Background(), request)
			if hookErr != nil {
				t.Fatal(hookErr)
			}
			wantCode(t, err, "path_changed")
			if _, err := os.Stat(receipt); !os.IsNotExist(err) {
				t.Fatal("displaced attempt was confirmed at the original path")
			}
			if point == "before_receipt" {
				if _, err := os.Stat(filepath.Join(moved, CompletionName)); !os.IsNotExist(err) {
					t.Fatal("completed a moved attempt")
				}
			}
			if _, err := os.Stat(filepath.Join(moved, filepath.Base(target))); err != nil {
				t.Fatal("failed attempt was deleted instead of retained")
			}
		})
	}
}

func TestCreateOnlyConcurrentSameAttemptDoesNotReplaceFiles(t *testing.T) {
	f, request := createOnlyFixture(t)
	var group sync.WaitGroup
	errorsOut := make(chan error, 6)
	for range 6 {
		group.Add(1)
		go func() { defer group.Done(); _, err := f.Write(context.Background(), request); errorsOut <- err }()
	}
	group.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			var typed *Error
			if !errors.As(err, &typed) || typed.Code != "attempt_incomplete" {
				t.Fatal(err)
			}
		}
	}
	result, err := f.VerifyAttempt(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(result.Path))
	if len(entries) != 2 {
		t.Fatal("concurrent writers created extra files")
	}
}

func TestCreateOnlyModeIsExplicitAndNeverRetargetsAtomicIntent(t *testing.T) {
	f, request := fixture(t)
	root := f.roots[request.WorkspaceID]
	root.WriteMode = ModeCreateOnly
	raw, _ := json.Marshal([]Root{root})
	changed, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, err = changed.Write(context.Background(), request)
	wantCode(t, err, "root_changed")
	destination, err := changed.Resolve(request.WorkspaceID, request.Destination.Directory, request.VersionID, 1)
	if err != nil || destination.RelativePath == request.Destination.RelativePath || !strings.Contains(destination.RelativePath, CreateOnlyDirectory) {
		t.Fatal("new mode did not use a distinct immutable intent")
	}
	root.WriteMode = "best_effort"
	raw, _ = json.Marshal([]Root{root})
	if _, err := New(string(raw)); err == nil {
		t.Fatal("unknown storage mode was silently accepted")
	}
}
