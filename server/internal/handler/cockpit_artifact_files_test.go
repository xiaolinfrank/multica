package handler

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
)

type observedArtifactFileStore struct {
	*storage.LocalStorage
	reads      int
	afterClose func()
}

func (s *observedArtifactFileStore) GetReader(ctx context.Context, key string) (io.ReadCloser, error) {
	s.reads++
	reader, err := s.LocalStorage.GetReader(ctx, key)
	if err != nil || s.afterClose == nil {
		return reader, err
	}
	return &artifactFileCloseHook{ReadCloser: reader, after: s.afterClose}, nil
}

type artifactFileCloseHook struct {
	io.ReadCloser
	after func()
}

func (r *artifactFileCloseHook) Close() error {
	err := r.ReadCloser.Close()
	r.after()
	return err
}

type cockpitArtifactFileFixture struct {
	handler                      Handler
	workspace, artifact, version string
	key, body, hash              string
	store                        *observedArtifactFileStore
}

func newCockpitArtifactFileFixture(t *testing.T) cockpitArtifactFileFixture {
	t.Helper()
	ws := cockpitFixture(t, "Artifact file boundary")
	project := dbfx.Project(t, "File project", testutil.Cols{"workspace_id": ws})
	module := dbfx.Module(t, project, "File module", testutil.Cols{"workspace_id": ws})
	root := createNode(t, ws, map[string]any{"code": "file-project", "project_id": project})
	group := createNode(t, ws, map[string]any{"code": "file-module", "parent_id": root.ID, "module_id": module})
	node := createNode(t, ws, map[string]any{"code": "file-leaf", "parent_id": group.ID})
	source := dbfx.Issue(t, "Produce fixed file", testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": module})
	review := dbfx.Issue(t, "Review fixed file", testutil.Cols{"workspace_id": ws, "project_id": project, "module_id": module, "assignee_type": "member", "assignee_id": testUserID})
	artifactID, versionID := uuid.NewString(), uuid.NewString()
	body := "Stable file bytes\n中文证据保留尾部空格。  \n"
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	key := "workspaces/" + ws + "/artifact-versions/" + versionID + "/" + uuid.NewString() + ".txt"
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	t.Setenv("LOCAL_UPLOAD_BASE_URL", "")
	store := &observedArtifactFileStore{LocalStorage: storage.NewLocalStorageFromEnv()}
	objectURL, err := store.Upload(context.Background(), key, []byte(body), "text/plain; charset=utf-8", "审阅证据.txt")
	if err != nil {
		t.Fatal(err)
	}
	dbfx.Insert(t, "cockpit_artifact", testutil.Cols{"id": artifactID, "workspace_id": ws, "owner_node_id": node.ID, "project_id": project, "module_id": module,
		"source_issue_id": source, "authorized_producer_issue_id": source, "creation_key": uuid.NewString(), "request_hash": hash,
		"created_by": testUserID, "title": "Fixed file", "reviewer_id": testUserID})
	dbfx.Insert(t, "cockpit_artifact_version", testutil.Cols{"id": versionID, "workspace_id": ws, "artifact_id": artifactID, "version_number": 1,
		"submission_key": uuid.NewString(), "request_hash": hash, "producer_issue_id": source, "producer_issue_identifier": "TES-1", "producer_issue_title": "Produce fixed file",
		"payload_kind": "attachment", "source_attachment_id": uuid.NewString(), "filename": "审阅证据.txt", "content_type": "text/plain; charset=utf-8",
		"size_bytes": len([]byte(body)), "content_hash": hash, "storage_key": key, "object_url": objectURL, "capture_status": "ready", "decision": "pending",
		"reviewer_id": testUserID, "review_issue_id": review, "submitted_by_type": "member", "submitted_by_id": testUserID, "submitted_by_user_id": testUserID})
	h := *testHandler
	h.Storage = store
	svc := *testHandler.IssueService
	svc.CockpitArtifactBackendReady = true
	h.IssueService = &svc
	return cockpitArtifactFileFixture{handler: h, workspace: ws, artifact: artifactID, version: versionID, key: key, body: body, hash: hash, store: store}
}

func (f cockpitArtifactFileFixture) authenticated(t *testing.T, handler http.HandlerFunc, suffix string) *testutil.Response {
	t.Helper()
	path := "/api/cockpit/artifacts/" + f.artifact + "/versions/" + f.version + "/" + suffix
	req := testutil.WithURLParams(cockpitRequest(http.MethodGet, path, f.workspace, nil), "artifactId", f.artifact, "versionId", f.version)
	return testutil.Call(t, cockpitHandler(handler), req)
}

func (f cockpitArtifactFileFixture) signedRequest(path string) *http.Request {
	return testutil.WithURLParams(httptest.NewRequest(http.MethodGet, path, nil), "versionId", f.version)
}

func TestCockpitArtifactFileHTTPMintsBoundedLinksAndStreamsVerifiedRanges(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	anonymous := httptest.NewRecorder()
	f.store.ServeFile(anonymous, httptest.NewRequest(http.MethodGet, "/uploads/"+f.key, nil), f.key)
	if anonymous.Code != http.StatusNotFound {
		t.Fatal("fixed file escaped through the anonymous attachment endpoint")
	}
	var link service.CockpitArtifactDownloadLink
	response := f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusOK).JSON(&link)
	if f.store.reads != 0 {
		t.Fatal("minting a bounded link read the file body")
	}
	if link.WorkspaceID != f.workspace || link.ArtifactID != f.artifact || link.VersionID != f.version || !strings.HasPrefix(link.URL, "/api/cockpit/artifact-files/"+f.version+"/download?token=") {
		t.Fatalf("wrong scoped link: %+v", link)
	}
	expires, err := time.Parse(time.RFC3339, link.ExpiresAt)
	if err != nil || time.Until(expires) <= 0 || time.Until(expires) > time.Minute {
		t.Fatalf("invalid short expiry: %s (%v)", link.ExpiresAt, err)
	}
	if strings.Contains(response.Body.String(), f.key) || strings.Contains(response.Body.String(), "storage_key") || response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal("link response exposed storage or allowed capability caching")
	}
	stream := testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusOK)
	if stream.Body.String() != f.body || stream.Header().Get("ETag") != `"`+f.hash+`"` || !strings.HasPrefix(stream.Header().Get("Content-Disposition"), "attachment;") || stream.Header().Get("X-Content-Type-Options") != "nosniff" || stream.Header().Get("Referrer-Policy") != "no-referrer" || stream.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("unsafe or incorrect file response: headers=%v bytes=%q", stream.Header(), stream.Body.String())
	}
	rangeRequest := f.signedRequest(link.URL)
	rangeRequest.Header.Set("Range", "bytes=0-5")
	ranged := testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, rangeRequest).Want(http.StatusPartialContent)
	if ranged.Body.String() != f.body[:6] || ranged.Header().Get("Content-Range") != fmt.Sprintf("bytes 0-5/%d", len([]byte(f.body))) {
		t.Fatalf("wrong verified range: %s %q", ranged.Header().Get("Content-Range"), ranged.Body.String())
	}
	f.authenticated(t, f.handler.DownloadCockpitArtifactFile, "download").Want(http.StatusOK)
}

