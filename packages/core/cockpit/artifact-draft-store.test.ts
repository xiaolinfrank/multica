// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitArtifactDraftKey, prepareCockpitArtifactCreation, prepareCockpitArtifactSubmission, rebaseCockpitArtifactSubmissionDraft,
  settleCockpitArtifactCreation, settleCockpitArtifactSubmission, updateCockpitArtifactCreationDraft, updateCockpitArtifactReviewDraft,
  updateCockpitArtifactSubmissionDraft, useCockpitArtifactDraftStore } from "./artifact-draft-store";

const firstKey = "12345678-1234-4234-8234-123456789001";
const nextKey = "12345678-1234-4234-8234-123456789002";
beforeEach(() => useCockpitArtifactDraftStore.getState().clearDraft());

describe("artifact command drafts", () => {
  it("keeps unknown creation results tied to the original node, source, reviewer and key until exact acknowledgement", () => {
    const scope = cockpitArtifactDraftKey("ws", "create", "node-a");
    updateCockpitArtifactCreationDraft(scope, { title: "  Dataset  ", sourceIssueId: "issue-a", reviewerId: "person-a" });
    const original = prepareCockpitArtifactCreation(scope, "node-a", firstKey);
    updateCockpitArtifactCreationDraft(scope, { sourceIssueId: "issue-b", title: "Another artifact" });
    expect(prepareCockpitArtifactCreation(scope, "node-b", nextKey)).toEqual(original);
    expect(original).toMatchObject({ creation_key: firstKey, node_id: "node-a", source_issue_id: "issue-a", reviewer_id: "person-a", title: "Dataset" });
    settleCockpitArtifactCreation(scope, nextKey, true);
    expect(useCockpitArtifactDraftStore.getState().draft.creations[scope]?.pending).toEqual(original);
    settleCockpitArtifactCreation(scope, firstKey, true);
    expect(useCockpitArtifactDraftStore.getState().draft.creations[scope]).toBeUndefined();
  });

  it("freezes exact text bytes and observed revision across retry, and allows an explicit rebase only after definite refusal", () => {
    const scope = cockpitArtifactDraftKey("ws", "submit", "artifact");
    const content = "\n# Fixed evidence\n\nLine with spaces.  \n";
    updateCockpitArtifactSubmissionDraft(scope, 4, { text: content });
    const original = prepareCockpitArtifactSubmission(scope, 99, firstKey);
    expect(original).toEqual({ expected_revision: 4, submission_key: firstKey, payload: { kind: "text", content } });
    updateCockpitArtifactSubmissionDraft(scope, 9, { text: "changed" });
    rebaseCockpitArtifactSubmissionDraft(scope, 9);
    expect(prepareCockpitArtifactSubmission(scope, 9, nextKey)).toEqual(original);
    settleCockpitArtifactSubmission(scope, firstKey, false);
    updateCockpitArtifactSubmissionDraft(scope, 9, { text: "corrected\n" });
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]?.baseRevision).toBe(4);
    rebaseCockpitArtifactSubmissionDraft(scope, 9);
    expect(prepareCockpitArtifactSubmission(scope, 99, nextKey)).toEqual({ expected_revision: 9, submission_key: nextKey, payload: { kind: "text", content: "corrected\n" } });
    settleCockpitArtifactSubmission(scope, firstKey, true);
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]?.pending?.submission_key).toBe(nextKey);
  });

  it("retains the selected attachment identity without accidentally carrying text into a file command", () => {
    const scope = cockpitArtifactDraftKey("ws", "submit", "artifact");
    updateCockpitArtifactSubmissionDraft(scope, 2, { text: "old text", kind: "attachment", attachmentId: "attachment-1" });
    expect(prepareCockpitArtifactSubmission(scope, 2, firstKey).payload).toEqual({ kind: "attachment", attachment_id: "attachment-1" });
    settleCockpitArtifactSubmission(scope, firstKey, true);
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]).toBeUndefined();
  });

  it("separates authority-bound feedback and workspace drafts, and clears all through account cleanup", () => {
    const first = cockpitArtifactDraftKey("ws-a", "review", "artifact", "version", "review-1", "person-1");
    const transferred = cockpitArtifactDraftKey("ws-a", "review", "artifact", "version", "review-2", "person-2");
    const second = cockpitArtifactDraftKey("ws-b", "review", "artifact", "version", "review-1", "person-1");
    updateCockpitArtifactReviewDraft(first, { feedback: "Needs additional evidence", decision: "changes_requested" });
    expect(useCockpitArtifactDraftStore.getState().draft.reviews[transferred]).toBeUndefined();
    expect(useCockpitArtifactDraftStore.getState().draft.reviews[second]).toBeUndefined();
    resetAllRegisteredDrafts();
    expect(useCockpitArtifactDraftStore.getState().draft).toEqual({ creations: {}, submissions: {}, reviews: {} });
  });
});
