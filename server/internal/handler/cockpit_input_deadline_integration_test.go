package handler

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type inputDeadlineStore struct {
	*storage.LocalStorage
	closed atomic.Int64
}

func (s *inputDeadlineStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	r, err := s.LocalStorage.GetReader(ctx, key)
	if err != nil {
		return nil, err
	}
	return &inputDeadlineSource{ReadCloser: r, closed: &s.closed}, nil
}

type inputDeadlineSource struct {
	io.ReadCloser
	closed *atomic.Int64
}

func (r *inputDeadlineSource) Close() error {
	r.closed.Add(1)
	return r.ReadCloser.Close()
}

type inputSocketFixture struct {
	h         *Handler
	ws, spool string
	store     *inputDeadlineStore
}

func newInputSocketFixture(t *testing.T) inputSocketFixture {
	t.Helper()
	ws := dbfx.Workspace(t, "Input socket deadline", "input-socket-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input_version WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input_transfer WHERE workspace_id=$1", ws)
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	t.Setenv("LOCAL_UPLOAD_BASE_URL", "")
	store := &inputDeadlineStore{LocalStorage: storage.NewLocalStorageFromEnv()}
	h := *testHandler
	h.Storage = store
	h.IssueService = &service.IssueService{Queries: h.Queries, TxStarter: testPool, CockpitInputBackendReady: true}
	if !h.IssueService.ConfigureCockpitInputStorage(store) {
		t.Fatal("private input storage unavailable")
	}
	spool := t.TempDir()
	h.IssueService.CockpitInputCapturer.TempDir = spool
	return inputSocketFixture{h: &h, ws: ws, spool: spool, store: store}
}

func (f inputSocketFixture) uploadSession(t *testing.T, size int64) (service.CockpitInputQuery, int64) {
	t.Helper()
	p := service.CockpitInputRead{WorkspaceID: parseUUID(f.ws), CredentialOwnerID: parseUUID(testUserID), ActorSource: "human"}
	created, err := f.h.IssueService.CreateCockpitInput(t.Context(), p, service.CockpitInputCreateInput{CommandKey: uuid.NewString(), Title: "Socket deadline bytes"})
	if err != nil {
		t.Fatal(err)
	}
	q := service.CockpitInputQuery{CockpitInputRead: p, InputID: parseUUID(created.Receipt.InputID)}
	submitted, err := f.h.IssueService.SubmitCockpitInputVersion(t.Context(), q, service.CockpitInputVersionSubmitInput{CommandKey: uuid.NewString(), ExpectedRevision: 1, Source: service.CockpitInputSourceInput{Kind: "upload", Upload: &service.CockpitInputUploadSource{Filename: "socket.bin", ContentType: "application/octet-stream", SizeBytes: &size}}})
	if err != nil {
		t.Fatal(err)
	}
	if submitted.Receipt.TransferID == nil || submitted.Receipt.TransferRevision == nil {
		t.Fatal("missing precise upload session")
	}
	q.VersionID, q.TransferID = parseUUID(submitted.Receipt.VersionID), parseUUID(*submitted.Receipt.TransferID)
	return q, *submitted.Receipt.TransferRevision
}

func inputSocketConnect(t *testing.T, address string) *net.TCPConn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	tcp := conn.(*net.TCPConn)
	if err = tcp.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err = tcp.SetReadBuffer(1024); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tcp.Close() })
	return tcp
}

