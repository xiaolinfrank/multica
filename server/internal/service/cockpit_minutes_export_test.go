package service

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// This adapter is entirely in memory: service regressions never touch NAS or
// invoke an Agent. Filesystem correctness belongs to cockpitnas's own tests.
type fakeMinutesExporter struct {
	mu         sync.Mutex
	rootPath   string
	rootIDs    []string
	resolveErr error
	write      func(context.Context, cockpitnas.Request) (cockpitnas.Result, error)
	requests   []cockpitnas.Request
	writeCount atomic.Int32
}

const exportFixtureRootID = "019f06d9-3020-7000-8000-000000000001"

func (e *fakeMinutesExporter) RootIDs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.rootIDs != nil {
		return append([]string(nil), e.rootIDs...)
	}
	return []string{exportFixtureRootID}
}

func (e *fakeMinutesExporter) Preview(_ string, directory string) (cockpitnas.Directory, error) {
	return cockpitnas.Directory{RootID: exportFixtureRootID, Directory: directory}, nil
}
func (e *fakeMinutesExporter) Resolve(_ string, directory, version string, number int32) (cockpitnas.Destination, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.resolveErr != nil {
		return cockpitnas.Destination{}, e.resolveErr
	}
	if !strings.HasPrefix(directory, "/test-nas/") {
		return cockpitnas.Destination{}, &cockpitnas.Error{Code: "outside_root", Message: "outside configured NAS root"}
	}
	root := e.rootPath
	if root == "" {
		root = "/test-nas"
	}
	rel := filepath.Join(strings.TrimPrefix(directory, "/test-nas/"), "已发布纪要", fmt.Sprintf("minutes-v%04d-%s.md", number, version))
	return cockpitnas.Destination{RootID: exportFixtureRootID, RootPath: root, Directory: directory, RelativePath: rel, TargetPath: filepath.Join(root, rel)}, nil
}
func (e *fakeMinutesExporter) Write(ctx context.Context, req cockpitnas.Request) (cockpitnas.Result, error) {
	e.writeCount.Add(1)
	e.mu.Lock()
	e.requests = append(e.requests, req)
	write := e.write
	e.mu.Unlock()
	if write != nil {
		return write(ctx, req)
	}
	return fakeMinutesExportResult(req), nil
}
func fakeMinutesExportResult(req cockpitnas.Request) cockpitnas.Result {
	return cockpitnas.Result{Path: req.Destination.TargetPath, ContentHash: req.ContentHash, Size: int64(len([]byte(req.Content)))}
}
func (e *fakeMinutesExporter) setWrite(write func(context.Context, cockpitnas.Request) (cockpitnas.Result, error)) {
	e.mu.Lock()
	e.write = write
	e.mu.Unlock()
}
func newMinutesExportFixture(t *testing.T) (cockpitWorkflowFixture, db.CockpitMinutesVersion, *fakeMinutesExporter) {
	t.Helper()
	f := newCockpitWorkflowFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_minutes_export WHERE workspace_id=$1", f.ws)
	f.Exec(t, "UPDATE cockpit_meeting SET nas_dir='/test-nas/meeting' WHERE id=$1", f.meeting)
	v, _ := prepareHandoffPending(t, f)
	if err := f.issues.ReviewCockpitMeetingMinutes(context.Background(), CockpitMinutesReview{
		CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: v.ID}, Decision: "approved",
	}); err != nil {
		t.Fatal(err)
	}
	v = f.versions(t)[0]
	e := &fakeMinutesExporter{}
	f.issues.CockpitNASExporter = e
	return f, v, e
}
func exportFixtureTarget() CockpitMinutesExportTarget {
	return CockpitMinutesExportTarget{RootID: exportFixtureRootID, Directory: "/test-nas/meeting"}
}
func publishMinutesExportFixture(t *testing.T, f cockpitWorkflowFixture, version db.CockpitMinutesVersion) db.CockpitMinutesExport {
	t.Helper()
	target := exportFixtureTarget()
	if err := f.issues.PublishCockpitMeetingMinutes(context.Background(), CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID, NASExport: &target}); err != nil {
		t.Fatal(err)
	}
	rows, err := f.q.ListCockpitMinutesExports(context.Background(), db.ListCockpitMinutesExportsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if err != nil || len(rows) != 1 {
		t.Fatalf("exports = %d, error=%v", len(rows), err)
	}
	return rows[0]
}
func getMinutesExportFixture(t *testing.T, f cockpitWorkflowFixture, id pgtype.UUID) db.CockpitMinutesExport {
	t.Helper()
	row, err := f.q.GetCockpitMinutesExport(context.Background(), db.GetCockpitMinutesExportParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: id})
	if err != nil {
		t.Fatal(err)
	}
	return row
}
func processMinutesExportFixture(t *testing.T, worker *CockpitMinutesExportWorker) {
	t.Helper()
	if worked, err := worker.ProcessNext(context.Background()); err != nil || !worked {
		t.Fatalf("worker processed=%v error=%v", worked, err)
	}
}

