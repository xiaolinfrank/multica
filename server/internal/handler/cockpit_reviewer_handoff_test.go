package handler

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestCockpitReviewerHandoffHTTPRecoversDepartedReviewer(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	originalReviewer := dbfx.User(t, "Original reviewer", "original-"+uuid.NewString()+"@example.com")
	replacement := dbfx.User(t, "Replacement reviewer", "replacement-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, ws, originalReviewer, "member")
	dbfx.Member(t, ws, replacement, "member")
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": originalReviewer}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.UpdateCockpitMeetingReadiness, http.MethodPatch, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "ended": true, "materials_ready": true}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ReleaseCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.SubmitCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"expected_revision": state.Revision, "submission_key": uuid.NewString(), "content": "# Agreed scope\n\nKeep the evidence fixed across reviewer changes."}).Want(http.StatusOK).JSON(&state)
	original := state.Versions[0]
	originalReviewIssue := *original.ReviewIssue
	original.ReviewIssue = &originalReviewIssue
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", ws, originalReviewer)
	key := uuid.NewString()
	command := map[string]any{"expected_revision": state.Revision, "handoff_key": key, "reviewer_id": replacement, "reason": "  Original reviewer left the team.  "}
	callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, "", "", command).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, "", "", command).Want(http.StatusOK).JSON(&state)
	if len(state.ReviewerHandoffs) != 1 || len(state.Versions) != 1 || !state.CanReassignReviewer {
		t.Fatalf("handover did not return a single authoritative history record: %+v", state)
	}
	handoff, current := state.ReviewerHandoffs[0], state.Versions[0]
	if handoff.HandoffKey != key || handoff.CreatedBy != testUserID || handoff.FromReviewerID != originalReviewer || handoff.ToReviewerID != replacement || handoff.Reason != "Original reviewer left the team." || handoff.VersionID == nil || *handoff.VersionID != original.ID {
		t.Fatalf("handover audit identity was lost: %+v", handoff)
	}
	if handoff.FromReviewerName != "Original reviewer" || handoff.ToReviewerName != "Replacement reviewer" {
		t.Fatalf("departed participants lost their readable identity: from=%q to=%q", handoff.FromReviewerName, handoff.ToReviewerName)
	}
	if handoff.FromReviewIssue == nil || handoff.FromReviewIssue.ID != original.ReviewIssue.ID || handoff.FromReviewIssue.Status != "cancelled" || handoff.ToReviewIssue == nil || handoff.ToReviewIssue.ID != current.ReviewIssue.ID || current.ReviewIssue.ID == original.ReviewIssue.ID {
		t.Fatalf("old and new responsibilities are not distinct: from=%+v to=%+v original=%s current=%s", handoff.FromReviewIssue, handoff.ToReviewIssue, original.ReviewIssue.ID, current.ReviewIssue.ID)
	}
	if current.ID != original.ID || current.Content != original.Content || current.ContentHash != original.ContentHash || current.SubmissionKey != original.SubmissionKey || current.VersionNumber != original.VersionNumber || current.SubmittedByID != original.SubmittedByID || current.Decision != "pending" || current.ReviewerID != replacement {
		t.Fatalf("handover rewrote fixed evidence or fabricated a decision: %+v", current)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 3 {
		t.Fatal("handover retry created extra review issues")
	}

	// Rejoining restores membership, but it cannot restore superseded authority.
	dbfx.Member(t, ws, originalReviewer, "member")
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, originalReviewer, current.ID,
		map[string]any{"expected_revision": state.Revision, "decision": "approved"}).Want(http.StatusForbidden)
	testutil.Call(t, testHandler.DeleteIssue, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/issue", ws, nil), "id", original.ReviewIssue.ID)).Want(http.StatusConflict)
	setMeetingRoles(t, ws, meeting.ID, original.ReviewIssue.ID, map[string]any{"roles": []string{"reference"}}).Want(http.StatusConflict)
	testutil.Call(t, cockpitHandler(testHandler.DeleteCockpitMeetingIssue), testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/unlink", ws, nil), "meetingId", meeting.ID, "issueId", original.ReviewIssue.ID)).Want(http.StatusConflict)

	// Ordinary reassignment/completion cannot grant the former reviewer approval.
	testutil.Call(t, testHandler.UpdateIssue, testutil.WithURLParams(cockpitRequest(http.MethodPut, "/issue", ws,
		map[string]any{"status": "done", "assignee_type": "member", "assignee_id": originalReviewer}), "id", current.ReviewIssue.ID)).Want(http.StatusOK)
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, originalReviewer, current.ID,
		map[string]any{"expected_revision": state.Revision, "decision": "approved"}).Want(http.StatusForbidden)
	callCockpitWorkflow(t, testHandler.ReviewCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, replacement, current.ID,
		map[string]any{"expected_revision": state.Revision, "decision": "approved", "feedback": "Verified the unchanged source."}).Want(http.StatusOK).JSON(&state)
	callCockpitWorkflow(t, testHandler.PublishCockpitMeetingMinutes, http.MethodPost, ws, meeting.ID, "", current.ID,
		map[string]any{"expected_revision": state.Revision}).Want(http.StatusOK).JSON(&state)
	if state.PublishedVersionID == nil || *state.PublishedVersionID != original.ID || state.Versions[0].ReviewedBy == nil || *state.Versions[0].ReviewedBy != replacement {
		t.Fatal("the new reviewer could not complete and publish the original evidence")
	}
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(cockpitRequest(http.MethodDelete, "/api/workspaces/"+ws, ws, nil), "id", ws)).Want(http.StatusNoContent)
	if dbfx.Count(t, "SELECT count(*) FROM cockpit_reviewer_handoff WHERE workspace_id=$1", ws) != 0 {
		t.Fatal("workspace teardown left handover history behind")
	}
}

