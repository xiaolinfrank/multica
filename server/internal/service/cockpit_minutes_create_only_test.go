package service

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func newCreateOnlyMinutesFixture(t *testing.T) (cockpitWorkflowFixture, db.CockpitMinutesVersion, *fakeMinutesExporter) {
	t.Helper()
	f, version, exporter := newMinutesExportFixture(t)
	f.Cleanup(t, "DELETE FROM cockpit_minutes_export_attempt WHERE workspace_id=$1", f.ws)
	exporter.mode = cockpitnas.ModeCreateOnly
	return f, version, exporter
}

func publishCreateOnlyMinutes(t *testing.T, f cockpitWorkflowFixture, version db.CockpitMinutesVersion) db.CockpitMinutesExport {
	t.Helper()
	target := exportFixtureTarget()
	target.WriteMode = cockpitnas.ModeCreateOnly
	if err := f.issues.PublishCockpitMeetingMinutes(context.Background(), CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID, NASExport: &target}); err != nil {
		t.Fatal(err)
	}
	rows, err := f.q.ListCockpitMinutesExports(context.Background(), db.ListCockpitMinutesExportsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if err != nil || len(rows) != 1 {
		t.Fatalf("missing export: %d %v", len(rows), err)
	}
	return rows[0]
}

func createOnlyAttempts(t *testing.T, f cockpitWorkflowFixture, row db.CockpitMinutesExport) CockpitMinutesExportAttemptPage {
	t.Helper()
	page, err := f.issues.ListCockpitMinutesExportAttempts(context.Background(), CockpitMinutesExportAttemptList{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: row.ID})
	if err != nil {
		t.Fatal(err)
	}
	return page
}

func TestCockpitCreateOnlyRequiresExplicitModeBeforePublication(t *testing.T) {
	f, version, _ := newCreateOnlyMinutesFixture(t)
	for _, mode := range []string{"", cockpitnas.ModeAtomic, "best_effort"} {
		target := exportFixtureTarget()
		target.WriteMode = mode
		err := f.issues.PublishCockpitMeetingMinutes(context.Background(), CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID, NASExport: &target})
		if !errors.Is(err, ErrCockpitWorkflowInput) {
			t.Fatalf("mode %q should require explicit confirmation: %v", mode, err)
		}
		if f.work(t).PublishedVersionID.Valid {
			t.Fatal("invalid NAS intent partially published the version")
		}
	}
	row := publishCreateOnlyMinutes(t, f, version)
	if row.WriteMode != cockpitnas.ModeCreateOnly || row.VerifiedPath.Valid || row.ReceiptHash.Valid {
		t.Fatalf("premature completion evidence: %+v", row)
	}
}

func TestCockpitCreateOnlyRecordsIntentThenConfirmsExactEvidence(t *testing.T) {
	f, version, exporter := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	exporter.setWrite(func(ctx context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		id, err := util.ParseUUID(request.AttemptID)
		if err != nil {
			t.Fatal(err)
		}
		attempt, err := f.q.GetCockpitMinutesExportAttempt(ctx, db.GetCockpitMinutesExportAttemptParams{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: row.ID, ID: id})
		if err != nil || attempt.Status != "planned" || attempt.AttemptNumber != 1 || attempt.ContentHash != version.ContentHash {
			t.Fatalf("filesystem access preceded durable intent: %+v %v", attempt, err)
		}
		return fakeMinutesExportResult(request), nil
	})
	processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
	done := getMinutesExportFixture(t, f, row.ID)
	if done.Status != "succeeded" || !done.VerifiedPath.Valid || done.VerifiedPath.String == done.TargetPath || !done.ReceiptPath.Valid || !done.ReceiptHash.Valid || !done.VerifiedAttemptID.Valid {
		t.Fatalf("missing verified copy: %+v", done)
	}
	page := createOnlyAttempts(t, f, row)
	if page.Total != 1 || page.Items[0].Status != "verified" || page.Items[0].VerifiedPath == nil || *page.Items[0].VerifiedPath != done.VerifiedPath.String {
		t.Fatalf("incomplete attempt ledger: %+v", page)
	}
	_, err := f.issues.RetryCockpitMinutesExport(context.Background(), CockpitMinutesExportRetry{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: row.ID, ActorID: f.owner, ExpectedRevision: done.Revision})
	if err != nil || exporter.writeCount.Load() != 1 {
		t.Fatalf("successful retry generated another copy: %v", err)
	}
}