func TestCockpitMinutesExportPublishAtomicAndOffline(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	before := f.work(t)
	invalid := exportFixtureTarget()
	invalid.Directory = "/outside/meeting"
	cmd := CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID, NASExport: &invalid}
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, cmd); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("invalid destination = %v", err)
	}
	if f.work(t).Revision != before.Revision || f.work(t).PublishedVersionID.Valid || f.versions(t)[0].PublishedAt.Valid {
		t.Fatal("invalid export left publication changes committed")
	}
	row := publishMinutesExportFixture(t, f, version)
	if row.Status != "queued" || row.Attempts != 0 || row.CycleAttempts != 0 || row.VersionID != version.ID || row.ContentHash != version.ContentHash || row.SourceIssueID != version.SourceIssueID {
		t.Fatalf("queued intent = %+v", row)
	}
	if exporter.writeCount.Load() != 0 || !f.versions(t)[0].PublishedAt.Valid {
		t.Fatal("publication performed I/O or failed to persist independently")
	}
	// A retry with the original pre-publication revision acknowledges the
	// existing publication and exact destination without creating another row.
	target := exportFixtureTarget()
	cmd.NASExport = &target
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, cmd); err != nil {
		t.Fatalf("publish replay: %v", err)
	}
	rows, _ := f.q.ListCockpitMinutesExports(ctx, db.ListCockpitMinutesExportsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if len(rows) != 1 || rows[0].ID != row.ID {
		t.Fatal("publication retry duplicated export intent")
	}
	exporter.setWrite(func(context.Context, cockpitnas.Request) (cockpitnas.Result, error) {
		return cockpitnas.Result{}, &cockpitnas.Error{Code: "root_offline", Message: "NAS is offline", Retryable: true}
	})
	processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
	row = getMinutesExportFixture(t, f, row.ID)
	if row.Status != "retry_wait" || !row.NextRetryAt.Valid || row.LastErrorCode != "root_offline" || !f.versions(t)[0].PublishedAt.Valid || f.versions(t)[0].Decision != "approved" {
		t.Fatal("offline mirror lost publication or recoverable intent")
	}
}

