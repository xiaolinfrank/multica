package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"reflect"
	"testing"

	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func inputUploadFixture(t *testing.T) (principalFixture, *IssueService, CockpitInputRead, *storage.LocalStorage) {
	t.Helper()
	f, s, p := inputWriteFixture(t)
	// Registered in dependency order: cleanup runs in reverse, before the head.
	f.Cleanup(t, "DELETE FROM cockpit_input_version WHERE workspace_id=$1", p.WorkspaceID)
	f.Cleanup(t, "DELETE FROM cockpit_input_transfer WHERE workspace_id=$1", p.WorkspaceID)
	f.Cleanup(t, "DELETE FROM cockpit_input_reference WHERE workspace_id=$1", p.WorkspaceID)
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	store := storage.NewLocalStorageFromEnv()
	if store == nil || !s.ConfigureCockpitInputStorage(store) {
		t.Fatal("owned private input storage unavailable")
	}
	return f, s, p, store
}

func inputSubmitUpload(t *testing.T, s *IssueService, p CockpitInputRead, content string) (CockpitInputQuery, CockpitInputVersionResult) {
	t.Helper()
	head, err := s.CreateCockpitInput(context.Background(), p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Raw field recording"})
	if err != nil {
		t.Fatal(err)
	}
	q := CockpitInputQuery{CockpitInputRead: p, InputID: inputTrustedID(head.Receipt.InputID)}
	size := int64(len(content))
	result, err := s.SubmitCockpitInputVersion(context.Background(), q, CockpitInputVersionSubmitInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: head.Receipt.InputRevision, Source: CockpitInputSourceInput{Kind: "upload", Upload: &CockpitInputUploadSource{Filename: "source.txt", ContentType: "text/plain", SizeBytes: &size}}})
	if err != nil || result.Receipt.TransferID == nil || result.Receipt.TransferRevision == nil || result.Current == nil || result.Transfer == nil {
		t.Fatalf("submit: %+v %v", result, err)
	}
	q.VersionID, q.TransferID = inputTrustedID(result.Receipt.VersionID), inputTrustedID(*result.Receipt.TransferID)
	return q, result
}

type inputCountReader struct {
	io.Reader
	reads int
}

func (r *inputCountReader) Read(p []byte) (int, error) { r.reads++; return r.Reader.Read(p) }

func TestCockpitInputUploadPinsBeforeStorageAndFinalizesExactAttempt(t *testing.T) {
	f, s, p, _ := inputUploadFixture(t)
	ctx := context.Background()
	content := " exact original bytes\n"
	q, initial := inputSubmitUpload(t, s, p, content)
	rejected := &inputCountReader{Reader: bytes.NewBufferString(content)}
	if _, err := s.UploadCockpitInputBytes(ctx, q, 99, rejected); inputErrorCode(err) != "revision_conflict" || rejected.reads != 0 {
		t.Fatalf("revision rejection read body: %d %v", rejected.reads, err)
	}
	up, err := s.UploadCockpitInputBytes(ctx, q, *initial.Receipt.TransferRevision, bytes.NewBufferString(content))
	if err != nil || up.Current == nil || up.Current.State != "awaiting_finalize" || !up.Current.CanFinalize {
		t.Fatalf("upload checkpoint: %+v %v", up, err)
	}
	hash := sha256.Sum256([]byte(content))
	sum := hex.EncodeToString(hash[:])
	before, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil || before.ContentHash.String != sum || before.ReadyAt.Valid || before.CurrentTransferID.Valid {
		t.Fatalf("pre-finalize pin: %+v %v", before, err)
	}
	command := CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: sum}
	final, err := s.FinalizeCockpitInputTransfer(ctx, q, command)
	if err != nil || final.Receipt.State != "verified" || final.Version == nil || final.Version.CaptureState != "ready" {
		t.Fatalf("finalize: %+v %v", final, err)
	}
	replay, err := s.FinalizeCockpitInputTransfer(ctx, q, command)
	if err != nil || !replay.Replayed || !reflect.DeepEqual(replay.Receipt, final.Receipt) {
		t.Fatalf("immutable finalize replay: %+v %v", replay, err)
	}
	_, reader, err := s.OpenCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || string(got) != content {
		t.Fatalf("verified bytes: %q %v %v", got, readErr, closeErr)
	}
	var tasks int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM agent_task_queue t JOIN agent a ON a.id=t.agent_id WHERE a.workspace_id=$1", p.WorkspaceID).Scan(&tasks); err != nil || tasks != 0 {
		t.Fatalf("input dispatched work: %d %v", tasks, err)
	}
}

