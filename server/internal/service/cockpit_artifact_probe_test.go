package service

import (
	"bytes"
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/artifactcapture"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"io"
	"testing"
	"time"
)

type artifactProbeStore struct {
	artifactMemoryStore
	fastKey   string
	deadlines []time.Time
	closed    int
}
type artifactProbeReader struct {
	ctx    context.Context
	read   io.Reader
	closed *int
}

func (r *artifactProbeReader) Read(b []byte) (int, error) {
	if r.read != nil {
		return r.read.Read(b)
	}
	<-r.ctx.Done()
	return 0, r.ctx.Err()
}
func (r *artifactProbeReader) Close() error { *r.closed++; return nil }
func (s *artifactProbeStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	deadline, _ := ctx.Deadline()
	s.deadlines = append(s.deadlines, deadline)
	r := &artifactProbeReader{ctx: ctx, closed: &s.closed}
	if key == s.fastKey {
		r.read = bytes.NewReader([]byte("evidence"))
	}
	return r, nil
}
func TestCockpitArtifactProbeSharesOneDeadlineAndClosesReaders(t *testing.T) {
	store := &artifactProbeStore{fastKey: "first"}
	svc := &IssueService{CockpitArtifactCapturer: &artifactcapture.Capturer{Store: store}, artifactProbeTimeout: 20 * time.Millisecond}
	rows := []db.ListCockpitAcceptanceVersionSourcesRow{}
	for _, key := range []string{"first", "second", "third"} {
		rows = append(rows, db.ListCockpitAcceptanceVersionSourcesRow{PayloadKind: "attachment", CaptureStatus: "ready", StorageKey: pgtype.Text{String: key, Valid: true}, SizeBytes: pgtype.Int8{Int64: 8, Valid: true}, ContentHash: pgtype.Text{String: minutesContentHash("evidence"), Valid: true}})
	}
	if err := svc.probeAcceptanceSources(context.Background(), rows); !errors.Is(err, ErrCockpitArtifactVerificationTimeout) {
		t.Fatalf("whole evidence probe did not return its stable timeout: %v", err)
	}
	if len(store.deadlines) != 2 || !store.deadlines[0].Equal(store.deadlines[1]) || store.deadlines[0].IsZero() || store.closed != 2 {
		t.Fatalf("deadline restarted per file or reader leaked: deadlines=%v closed=%d", store.deadlines, store.closed)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := svc.probeAcceptanceSources(ctx, rows); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled verification misreported a conclusion: %v", err)
	}
	if len(store.deadlines) != 2 {
		t.Fatal("cancelled request touched storage")
	}
}
func TestCockpitArtifactRuntimeProbeTimeoutPreservesReviewRecovery(t *testing.T) {
	f := newArtifactFixture(t)
	ctx := context.Background()
	store := &artifactMemoryStore{objects: map[string][]byte{}}
	version, _ := f.fileSubmission(t, store)
	if _, err := f.issues.ProcessNextCockpitArtifactCapture(ctx); err != nil {
		t.Fatal(err)
	}
	blocked := &artifactProbeStore{}
	f.issues.CockpitArtifactCapturer = &artifactcapture.Capturer{Store: blocked}
	f.issues.artifactProbeTimeout = 20 * time.Millisecond
	detail, err := f.issues.GetCockpitArtifactVersion(ctx, CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, VersionID: version, Human: true})
	if err != nil || detail.ContentAvailable || detail.ContentUnavailableReason != "verification_timeout" || !detail.Version.CanReview {
		t.Fatalf("timeout destroyed a recoverable review: %+v %v", detail, err)
	}
	cmd := CockpitArtifactReview{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, ExpectedRevision: detail.Version.Revision}, VersionID: version, Decision: "approved"}
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, cmd); !errors.Is(err, ErrCockpitArtifactVerificationTimeout) {
		t.Fatalf("approval accepted unverifiable content: %v", err)
	}
	calls := len(blocked.deadlines)
	cmd.Decision = "changes_requested"
	cmd.Feedback = "Storage verification timed out; supply a recoverable fixed copy."
	if err = f.issues.ReviewCockpitArtifactVersion(ctx, cmd); err != nil {
		t.Fatal(err)
	}
	if len(blocked.deadlines) != calls {
		t.Fatal("formal return unnecessarily re-probed unavailable content")
	}
	if blocked.closed != calls {
		t.Fatal("timed-out readers were not released")
	}
}