func TestCockpitMinutesExportConcurrentDedupAndHistoricalVersion(t *testing.T) {
	f, version, _ := newMinutesExportFixture(t)
	ctx := context.Background()
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}); err != nil {
		t.Fatal(err)
	}
	// A later unreviewed version must not invalidate export of the old approved
	// publication, nor make the new content exportable without review.
	newVersion, _ := submitHandoffFixtureVersion(t, f)
	in := CockpitMinutesExportCommand{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Target: exportFixtureTarget()}
	var wg sync.WaitGroup
	rows := make(chan db.CockpitMinutesExport, 4)
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			row, err := f.issues.ExportCockpitMeetingMinutes(ctx, in)
			rows <- row
			errs <- err
		}()
	}
	wg.Wait()
	close(rows)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id pgtype.UUID
	for row := range rows {
		if id.Valid && row.ID != id {
			t.Fatal("concurrent export requests produced different operations")
		}
		id = row.ID
	}
	in.VersionID = newVersion.ID
	if _, err := f.issues.ExportCockpitMeetingMinutes(ctx, in); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("pending version export = %v", err)
	}
	in.VersionID = version.ID
	in.ActorID = parseTestUUID(t, f.member(t, "ordinary-export-member"))
	if _, err := f.issues.ExportCockpitMeetingMinutes(ctx, in); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("ordinary member export = %v", err)
	}
	in.ActorID = f.owner
	in.WorkspaceID = dbid.NewV7()
	if _, err := f.issues.ExportCockpitMeetingMinutes(ctx, in); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("cross-workspace export = %v", err)
	}
}

func TestCockpitMinutesExportNewIntentRequiresCurrentMeetingDirectory(t *testing.T) {
	f, version, _ := newMinutesExportFixture(t)
	ctx := context.Background()
	old := publishMinutesExportFixture(t, f, version)
	f.Exec(t, "UPDATE cockpit_meeting SET nas_dir='/test-nas/moved-meeting' WHERE id=$1", f.meeting)
	in := CockpitMinutesExportCommand{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Target: exportFixtureTarget()}
	replayed, err := f.issues.ExportCockpitMeetingMinutes(ctx, in)
	if err != nil || replayed.ID != old.ID || replayed.Directory != old.Directory {
		t.Fatalf("pinned old intent was not replayed: %+v/%v", replayed, err)
	}
	in.Target.Directory = "/test-nas/unconfirmed-directory"
	if _, err := f.issues.ExportCockpitMeetingMinutes(ctx, in); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("new unconfirmed destination accepted: %v", err)
	}
	in.Target.Directory = "/test-nas/moved-meeting"
	newIntent, err := f.issues.ExportCockpitMeetingMinutes(ctx, in)
	if err != nil || newIntent.ID == old.ID || newIntent.Directory != in.Target.Directory {
		t.Fatalf("confirmed new intent = %+v/%v", newIntent, err)
	}
	if getMinutesExportFixture(t, f, old.ID).TargetPath != old.TargetPath {
		t.Fatal("directory change retargeted the old operation")
	}
}

