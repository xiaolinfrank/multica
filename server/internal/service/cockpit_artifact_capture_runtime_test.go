package service

import (
	"bytes"
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"io"
	"strings"
	"sync"
	"testing"
)

type artifactMemoryStore struct {
	mu          sync.Mutex
	objects     map[string][]byte
	unavailable bool
	onUpload    func(string)
}

func (s *artifactMemoryStore) SupportsPrivateArtifactFiles() bool { return true }

func (s *artifactMemoryStore) GetReader(_ context.Context, key string) (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable {
		return nil, errors.New("fixture storage unavailable")
	}
	b, ok := s.objects[key]
	if !ok {
		return nil, errors.New("fixture object missing")
	}
	return io.NopCloser(bytes.NewReader(append([]byte(nil), b...))), nil
}
func (s *artifactMemoryStore) Upload(ctx context.Context, key string, b []byte, kind, name string) (string, error) {
	return s.UploadStream(ctx, key, bytes.NewReader(b), int64(len(b)), kind, name)
}
func (s *artifactMemoryStore) UploadStream(_ context.Context, key string, r io.Reader, _ int64, _, _ string) (string, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	if s.onUpload != nil {
		s.onUpload(key)
	}
	s.mu.Lock()
	s.objects[key] = data
	s.mu.Unlock()
	return s.ObjectURL(key), nil
}
func (s *artifactMemoryStore) Delete(ctx context.Context, key string) { _ = s.DeleteObject(ctx, key) }
func (s *artifactMemoryStore) DeleteObject(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unavailable {
		return errors.New("fixture delete unavailable")
	}
	delete(s.objects, key)
	return nil
}
func (s *artifactMemoryStore) DeleteKeys(ctx context.Context, keys []string) {
	for _, key := range keys {
		s.Delete(ctx, key)
	}
}
func (s *artifactMemoryStore) KeyFromURL(url string) string {
	return strings.TrimPrefix(url, "https://artifact.fixture/")
}
func (s *artifactMemoryStore) ObjectURL(key string) string { return "https://artifact.fixture/" + key }
func (s *artifactMemoryStore) CdnDomain() string           { return "https://artifact.fixture/" }
func (f artifactFixture) fileSubmission(t *testing.T, store *artifactMemoryStore) (pgtype.UUID, string) {
	t.Helper()
	f.issues.CockpitArtifactStorage = store
	f.issues.CockpitArtifactCapturer = &artifactcapture.Capturer{Store: store, TempDir: t.TempDir()}
	key := "attachments/" + util.UUIDToString(dbid.NewV7()) + ".txt"
	body := []byte("Fixed evidence bytes\n")
	store.objects[key] = body
	attachment := f.Insert(t, "attachment", testutil.Cols{"workspace_id": f.ws, "issue_id": f.producer, "uploader_type": "member", "uploader_id": f.owner, "filename": "evidence.txt", "url": store.ObjectURL(key), "content_type": "text/plain", "size_bytes": len(body)})
	in := f.submission(t, "unused")
	in.Payload = CockpitArtifactPayload{Kind: "attachment", AttachmentID: &attachment}
	id, err := f.issues.SubmitCockpitArtifactVersion(context.Background(), in, IssueCreateOpts{})
	if err != nil {
		t.Fatal(err)
	}
	return id, key
}
func TestCockpitArtifactRuntimeFileCaptureReviewAndMissingContentRecovery(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	store := &artifactMemoryStore{objects: map[string][]byte{}}
	version, _ := f.fileSubmission(t, store)
	before, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || before.ReviewIssueID.Valid || before.CaptureStatus != "queued" {
		t.Fatalf("file pretended ready before capture: %+v %v", before, err)
	}
	page, err := f.issues.ListCockpitArtifacts(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, Status: "capturing", Human: true})
	if err != nil || page.FilteredTotal != 1 || len(page.Items) != 1 || page.Items[0].Status != "capturing" {
		t.Fatalf("capture lifecycle did not match header filter: %+v %v", page, err)
	}
	processed, err := f.issues.ProcessNextCockpitArtifactCapture(ctx)
	if err != nil || !processed {
		t.Fatalf("capture failed: %v", err)
	}
	v, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || v.CaptureStatus != "ready" || !v.ReviewIssueID.Valid {
		t.Fatalf("capture did not atomically publish review: %+v %v", v, err)
	}
	_ = store.DeleteObject(ctx, v.StorageKey.String)
	detail, err := f.issues.GetCockpitArtifactVersion(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, VersionID: v.ID, Human: true})
	if err != nil || detail.ContentAvailable || !detail.Version.CanReview {
		t.Fatalf("missing content stranded formal recovery authority: %+v %v", detail, err)
	}
	command := CockpitArtifactReview{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: v.Revision, Human: true}, VersionID: v.ID, Decision: "approved"}
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, command); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("missing bytes were approved: %v", err)
	}
	command.Decision = "changes_requested"
	command.Feedback = "The fixed copy is unavailable; upload a replacement."
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, command); err != nil {
		t.Fatal(err)
	}
	if !f.artifactHeader(t).CanSubmit {
		t.Fatal("formal rejection did not reopen submission")
	}
}
func TestCockpitArtifactRuntimeCaptureReusesVerifiedCopyAfterReviewerRecovery(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	reviewer := f.User(t, "file reviewer", "file-reviewer-"+util.UUIDToString(dbid.NewV7())+"@multica.test")
	memberID := f.Member(t, f.WorkspaceID, reviewer, "member")
	reviewerID := parseTestUUID(t, reviewer)
	handoff := CockpitArtifactReviewerCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: f.artifactHeader(t).Revision, Human: true}, HandoffKey: dbid.NewV7(), ReviewerID: reviewerID, Reason: "Assign the file review"}
	if _, err := f.issues.ReassignCockpitArtifactReviewer(ctx, handoff, IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	store := &artifactMemoryStore{objects: map[string][]byte{}}
	version, source := f.fileSubmission(t, store)
	if _, err := f.Pool.Exec(ctx, "DELETE FROM member WHERE id=$1", parseTestUUID(t, memberID)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.issues.ProcessNextCockpitArtifactCapture(ctx); err != nil {
		t.Fatal(err)
	}
	v, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || v.CaptureStatus != "needs_attention" || v.ReviewIssueID.Valid {
		t.Fatalf("departed reviewer incorrectly got a formal task: %+v %v", v, err)
	}
	handoff.ExpectedRevision = f.artifactHeader(t).Revision
	handoff.ReviewerID = f.owner
	handoff.HandoffKey = dbid.NewV7()
	handoff.Reason = "Recover departed reviewer responsibility"
	result, err := f.issues.ReassignCockpitArtifactReviewer(ctx, handoff, IssueCreateOpts{})
	if err != nil || result.Handoff.VersionID == nil || result.Handoff.FromReviewIssueID != nil || result.Handoff.ToReviewIssueID != nil {
		t.Fatalf("pre-review handoff lost the fixed version: %+v %v", result, err)
	}
	_ = store.DeleteObject(ctx, source)
	v, err = f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.issues.RetryCockpitArtifactCapture(ctx, CockpitArtifactCaptureRetry{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, ExpectedRevision: v.Revision, Human: true}, VersionID: v.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.issues.ProcessNextCockpitArtifactCapture(ctx); err != nil {
		t.Fatal(err)
	}
	v, err = f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || v.CaptureStatus != "ready" || v.ReviewerID != f.owner || !v.ReviewIssueID.Valid {
		t.Fatalf("verified bytes were lost after source deletion: %+v %v", v, err)
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_artifact_capture_attempt WHERE workspace_id=$1", f.ws) != 1 {
		t.Fatal("recovery unnecessarily reread and recopied the deleted source")
	}
}

func TestCockpitArtifactRuntimeDeletionRetainsLateUploadCleanup(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	// The cleanup worker claims globally. Keep retained attempts from earlier
	// test runs out of this in-memory provider without changing their history.
	isolation, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer isolation.Rollback(ctx)
	rows, err := isolation.Query(ctx, "SELECT id FROM cockpit_artifact_capture_attempt WHERE workspace_id<>$1 FOR UPDATE", f.ws)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	entered := make(chan string, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	defer unblock()
	store := &artifactMemoryStore{objects: map[string][]byte{}, onUpload: func(key string) { entered <- key; <-release }}
	_, _ = f.fileSubmission(t, store)
	done := make(chan error, 1)
	go func() { _, err := f.issues.ProcessNextCockpitArtifactCapture(ctx); done <- err }()
	key := <-entered
	if err := f.q.DeleteCockpitArtifactsByWorkspace(ctx, f.ws); err != nil {
		t.Fatal(err)
	}
	if processed, err := f.issues.ProcessNextCockpitArtifactObjectCleanup(ctx); err != nil || processed {
		t.Fatalf("unfinished I/O falsely claimed cleaned: %v %v", processed, err)
	}
	unblock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if count := f.Count(t, "SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1", f.ws); count != 0 {
		t.Fatal("late completion resurrected a deleted version")
	}
	if processed, err := f.issues.ProcessNextCockpitArtifactObjectCleanup(ctx); err != nil || !processed {
		t.Fatalf("late object did not retain cleanup owner: %v %v", processed, err)
	}
	if _, err := store.GetReader(ctx, key); err == nil {
		t.Fatal("late object survived cleanup")
	}
	if count := f.Count(t, "SELECT count(*) FROM cockpit_artifact_capture_attempt WHERE workspace_id=$1 AND cleanup_status='deleted'", f.ws); count != 1 {
		t.Fatal("cleanup discarded the late-write tombstone")
	}
	store.onUpload = nil
	if _, err := store.Upload(ctx, key, []byte("provider finished even later"), "text/plain", "evidence.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Pool.Exec(ctx, "UPDATE cockpit_artifact_capture_attempt SET cleanup_next_attempt_at=now() WHERE workspace_id=$1", f.ws); err != nil {
		t.Fatal(err)
	}
	if processed, err := f.issues.ProcessNextCockpitArtifactObjectCleanup(ctx); err != nil || !processed {
		t.Fatalf("deleted tombstone did not reconcile provider ambiguity: %v %v", processed, err)
	}
	if _, err := store.GetReader(ctx, key); err == nil {
		t.Fatal("reconciliation missed an ambiguously late provider object")
	}
}

type artifactPublicStore struct{ *artifactMemoryStore }

func (s *artifactPublicStore) SupportsPrivateArtifactFiles() bool { return false }
func TestCockpitArtifactRuntimePrivateStorageFailureDoesNotStrandQueuedVersion(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	store := &artifactMemoryStore{objects: map[string][]byte{}}
	version, _ := f.fileSubmission(t, store)
	queued, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil {
		t.Fatal(err)
	}
	f.issues.ConfigureCockpitArtifactStorage(&artifactPublicStore{store})
	header := f.artifactHeader(t)
	if header.FileCaptureAvailable || header.FileCaptureUnavailableReason != "private_storage_required" {
		t.Fatalf("public storage pretended eligible: %+v", header)
	}
	attachment := util.UUIDToString(queued.SourceAttachmentID)
	replay := CockpitArtifactSubmission{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: 1}, SubmissionKey: queued.SubmissionKey, ProducerIssueID: f.producer, ActorType: "member", AuthorID: f.owner, Payload: CockpitArtifactPayload{Kind: "attachment", AttachmentID: &attachment}}
	if id, e := f.issues.SubmitCockpitArtifactVersion(ctx, replay, IssueCreateOpts{}); e != nil || id != version {
		t.Fatalf("private storage gate hid an existing submission receipt: %v", e)
	}
	if processed, e := f.issues.ProcessNextCockpitArtifactCapture(ctx); e != nil || !processed {
		t.Fatalf("configuration loss did not settle its queued job: %v %v", processed, e)
	}
	failed, err := f.q.GetCockpitArtifactVersion(ctx, db.GetCockpitArtifactVersionParams{WorkspaceID: f.ws, ArtifactID: f.artifact, ID: version})
	if err != nil || failed.CaptureStatus != "needs_attention" || failed.CaptureErrorCode != "private_storage_required" || failed.ReviewIssueID.Valid {
		t.Fatalf("unsupported storage fabricated a captured version: %+v %v", failed, err)
	}
	if f.Count(t, "SELECT count(*) FROM cockpit_artifact_capture_attempt WHERE workspace_id=$1", f.ws) != 0 {
		t.Fatal("unsupported storage fabricated an I/O attempt")
	}
	if err = f.issues.RetryCockpitArtifactCapture(ctx, CockpitArtifactCaptureRetry{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: failed.Revision}, VersionID: version}); !errors.Is(err, ErrCockpitArtifactPrivateStorageRequired) {
		t.Fatalf("retry silently accepted public storage: %v", err)
	}
	newer := replay
	newer.SubmissionKey = dbid.NewV7()
	newer.ExpectedRevision = f.artifactHeader(t).Revision
	if _, err = f.issues.SubmitCockpitArtifactVersion(ctx, newer, IssueCreateOpts{}); !errors.Is(err, ErrCockpitArtifactPrivateStorageRequired) {
		t.Fatalf("new file submission accepted public storage: %v", err)
	}
	if !f.artifactHeader(t).CanSubmit {
		t.Fatal("failed file capture prevented an explicit replacement")
	}
	if _, err = f.issues.SubmitCockpitArtifactVersion(ctx, f.submission(t, "Explicit replacement text"), IssueCreateOpts{}); err != nil {
		t.Fatalf("private file policy disabled text: %v", err)
	}
}
