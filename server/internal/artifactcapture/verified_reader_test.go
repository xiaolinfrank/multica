package artifactcapture

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
)

type fixedReadStore struct {
	Store
	open func(context.Context, string) (io.ReadCloser, error)
}

func (s fixedReadStore) SupportsPrivateArtifactFiles() bool { return true }

type publicReadStore struct{ fixedReadStore }

func (s publicReadStore) SupportsPrivateArtifactFiles() bool { return false }

func TestArtifactCaptureRequiresPrivateStorageBeforeAnyIO(t *testing.T) {
	capture, request, _ := fixture(t, "fixed object")
	capture.Store = publicReadStore{fixedReadStore{open: func(context.Context, string) (io.ReadCloser, error) {
		t.Fatal("unconfirmed private storage was read")
		return nil, nil
	}}}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("fixed object")))
	_, err := capture.Capture(context.Background(), request)
	requireCode(t, err, "private_storage_required")
	err = capture.Verify(context.Background(), "fixed/object", request.Source.SizeBytes, hash)
	requireCode(t, err, "private_storage_required")
	reader, err := capture.OpenVerified(context.Background(), "fixed/object", request.Source.SizeBytes, hash)
	requireCode(t, err, "private_storage_required")
	if reader != nil {
		t.Fatal("public storage returned a reader")
	}
}

func (s fixedReadStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.open(ctx, key)
}

type finishErrorReader struct {
	io.Reader
	closeError error
	closed     bool
}

func (r *finishErrorReader) Close() error {
	r.closed = true
	return r.closeError
}

func TestOpenVerifiedKeepsTheVerifiedResponseIndependentOfLaterStorageChanges(t *testing.T) {
	const body = "# 固定成果\nExact bytes include trailing spaces.  \n"
	capture, request, store := fixture(t, body)
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	reader, err := capture.OpenVerified(context.Background(), request.Source.StorageKey, int64(len(body)), hash)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	store.objects[request.Source.StorageKey] = []byte("external replacement")
	data, err := io.ReadAll(reader)
	if err != nil || string(data) != body {
		t.Fatalf("served bytes = %q, error = %v", data, err)
	}
	if _, err := reader.Seek(2, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	data, err = io.ReadAll(reader)
	if err != nil || string(data) != body[2:] {
		t.Fatalf("range bytes = %q, error = %v", data, err)
	}
	files, err := os.ReadDir(capture.TempDir)
	if err != nil || len(files) != 1 {
		t.Fatalf("verified response must retain one owned spool: %v %v", files, err)
	}
	if store.uploads != 0 {
		t.Fatal("opening a verified response wrote an object")
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatalf("repeated close: %v", err)
	}
	files, err = os.ReadDir(capture.TempDir)
	if err != nil || len(files) != 0 {
		t.Fatalf("closed response retained a spool: %v %v", files, err)
	}
}

func TestOpenVerifiedRejectsChangedBytesAndFailedReadCompletion(t *testing.T) {
	for _, scenario := range []string{"short", "long", "hash", "close"} {
		t.Run(scenario, func(t *testing.T) {
			body := []byte("fixed object")
			readBody := bytes.Clone(body)
			var closeErr error
			code := "capture_mismatch"
			switch scenario {
			case "short":
				readBody = readBody[:len(readBody)-1]
			case "long":
				readBody = append(readBody, '!')
			case "hash":
				readBody[0] = 'X'
			case "close":
				closeErr = errors.New("provider integrity check did not finish")
				code = "capture_verify_failed"
			}
			input := &finishErrorReader{Reader: bytes.NewReader(readBody), closeError: closeErr}
			capture := &Capturer{TempDir: t.TempDir(), Store: fixedReadStore{open: func(context.Context, string) (io.ReadCloser, error) { return input, nil }}}
			reader, err := capture.OpenVerified(context.Background(), "fixed/object", int64(len(body)), fmt.Sprintf("%x", sha256.Sum256(body)))
			if reader != nil {
				reader.Close()
				t.Fatal("unverified bytes were made available")
			}
			requireCode(t, err, code)
			if !input.closed {
				t.Fatal("source reader was not closed")
			}
			files, readErr := os.ReadDir(capture.TempDir)
			if readErr != nil || len(files) != 0 {
				t.Fatalf("failed verification retained a spool: %v %v", files, readErr)
			}
		})
	}
}

func TestVerifyRejectsAProviderCloseFailure(t *testing.T) {
	body := []byte("verified-sized bytes")
	input := &finishErrorReader{Reader: bytes.NewReader(body), closeError: errors.New("provider checksum failure")}
	capture := &Capturer{Store: fixedReadStore{open: func(context.Context, string) (io.ReadCloser, error) { return input, nil }}}
	err := capture.Verify(context.Background(), "fixed/object", int64(len(body)), fmt.Sprintf("%x", sha256.Sum256(body)))
	requireCode(t, err, "capture_verify_failed")
	if !input.closed {
		t.Fatal("verification did not close the source")
	}
}

func TestOpenVerifiedCancellationAndInvalidInputsDoNotLeakSpools(t *testing.T) {
	capture, request, store := fixture(t, "fixed object")
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte("fixed object")))
	opened := 0
	capture.Store = fixedReadStore{Store: store, open: func(ctx context.Context, key string) (io.ReadCloser, error) {
		opened++
		return store.GetReader(ctx, key)
	}}
	for _, key := range []string{"", "/absolute", "../escape", "https://remote/file"} {
		_, err := capture.OpenVerified(context.Background(), key, request.Source.SizeBytes, hash)
		requireCode(t, err, "invalid_payload")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := capture.OpenVerified(ctx, request.Source.StorageKey, request.Source.SizeBytes, hash); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled open = %v", err)
	}
	if opened != 0 {
		t.Fatalf("invalid or cancelled input opened storage %d times", opened)
	}
	ctx, cancel = context.WithCancel(context.Background())
	reader, err := capture.OpenVerified(ctx, request.Source.StorageKey, request.Source.SizeBytes, hash)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := reader.Read(make([]byte, 1)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled response read = %v", err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(capture.TempDir)
	if err != nil || len(files) != 0 {
		t.Fatalf("cancelled response retained a spool: %v %v", files, err)
	}
}