func TestCockpitMinutesExportRetryBudgetAndSuccess(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	row := publishMinutesExportFixture(t, f, version)
	exporter.setWrite(func(context.Context, cockpitnas.Request) (cockpitnas.Result, error) {
		return cockpitnas.Result{}, &cockpitnas.Error{Code: "root_offline", Message: "offline", Retryable: true}
	})
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	for attempt := int32(1); attempt <= 8; attempt++ {
		processMinutesExportFixture(t, worker)
		row = getMinutesExportFixture(t, f, row.ID)
		if row.Attempts != attempt || row.CycleAttempts != attempt {
			t.Fatalf("attempt counts = %d/%d want %d", row.Attempts, row.CycleAttempts, attempt)
		}
		if attempt < 8 {
			if row.Status != "retry_wait" || !row.NextRetryAt.Time.After(row.UpdatedAt.Time) || row.NextRetryAt.Time.Sub(row.UpdatedAt.Time) > 5*time.Minute {
				t.Fatal("retry backoff missing or exceeds cap")
			}
			f.Exec(t, "UPDATE cockpit_minutes_export SET next_retry_at=now()-interval '1 second' WHERE id=$1", row.ID)
		}
	}
	if row.Status != "needs_attention" || row.NextRetryAt.Valid || exporter.writeCount.Load() != 8 {
		t.Fatal("eight failures did not stop automatic attempts")
	}
	if worked, err := worker.ProcessNext(ctx); worked || err != nil {
		t.Fatalf("ninth automatic attempt: %v/%v", worked, err)
	}
	retry := CockpitMinutesExportRetry{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: row.ID, ActorID: f.owner, ExpectedRevision: row.Revision - 1}
	if _, err := f.issues.RetryCockpitMinutesExport(ctx, retry); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("stale retry = %v", err)
	}
	retry.ExpectedRevision = row.Revision
	queued, err := f.issues.RetryCockpitMinutesExport(ctx, retry)
	if err != nil || queued.Attempts != 8 || queued.CycleAttempts != 0 || queued.TargetPath != row.TargetPath || queued.Status != "queued" {
		t.Fatalf("manual retry = %+v/%v", queued, err)
	}
	if _, err := f.issues.RetryCockpitMinutesExport(ctx, retry); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("ambiguous stale retry silently acknowledged: %v", err)
	}
	retry.ExpectedRevision = queued.Revision
	noChange, err := f.issues.RetryCockpitMinutesExport(ctx, retry)
	if err != nil || noChange.Revision != queued.Revision {
		t.Fatal("already queued retry changed operation")
	}
	exporter.setWrite(nil)
	processMinutesExportFixture(t, worker)
	row = getMinutesExportFixture(t, f, row.ID)
	if row.Status != "succeeded" || row.Attempts != 9 || row.CycleAttempts != 1 || !row.SizeBytes.Valid || row.SizeBytes.Int64 != int64(len(version.Content)) || !row.CompletedAt.Valid {
		t.Fatalf("completed export = %+v", row)
	}
	exporter.mu.Lock()
	last := exporter.requests[len(exporter.requests)-1]
	exporter.mu.Unlock()
	if last.Content != version.Content || last.ContentHash != version.ContentHash || last.OperationID != util.UUIDToString(row.ID) || last.VersionID != util.UUIDToString(version.ID) || last.LeaseToken == "" {
		t.Fatal("worker did not pass the exact immutable content and lease identity")
	}
}

func TestCockpitMinutesExportLeaseFencesLateWorker(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	row := publishMinutesExportFixture(t, f, version)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	exporter.setWrite(func(_ context.Context, req cockpitnas.Request) (cockpitnas.Result, error) {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
			return cockpitnas.Result{}, &cockpitnas.Error{Code: "late_failure", Message: "expired worker must not replace success"}
		}
		return fakeMinutesExportResult(req), nil
	})
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	done := make(chan error, 1)
	go func() { _, err := worker.ProcessNext(ctx); done <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first worker did not reach writer")
	}
	first := getMinutesExportFixture(t, f, row.ID)
	if first.Status != "running" || !first.LeaseToken.Valid {
		t.Fatal("claim did not persist before filesystem work")
	}
	if worked, err := worker.ProcessNext(ctx); worked || err != nil {
		t.Fatalf("live lease stolen: %v/%v", worked, err)
	}
	f.Exec(t, "UPDATE cockpit_minutes_export SET lease_expires_at=now()-interval '1 second' WHERE id=$1", row.ID)
	processMinutesExportFixture(t, worker)
	completed := getMinutesExportFixture(t, f, row.ID)
	unblock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("old worker did not finish")
	}
	row = getMinutesExportFixture(t, f, row.ID)
	if row.Status != "succeeded" || row.Attempts != 2 || row.Revision != completed.Revision || row.LastErrorCode != "" {
		t.Fatalf("late worker overwrote new result: %+v", row)
	}
}

func TestCockpitMinutesExportExpiredEighthClaimNeedsAttention(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	row := publishMinutesExportFixture(t, f, version)
	f.Exec(t, "UPDATE cockpit_minutes_export SET status='running',attempts=8,cycle_attempts=8,lease_token=$2,lease_expires_at=now()-interval '1 second',next_retry_at=NULL WHERE id=$1", row.ID, dbid.NewV7())
	processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
	row = getMinutesExportFixture(t, f, row.ID)
	if row.Status != "needs_attention" || row.Attempts != 8 || row.CycleAttempts != 8 || row.LastErrorCode != "attempts_exhausted" || exporter.writeCount.Load() != 0 {
		t.Fatalf("expired eighth claim = %+v", row)
	}
}

