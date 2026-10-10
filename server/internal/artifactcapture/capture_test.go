package artifactcapture

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
)

type memoryStore struct {
	mu        sync.Mutex
	objects   map[string][]byte
	uploads   int
	corrupt   bool
	uploadErr error
	readErr   error
}

func (s *memoryStore) SupportsPrivateArtifactFiles() bool { return true }

func (s *memoryStore) GetReader(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.readErr != nil {
		return nil, s.readErr
	}
	data, ok := s.objects[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return io.NopCloser(bytes.NewReader(bytes.Clone(data))), nil
}

func (s *memoryStore) UploadStream(_ context.Context, key string, reader io.Reader, _ int64, _, _ string) (string, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads++
	if s.corrupt {
		data = []byte("wrong bytes")
	}
	s.objects[key] = data
	return "opaque-storage-url", s.uploadErr
}

func fixture(t *testing.T, body string) (*Capturer, Request, *memoryStore) {
	t.Helper()
	store := &memoryStore{objects: map[string][]byte{"workspaces/source/report.md": []byte(body)}}
	request := Request{WorkspaceID: "10000000-0000-4000-8000-000000000001", VersionID: "20000000-0000-4000-8000-000000000001",
		AttemptID: "30000000-0000-4000-8000-000000000001", Source: Source{AttachmentID: "40000000-0000-4000-8000-000000000001",
			StorageKey: "workspaces/source/report.md", Filename: "成果 report.md", ContentType: "text/markdown", SizeBytes: int64(len(body))}}
	return &Capturer{Store: store, TempDir: t.TempDir()}, request, store
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("capture error = %v, want %s", err, code)
	}
}

func TestCapturePreservesExactBytesAndOriginalSourceIndependence(t *testing.T) {
	body := "# 成果\n\nEvidence includes trailing spaces.  \n"
	capture, request, store := fixture(t, body)
	result, err := capture.Capture(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ContentHash != fmt.Sprintf("%x", sha256.Sum256([]byte(body))) || result.SizeBytes != int64(len(body)) || result.AttachmentID != request.Source.AttachmentID {
		t.Fatalf("incorrect fixed metadata: %+v", result)
	}
	if string(store.objects[result.StorageKey]) != body || result.StorageKey == request.Source.StorageKey {
		t.Fatal("capture did not retain an independent exact copy")
	}
	delete(store.objects, request.Source.StorageKey)
	if err := capture.Verify(context.Background(), result.StorageKey, result.SizeBytes, result.ContentHash); err != nil {
		t.Fatalf("removing the source damaged the fixed version: %v", err)
	}
	files, err := os.ReadDir(capture.TempDir)
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary spool was not removed: %v %v", files, err)
	}
}

func TestCaptureRefusesChangedSourceBeforeUpload(t *testing.T) {
	for _, scenario := range []string{"shorter", "longer", "hash"} {
		t.Run(scenario, func(t *testing.T) {
			capture, request, store := fixture(t, "fixed bytes")
			switch scenario {
			case "shorter":
				request.Source.SizeBytes++
			case "longer":
				request.Source.SizeBytes--
			case "hash":
				request.ExpectedHash = strings.Repeat("0", 64)
			}
			_, err := capture.Capture(context.Background(), request)
			requireCode(t, err, "source_changed")
			if store.uploads != 0 {
				t.Fatal("changed source reached object storage")
			}
		})
	}
}

func TestCaptureRequiresReadBackAndLeavesFailedObjectForDurableCleanup(t *testing.T) {
	capture, request, store := fixture(t, "fixed bytes")
	store.corrupt = true
	result, err := capture.Capture(context.Background(), request)
	requireCode(t, err, "capture_mismatch")
	if result.StorageKey != "" {
		t.Fatal("a corrupt upload was reported as a fixed version")
	}
	key, _ := TargetKey(request)
	if _, exists := store.objects[key]; !exists {
		t.Fatal("capture unexpectedly removed a caller-owned cleanup intent object")
	}
}

func TestCaptureDoesNotAcknowledgeAmbiguousUpload(t *testing.T) {
	capture, request, store := fixture(t, "fixed bytes")
	store.uploadErr = errors.New("connection lost after upload")
	_, err := capture.Capture(context.Background(), request)
	requireCode(t, err, "capture_write_failed")
	key, _ := TargetKey(request)
	if string(store.objects[key]) != "fixed bytes" {
		t.Fatal("fixture did not model an ambiguous committed upload")
	}
	// An owning worker may reconcile this object under the same durable intent.
	if err := capture.Verify(context.Background(), key, request.Source.SizeBytes, fmt.Sprintf("%x", sha256.Sum256([]byte("fixed bytes")))); err != nil {
		t.Fatal(err)
	}
}

func TestCaptureAttemptsHaveIndependentKeys(t *testing.T) {
	capture, first, _ := fixture(t, "fixed bytes")
	second := first
	second.AttemptID = "30000000-0000-4000-8000-000000000002"
	var results [2]Result
	var errs [2]error
	var wait sync.WaitGroup
	for index, request := range []Request{first, second} {
		wait.Add(1)
		go func(index int, request Request) {
			defer wait.Done()
			results[index], errs[index] = capture.Capture(context.Background(), request)
		}(index, request)
	}
	wait.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("capture errors: %v", errs)
	}
	if results[0].StorageKey == results[1].StorageKey || results[0].ContentHash != results[1].ContentHash {
		t.Fatalf("capture attempt identities overlap: %+v", results)
	}
}

func TestCaptureRejectsUnsafeInputAndCancelledWork(t *testing.T) {
	for _, scenario := range []string{"identity", "source_escape", "filename", "size", "hash"} {
		t.Run(scenario, func(t *testing.T) {
			capture, request, store := fixture(t, "fixed bytes")
			switch scenario {
			case "identity":
				request.AttemptID = "../../other"
			case "source_escape":
				request.Source.StorageKey = "../other"
			case "filename":
				request.Source.Filename = "../report.md"
			case "size":
				request.Source.SizeBytes = MaxBytes + 1
			case "hash":
				request.ExpectedHash = "not-a-hash"
			}
			if _, err := capture.Capture(context.Background(), request); err == nil || store.uploads != 0 {
				t.Fatalf("unsafe input reached storage: %v", err)
			}
		})
	}
	capture, request, store := fixture(t, "fixed bytes")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := capture.Capture(ctx, request); !errors.Is(err, context.Canceled) || store.uploads != 0 {
		t.Fatalf("cancelled capture result: %v", err)
	}
}
