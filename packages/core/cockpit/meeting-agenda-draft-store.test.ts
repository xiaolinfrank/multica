// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitMeetingAgendaDraftKey, useCockpitMeetingAgendaDraftStore, prepareCockpitMeetingCommand, settleCockpitMeetingCommand, setCockpitMeetingFormDraft, clearCockpitMeetingFormDraft, type CockpitMeetingPendingCommand } from "./meeting-agenda-draft-store";

vi.mock("../platform/storage", () => ({ defaultStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const key = cockpitMeetingAgendaDraftKey("ws-a", "meeting", "occurrence");
const first: CockpitMeetingPendingCommand = { kind: "materials", body: { command_key: "11111111-1111-4111-8111-111111111111", expected_revision: 3, materials_ready: true } };
beforeEach(() => useCockpitMeetingAgendaDraftStore.getState().clearDraft());

describe("meeting command and form draft persistence", () => {
  it("replays one frozen intent after another actor changes the meeting or the dialog reopens", () => {
    expect(prepareCockpitMeetingCommand(key, first)).toEqual(first);
    expect(prepareCockpitMeetingCommand(key, { ...first, body: { ...first.body, command_key: "22222222-2222-4222-8222-222222222222", materials_ready: false } })).toEqual(first);
    settleCockpitMeetingCommand(key, "other-key");
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.commands[key]).toEqual(first);
  });
  it("settles an acknowledged command once its command key matches", () => {
    prepareCockpitMeetingCommand(key, first);
    settleCockpitMeetingCommand(key, first.body.command_key);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.commands[key]).toBeUndefined();
  });
  it("retains unsent time reasons without letting old confirmation clear new input", () => {
    const form = { kind: "occurrence" as const, transition: "correct_times" as const, observedRevision: 2, start: "2026-01-01T09:00", end: "", reason: "Minutes lacked the actual start" };
    setCockpitMeetingFormDraft(key, form);
    setCockpitMeetingFormDraft(key, { ...form, reason: "New correction explanation" });
    clearCockpitMeetingFormDraft(key, form);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.forms[key]).toMatchObject({ reason: "New correction explanation", observedRevision: 2 });
  });
  it("resets to the empty draft without leftover commands or forms", () => {
    prepareCockpitMeetingCommand(key, first);
    resetAllRegisteredDrafts();
    expect(useCockpitMeetingAgendaDraftStore.getState().draft).toEqual({ commands: {}, forms: {} });
  });
});