func TestCockpitCreateOnlyRetriesAnIncompleteAttemptAtANewPath(t *testing.T) {
	f, version, exporter := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	exporter.setWrite(func(_ context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		if exporter.writeCount.Load() == 1 {
			return cockpitnas.Result{}, &cockpitnas.Error{Code: "storage_unavailable", Message: "Interrupted create-only write", Retryable: true}
		}
		return fakeMinutesExportResult(request), nil
	})
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	processMinutesExportFixture(t, worker)
	first := createOnlyAttempts(t, f, row).Items[0]
	if first.Status != "failed" || first.LastErrorCode != "storage_unavailable" || first.VerifiedPath != nil {
		t.Fatalf("partial attempt was confirmed: %+v", first)
	}
	f.Exec(t, "UPDATE cockpit_minutes_export SET next_retry_at=now()-interval '1 second' WHERE id=$1", row.ID)
	processMinutesExportFixture(t, worker)
	page := createOnlyAttempts(t, f, row)
	if page.Total != 2 || page.Items[0].Status != "verified" || page.Items[1].ID != first.ID || page.Items[1].TargetPath != first.TargetPath || page.Items[0].TargetPath == first.TargetPath {
		t.Fatalf("retry changed a retained attempt: %+v", page)
	}
	if getMinutesExportFixture(t, f, row.ID).Status != "succeeded" {
		t.Fatal("fresh attempt did not converge")
	}
}

func TestCockpitCreateOnlyRecoversReceiptAfterLostDatabaseAcknowledgement(t *testing.T) {
	f, version, exporter := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	var written cockpitnas.Request
	exporter.setWrite(func(_ context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		written = request
		f.Exec(t, "UPDATE cockpit_minutes_export SET lease_expires_at=now()-interval '1 second' WHERE id=$1", row.ID)
		return fakeMinutesExportResult(request), nil
	})
	exporter.verify = func(_ context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		if request.AttemptID != written.AttemptID {
			t.Fatal("recovery did not inspect its durable prior attempt")
		}
		return fakeMinutesExportResult(request), nil
	}
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	processMinutesExportFixture(t, worker)
	if getMinutesExportFixture(t, f, row.ID).Status != "running" {
		t.Fatal("expired writer settled the operation")
	}
	processMinutesExportFixture(t, worker)
	done := getMinutesExportFixture(t, f, row.ID)
	page := createOnlyAttempts(t, f, row)
	if done.Status != "succeeded" || exporter.writeCount.Load() != 1 || done.VerifiedPath.String != fakeMinutesExportResult(written).Path || page.Items[0].Status != "recovered" || page.Total != 2 {
		t.Fatalf("lost ACK created another copy instead of reconciling: %+v %+v", done, page)
	}
}

func TestCockpitCreateOnlyLateWriterCannotReplaceNewerVerifiedCopy(t *testing.T) {
	f, version, exporter := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	worker := NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus)
	var newer cockpitnas.Result
	exporter.setWrite(func(_ context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		if exporter.writeCount.Load() == 1 {
			f.Exec(t, "UPDATE cockpit_minutes_export SET lease_expires_at=now()-interval '1 second' WHERE id=$1", row.ID)
			processMinutesExportFixture(t, worker)
		} else {
			newer = fakeMinutesExportResult(request)
		}
		return fakeMinutesExportResult(request), nil
	})
	processMinutesExportFixture(t, worker)
	done := getMinutesExportFixture(t, f, row.ID)
	page := createOnlyAttempts(t, f, row)
	if done.Status != "succeeded" || done.VerifiedPath.String != newer.Path || util.UUIDToString(done.VerifiedAttemptID) != newer.AttemptID || page.Total != 2 {
		t.Fatalf("old lease replaced the confirmed copy: %+v %+v", done, page)
	}
	for _, attempt := range page.Items {
		if attempt.Status != "verified" {
			t.Fatalf("lost truthful evidence from a late writer: %+v", attempt)
		}
	}
}

