package service

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestCockpitArtifactPayloadPreservesExactVersionBytes(t *testing.T) {
	content := "# 成果\nEvidence  \n"
	payload, err := NormalizeCockpitArtifactPayload(CockpitArtifactPayload{Kind: "text", Content: &content})
	if err != nil {
		t.Fatal(err)
	}
	if payload.Content != content || payload.ContentHash != fmt.Sprintf("%x", sha256.Sum256([]byte(content))) {
		t.Fatalf("text version was normalized or fingerprinted incorrectly: %+v", payload)
	}
	changed := strings.TrimSpace(content)
	other, err := NormalizeCockpitArtifactPayload(CockpitArtifactPayload{Kind: "text", Content: &changed})
	if err != nil || payload.ContentHash == other.ContentHash {
		t.Fatal("trailing bytes did not distinguish versions")
	}
}

func TestCockpitArtifactPayloadRefusesAmbiguousAndUnboundedInputs(t *testing.T) {
	content, attachment := "content", "10000000-0000-4000-8000-000000000001"
	blank, huge := " \n\t ", strings.Repeat("x", CockpitArtifactMaxTextBytes+1)
	for _, input := range []CockpitArtifactPayload{
		{Kind: "text"}, {Kind: "text", Content: &blank}, {Kind: "text", Content: &huge},
		{Kind: "text", Content: &content, AttachmentID: &attachment}, {Kind: "attachment", Content: &content, AttachmentID: &attachment},
		{Kind: "attachment"}, {Kind: "remote_url", Content: &content},
	} {
		if _, err := NormalizeCockpitArtifactPayload(input); !errors.Is(err, ErrCockpitWorkflowInput) {
			t.Fatalf("invalid payload accepted: %+v, err=%v", input, err)
		}
	}
	file, err := NormalizeCockpitArtifactPayload(CockpitArtifactPayload{Kind: "attachment", AttachmentID: &attachment})
	if err != nil || file.AttachmentID != attachment || file.ContentHash != "" {
		t.Fatalf("uncaptured attachment advertised a content fingerprint: %+v %v", file, err)
	}
}

func TestCockpitAcceptanceCriteriaKeepStableIdentityAndRejectDuplicates(t *testing.T) {
	id := "10000000-0000-4000-8000-000000000001"
	input := []CockpitAcceptanceCriterionInput{{ID: id, Title: "  Check evidence  ", Description: "Review the fixed report."}}
	criteria, err := NormalizeCockpitAcceptanceCriteria(input)
	if err != nil || criteria[0].ID != id || criteria[0].Title != "Check evidence" || input[0].Title != "  Check evidence  " {
		t.Fatalf("criteria normalization damaged identity or input: %+v %v", criteria, err)
	}
	if _, err := NormalizeCockpitAcceptanceCriteria(append(input, input[0])); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("duplicate criterion identity accepted: %v", err)
	}
	if _, err := NormalizeCockpitAcceptanceCriteria([]CockpitAcceptanceCriterionInput{{ID: id, Title: ""}}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("empty acceptance condition accepted: %v", err)
	}
}

func TestCockpitAcceptanceEvidenceIdentityIsOrderIndependentAndVersionSpecific(t *testing.T) {
	c1, c2 := "10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"
	v1, v2, v3 := "20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000003"
	input := []CockpitAcceptanceEvidenceInput{{CriterionID: c2, VersionIDs: []string{v2, v1}}, {CriterionID: c1, VersionIDs: []string{v1}}}
	first, err := NormalizeCockpitAcceptanceEvidence(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NormalizeCockpitAcceptanceEvidence([]CockpitAcceptanceEvidenceInput{{CriterionID: c1, VersionIDs: []string{v1}}, {CriterionID: c2, VersionIDs: []string{v1, v2}}})
	if err != nil || !reflect.DeepEqual(first, second) || input[0].VersionIDs[0] != v2 {
		t.Fatalf("equivalent evidence changed identity or caller input: %+v %+v %v", first, second, err)
	}
	one, _ := cockpitArtifactFingerprint(first)
	two, _ := cockpitArtifactFingerprint(second)
	second[1].VersionIDs[1] = v3
	changed, _ := cockpitArtifactFingerprint(second)
	if one != two || one == changed {
		t.Fatal("fingerprint did not distinguish a different fixed version")
	}
	if _, err := NormalizeCockpitAcceptanceEvidence([]CockpitAcceptanceEvidenceInput{{CriterionID: c1, VersionIDs: []string{v1, v1}}}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("duplicate evidence accepted: %v", err)
	}
	if _, err := NormalizeCockpitAcceptanceEvidence([]CockpitAcceptanceEvidenceInput{{CriterionID: c1}}); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("criterion without fixed evidence accepted: %v", err)
	}
}
