package handler

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitInputHTTPRawUploadFinalizeAndPrivateSignedDownload(t *testing.T) {
	ws := dbfx.Workspace(t, "Input file HTTP", "input-file-http-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	dbfx.Cleanup(t, "DELETE FROM search_index_change WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input_version WHERE workspace_id=$1", ws)
	dbfx.Cleanup(t, "DELETE FROM cockpit_input_transfer WHERE workspace_id=$1", ws)
	t.Setenv("LOCAL_UPLOAD_DIR", t.TempDir())
	t.Setenv("LOCAL_UPLOAD_BASE_URL", "")
	store := storage.NewLocalStorageFromEnv()
	h := *testHandler
	h.Storage = store
	h.IssueService = &service.IssueService{Queries: h.Queries, TxStarter: testPool, TaskService: h.TaskService, CockpitInputBackendReady: true, CockpitRunInputManifestBackendReady: true}
	if !h.IssueService.ConfigureCockpitInputStorage(store) {
		t.Fatal("owned private input storage unavailable")
	}
	var created service.CockpitInputCreateResult
	testutil.Call(t, cockpitHandler(h.CreateCockpitInput), cockpitRequest(http.MethodPost, "/api/cockpit/inputs", ws, map[string]any{"command_key": uuid.NewString(), "title": "Exact recording", "description": ""})).Want(200).JSON(&created)
	input := created.Receipt.InputID
	body := "  exact input bytes\x00\n中文尾部  \n"
	size := int64(len(body))
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
	var submitted service.CockpitInputVersionResult
	req := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/api/cockpit/inputs/"+input+"/versions", ws, service.CockpitInputVersionSubmitInput{CommandKey: uuid.NewString(), ExpectedRevision: 1, Source: service.CockpitInputSourceInput{Kind: "upload", Upload: &service.CockpitInputUploadSource{Filename: "recording.bin", ContentType: "application/octet-stream", SizeBytes: &size}}}), "inputId", input)
	testutil.Call(t, cockpitHandler(h.SubmitCockpitInputVersion), req).Want(200).JSON(&submitted)
	if submitted.Receipt.TransferID == nil || submitted.Receipt.TransferRevision == nil {
		t.Fatal("upload confirmation omitted its exact session")
	}
	version, transfer := submitted.Receipt.VersionID, *submitted.Receipt.TransferID
	url := "/api/cockpit/inputs/" + input + "/versions/" + version + "/transfers/" + transfer + "/bytes"
	upload := testutil.WithURLParams(httptest.NewRequest(http.MethodPut, url, strings.NewReader(body)), "inputId", input, "versionId", version, "transferId", transfer)
	upload.Header.Set("X-User-ID", testUserID)
	upload.Header.Set("X-Workspace-ID", ws)
	upload.Header.Set("Content-Type", "application/octet-stream")
	upload.Header.Set("X-Input-Transfer-Revision", strconv.FormatInt(*submitted.Receipt.TransferRevision, 10))
	var accepted service.CockpitInputUploadResult
	testutil.Call(t, withInputRecorderDeadlines(cockpitHandler(h.UploadCockpitInputBytes)), upload).Want(200).JSON(&accepted)
	if accepted.Current == nil || accepted.Current.State != "awaiting_finalize" {
		t.Fatalf("raw byte checkpoint: %+v", accepted)
	}
	finalize := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/finalize", ws, service.CockpitInputFinalizeInput{CommandKey: uuid.NewString(), ExpectedRevision: accepted.Current.Revision, ExpectedContentHash: hash}), "inputId", input, "versionId", version, "transferId", transfer)
	testutil.Call(t, cockpitHandler(h.FinalizeCockpitInputTransfer), finalize).Want(200)
	row, err := h.Queries.GetCockpitInputTransfer(context.Background(), db.GetCockpitInputTransferParams{WorkspaceID: parseUUID(ws), InputID: parseUUID(input), VersionID: parseUUID(version), ID: parseUUID(transfer)})
	if err != nil {
		t.Fatal(err)
	}
	anon := httptest.NewRecorder()
	store.ServeFile(anon, httptest.NewRequest(http.MethodGet, "/uploads/"+row.OwnedStorageKey, nil), row.OwnedStorageKey)
	if anon.Code != 404 {
		t.Fatalf("private input object exposed anonymously: %d", anon.Code)
	}
	var link service.CockpitInputDownloadLink
	linkReq := testutil.WithURLParams(cockpitRequest(http.MethodPost, "/download-link", ws, nil), "inputId", input, "versionId", version)
	response := testutil.Call(t, cockpitHandler(h.GetCockpitInputDownloadLink), linkReq).Want(200).JSON(&link)
	expires, err := time.Parse(time.RFC3339, link.ExpiresAt)
	if err != nil || time.Until(expires) <= 0 || time.Until(expires) > time.Minute || link.ContentHash != hash || link.SizeBytes != size || strings.Contains(response.Body.String(), row.OwnedStorageKey) {
		t.Fatalf("unsafe download capability: %+v %v", link, err)
	}
	signed := func(path string) *http.Request {
		return testutil.WithURLParams(httptest.NewRequest(http.MethodGet, path, nil), "versionId", version)
	}
	read := testutil.Call(t, withInputRecorderDeadlines(h.DownloadCockpitInputSignedFile), signed(link.URL)).Want(200)
	if read.Body.String() != body || read.Header().Get("ETag") != `"`+hash+`"` || read.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("download changed bytes or exposed unsafe headers")
	}
	rangeReq := signed(link.URL)
	rangeReq.Header.Set("Range", "bytes=0-5")
	ranged := testutil.Call(t, withInputRecorderDeadlines(h.DownloadCockpitInputSignedFile), rangeReq).Want(206)
	if ranged.Body.String() != body[:6] {
		t.Fatal("range did not use the verified fixed bytes")
	}
	testutil.Call(t, h.DownloadCockpitInputSignedFile, signed(link.URL+"&token=ambiguous")).Want(403)
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", ws, testUserID)
	testutil.Call(t, withInputRecorderDeadlines(h.DownloadCockpitInputSignedFile), signed(link.URL)).Want(403)
}