func TestCockpitMinutesExportWorkerOnlyClaimsConfiguredRoots(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	row := publishMinutesExportFixture(t, f, version)
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	for _, ids := range [][]string{{}, {"019f06d9-3020-7000-8000-000000000002"}} {
		exporter.rootIDs = ids
		if worked, err := worker.ProcessNext(ctx); worked || err != nil {
			t.Fatalf("unconfigured replica claimed export: %v/%v", worked, err)
		}
		untouched := getMinutesExportFixture(t, f, row.ID)
		if untouched.Revision != row.Revision || untouched.Status != "queued" || untouched.Attempts != 0 {
			t.Fatal("unconfigured replica modified another root's work")
		}
	}
	exporter.rootIDs = []string{exportFixtureRootID}
	processMinutesExportFixture(t, worker)
	if getMinutesExportFixture(t, f, row.ID).Status != "succeeded" {
		t.Fatal("configured replica could not complete waiting work")
	}
}

func TestCockpitMinutesExportVersionReviewerAndRevokedMembership(t *testing.T) {
	f := newCockpitWorkflowFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_minutes_export WHERE workspace_id=$1", f.ws)
	f.Exec(t, "UPDATE cockpit_meeting SET nas_dir='/test-nas/meeting' WHERE id=$1", f.meeting)
	ctx := context.Background()
	version, _ := prepareHandoffPending(t, f)
	reviewer := parseTestUUID(t, f.member(t, "export-version-reviewer"))
	if err := f.issues.ChangeCockpitMeetingReviewer(ctx, handoffInput(t, f, reviewer), IssueCreateOpts{}); err != nil {
		t.Fatal(err)
	}
	review := CockpitMinutesReview{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Decision: "approved"}
	review.ActorID = reviewer
	if err := f.issues.ReviewCockpitMeetingMinutes(ctx, review); err != nil {
		t.Fatal(err)
	}
	if err := f.issues.PublishCockpitMeetingMinutes(ctx, CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}); err != nil {
		t.Fatal(err)
	}
	f.issues.CockpitNASExporter = &fakeMinutesExporter{}
	in := CockpitMinutesExportCommand{CockpitMinutesVersionCommand: CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID}, Target: exportFixtureTarget()}
	in.ActorID = reviewer
	row, err := f.issues.ExportCockpitMeetingMinutes(ctx, in)
	if err != nil || row.CreatedBy != reviewer {
		t.Fatalf("version reviewer cannot export: %+v/%v", row, err)
	}
	f.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, reviewer)
	if _, err := f.issues.ExportCockpitMeetingMinutes(ctx, in); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("former member retained export authority: %v", err)
	}
	if _, err := f.issues.RetryCockpitMinutesExport(ctx, CockpitMinutesExportRetry{WorkspaceID: f.ws, MeetingID: f.meeting, ActorID: reviewer, ExportID: row.ID, ExpectedRevision: row.Revision}); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("former member retained retry authority: %v", err)
	}
}

