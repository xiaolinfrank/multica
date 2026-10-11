// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { checkpointCockpitMeetingCreation, prepareCockpitMeetingCreation, settleCockpitMeetingCreation, useCockpitMeetingCreateDraftStore } from "./meeting-create-draft-store";
const key = JSON.stringify(["workspace", "project", null]);
const input = { meeting: { creation_key: "10000000-0000-4000-8000-000000000001", node_id: null, meet_date: "2026-10-10", start_time: "", end_time: "", kind: "", status: "", track: "", parties: "", organizer: "Person", attendees: "", location: "", title: "Plan review" },
  provision: { create_dir: false }, workflow: { reviewer_id: "person" }, autoSaveEntries: [] };
beforeEach(() => useCockpitMeetingCreateDraftStore.getState().clearDraft());
describe("durable meeting creation intent", () => {
  it("keeps the exact key and body after an unknown result and ignores attempts to replace it", () => {
    const command = prepareCockpitMeetingCreation(key, input); settleCockpitMeetingCreation(key, command, "uncertain");
    const retry = prepareCockpitMeetingCreation(key, { ...input, meeting: { ...input.meeting, creation_key: "10000000-0000-4000-8000-000000000002", title: "Changed" } });
    expect(retry.meeting).toEqual(input.meeting); expect(retry.uncertain).toBe(true);
    settleCockpitMeetingCreation(key, retry, "rejected"); expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]?.meeting).toEqual(input.meeting);
  });
  it("resumes confirmed checkpoints and lets setup change without changing the created meeting", () => {
    const command = prepareCockpitMeetingCreation(key, input); checkpointCockpitMeetingCreation(key, command, { meetingId: "meeting" });
    const next = prepareCockpitMeetingCreation(key, { ...input, workflow: { reviewer_id: "replacement" } });
    expect(next.meetingId).toBe("meeting"); expect(next.meeting).toEqual(input.meeting);
    checkpointCockpitMeetingCreation(key, command, { workflowCreated: true }); settleCockpitMeetingCreation(key, command, "accepted");
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toMatchObject({ workflow: { reviewer_id: "replacement" }, workflowCreated: false });
    checkpointCockpitMeetingCreation(key, next, { workflowCreated: true }); settleCockpitMeetingCreation(key, next, "accepted");
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toBeUndefined();
  });
  it("retains an acknowledged background directory plan without declaring its directories ready or resubmitting changed intent", () => {
    const confirmed = { ...input, provision: { create_dir: true, base_dir: "/approved/meetings" } };
    const command = prepareCockpitMeetingCreation(key, confirmed);
    checkpointCockpitMeetingCreation(key, command, { meetingId: "meeting", workflowCreated: true });
    const operation = "10000000-0000-4000-8000-000000000003";
    checkpointCockpitMeetingCreation(key, command, { directoryOperationId: operation });
    const restored = prepareCockpitMeetingCreation(key, { ...confirmed, provision: { create_dir: false, base_dir: "/different" } });
    expect(restored.directoryOperationId).toBe(operation);
    expect(restored.directoryReady).toBe(false);
    expect(restored.provision).toEqual(confirmed.provision);
    expect(restored.meetingId).toBe("meeting");
    settleCockpitMeetingCreation(key, restored, "accepted");
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toBeUndefined();
  });
  it("allows a definite first rejection to be corrected, while logout and other scopes cannot be resurrected by late receipts", () => {
    const rejected = prepareCockpitMeetingCreation(key, input); settleCockpitMeetingCreation(key, rejected, "rejected"); expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope[key]).toBeUndefined();
    const command = prepareCockpitMeetingCreation(key, input); resetAllRegisteredDrafts(); checkpointCockpitMeetingCreation(key, command, { meetingId: "late" }); settleCockpitMeetingCreation(key, command, "uncertain");
    expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope).toEqual({});
    prepareCockpitMeetingCreation("other-workspace", input); settleCockpitMeetingCreation(key, command, "accepted"); expect(useCockpitMeetingCreateDraftStore.getState().draft.byScope["other-workspace"]).toBeDefined();
  });
});