func TestCockpitInputRestoreMatchingBytesPreservesFirstAcceptanceAndRejectsWrongFile(t *testing.T) {
	f, s, p, store := inputUploadFixture(t)
	ctx := context.Background()
	content := "fixed source bytes"
	q, initial := inputSubmitUpload(t, s, p, content)
	up, err := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	v, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: v.ContentHash.String})
	if err != nil {
		t.Fatal(err)
	}
	original, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.ReadCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.DeleteObject(ctx, file.StorageKey); err != nil {
		t.Fatal(err)
	}
	checked, err := s.VerifyCockpitInputVersion(ctx, q)
	if err != nil || checked.Availability != "checking" || checked.CaptureState != "ready" {
		t.Fatalf("verification was not scheduled: %+v %v", checked, err)
	}
	if worked, e := s.ProcessNextCockpitInputVerification(ctx); !worked || e == nil {
		t.Fatalf("missing copy was not verified asynchronously: %v %v", worked, e)
	}
	detail, e := s.GetCockpitInputVersion(ctx, q)
	if e != nil {
		t.Fatal(e)
	}
	checked = detail.Version
	if checked.Availability != "unavailable" || checked.CaptureState != "ready" {
		t.Fatalf("missing fixed copy: %+v %v", checked, err)
	}
	restart, err := s.RestartCockpitInputTransfer(ctx, q, CockpitInputRestartInput{Mode: "upload_matching_bytes", CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: checked.Revision, PreviousTransferID: initial.Receipt.TransferID})
	if err != nil {
		t.Fatal(err)
	}
	q.TransferID = inputTrustedID(restart.Receipt.TransferID)
	if _, err = s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString("wrong source bytes")); err == nil {
		t.Fatal("same-size wrong replacement was accepted")
	}
	failed, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil {
		t.Fatal(err)
	}
	previous := util.UUIDToString(q.TransferID)
	retry, err := s.RestartCockpitInputTransfer(ctx, q, CockpitInputRestartInput{Mode: "upload_matching_bytes", CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: failed.Revision, PreviousTransferID: &previous})
	if err != nil {
		t.Fatal(err)
	}
	q.TransferID = inputTrustedID(retry.Receipt.TransferID)
	up, err = s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: original.ContentHash.String})
	if err != nil {
		t.Fatal(err)
	}
	restored, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil || restored.ContentHash != original.ContentHash || restored.PinnedSizeBytes != original.PinnedSizeBytes || restored.ReadyAt != original.ReadyAt || restored.AcceptedTransferID != original.AcceptedTransferID || restored.CurrentTransferID != q.TransferID {
		t.Fatalf("restoration changed original history: %+v %v", restored, err)
	}
}

