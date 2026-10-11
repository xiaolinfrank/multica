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

type privateInputStore struct{ *memoryStore }

func (privateInputStore) SupportsPrivateInputFiles() bool { return true }

func inputFixture(t *testing.T) (*Capturer, InputTarget, *memoryStore) {
	t.Helper()
	c, r, store := fixture(t, "unused source")
	c.Store = privateInputStore{store}
	return c, InputTarget{WorkspaceID: r.WorkspaceID, VersionID: r.VersionID, TransferID: r.AttemptID, Filename: "访谈 100%.txt", ContentType: "text/plain"}, store
}

func TestInputBytesExposePinBeforeWritingAndKeepExactPreparedContent(t *testing.T) {
	c, target, store := inputFixture(t)
	ctx := context.Background()
	body := []byte("fixed input with trailing spaces  \n")
	wantHash := fmt.Sprintf("%x", sha256.Sum256(body))
	p, err := PrepareBytes(ctx, bytes.NewReader(body), c.TempDir, int64(len(body)), "")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if p.ContentHash() != wantHash || p.SizeBytes() != int64(len(body)) || store.uploads != 0 {
		t.Fatal("the domain cannot pin exact content before the first storage write")
	}
	key, err := InputTargetKey(target)
	if err != nil || !validInputKey(key) || strings.Contains(key, target.Filename) {
		t.Fatalf("input target is not an independent opaque transfer identity: %q %v", key, err)
	}
	// Replacing the caller's source after preparation cannot alter its spool.
	body[0] = 'X'
	if err := c.WriteInputAndVerify(ctx, target, p); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(store.objects[key])); got != wantHash {
		t.Fatalf("stored hash = %s, pinned %s", got, wantHash)
	}
	reader, err := c.OpenVerifiedInput(ctx, key, p.SizeBytes(), wantHash)
	if err != nil {
		t.Fatal(err)
	}
	store.objects[key] = []byte("later external replacement")
	served, err := io.ReadAll(reader)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(served)) != wantHash {
		t.Fatalf("verified response changed with storage: %q %v", served, err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(c.TempDir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("owned spools remain after Close: %v %v", entries, err)
	}
}

func TestInputBytesAmbiguousWriteRequiresReconciliationWithoutSecondUpload(t *testing.T) {
	c, target, store := inputFixture(t)
	ctx := context.Background()
	p, err := PrepareBytes(ctx, strings.NewReader("fixed"), c.TempDir, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	store.uploadErr = errors.New("response lost after storing")
	requireCode(t, c.WriteInputAndVerify(ctx, target, p), "capture_write_failed")
	key, _ := InputTargetKey(target)
	if err := c.VerifyInput(ctx, key, p.SizeBytes(), p.ContentHash()); err != nil {
		t.Fatal(err)
	}
	requireCode(t, c.WriteInputAndVerify(ctx, target, p), "prepared_bytes_unavailable")
	if store.uploads != 1 || string(store.objects[key]) != "fixed" {
		t.Fatal("ambiguous object was uploaded again or removed")
	}
}

func TestInputBytesConcurrentSubmissionWritesTheSpoolOnce(t *testing.T) {
	c, target, store := inputFixture(t)
	p, err := PrepareBytes(context.Background(), strings.NewReader("fixed"), c.TempDir, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() { results <- c.WriteInputAndVerify(context.Background(), target, p) })
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		} else {
			requireCode(t, err, "prepared_bytes_unavailable")
		}
	}
	if succeeded != 1 || store.uploads != 1 {
		t.Fatalf("submissions = %d, uploads = %d", succeeded, store.uploads)
	}
}

func TestInputBytesRequireTheirOwnNamespaceAndPrivateCapability(t *testing.T) {
	c, target, store := inputFixture(t)
	ctx := context.Background()
	p, err := PrepareBytes(ctx, strings.NewReader("fixed"), c.TempDir, 5, "")
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	key, _ := InputTargetKey(target)
	c.Store = store // Artifact privacy alone does not cover input files.
	requireCode(t, c.WriteInputAndVerify(ctx, target, p), "private_storage_required")
	requireCode(t, c.VerifyInput(ctx, key, 5, p.ContentHash()), "private_storage_required")
	_, err = c.OpenVerifiedInput(ctx, key, 5, p.ContentHash())
	requireCode(t, err, "private_storage_required")
	c.Store = privateInputStore{store}
	for _, invalid := range []string{strings.Replace(key, "input-versions", "artifact-versions", 1), key + "/child", strings.Replace(key, "/", "%2F", 1), "/" + key, key + ".txt"} {
		requireCode(t, c.VerifyInput(ctx, invalid, 5, p.ContentHash()), "invalid_payload")
		_, err := c.OpenVerifiedInput(ctx, invalid, 5, p.ContentHash())
		requireCode(t, err, "invalid_payload")
	}
	if store.uploads != 0 {
		t.Fatal("rejected storage received bytes")
	}
	// Preflight rejection did not consume the prepared spool.
	if err := c.WriteInputAndVerify(ctx, target, p); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareBytesRejectsChangedOrInvalidSourcesAndCleansPartialSpools(t *testing.T) {
	for _, scenario := range []string{"short", "long", "hash", "read_error", "over_limit", "negative", "invalid_hash", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			dir := t.TempDir()
			var reader io.Reader = strings.NewReader("fixed")
			size, hash := int64(5), ""
			ctx := context.Background()
			switch scenario {
			case "short":
				size++
			case "long":
				size--
			case "hash":
				hash = strings.Repeat("0", 64)
			case "read_error":
				reader = io.MultiReader(reader, brokenSource{})
			case "over_limit":
				size = MaxBytes + 1
			case "negative":
				size = -1
			case "invalid_hash":
				hash = "invalid"
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			prepared, err := PrepareBytes(ctx, reader, dir, size, hash)
			if err == nil || prepared != nil {
				if prepared != nil {
					prepared.Close()
				}
				t.Fatal("unconfirmed bytes returned a pin")
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("partial spool remains: %v %v", entries, err)
			}
		})
	}
}

type brokenSource struct{}

func (brokenSource) Read([]byte) (int, error) { return 0, errors.New("source disconnected") }
