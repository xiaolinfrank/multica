package main

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitMeetingPreparationRuntimeRequiresCanonicalTransactions(t *testing.T) {
	for _, h := range []*handler.Handler{nil, {}, {IssueService: &service.IssueService{CockpitMeetingTemplatesBackendReady: true, CockpitMeetingDispositionBackendReady: true}}, {IssueService: service.NewIssueService(db.New(nil), artifactRuntimeNoIOTx{}, nil, nil, &service.TaskService{})}} {
		if enableCockpitMeetingPreparationRuntime(h) {
			t.Fatal("incomplete canonical transaction dependencies advertised preparation")
		}
		if h != nil && h.IssueService != nil && (h.IssueService.CockpitMeetingTemplatesBackendReady || h.IssueService.CockpitMeetingDispositionBackendReady) {
			t.Fatal("stale availability survived partial initialization")
		}
	}
	q := db.New(nil)
	tasks := service.NewTaskService(q, artifactRuntimeNoIOTx{}, nil, nil)
	svc := service.NewIssueService(q, artifactRuntimeNoIOTx{}, nil, nil, tasks)
	if !enableCockpitMeetingPreparationRuntime(&handler.Handler{IssueService: svc}) || !svc.CockpitMeetingTemplatesBackendReady || !svc.CockpitMeetingDispositionBackendReady {
		t.Fatal("fully wired preparation/disposition remained unavailable")
	}
	if svc.CockpitArtifactBackendReady || svc.CockpitArtifactCapturer != nil {
		t.Fatal("preparation availability fabricated storage or artifact readiness")
	}
}
