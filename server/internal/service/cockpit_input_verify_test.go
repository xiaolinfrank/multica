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
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type inputStaleProbeStore struct {
	*storage.LocalStorage
	key              string
	entered, release chan struct{}
	reads            atomic.Int64
	blocked          atomic.Bool
}

func (s *inputStaleProbeStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	s.reads.Add(1)
	if key == s.key && s.blocked.CompareAndSwap(false, true) {
		close(s.entered)
		<-s.release
		return nil, errors.New("owned fixture: the old copy became unavailable")
	}
	return s.LocalStorage.GetReader(ctx, key)
}

func TestCockpitInputVerificationIsAsyncAndLateProbeCannotReplaceRestoredCopy(t *testing.T) {
	_, s, p, local := inputUploadFixture(t)
	ctx := context.Background()
	content := "stable fixed bytes"
	q, _ := inputSubmitUpload(t, s, p, content)
	up, err := s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	first, err := s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: *up.Current.ContentHash})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.ReadCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	probe := &inputStaleProbeStore{LocalStorage: local, key: file.StorageKey, entered: make(chan struct{}), release: make(chan struct{})}
	s.ConfigureCockpitInputStorage(probe)
	queued, err := s.VerifyCockpitInputVersion(ctx, q)
	if err != nil || queued.Availability != "checking" || probe.reads.Load() != 0 || queued.CanVerify {
		t.Fatalf("JSON verify performed provider IO or offered duplicate probe: %+v reads=%d %v", queued, probe.reads.Load(), err)
	}
	result := make(chan error, 1)
	go func() {
		worked, e := s.ProcessNextCockpitInputVerification(ctx)
		if !worked && e == nil {
			e = errors.New("queued probe was not claimed")
		}
		result <- e
	}()
	select {
	case <-probe.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not enter private verification")
	}
	released := false
	defer func() {
		if !released {
			close(probe.release)
			<-result
		}
	}()
	previous := util.UUIDToString(q.TransferID)
	restart, err := s.RestartCockpitInputTransfer(ctx, q, CockpitInputRestartInput{Mode: "upload_matching_bytes", CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: queued.Revision, PreviousTransferID: &previous})
	if err != nil {
		t.Fatal(err)
	}
	q.TransferID = inputTrustedID(restart.Receipt.TransferID)
	up, err = s.UploadCockpitInputBytes(ctx, q, 1, bytes.NewBufferString(content))
	if err != nil {
		t.Fatal(err)
	}
	restored, err := s.FinalizeCockpitInputTransfer(ctx, q, CockpitInputFinalizeInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: up.Current.Revision, ExpectedContentHash: *up.Current.ContentHash})
	if err != nil {
		t.Fatal(err)
	}
	close(probe.release)
	released = true
	if err = <-result; err != nil {
		t.Fatalf("stale probe should be discarded: %v", err)
	}
	current, err := s.GetCockpitInputVersion(ctx, q)
	if err != nil || current.Version.Availability != "available" || current.Version.CurrentTransferID == nil || *current.Version.CurrentTransferID != restored.Receipt.TransferID || current.Version.ReadyAt == nil || first.Version.ReadyAt == nil || *current.Version.ReadyAt != *first.Version.ReadyAt {
		t.Fatalf("late observation replaced the new copy or first acceptance: %+v %v", current.Version, err)
	}
}