func TestCockpitMinutesExportConflictAndPinnedSource(t *testing.T) {
	for _, scenario := range []string{"content_changed", "root_changed", "target_conflict", "result_mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			f, version, exporter := newMinutesExportFixture(t)
			row := publishMinutesExportFixture(t, f, version)
			expectedCode := ""
			switch scenario {
			case "content_changed":
				f.Exec(t, "UPDATE cockpit_minutes_version SET content='changed outside normal workflow' WHERE id=$1", version.ID)
				expectedCode = "source_conflict"
			case "root_changed":
				exporter.rootPath = "/changed-root"
				expectedCode = "destination_changed"
			case "target_conflict":
				exporter.setWrite(func(context.Context, cockpitnas.Request) (cockpitnas.Result, error) {
					return cockpitnas.Result{}, &cockpitnas.Error{Code: "target_conflict", Message: "Existing human content differs"}
				})
				expectedCode = "target_conflict"
			case "result_mismatch":
				exporter.setWrite(func(_ context.Context, req cockpitnas.Request) (cockpitnas.Result, error) {
					result := fakeMinutesExportResult(req)
					result.ContentHash = "different"
					return result, nil
				})
				expectedCode = "result_conflict"
			}
			processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
			row = getMinutesExportFixture(t, f, row.ID)
			if row.Status != "needs_attention" || row.LastErrorCode != expectedCode || row.NextRetryAt.Valid || !f.versions(t)[0].PublishedAt.Valid {
				t.Fatalf("conflict outcome = %+v", row)
			}
			if (scenario == "content_changed" || scenario == "root_changed") && exporter.writeCount.Load() != 0 {
				t.Fatal("changed source or destination still reached filesystem writer")
			}
		})
	}
}

func TestCockpitMinutesExportAmbiguousWriteReconciles(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	row := publishMinutesExportFixture(t, f, version)
	var saved *cockpitnas.Request
	var materializations int
	exporter.setWrite(func(_ context.Context, req cockpitnas.Request) (cockpitnas.Result, error) {
		if saved == nil {
			copy := req
			saved = &copy
			materializations++
			return cockpitnas.Result{}, &cockpitnas.Error{Code: "uncertain_commit", Message: "Write completed but acknowledgement was lost", Retryable: true}
		}
		if req.Content != saved.Content || req.Destination != saved.Destination || req.OperationID != saved.OperationID {
			return cockpitnas.Result{}, &cockpitnas.Error{Code: "conflict", Message: "Retry changed its intent"}
		}
		return fakeMinutesExportResult(req), nil
	})
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	processMinutesExportFixture(t, worker)
	f.Exec(t, "UPDATE cockpit_minutes_export SET next_retry_at=now()-interval '1 second' WHERE id=$1", row.ID)
	processMinutesExportFixture(t, worker)
	row = getMinutesExportFixture(t, f, row.ID)
	if row.Status != "succeeded" || row.Attempts != 2 || materializations != 1 {
		t.Fatal("ambiguous commit was not reconciled idempotently")
	}
	if worked, err := worker.ProcessNext(ctx); worked || err != nil {
		t.Fatalf("completed operation ran again: %v/%v", worked, err)
	}
}

func TestCockpitMinutesExportDeletedLedgerCannotBeResurrected(t *testing.T) {
	f, version, exporter := newMinutesExportFixture(t)
	ctx := context.Background()
	row := publishMinutesExportFixture(t, f, version)
	var completions atomic.Int32
	f.issues.Bus.Subscribe(protocol.EventCockpitChanged, func(event events.Event) {
		if event.WorkspaceID == util.UUIDToString(f.ws) {
			completions.Add(1)
		}
	})
	exporter.setWrite(func(_ context.Context, req cockpitnas.Request) (cockpitnas.Result, error) {
		// Workspace deletion removes ledger rows, not external NAS copies.
		if err := f.q.DeleteCockpitMinutesExportsByWorkspace(ctx, f.ws); err != nil {
			return cockpitnas.Result{}, err
		}
		return fakeMinutesExportResult(req), nil
	})
	processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
	if _, err := f.q.GetCockpitMinutesExport(ctx, db.GetCockpitMinutesExportParams{WorkspaceID: f.ws, MeetingID: f.meeting, ID: row.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("deleted operation resurrected: %v", err)
	}
	if completions.Load() != 1 {
		t.Fatalf("claim plus stale completion emitted %d events; only claim should publish", completions.Load())
	}
}