func TestCockpitInputHTTPDeadlineInterruptsPartialUploadAndReleasesSpools(t *testing.T) {
	f := newInputSocketFixture(t)
	q, revision := f.uploadSession(t, 64*1024)
	finished := make(chan time.Duration, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 1200*time.Millisecond)
		defer cancel()
		r = testutil.WithURLParams(r.WithContext(ctx), "inputId", uuidToString(q.InputID), "versionId", uuidToString(q.VersionID), "transferId", uuidToString(q.TransferID))
		cockpitHandler(f.h.UploadCockpitInputBytes)(w, r)
		finished <- time.Since(started)
	}))
	t.Cleanup(server.Close)
	conn := inputSocketConnect(t, server.Listener.Addr().String())
	_, err := fmt.Fprintf(conn, "PUT /api/cockpit/inputs/%s/versions/%s/transfers/%s/bytes HTTP/1.1\r\nHost: input.test\r\nX-User-ID: %s\r\nX-Workspace-ID: %s\r\nContent-Type: application/octet-stream\r\nX-Input-Transfer-Revision: %d\r\nContent-Length: 65536\r\n\r\nfirst-part", uuidToString(q.InputID), uuidToString(q.VersionID), uuidToString(q.TransferID), testUserID, f.ws, revision)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case elapsed := <-finished:
		if elapsed < time.Second || elapsed > 4*time.Second {
			t.Fatalf("partial upload did not expire at its request budget: %s", elapsed)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("partial HTTP body ignored the connection deadline")
	}
	row, err := f.h.Queries.GetCockpitInputTransfer(t.Context(), db.GetCockpitInputTransferParams{WorkspaceID: q.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
	if err != nil || row.State != "failed" || row.IoFinishedAt.Valid {
		t.Fatalf("stalled upload retained a live lease or claimed stored bytes: %+v %v", row, err)
	}
	files, err := os.ReadDir(f.spool)
	if err != nil || len(files) != 0 || f.store.closed.Load() != 0 {
		t.Fatalf("partial upload leaked a spool or reached the provider: files=%d closed=%d err=%v", len(files), f.store.closed.Load(), err)
	}
	// A normal subsequent upload must still acquire the actual shared I/O slot.
	next, rev := f.uploadSession(t, 2)
	if _, err = f.h.IssueService.UploadCockpitInputBytes(t.Context(), next, rev, strings.NewReader("ok")); err != nil {
		t.Fatalf("stalled upload retained I/O capacity: %v", err)
	}
}

func TestCockpitInputHTTPDeadlineInterruptsStoppedDownloadAndClosesVerifiedReaders(t *testing.T) {
	f := newInputSocketFixture(t)
	body := strings.Repeat("x", 16*1024*1024)
	q, revision := f.uploadSession(t, int64(len(body)))
	upload, err := f.h.IssueService.UploadCockpitInputBytes(t.Context(), q, revision, strings.NewReader(body))
	if err != nil || upload.Current == nil {
		t.Fatalf("prepare download bytes: %+v %v", upload, err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	if _, err = f.h.IssueService.FinalizeCockpitInputTransfer(t.Context(), q, service.CockpitInputFinalizeInput{CommandKey: uuid.NewString(), ExpectedRevision: upload.Current.Revision, ExpectedContentHash: hash}); err != nil {
		t.Fatal(err)
	}
	var link service.CockpitInputDownloadLink
	req := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/download-link", f.ws, nil), "inputId", uuidToString(q.InputID), "versionId", uuidToString(q.VersionID))
	testutil.Call(t, cockpitHandler(f.h.GetCockpitInputDownloadLink), req).Want(200).JSON(&link)
	baseline := f.store.closed.Load()
	finished := make(chan time.Duration, 2)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		ctx, cancel := context.WithTimeout(r.Context(), 1200*time.Millisecond)
		defer cancel()
		r = testutil.WithURLParams(r.WithContext(ctx), "versionId", uuidToString(q.VersionID))
		f.h.DownloadCockpitInputSignedFile(w, r)
		finished <- time.Since(started)
	}))
	server.Config.ConnState = func(conn net.Conn, state http.ConnState) {
		if state == http.StateNew {
			_ = conn.(*net.TCPConn).SetWriteBuffer(4096)
		}
	}
	server.Start()
	t.Cleanup(server.Close)
	for i := 0; i < 2; i++ {
		conn := inputSocketConnect(t, server.Listener.Addr().String())
		if _, err = fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: input.test\r\n\r\n", link.URL); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		select {
		case elapsed := <-finished:
			if elapsed < time.Second || elapsed > 4*time.Second {
				t.Fatalf("download did not stall until its request budget: %s", elapsed)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("stopped receiver retained a download slot past the socket deadline")
		}
	}
	files, err := os.ReadDir(f.spool)
	if err != nil || len(files) != 0 || f.store.closed.Load() != baseline+2 {
		t.Fatalf("download readers were not closed: spools=%d provider closes=%d want=%d err=%v", len(files), f.store.closed.Load(), baseline+2, err)
	}
	_, reader, err := f.h.IssueService.OpenCockpitInputFile(t.Context(), q)
	if err != nil {
		t.Fatalf("stopped downloads retained both I/O slots: %v", err)
	}
	if err = reader.Close(); err != nil {
		t.Fatal(err)
	}
	// Ordinary denials must finish their small JSON response before cleanup
	// expires a failed stream's write deadline.
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.ws, testUserID)
	response, err := http.Get(server.URL + link.URL)
	if err != nil {
		t.Fatalf("normal signed-file denial was truncated: %v", err)
	}
	defer response.Body.Close()
	denial, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusForbidden || !strings.Contains(string(denial), "permission_revoked") {
		t.Fatalf("denial did not finish before cleanup: status=%d body=%q err=%v", response.StatusCode, denial, err)
	}
}