func TestCockpitCreateOnlyRejectsAdapterEvidenceOutsideItsAttempt(t *testing.T) {
	for _, invalid := range []string{"path", "receipt_hash", "attempt"} {
		t.Run(invalid, func(t *testing.T) {
			f, version, exporter := newCreateOnlyMinutesFixture(t)
			row := publishCreateOnlyMinutes(t, f, version)
			exporter.setWrite(func(_ context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
				result := fakeMinutesExportResult(request)
				switch invalid {
				case "path":
					result.Path = "/foreign/file.md"
				case "receipt_hash":
					result.ReceiptHash = ""
				case "attempt":
					result.AttemptID = util.UUIDToString(dbid.NewV7())
				}
				return result, nil
			})
			processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
			failed := getMinutesExportFixture(t, f, row.ID)
			if failed.Status != "needs_attention" || failed.LastErrorCode != "result_conflict" || failed.VerifiedPath.Valid {
				t.Fatalf("incorrect evidence became official: %+v", failed)
			}
		})
	}
}

func TestCockpitCreateOnlyAttemptHistoryIsPagedAndScoped(t *testing.T) {
	f, version, _ := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	for number := 1; number <= 31; number++ {
		f.Insert(t, "cockpit_minutes_export_attempt", testutil.Cols{"id": dbid.NewV7(), "workspace_id": f.ws, "meeting_id": f.meeting, "export_id": row.ID,
			"attempt_number": number, "target_path": fmt.Sprintf("/recorded/attempt-%d/minutes.md", number), "receipt_path": fmt.Sprintf("/recorded/attempt-%d/complete.json", number), "content_hash": row.ContentHash})
	}
	query := CockpitMinutesExportAttemptList{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: row.ID, PageSize: 25}
	page, err := f.issues.ListCockpitMinutesExportAttempts(context.Background(), query)
	if err != nil || page.Total != 31 || len(page.Items) != 25 || page.NextCursor == nil || page.Items[0].AttemptNumber != 31 {
		t.Fatalf("unbounded or incorrect first page: %+v %v", page, err)
	}
	query.Cursor = *page.NextCursor
	last, err := f.issues.ListCockpitMinutesExportAttempts(context.Background(), query)
	if err != nil || len(last.Items) != 6 || last.NextCursor != nil || last.Items[0].AttemptNumber != 6 {
		t.Fatalf("incorrect continuation: %+v %v", last, err)
	}
	query.ExportID = dbid.NewV7()
	if _, err := f.issues.ListCockpitMinutesExportAttempts(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("cross-operation cursor was accepted: %v", err)
	}
	query.Cursor = ""
	query.ExportID = row.ID
	query.WorkspaceID = dbid.NewV7()
	if _, err := f.issues.ListCockpitMinutesExportAttempts(context.Background(), query); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("cross-workspace ledger was exposed: %v", err)
	}
}

func TestCockpitCreateOnlyDeletedWorkspaceCannotBeResurrectedByReceipt(t *testing.T) {
	f, version, exporter := newCreateOnlyMinutesFixture(t)
	row := publishCreateOnlyMinutes(t, f, version)
	exporter.setWrite(func(ctx context.Context, request cockpitnas.Request) (cockpitnas.Result, error) {
		if err := f.q.DeleteCockpitMinutesExportsByWorkspace(ctx, f.ws); err != nil {
			return cockpitnas.Result{}, err
		}
		return fakeMinutesExportResult(request), nil
	})
	processMinutesExportFixture(t, NewCockpitMinutesExportWorker(f.q, exporter, f.issues.Bus))
	var remaining int
	if err := f.Pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM cockpit_minutes_export WHERE id=$1) + (SELECT count(*) FROM cockpit_minutes_export_attempt WHERE export_id=$1)", row.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("late receipt recreated deleted records: %d %v", remaining, err)
	}
}
