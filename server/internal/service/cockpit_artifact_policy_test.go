package service

import (
	"errors"
	"testing"
)

func TestCockpitArtifactFormalReviewRejectsMachineAndOrdinaryTaskAuthority(t *testing.T) {
	facts := cockpitFormalReviewFacts{Revision: 3, ReviewerID: "designated-reviewer", Decision: "pending", Ready: true, Current: true, ReviewIssueID: "human-review-issue"}
	for _, actor := range []struct {
		id    string
		human bool
	}{{"designated-reviewer", false}, {"ordinary-issue-assignee", true}, {"workspace-admin", true}} {
		if _, _, err := validateCockpitFormalReview(facts, actor.id, actor.human, 3, "approved", ""); !errors.Is(err, ErrCockpitWorkflowForbidden) {
			t.Fatalf("unassigned formal authority accepted: %+v %v", actor, err)
		}
	}
	if _, replay, err := validateCockpitFormalReview(facts, facts.ReviewerID, true, 3, "approved", ""); err != nil || replay {
		t.Fatalf("valid human review rejected: %v replay=%v", err, replay)
	}
	// No Issue status or ordinary assignee is part of the decision input.
	facts.ReviewIssueID = ""
	if _, _, err := validateCockpitFormalReview(facts, facts.ReviewerID, true, 3, "approved", ""); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("missing formal review accepted: %v", err)
	}
}

func TestCockpitArtifactFormalDecisionReplayPreservesTheOriginalConclusion(t *testing.T) {
	facts := cockpitFormalReviewFacts{Revision: 5, ReviewerID: "reviewer", ReviewedBy: "reviewer", Decision: "changes_requested", Feedback: "Missing evidence", Ready: true, ReviewIssueID: "review"}
	if feedback, replay, err := validateCockpitFormalReview(facts, "reviewer", true, 3, "changes_requested", " Missing evidence "); err != nil || !replay || feedback != facts.Feedback {
		t.Fatalf("same decision replay failed: %q %v %v", feedback, replay, err)
	}
	if _, _, err := validateCockpitFormalReview(facts, "reviewer", true, 5, "approved", ""); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("terminal decision was replaced: %v", err)
	}
	if _, _, err := validateCockpitFormalReview(facts, "reviewer", true, 5, "rejected", ""); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("rejection without a reason was accepted: %v", err)
	}
}

func TestCockpitArtifactSubmissionDoesNotReplaceActiveCaptureOrReview(t *testing.T) {
	for _, current := range []CockpitArtifactVersionMetadata{{CaptureStatus: "queued", Decision: "not_requested"}, {CaptureStatus: "running", Decision: "not_requested"},
		{CaptureStatus: "retry_wait", Decision: "not_requested"}, {CaptureStatus: "ready", Decision: "pending"}, {CaptureStatus: "future-state", Decision: "future-decision"}} {
		if err := validateCockpitArtifactSubmission(false, &current); !errors.Is(err, ErrCockpitWorkflowConflict) {
			t.Fatalf("active or unknown lifecycle replaced: %+v %v", current, err)
		}
	}
	for _, current := range []CockpitArtifactVersionMetadata{{CaptureStatus: "ready", Decision: "approved"}, {CaptureStatus: "ready", Decision: "changes_requested"},
		{CaptureStatus: "ready", Decision: "rejected"}, {CaptureStatus: "needs_attention", Decision: "not_requested"}} {
		if err := validateCockpitArtifactSubmission(false, &current); err != nil {
			t.Fatalf("completed or explicitly failed lifecycle cannot be revised: %+v %v", current, err)
		}
	}
	if err := validateCockpitArtifactSubmission(true, nil); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("archived artifact accepted new work: %v", err)
	}
}

func TestCockpitAcceptanceRequiresCurrentEvidenceAndExplicitStaleReplacement(t *testing.T) {
	if err := validateCockpitAcceptanceEvidenceCurrent(true, false); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("superseded artifact evidence accepted: %v", err)
	}
	if err := validateCockpitAcceptanceEvidenceCurrent(false, true); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("changed definition accepted: %v", err)
	}
	for _, command := range []struct {
		stale bool
		id    string
	}{{true, ""}, {true, "different-request"}, {false, "pending-request"}} {
		if err := validateCockpitAcceptanceReplacement("pending-request", "pending", command.stale, command.id); !errors.Is(err, ErrCockpitWorkflowConflict) {
			t.Fatalf("unconfirmed or active request replaced: %+v %v", command, err)
		}
	}
	if err := validateCockpitAcceptanceReplacement("pending-request", "pending", true, "pending-request"); err != nil {
		t.Fatal(err)
	}
	if err := validateCockpitAcceptanceReplacement("approved-request", "approved", false, ""); err != nil {
		t.Fatalf("new round after a terminal request rejected: %v", err)
	}
	if err := validateCockpitAcceptanceReplacement("future-request", "future-decision", true, "future-request"); !errors.Is(err, ErrCockpitWorkflowConflict) {
		t.Fatalf("unknown formal state was replaced: %v", err)
	}
}