func TestCockpitInputSourceAttachmentCapturesWithoutCreatingAnArtifact(t *testing.T) {
	f, s, p, store := inputUploadFixture(t)
	ctx := context.Background()
	issue := parseTestUUID(t, f.Issue(t, "Source attachment task"))
	attachment := dbid.NewV7()
	data := []byte("source attachment")
	key := "workspaces/" + util.UUIDToString(p.WorkspaceID) + "/" + util.UUIDToString(attachment) + ".txt"
	url, err := store.Upload(ctx, key, data, "text/plain", "report.txt")
	if err != nil {
		t.Fatal(err)
	}
	f.Insert(t, "attachment", testutil.Cols{"id": attachment, "workspace_id": p.WorkspaceID, "issue_id": issue, "url": url, "filename": "report.txt", "content_type": "text/plain", "size_bytes": len(data), "uploader_type": "member", "uploader_id": p.CredentialOwnerID})
	head, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Existing source file"})
	if err != nil {
		t.Fatal(err)
	}
	q := CockpitInputQuery{CockpitInputRead: p, InputID: inputTrustedID(head.Receipt.InputID)}
	sub, err := s.SubmitCockpitInputVersion(ctx, q, CockpitInputVersionSubmitInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, Source: CockpitInputSourceInput{Kind: "attachment", Attachment: &CockpitInputAttachmentSource{IssueID: util.UUIDToString(issue), AttachmentID: util.UUIDToString(attachment)}}})
	if err != nil {
		t.Fatal(err)
	}
	worked, err := s.ProcessNextCockpitInputCapture(ctx)
	if err != nil || !worked {
		t.Fatalf("capture: %v %v", worked, err)
	}
	q.VersionID = inputTrustedID(sub.Receipt.VersionID)
	version, err := s.GetCockpitInputVersion(ctx, q)
	if err != nil || version.Version.CaptureState != "ready" || version.Version.Source.Issue == nil || version.Version.Source.Issue.ID != util.UUIDToString(issue) {
		t.Fatalf("captured typed source: %+v %v", version, err)
	}
	var artifacts int
	if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_artifact WHERE workspace_id=$1", p.WorkspaceID).Scan(&artifacts); err != nil || artifacts != 0 {
		t.Fatalf("capture manufactured an artifact: %d %v", artifacts, err)
	}
}

func TestCockpitInputMatchingRestorationReclaimsOnlySupersededOwnedBytes(t *testing.T) {
	f, s, p, store := inputUploadFixture(t)
	ctx := context.Background()
	content := "same fixed content"
	q, _ := inputSubmitUpload(t, s, p, content)
	up, err := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: *up.Current.ContentHash})
	if err != nil {
		t.Fatal(err)
	}
	original, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
	if err != nil {
		t.Fatal(err)
	}
	if r, e := store.GetReader(ctx, original.OwnedStorageKey); e != nil {
		t.Fatal(e)
	} else {
		_ = r.Close()
	}
	previous := util.UUIDToString(q.TransferID)
	restart, err := s.RestartCockpitInputTransfer(ctx, q, CockpitInputRestartInput{Mode: "upload_matching_bytes", CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: first.Version.Revision, PreviousTransferID: &previous})
	if err != nil {
		t.Fatal(err)
	}
	q.TransferID = inputTrustedID(restart.Receipt.TransferID)
	up, err = s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: *up.Current.ContentHash}); err != nil {
		t.Fatal(err)
	}
	worked, err := s.ProcessNextCockpitInputCleanup(ctx)
	if err != nil || !worked {
		t.Fatalf("superseded-copy cleanup: %v %v", worked, err)
	}
	if r, e := store.GetReader(ctx, original.OwnedStorageKey); e == nil {
		_ = r.Close()
		t.Fatal("superseded full copy accumulated indefinitely")
	}
	retained, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: original.ID})
	if err != nil || retained.State != "verified" || retained.CleanupState != "deleted" || !bytes.Equal(retained.FinalizeReceipt, original.FinalizeReceipt) {
		t.Fatalf("cleanup rewrote accepted history: %+v %v", retained, err)
	}
	v, err := f.q.GetCockpitInputVersion(ctx, db.GetCockpitInputVersionParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, ID: q.VersionID})
	if err != nil || v.AcceptedTransferID != original.ID || v.CurrentTransferID != q.TransferID {
		t.Fatalf("first/current pointer identities drifted: %+v %v", v, err)
	}
	_, reader, err := s.OpenCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || string(got) != content {
		t.Fatalf("cleanup removed current copy: %q %v %v", got, readErr, closeErr)
	}
}
