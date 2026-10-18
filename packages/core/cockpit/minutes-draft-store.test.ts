// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeCockpitMinutesSubmission, prepareCockpitMinutesSubmission,
  rejectCockpitMinutesSubmission, setCockpitMinutesDraftContent, useCockpitMinutesDraftStore,
} from "./minutes-draft-store";
import { versionFixture, WORKFLOW_SUBMISSION_KEY } from "./workflow-test-fixtures";

describe("retryable minutes drafts", () => {
  beforeEach(() => useCockpitMinutesDraftStore.getState().clearDraft());

  it("keeps the exact submission after an unknown result and only clears a matching confirmed version", () => {
    setCockpitMinutesDraftContent("m1", " Fixed minutes text ");
    setCockpitMinutesDraftContent("m2", "Another meeting");
    const first = prepareCockpitMinutesSubmission("m1", 4, WORKFLOW_SUBMISSION_KEY);
    setCockpitMinutesDraftContent("m1", "Do not replace an unconfirmed command");
    expect(prepareCockpitMinutesSubmission("m1", 99, "20000000-0000-4000-8000-000000000002")).toBe(first);
    expect(acknowledgeCockpitMinutesSubmission("m1", [versionFixture({ content: "different" })])).toBe(false);
    expect(acknowledgeCockpitMinutesSubmission("m1", [versionFixture()])).toBe(true);
    expect(useCockpitMinutesDraftStore.getState().draft.byMeeting.m1).toBeUndefined();
    expect(useCockpitMinutesDraftStore.getState().draft.byMeeting.m2?.content).toBe("Another meeting");
  });

  it("permits correction after a definite refusal without rotating the submission key", () => {
    setCockpitMinutesDraftContent("m1", "Bad draft");
    prepareCockpitMinutesSubmission("m1", 2, WORKFLOW_SUBMISSION_KEY);
    rejectCockpitMinutesSubmission("m1");
    setCockpitMinutesDraftContent("m1", "Corrected draft");
    expect(prepareCockpitMinutesSubmission("m1", 5, "20000000-0000-4000-8000-000000000002")).toEqual({
      expected_revision: 5, submission_key: WORKFLOW_SUBMISSION_KEY, content: "Corrected draft",
    });
  });
});
