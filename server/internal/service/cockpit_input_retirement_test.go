package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputRetirementKeepsUnboundVersionCommandHash(t *testing.T) {
	p := CockpitInputQuery{InputID: dbid.NewV7()}
	in := CockpitInputVersionSubmitInput{CommandKey: "10000000-0000-0000-0000-000000000001", ExpectedRevision: 1}
	// The former nullable relationship contributed null even when omitted.
	legacy := struct {
		CommandKey       string                  `json:"command_key"`
		ExpectedRevision int64                   `json:"expected_revision"`
		Source           CockpitInputSourceInput `json:"source"`
		InitialReference *struct{}               `json:"initial_reference"`
	}{CommandKey: in.CommandKey, ExpectedRevision: in.ExpectedRevision, Source: in.Source}
	want := inputWriteHash(p.CockpitInputRead, "input_version_submit", p.InputID, legacy)
	for _, value := range []json.RawMessage{nil, json.RawMessage("null")} {
		in.InitialReference = value
		if got := inputWriteHash(p.CockpitInputRead, "input_version_submit", p.InputID, in); got != want {
			t.Fatal("retiring meeting references changed an existing unbound version's command identity")
		}
	}
}

func TestCockpitInputRetirementRejectsMeetingReferenceBeforeWriting(t *testing.T) {
	s := &IssueService{}
	in := CockpitInputVersionSubmitInput{CommandKey: "10000000-0000-0000-0000-000000000001", ExpectedRevision: 1, InitialReference: json.RawMessage(`{"meeting_id":"20000000-0000-0000-0000-000000000001"}`)}
	_, err := s.SubmitCockpitInputVersion(context.Background(), CockpitInputQuery{}, in)
	if !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("retired reference reached a write: %v", err)
	}
}
