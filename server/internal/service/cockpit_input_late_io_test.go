package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type inputBlockedStore struct {
	*storage.LocalStorage
	entered chan struct{}
	release chan struct{}
}

type inputAmbiguousStore struct {
	*storage.LocalStorage
	writes      atomic.Int64
	failedReads atomic.Int64
}

func (s *inputAmbiguousStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	if s.failedReads.Load() > 0 {
		s.failedReads.Add(-1)
		return nil, errors.New("owned fixture: temporary object provider outage")
	}
	return s.LocalStorage.GetReader(ctx, key)
}

func (s *inputAmbiguousStore) UploadStream(ctx context.Context, key string, r io.Reader, size int64, contentType, filename string) (string, error) {
	s.writes.Add(1)
	url, err := s.LocalStorage.UploadStream(ctx, key, r, size, contentType, filename)
	if err != nil {
		return url, err
	}
	return "", errors.New("owned fixture: storage acknowledgement was lost after the write")
}

func TestCockpitInputAmbiguousWriteReconcilesOriginalKeyWithoutReupload(t *testing.T) {
	f, s, p, local := inputUploadFixture(t)
	ctx := context.Background()
	ambiguous := &inputAmbiguousStore{LocalStorage: local}
	s.ConfigureCockpitInputStorage(ambiguous)
	q, _ := inputSubmitUpload(t, s, p, "fixed original bytes")
	if _, err := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString("fixed original bytes")); err == nil {
		t.Fatal("ambiguous provider reply was presented as success")
	}
	original, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
	if err != nil || original.State != "verifying" || !original.ContentHash.Valid || original.FinishedAt.Valid {
		t.Fatalf("uncertain owned attempt lost reconciliation: %+v %v", original, err)
	}
	retryBody := &inputCountReader{Reader: bytes.NewBufferString("fixed original bytes")}
	if _, err = s.UploadCockpitInputBytes(ctx, q, 1, retryBody); err == nil || retryBody.reads != 0 {
		t.Fatalf("original transfer accepted a second upload: %d %v", retryBody.reads, err)
	}
	if worked, e := s.ProcessNextCockpitInputCapture(ctx); e != nil || !worked {
		t.Fatalf("original-key reconciliation: %v %v", worked, e)
	}
	current, err := s.GetCockpitInputTransfer(ctx, q)
	if err != nil || current.State != "awaiting_finalize" || !current.CanFinalize || ambiguous.writes.Load() != 1 {
		t.Fatalf("reconciliation rewrote data or hid accepted bytes: %+v writes=%d %v", current, ambiguous.writes.Load(), err)
	}
	if _, err = s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: current.Revision, ExpectedContentHash: original.ContentHash.String}); err != nil {
		t.Fatal(err)
	}
}

func TestCockpitInputTransientReconciliationRetainsOriginalAttemptUntilStorageRecovers(t *testing.T) {
	f, s, p, local := inputUploadFixture(t)
	ctx := context.Background()
	ambiguous := &inputAmbiguousStore{LocalStorage: local}
	s.ConfigureCockpitInputStorage(ambiguous)
	q, _ := inputSubmitUpload(t, s, p, "fixed recoverable bytes")
	if _, err := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString("fixed recoverable bytes")); err == nil {
		t.Fatal("fixture must lose the original write acknowledgement")
	}
	ambiguous.failedReads.Store(1)
	if worked, err := s.ProcessNextCockpitInputCapture(ctx); !worked || err == nil {
		t.Fatalf("temporary storage outage must remain explicit: %v %v", worked, err)
	}
	current, err := s.GetCockpitInputTransfer(ctx, q)
	if err != nil || current.State != "verifying" || !current.CanAbandon || current.CanRestart || current.FinishedAt != nil {
		t.Fatalf("transient outage discarded the original copy or hid explicit abandonment: %+v %v", current, err)
	}
	if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_input_transfer SET lease_expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND id=$2", p.WorkspaceID, q.TransferID); err != nil {
		t.Fatal(err)
	}
	if worked, e := s.ProcessNextCockpitInputCapture(ctx); !worked || e != nil {
		t.Fatalf("original copy did not recover: %v %v", worked, e)
	}
	current, err = s.GetCockpitInputTransfer(ctx, q)
	if err != nil || current.State != "awaiting_finalize" || !current.CanFinalize || ambiguous.writes.Load() != 1 {
		t.Fatalf("recovery required a second upload: %+v writes=%d %v", current, ambiguous.writes.Load(), err)
	}
}