func TestCockpitReviewerHandoffHTTPBoundary(t *testing.T) {
	ws, meeting := newCockpitWorkflowHTTPFixture(t)
	reviewer := dbfx.User(t, "Next reviewer", "next-"+uuid.NewString()+"@example.com")
	dbfx.Member(t, ws, reviewer, "member")
	var state CockpitMeetingWorkflowResponse
	callCockpitWorkflow(t, testHandler.EnableCockpitMeetingWorkflow, http.MethodPost, ws, meeting.ID, "", "",
		map[string]any{"reviewer_id": testUserID}).Want(http.StatusOK).JSON(&state)
	body := map[string]any{"expected_revision": state.Revision, "handoff_key": uuid.NewString(), "reviewer_id": reviewer, "reason": "New review owner"}
	callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, reviewer, "", body).Want(http.StatusForbidden)
	for _, bad := range []map[string]any{
		{"handoff_key": uuid.NewString(), "reviewer_id": reviewer, "reason": "Missing revision"},
		{"expected_revision": 1, "handoff_key": "invalid", "reviewer_id": reviewer, "reason": "Bad key"},
		{"expected_revision": 1, "handoff_key": uuid.NewString(), "reviewer_id": "invalid", "reason": "Bad reviewer"},
		{"expected_revision": 1, "handoff_key": uuid.NewString(), "reviewer_id": reviewer, "reason": " "},
	} {
		callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, "", "", bad).Want(http.StatusBadRequest)
	}
	callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, "", "", body).Want(http.StatusOK).JSON(&state)
	if len(state.ReviewerHandoffs) != 1 || state.ReviewerHandoffs[0].VersionID != nil || state.ReviewerHandoffs[0].FromReviewIssue != nil || state.ReviewerHandoffs[0].ToReviewIssue != nil || len(state.Versions) != 0 {
		t.Fatalf("a future-default handover created review work: %+v", state)
	}
	if dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", ws) != 1 {
		t.Fatal("a default-only handover created an empty task")
	}
	body["reason"] = "Different command using the same key"
	callCockpitWorkflow(t, testHandler.ChangeCockpitMeetingReviewer, http.MethodPost, ws, meeting.ID, "", "", body).Want(http.StatusConflict)
}
