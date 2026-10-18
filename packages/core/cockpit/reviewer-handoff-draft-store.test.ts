// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeCockpitReviewerHandoff, prepareCockpitReviewerHandoff, rejectCockpitReviewerHandoff,
  setCockpitReviewerHandoffDraft, useCockpitReviewerHandoffDraftStore,
} from "./reviewer-handoff-draft-store";
import { handoffFixture, versionFixture, workflowFixture, WORKFLOW_HANDOFF_KEY, WORKFLOW_MEETING_ID } from "./workflow-test-fixtures";

beforeEach(() => useCockpitReviewerHandoffDraftStore.getState().clearDraft());

describe("reviewer transfer command recovery", () => {
  it("keeps the exact confirmed intent while unknown and clears only the matching authoritative receipt", () => {
    setCockpitReviewerHandoffDraft(WORKFLOW_MEETING_ID, { reviewer_id: "reviewer-2", reason: " Reviewer left the team " });
    setCockpitReviewerHandoffDraft("other-meeting", { reason: "Other draft" });
    const first = prepareCockpitReviewerHandoff(WORKFLOW_MEETING_ID, 1, WORKFLOW_HANDOFF_KEY);
    setCockpitReviewerHandoffDraft(WORKFLOW_MEETING_ID, { reviewer_id: "replacement-3", reason: "Unconfirmed replacement" });
    expect(prepareCockpitReviewerHandoff(WORKFLOW_MEETING_ID, 90, "30000000-0000-4000-8000-000000000002")).toBe(first);
    const result = workflowFixture({ revision: 9, reviewer_id: "replacement-3", current_version_id: "version-1", versions: [versionFixture()], reviewer_handoffs: [handoffFixture()] });
    expect(acknowledgeCockpitReviewerHandoff(WORKFLOW_MEETING_ID, { ...result, reviewer_handoffs: [] })).toBe(false);
    expect(acknowledgeCockpitReviewerHandoff(WORKFLOW_MEETING_ID, { ...result, meeting_id: "different-meeting" })).toBe(false);
    expect(acknowledgeCockpitReviewerHandoff(WORKFLOW_MEETING_ID, result)).toBe(true);
    expect(useCockpitReviewerHandoffDraftStore.getState().draft.byMeeting[WORKFLOW_MEETING_ID]).toBeUndefined();
    expect(useCockpitReviewerHandoffDraftStore.getState().draft.byMeeting["other-meeting"]?.reason).toBe("Other draft");
  });

  it("gives reconfirmed intent a new key after definite refusal and accepts a future-only receipt", () => {
    setCockpitReviewerHandoffDraft(WORKFLOW_MEETING_ID, { reviewer_id: "gone-reviewer", reason: "Original reason" });
    prepareCockpitReviewerHandoff(WORKFLOW_MEETING_ID, 1, WORKFLOW_HANDOFF_KEY);
    rejectCockpitReviewerHandoff(WORKFLOW_MEETING_ID);
    setCockpitReviewerHandoffDraft(WORKFLOW_MEETING_ID, { reviewer_id: "reviewer-2", reason: "Reviewer left the team" });
    const newKey = "30000000-0000-4000-8000-000000000002";
    expect(prepareCockpitReviewerHandoff(WORKFLOW_MEETING_ID, 4, newKey))
      .toMatchObject({ expected_revision: 4, handoff_key: newKey, reviewer_id: "reviewer-2" });
    expect(acknowledgeCockpitReviewerHandoff(WORKFLOW_MEETING_ID, workflowFixture({ revision: 5, reviewer_handoffs: [
      handoffFixture({ handoff_key: newKey, revision: 5, version_id: null, from_review_issue: null, to_review_issue: null }),
    ] }))).toBe(true);
  });
});
