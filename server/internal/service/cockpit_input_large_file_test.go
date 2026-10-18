package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type inputLargePatternReader struct {
	remaining int64
	offset    int
	pattern   []byte
}

func (r *inputLargePatternReader) Read(dst []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if int64(len(dst)) > r.remaining {
		dst = dst[:r.remaining]
	}
	n := 0
	for n < len(dst) {
		copied := copy(dst[n:], r.pattern[r.offset:])
		n += copied
		r.offset = (r.offset + copied) % len(r.pattern)
	}
	r.remaining -= int64(n)
	return n, nil
}

// This acceptance test performs real 500 MiB local private-object I/O on agent3.
// It does not replace the separate Next HTTP or real NAS acceptance paths.
func TestCockpitInput500MiBStreamingAndSharedIOBudget(t *testing.T) {
	if os.Getenv("MULTICA_RUN_INPUT_LARGE_FILE") != "1" {
		t.Skip("set MULTICA_RUN_INPUT_LARGE_FILE=1 only in the exclusive agent3 test window")
	}
	f, s, p, local := inputUploadFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Minute)
	defer cancel()
	spoolDir := t.TempDir()
	s.CockpitInputCapturer.TempDir = spoolDir
	const size int64 = 500 << 20
	pattern := bytes.Repeat([]byte("fixed-input-acceptance\x00\xff\n"), 1024)
	stream := func() io.Reader { return &inputLargePatternReader{remaining: size, pattern: pattern} }
	digest := sha256.New()
	if n, err := io.Copy(digest, stream()); err != nil || n != size {
		t.Fatalf("expected fingerprint: %d %v", n, err)
	}
	hash := hex.EncodeToString(digest.Sum(nil))
	started := time.Now()
	host, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	report := map[string]any{"host": host, "workspace_id": util.UUIDToString(p.WorkspaceID), "size_bytes": size, "sha256": hash, "layer": "service + private local storage", "process_memory_measured": false, "http_or_real_nas": false, "passed": false}
	t.Cleanup(func() {
		report["elapsed_ms"] = float64(time.Since(started).Microseconds()) / 1000
		report["passed"] = !t.Failed()
		data, e := json.MarshalIndent(report, "", "  ")
		if e != nil {
			t.Error(e)
			return
		}
		t.Logf("input_large_acceptance=%s", data)
		if path := os.Getenv("MULTICA_INPUT_LARGE_REPORT"); path != "" {
			if e = os.WriteFile(path, append(data, '\n'), 0600); e != nil {
				t.Error(e)
			}
		}
	})
	assertSpools := func(count int, expectedBytes int64) {
		t.Helper()
		entries, e := os.ReadDir(spoolDir)
		if e != nil {
			t.Fatal(e)
		}
		var total int64
		for _, entry := range entries {
			info, e := entry.Info()
			if e != nil {
				t.Fatal(e)
			}
			if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
				t.Fatalf("nonprivate spool: %s %v", entry.Name(), info.Mode())
			}
			total += info.Size()
		}
		if len(entries) != count || total != expectedBytes {
			t.Fatalf("actual spools: files=%d bytes=%d want=%d/%d", len(entries), total, count, expectedBytes)
		}
	}
	head, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Owned 500 MiB acceptance input"})
	if err != nil {
		t.Fatal(err)
	}
	q := CockpitInputQuery{CockpitInputRead: p, InputID: inputTrustedID(head.Receipt.InputID)}
	declared := size
	sub, err := s.SubmitCockpitInputVersion(ctx, q, CockpitInputVersionSubmitInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, Source: CockpitInputSourceInput{Kind: "upload", Upload: &CockpitInputUploadSource{Filename: "owned-500-mib.bin", ContentType: "application/octet-stream", SizeBytes: &declared, ClientSHA256: &hash}}})
	if err != nil || sub.Receipt.TransferID == nil {
		t.Fatalf("large input intent: %+v %v", sub, err)
	}
	q.VersionID, q.TransferID = inputTrustedID(sub.Receipt.VersionID), inputTrustedID(*sub.Receipt.TransferID)
	uploadStart := time.Now()
	up, err := s.UploadCockpitInputBytes(ctx, q, 1, stream())
	if err != nil || up.Current == nil || up.Current.State != "awaiting_finalize" || up.Current.ReceivedBytes == nil || *up.Current.ReceivedBytes != size {
		t.Fatalf("large upload: %+v %v", up, err)
	}
	report["upload_ms"] = float64(time.Since(uploadStart).Microseconds()) / 1000
	assertSpools(0, 0)
	final, err := s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: hash})
	if err != nil || final.Version == nil || final.Version.SizeBytes == nil || *final.Version.SizeBytes != size || final.Version.ContentHash == nil || *final.Version.ContentHash != hash {
		t.Fatalf("fixed large pin: %+v %v", final, err)
	}
	pending, _ := inputSubmitUpload(t, s, p, "x")
	readctx, stopRead := context.WithCancel(ctx)
	defer stopRead()
	_, first, err := s.OpenCockpitInputFile(readctx, q)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	_, second, err := s.OpenCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	assertSpools(2, 2*size)
	report["peak_observed_spool_files"], report["peak_observed_spool_bytes"] = 2, 2*size
	downloadHash := sha256.New()
	if n, e := io.Copy(downloadHash, first); e != nil || n != size || hex.EncodeToString(downloadHash.Sum(nil)) != hash {
		t.Fatalf("verified download: bytes=%d hash=%x err=%v", n, downloadHash.Sum(nil), e)
	}
	report["download_bytes"] = size
	if _, reader, e := s.OpenCockpitInputFile(ctx, q); inputErrorCode(e) != "input_io_busy" || reader != nil {
		if reader != nil {
			_ = reader.Close()
		}
		t.Fatalf("third download escaped budget: %v", e)
	}
	body := &inputCountReader{Reader: bytes.NewBufferString("x")}
	if _, e := s.UploadCockpitInputBytes(ctx, pending, 1, body); inputErrorCode(e) != "input_io_busy" || body.reads != 0 {
		t.Fatalf("third direct upload read bytes despite shared budget: reads=%d err=%v", body.reads, e)
	}
	if got, e := s.GetCockpitInputTransfer(ctx, pending); e != nil || got.State != "awaiting_bytes" || got.Revision != 1 {
		t.Fatalf("busy request mutated the original attempt: %+v %v", got, e)
	}
	if _, e := s.GetCockpitInput(ctx, q); e != nil {
		t.Fatalf("bounded metadata blocked behind file capacity: %v", e)
	}
	stopRead()
	if _, e := first.Read(make([]byte, 1)); !errors.Is(e, context.Canceled) {
		t.Fatalf("cancelled reader remained readable: %v", e)
	}
	if _, reader, e := s.OpenCockpitInputFile(ctx, q); inputErrorCode(e) != "input_io_busy" || reader != nil {
		if reader != nil {
			_ = reader.Close()
		}
		t.Fatalf("cancellation released a still-owned spool: %v", e)
	}
	assertSpools(2, 2*size)
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	assertSpools(1, size)
	if recovered, e := s.UploadCockpitInputBytes(ctx, pending, 1, bytes.NewBufferString("x")); e != nil || recovered.Current == nil || recovered.Current.State != "awaiting_finalize" {
		t.Fatalf("capacity did not recover after actual Close: %+v %v", recovered, e)
	}
	if err = second.Close(); err != nil {
		t.Fatal(err)
	}
	assertSpools(0, 0)
	report["cancel_requires_close"], report["third_upload_body_reads"], report["spool_files_after_close"] = true, body.reads, 0
	file, err := s.ReadCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	qt := f.q.WithTx(tx)
	if err = qt.SetWorkspaceTeardownMode(ctx); err == nil {
		err = DeleteCockpitInputsForWorkspace(ctx, qt, p.WorkspaceID)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Expedite only these owned cleanup intents; the production worker still
	// performs its normal exact-key ownership/current-copy checks and deletion.
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_input_transfer SET cleanup_due_at=now() WHERE workspace_id=$1", p.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if worked, e := s.ProcessNextCockpitInputCleanup(ctx); e != nil || !worked {
			t.Fatalf("owned object cleanup %d: %v %v", i, worked, e)
		}
	}
	var deleted, remainingHeaders, remainingVersions int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input_transfer WHERE workspace_id=$1 AND cleanup_state='deleted'", p.WorkspaceID).Scan(&deleted); err != nil || deleted != 2 {
		t.Fatalf("cleanup facts: %d %v", deleted, err)
	}
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input WHERE workspace_id=$1", p.WorkspaceID).Scan(&remainingHeaders); err != nil || remainingHeaders != 0 {
		t.Fatalf("input headers after teardown: %d %v", remainingHeaders, err)
	}
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input_version WHERE workspace_id=$1", p.WorkspaceID).Scan(&remainingVersions); err != nil || remainingVersions != 0 {
		t.Fatalf("versions after teardown: %d %v", remainingVersions, err)
	}
	if reader, e := local.GetReader(ctx, file.StorageKey); e == nil {
		_ = reader.Close()
		t.Fatal("the 500 MiB owned object survived worker cleanup")
	}
	var storedFiles, storedBytes int64
	if err = filepath.WalkDir(os.Getenv("LOCAL_UPLOAD_DIR"), func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		storedFiles++
		storedBytes += info.Size()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if storedFiles != 0 || storedBytes != 0 {
		t.Fatalf("owned private objects remain: files=%d bytes=%d", storedFiles, storedBytes)
	}
	report["worker_deleted_owned_objects"], report["owned_storage_files_after_cleanup"], report["owned_storage_bytes_after_cleanup"] = deleted, storedFiles, storedBytes
	report["domain_headers_after_teardown"], report["domain_versions_after_teardown"], report["cleanup_tombstones_before_fixture_cleanup"] = remainingHeaders, remainingVersions, deleted
	var runs int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1", p.WorkspaceID).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("unexpected run creation: %d %v", runs, err)
	}
	report["agent_runs_created"] = runs
	assertSpools(0, 0)
}
