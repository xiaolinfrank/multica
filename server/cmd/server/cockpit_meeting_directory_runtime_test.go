package main

import (
	"testing"

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestCockpitDirectoryRuntimeRequiresCompleteDependenciesButNotConfiguredRoot(t *testing.T) {
	empty, err := cockpitnas.New("")
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range []*handler.Handler{nil, {}, {IssueService: &service.IssueService{CockpitMeetingDirectoryBackendReady: true}}} {
		if enableCockpitMeetingDirectoryRuntime(h, empty, "") {
			t.Fatal("incomplete directory runtime advertised availability")
		}
		if h != nil && h.IssueService != nil && h.IssueService.CockpitMeetingDirectoryBackendReady {
			t.Fatal("stale ready flag survived incomplete wiring")
		}
	}
	s := service.NewIssueService(db.New(nil), artifactRuntimeNoIOTx{}, nil, nil, nil)
	h := &handler.Handler{IssueService: s}
	if !enableCockpitMeetingDirectoryRuntime(h, empty, "") || !s.CockpitMeetingDirectoryBackendReady || s.CockpitDirectoryPreparer != empty {
		t.Fatal("valid rootless runtime must retain history reads")
	}
	if enableCockpitMeetingDirectoryRuntime(h, nil, "") || s.CockpitMeetingDirectoryBackendReady {
		t.Fatal("unconfigured filesystem implementation remained ready")
	}
	if !enableCockpitMeetingDirectoryRuntime(h, nil, "prepare_configuration_invalid") || s.CockpitDirectoryConfigurationError != "prepare_configuration_invalid" || s.CockpitDirectoryPreparer != nil {
		t.Fatal("invalid root configuration hid retained history or fabricated a provider")
	}
	if s.CockpitArtifactBackendReady || s.CockpitMeetingTemplatesBackendReady || s.CockpitMeetingDispositionBackendReady {
		t.Fatal("directory setup advertised unrelated capabilities")
	}
}
