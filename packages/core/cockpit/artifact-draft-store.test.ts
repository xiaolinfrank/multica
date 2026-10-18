// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitArtifactDraftKey, prepareCockpitArtifactCreation, prepareCockpitArtifactSubmission, rebaseCockpitArtifactSubmissionDraft,
  settleCockpitArtifactCreation, settleCockpitArtifactSubmission, updateCockpitArtifactCreationDraft, updateCockpitArtifactReviewDraft,
  updateCockpitArtifactSubmissionDraft, useCockpitArtifactDraftStore, cockpitArtifactSubmissionNeedsRebase } from "./artifact-draft-store";

const firstKey = "12345678-1234-4234-8234-123456789001";
const nextKey = "12345678-1234-4234-8234-123456789002";
beforeEach(() => useCockpitArtifactDraftStore.getState().clearDraft());

describe("artifact command drafts", () => {
  it("requires explicit producer confirmation, drops foreign attachments, and preserves fixed provenance during retry", () => {
    const scope = cockpitArtifactDraftKey("ws", "submit", "artifact");
    const before = { revision: 1, producerIssueId: "producer-a" }, after = { revision: 2, producerIssueId: "producer-b" };
    updateCockpitArtifactSubmissionDraft(scope, before, { text: "Keep this working draft", attachmentId: "old-attachment", sourceMeetingId: "meeting", sourceMinutesVersionId: "published-version" });
    expect(cockpitArtifactSubmissionNeedsRebase(useCockpitArtifactDraftStore.getState().draft.submissions[scope]!, after)).toBe(true);
    expect(() => prepareCockpitArtifactSubmission(scope, after, firstKey)).toThrow("artifact_producer_changed");
    rebaseCockpitArtifactSubmissionDraft(scope, after);
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]).toMatchObject({ text: "Keep this working draft", attachmentId: "", producerIssueId: "producer-b", sourceMeetingId: "meeting" });
    const command = prepareCockpitArtifactSubmission(scope, after, firstKey);
    expect(command).toMatchObject({ producer_issue_id: "producer-b", source_meeting_id: "meeting", source_minutes_version_id: "published-version" });
    expect(prepareCockpitArtifactSubmission(scope, { revision: 3, producerIssueId: "producer-c" }, nextKey)).toEqual(command);
  });
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
    updateCockpitArtifactSubmissionDraft(scope, { revision: 4, producerIssueId: "source-1" }, { text: content });
    const original = prepareCockpitArtifactSubmission(scope, { revision: 99, producerIssueId: "source-1" }, firstKey);
    expect(original).toEqual({ expected_revision: 4, submission_key: firstKey, producer_issue_id: "source-1", payload: { kind: "text", content } });
    updateCockpitArtifactSubmissionDraft(scope, { revision: 9, producerIssueId: "source-1" }, { text: "changed" });
    rebaseCockpitArtifactSubmissionDraft(scope, { revision: 9, producerIssueId: "source-1" });
    expect(prepareCockpitArtifactSubmission(scope, { revision: 9, producerIssueId: "source-1" }, nextKey)).toEqual(original);
    settleCockpitArtifactSubmission(scope, firstKey, false);
    updateCockpitArtifactSubmissionDraft(scope, { revision: 9, producerIssueId: "source-1" }, { text: "corrected\n" });
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]?.baseRevision).toBe(4);
    rebaseCockpitArtifactSubmissionDraft(scope, { revision: 9, producerIssueId: "source-1" });
    expect(prepareCockpitArtifactSubmission(scope, { revision: 99, producerIssueId: "source-1" }, nextKey)).toEqual({ expected_revision: 9, submission_key: nextKey, producer_issue_id: "source-1", payload: { kind: "text", content: "corrected\n" } });
    settleCockpitArtifactSubmission(scope, firstKey, true);
    expect(useCockpitArtifactDraftStore.getState().draft.submissions[scope]?.pending?.submission_key).toBe(nextKey);
  });

  it("retains the selected attachment identity without accidentally carrying text into a file command", () => {
    const scope = cockpitArtifactDraftKey("ws", "submit", "artifact");
    updateCockpitArtifactSubmissionDraft(scope, { revision: 2, producerIssueId: "source-1" }, { text: "old text", kind: "attachment", attachmentId: "attachment-1" });
    expect(prepareCockpitArtifactSubmission(scope, { revision: 2, producerIssueId: "source-1" }, firstKey).payload).toEqual({ kind: "attachment", attachment_id: "attachment-1" });
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


it("retains an explicit cross-Issue input manifest through producer rebase and freezes its original pending command", () => {
  const key = cockpitArtifactDraftKey("ws", "submit", "artifact-inputs");
  const first = { revision: 1, producerIssueId: "producer-a" }, next = { revision: 2, producerIssueId: "producer-b" };
  updateCockpitArtifactSubmissionDraft(key, first, { text: "Fixed output", inputManifestIssueId: "another-source-issue", inputManifestVersionId: firstKey });
  rebaseCockpitArtifactSubmissionDraft(key, next);
  expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]).toMatchObject({ inputManifestIssueId: "another-source-issue", inputManifestVersionId: firstKey });
  const command = prepareCockpitArtifactSubmission(key, next, nextKey);
  expect(command).toMatchObject({ producer_issue_id: "producer-b", input_manifest_version_id: firstKey });
  updateCockpitArtifactSubmissionDraft(key, next, { inputManifestIssueId: "different-source", inputManifestVersionId: nextKey });
  expect(prepareCockpitArtifactSubmission(key, next, firstKey)).toEqual(command);
  settleCockpitArtifactSubmission(key, nextKey, false);
  updateCockpitArtifactSubmissionDraft(key, next, { inputManifestIssueId: "different-source" });
  expect(useCockpitArtifactDraftStore.getState().draft.submissions[key]?.inputManifestVersionId).toBe("");
  expect(() => prepareCockpitArtifactSubmission(key, next, firstKey)).toThrow("artifact_input_manifest_source_required");
  updateCockpitArtifactSubmissionDraft(key, next, { inputManifestIssueId: "", inputManifestVersionId: "" });
  expect(prepareCockpitArtifactSubmission(key, next, firstKey)).not.toHaveProperty("input_manifest_version_id");
});