func TestCockpitInputVerifiedCopySurvivesUploaderRevocationForExplicitManagerFinalize(t *testing.T) {
	f, s, p, local := inputUploadFixture(t)
	ctx := context.Background()
	admin := parseTestUUID(t, f.member(t, "input-recovery-admin"))
	if _, err := f.Pool.Exec(ctx, "UPDATE member SET role='admin' WHERE workspace_id=$1 AND user_id=$2", p.WorkspaceID, admin); err != nil {
		t.Fatal(err)
	}
	blocked := &inputBlockedStore{LocalStorage: local, entered: make(chan struct{}), release: make(chan struct{})}
	s.ConfigureCockpitInputStorage(blocked)
	q, _ := inputSubmitUpload(t, s, p, "already accepted bytes")
	result := make(chan error, 1)
	go func() {
		out, e := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString("already accepted bytes"))
		if e == nil && out.Current != nil {
			e = errors.New("revoked uploader received a current projection")
		}
		result <- e
	}()
	select {
	case <-blocked.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not reach its durable owned key")
	}
	released := false
	defer func() {
		if !released {
			close(blocked.release)
			<-result
		}
	}()
	if _, err := f.Pool.Exec(ctx, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", p.WorkspaceID, p.CredentialOwnerID); err != nil {
		t.Fatal(err)
	}
	close(blocked.release)
	released = true
	if err := <-result; err != nil {
		t.Fatalf("actual verified storage fact was discarded after revocation: %v", err)
	}
	row, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
	if err != nil || row.State != "awaiting_finalize" || row.IoOutcome.String != "verified" || !row.ContentHash.Valid {
		t.Fatalf("verified copy cannot be recovered: %+v %v", row, err)
	}
	command := CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: row.Revision, ExpectedContentHash: row.ContentHash.String}
	if _, err = s.FinalizeCockpitInputTransfer(ctx, q, command); !errors.Is(err, ErrCockpitWorkflowForbidden) {
		t.Fatalf("revoked uploader gained finalization: %v", err)
	}
	q.CredentialOwnerID = admin
	command.CommandKey = util.UUIDToString(dbid.NewV7())
	final, err := s.FinalizeCockpitInputTransfer(ctx, q, command)
	if err != nil || final.Receipt.Principal.ActorID != util.UUIDToString(admin) || final.Current == nil || final.Current.Principal.ActorID != util.UUIDToString(p.CredentialOwnerID) || final.Version == nil || final.Version.CaptureState != "ready" {
		t.Fatalf("manager did not explicitly finalize the original uploader's fixed copy: %+v %v", final, err)
	}
}

func (s *inputBlockedStore) UploadStream(ctx context.Context, key string, r io.Reader, size int64, contentType, filename string) (string, error) {
	close(s.entered)
	<-s.release
	return s.LocalStorage.UploadStream(ctx, key, r, size, contentType, filename)
}

func TestCockpitInputLateWriteCannotReviveAbandonedOrDeletedInput(t *testing.T) {
	for _, teardown := range []bool{false, true} {
		name := "abandon"
		if teardown {
			name = "workspace_teardown"
		}
		t.Run(name, func(t *testing.T) {
			f, s, p, local := inputUploadFixture(t)
			ctx := context.Background()
			blocked := &inputBlockedStore{LocalStorage: local, entered: make(chan struct{}), release: make(chan struct{})}
			s.ConfigureCockpitInputStorage(blocked)
			q, _ := inputSubmitUpload(t, s, p, "late fixed bytes")
			done := make(chan error, 1)
			go func() {
				_, e := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString("late fixed bytes"))
				done <- e
			}()
			select {
			case <-blocked.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("upload did not enter owned storage")
			}
			released := false
			defer func() {
				if !released {
					close(blocked.release)
					<-done
				}
			}()
			transfer, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
			if err != nil || !transfer.ContentHash.Valid || transfer.State != "writing" {
				t.Fatalf("missing durable pre-upload checkpoint: %+v %v", transfer, err)
			}
			if teardown {
				tx, e := f.Pool.Begin(ctx)
				if e != nil {
					t.Fatal(e)
				}
				qt := f.q.WithTx(tx)
				if e = qt.SetWorkspaceTeardownMode(ctx); e == nil {
					e = DeleteCockpitInputsForWorkspace(ctx, qt, p.WorkspaceID)
				}
				if e != nil {
					_ = tx.Rollback(ctx)
					t.Fatal(e)
				}
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
			} else {
				result, e := s.AbandonCockpitInputTransfer(ctx, q, CockpitInputAbandonInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: transfer.Revision, Reason: "Stop this attempt"})
				if e != nil || result.Receipt.State != "abandoned" {
					t.Fatalf("abandon blocked by file IO: %+v %v", result, e)
				}
			}
			close(blocked.release)
			released = true
			if e := <-done; e == nil {
				t.Fatal("late copy was reported as current success")
			}
			var state, ioOutcome, receipt, actor string
			var deleted bool
			err = f.Pool.QueryRow(ctx, "SELECT state,COALESCE(io_outcome,''),command_receipt::text,COALESCE(actor_type,''),workspace_deleted_at IS NOT NULL FROM cockpit_input_transfer WHERE id=$1", q.TransferID).Scan(&state, &ioOutcome, &receipt, &actor, &deleted)
			if err != nil || ioOutcome != "verified" || deleted != teardown {
				t.Fatalf("late outcome was lost: %s/%s/%v %v", state, ioOutcome, deleted, err)
			}
			if teardown && (receipt != "{}" || actor != "") {
				t.Fatal("cleanup tombstone retained command or human identity")
			}
			if !teardown && state != "abandoned" {
				t.Fatalf("abandoned outcome changed to %s", state)
			}
			if _, err = f.Pool.Exec(ctx, "UPDATE cockpit_input_transfer SET cleanup_due_at=now() WHERE workspace_id=$1 AND id=$2", p.WorkspaceID, q.TransferID); err != nil {
				t.Fatal(err)
			}
			worked, err := s.ProcessNextCockpitInputCleanup(ctx)
			if err != nil || !worked {
				t.Fatalf("owned late-copy cleanup: %v %v", worked, err)
			}
			if r, e := local.GetReader(ctx, transfer.OwnedStorageKey); e == nil {
				_ = r.Close()
				t.Fatal("late owned copy survived explicit cleanup")
			}
			var ready int
			if err = f.Pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_input_version WHERE workspace_id=$1 AND id=$2 AND capture_state='ready'", p.WorkspaceID, q.VersionID).Scan(&ready); err != nil || ready != 0 {
				t.Fatalf("late completion resurrected readiness: %d %v", ready, err)
			}
		})
	}
}
