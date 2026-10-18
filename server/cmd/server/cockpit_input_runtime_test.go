package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/analytics"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitInputRuntimeDoesNotConfuseStorageWithCompleteCapability(t *testing.T) {
	s := &service.IssueService{CockpitInputBackendReady: true, CockpitRunInputManifestBackendReady: true}
	configureCockpitInputRuntime(&handler.Handler{IssueService: s}, nil, "input_configuration_invalid")
	if s.CockpitInputBackendReady || s.CockpitRunInputManifestBackendReady {
		t.Fatal("storage configuration exposed incomplete business or Run services")
	}
	if s.CockpitInputNAS != nil || s.CockpitInputConfigurationError != "input_configuration_invalid" {
		t.Fatal("invalid NAS configuration was hidden by an empty provider")
	}
}

func TestCockpitInputRuntimeSeparatesHistoryFromPrivateStorageAndNAS(t *testing.T) {
	q := db.New(nil)
	tasks := &service.TaskService{Queries: q, TxStarter: artifactRuntimeNoIOTx{}}
	s := service.NewIssueService(q, artifactRuntimeNoIOTx{}, nil, nil, tasks)
	h := &handler.Handler{IssueService: s, Storage: &storage.S3Storage{}}
	configureCockpitInputRuntime(h, nil, "input_configuration_invalid")
	if !s.CockpitInputBackendReady || !s.CockpitRunInputManifestBackendReady {
		t.Fatal("complete canonical wiring did not expose text/history/Run metadata")
	}
	if s.CockpitInputConfigurationError != "input_configuration_invalid" || storage.SupportsPrivateInputFiles(h.Storage) {
		t.Fatal("history readiness manufactured NAS or private file authority")
	}
	tasks.TxStarter = nil
	configureCockpitInputRuntime(h, nil, "")
	if s.CockpitInputBackendReady || s.CockpitRunInputManifestBackendReady {
		t.Fatal("incomplete canonical task transaction left stale input readiness enabled")
	}
}

func TestCockpitInputUploadCORSAllowsExactRevisionHeader(t *testing.T) {
	const origin = "https://input-client.example"
	t.Setenv("CORS_ALLOWED_ORIGINS", origin)
	router := NewRouter(nil, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil)
	req := httptest.NewRequest(http.MethodOptions, "/api/cockpit/inputs/10000000-0000-4000-8000-000000000001/versions/10000000-0000-4000-8000-000000000002/transfers/10000000-0000-4000-8000-000000000003/bytes", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type, X-Workspace-ID, X-Input-Transfer-Revision")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !headerListContains(rec.Header().Get("Access-Control-Allow-Headers"), "X-Input-Transfer-Revision") {
		t.Fatalf("upload preflight failed: status=%d headers=%v", rec.Code, rec.Header())
	}
}
