package service

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Formal review facts are independent of the linked Issue's editable status and assignee.
type cockpitFormalReviewFacts struct {
	Revision      int64
	ReviewerID    string
	ReviewedBy    string
	Decision      string
	Feedback      string
	Ready         bool
	Current       bool
	Superseded    bool
	ReviewIssueID string
}

func validateCockpitFormalReview(facts cockpitFormalReviewFacts, actorID string, human bool, expectedRevision int64, decision, feedback string) (string, bool, error) {
	if !human || actorID == "" || actorID != facts.ReviewerID {
		return "", false, ErrCockpitWorkflowForbidden
	}
	feedback = strings.TrimSpace(feedback)
	if (decision != "approved" && decision != "changes_requested" && decision != "rejected") || !utf8.ValidString(feedback) || len(feedback) > 16000 || (decision != "approved" && feedback == "") {
		return "", false, fmt.Errorf("%w: choose approved, changes_requested or rejected; a non-approval requires feedback up to 16000 UTF-8 bytes", ErrCockpitWorkflowInput)
	}
	if facts.Decision == decision && facts.Feedback == feedback && facts.ReviewedBy == actorID && facts.Ready && facts.ReviewIssueID != "" {
		return feedback, true, nil
	}
	if !facts.Current || facts.Superseded || !facts.Ready || facts.ReviewIssueID == "" || facts.Decision != "pending" || expectedRevision < 1 || facts.Revision != expectedRevision {
		return "", false, fmt.Errorf("%w: review the current fixed version and its designated human review request", ErrCockpitWorkflowConflict)
	}
	return feedback, false, nil
}

// A new submission never strands an active capture or pending formal review.
func validateCockpitArtifactSubmission(archived bool, current *CockpitArtifactVersionMetadata) error {
	if archived {
		return fmt.Errorf("%w: restore the archived artifact before submitting a version", ErrCockpitWorkflowConflict)
	}
	if current == nil {
		return nil
	}
	if current.CaptureStatus == "needs_attention" && current.Decision == "not_requested" {
		return nil
	}
	if current.CaptureStatus == "ready" && (current.Decision == "approved" || current.Decision == "changes_requested" || current.Decision == "rejected") {
		return nil
	}
	return fmt.Errorf("%w: finish or explicitly recover the current capture/review before submitting another version", ErrCockpitWorkflowConflict)
}

func validateCockpitAcceptanceReplacement(currentID, currentDecision string, currentStale bool, supersedesID string) error {
	if currentID == "" || currentDecision == "approved" || currentDecision == "changes_requested" || currentDecision == "rejected" {
		if supersedesID != "" {
			return fmt.Errorf("%w: there is no matching pending acceptance request to replace", ErrCockpitWorkflowConflict)
		}
		return nil
	}
	if currentDecision != "pending" || !currentStale || supersedesID != currentID {
		return fmt.Errorf("%w: replace the explicitly identified stale acceptance request; an active review cannot be silently replaced", ErrCockpitWorkflowConflict)
	}
	return nil
}

func validateCockpitAcceptanceEvidenceCurrent(criteriaCurrent, approvedVersionsCurrent bool) error {
	if !criteriaCurrent || !approvedVersionsCurrent {
		return fmt.Errorf("%w: acceptance conditions or approved artifact versions changed; create a new acceptance request with the current evidence", ErrCockpitWorkflowConflict)
	}
	return nil
}