type publicArtifactFileStore struct{ *observedArtifactFileStore }

func (s publicArtifactFileStore) SupportsPrivateArtifactFiles() bool { return false }

func TestCockpitArtifactFileHTTPRequiresConfirmedPrivateProvider(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	var link service.CockpitArtifactDownloadLink
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusOK).JSON(&link)
	f.handler.Storage = publicArtifactFileStore{f.store}
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusForbidden)
	f.authenticated(t, f.handler.DownloadCockpitArtifactFile, "download").Want(http.StatusForbidden)
	testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusForbidden)
	if f.store.reads != 0 {
		t.Fatal("unconfirmed private provider was read")
	}
}

func TestCockpitArtifactFileHTTPRefusesCrossScopeAndRevokedMembership(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	other := cockpitFixture(t, "Other artifact file workspace")
	request := testutil.WithURLParams(cockpitRequest(http.MethodGet, "/file", other, nil), "artifactId", f.artifact, "versionId", f.version)
	testutil.Call(t, cockpitHandler(f.handler.GetCockpitArtifactDownloadLink), request).Want(http.StatusNotFound)
	var link service.CockpitArtifactDownloadLink
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusOK).JSON(&link)
	wrongVersion := testutil.WithURLParams(httptest.NewRequest(http.MethodGet, link.URL, nil), "versionId", uuid.NewString())
	testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, wrongVersion).Want(http.StatusForbidden)
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.workspace, testUserID)
	testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusForbidden)
	if f.store.reads != 0 {
		t.Fatal("rejected authorization opened file storage")
	}
}

func TestCockpitArtifactFileHTTPRejectsChangedBytesAndRechecksAfterVerification(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	var link service.CockpitArtifactDownloadLink
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusOK).JSON(&link)
	if _, err := f.store.Upload(context.Background(), f.key, []byte("changed storage"), "text/plain", "file.txt"); err != nil {
		t.Fatal(err)
	}
	rejected := testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusConflict)
	if strings.Contains(rejected.Body.String(), "changed storage") || strings.Contains(rejected.Body.String(), f.key) {
		t.Fatal("unverified bytes or storage identity escaped in an error")
	}
	if _, err := f.store.Upload(context.Background(), f.key, []byte(f.body), "text/plain", "file.txt"); err != nil {
		t.Fatal(err)
	}
	f.store.afterClose = func() {
		dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", f.workspace, testUserID)
	}
	testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusForbidden)
}

func TestCockpitArtifactFileHTTPKeepsVerifiedBytesAfterStorageReplacement(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	var link service.CockpitArtifactDownloadLink
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusOK).JSON(&link)
	f.store.afterClose = func() {
		if _, err := f.store.Upload(context.Background(), f.key, []byte("replacement after verification"), "text/plain", "file.txt"); err != nil {
			t.Fatal(err)
		}
	}
	response := testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest(link.URL)).Want(http.StatusOK)
	if response.Body.String() != f.body || f.store.reads != 1 {
		t.Fatalf("response did not use the verified single read: opens=%d body=%q", f.store.reads, response.Body.String())
	}
}

func TestCockpitArtifactFileHTTPUnavailableBackendDoesNotReadStorage(t *testing.T) {
	f := newCockpitArtifactFileFixture(t)
	f.handler.IssueService.CockpitArtifactBackendReady = false
	f.authenticated(t, f.handler.GetCockpitArtifactDownloadLink, "download-link").Want(http.StatusServiceUnavailable)
	f.authenticated(t, f.handler.DownloadCockpitArtifactFile, "download").Want(http.StatusServiceUnavailable)
	testutil.Call(t, f.handler.DownloadCockpitArtifactSignedFile, f.signedRequest("/download?token=unavailable")).Want(http.StatusServiceUnavailable)
	if f.store.reads != 0 {
		t.Fatal("an unavailable backend opened file storage")
	}
}
