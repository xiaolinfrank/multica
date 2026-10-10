package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/storage"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"testing"
)

type artifactRuntimeNoIOTx struct{}

func (artifactRuntimeNoIOTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("runtime initialization must not access database")
}
func TestCockpitArtifactRuntimeRequiresCompleteDI(t *testing.T) {
	for _, h := range []*handler.Handler{nil, {}, {IssueService: &service.IssueService{CockpitArtifactBackendReady: true}}} {
		if enableCockpitArtifactRuntime(h) {
			t.Fatal("partially wired domain runtime became available")
		}
		if h != nil && h.IssueService != nil && h.IssueService.CockpitArtifactBackendReady {
			t.Fatal("stale readiness survived missing dependencies")
		}
	}
	svc := service.NewIssueService(db.New(nil), artifactRuntimeNoIOTx{}, nil, nil, &service.TaskService{})
	h := &handler.Handler{IssueService: svc}
	if !enableCockpitArtifactRuntime(h) || !svc.CockpitArtifactBackendReady {
		t.Fatal("complete domain runtime did not become available")
	}
}
func TestCockpitArtifactRuntimeSeparatesPrivateFileCapability(t *testing.T) {
	svc := service.NewIssueService(db.New(nil), artifactRuntimeNoIOTx{}, nil, nil, &service.TaskService{})
	h := &handler.Handler{IssueService: svc}
	if svc.ConfigureCockpitArtifactStorage(&storage.S3Storage{}) {
		t.Fatal("unverified public S3 advertised private file support")
	}
	if !enableCockpitArtifactRuntime(h) || !svc.CockpitArtifactBackendReady {
		t.Fatal("file-provider limitation disabled text and acceptance")
	}
	if storage.SupportsPrivateArtifactFiles(svc.CockpitArtifactStorage) {
		t.Fatal("runtime enablement changed storage authorization")
	}
	if !svc.ConfigureCockpitArtifactStorage(&storage.LocalStorage{}) {
		t.Fatal("the guarded local namespace did not expose file support")
	}
	if !svc.CockpitArtifactBackendReady {
		t.Fatal("changing file support discarded domain readiness")
	}
}
