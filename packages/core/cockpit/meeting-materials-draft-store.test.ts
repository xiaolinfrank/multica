// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { setCurrentWorkspace } from "../platform/workspace-storage";
import { acknowledgeCockpitMeetingNotesDraft, cockpitMeetingNotesDraftKey, rebaseCockpitMeetingNotesDraft, setCockpitMeetingNotesDraft, useCockpitMeetingMaterialsDraftStore } from "./meeting-materials-draft-store";

const storageValues = vi.hoisted(() => new Map<string, string>());
vi.mock("../platform/storage", () => ({ defaultStorage: {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storageValues.set(key, value); },
  removeItem: (key: string) => { storageValues.delete(key); },
} }));
const flushWorkspace = () => new Promise<void>((resolve) => queueMicrotask(resolve));

beforeEach(async () => {
  setCurrentWorkspace(null, null); await flushWorkspace(); storageValues.clear();
  useCockpitMeetingMaterialsDraftStore.getState().clearDraft();
});
afterEach(async () => { setCurrentWorkspace(null, null); await flushWorkspace(); });

describe("meeting material notes drafts", () => {
  it("holds the original editing baseline through typing until the user explicitly accepts the latest note", () => {
    const key = cockpitMeetingNotesDraftKey("ws-1", "meeting-1");
    setCockpitMeetingNotesDraft(key, "My draft", "Original note");
    setCockpitMeetingNotesDraft(key, "My draft with evidence", "Other person's newer note");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]).toEqual({ note: "My draft with evidence", baseNote: "Original note" });
    rebaseCockpitMeetingNotesDraft(key, "Other person's newer note");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]).toEqual({ note: "My draft with evidence", baseNote: "Other person's newer note" });
  });

  it("keeps unsaved text on a nonmatching read-back and does not let an old save acknowledgement remove a later edit", () => {
    const key = cockpitMeetingNotesDraftKey("ws-1", "meeting-1");
    setCockpitMeetingNotesDraft(key, "First save attempt", "Server note");
    acknowledgeCockpitMeetingNotesDraft(key, "Server note");
    expect(useCockpitMeetingMaterialsDraftStore.getState().hasDraft()).toBe(true);
    setCockpitMeetingNotesDraft(key, "Newer unsaved edit", "Server note");
    acknowledgeCockpitMeetingNotesDraft(key, "First save attempt");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]?.note).toBe("Newer unsaved edit");
    acknowledgeCockpitMeetingNotesDraft(key, "Newer unsaved edit");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]).toBeUndefined();
  });

  it("restores each workspace's notes and keeps a previous workspace's acknowledgement away from the active draft", async () => {
    const first = cockpitMeetingNotesDraftKey("ws-1", "same-meeting");
    const second = cockpitMeetingNotesDraftKey("ws-2", "same-meeting");
    const otherMeeting = cockpitMeetingNotesDraftKey("ws-2", "other-meeting");
    setCurrentWorkspace("team-a", "ws-1"); await flushWorkspace();
    setCockpitMeetingNotesDraft(first, "Identical input", "First baseline");
    setCurrentWorkspace("team-b", "ws-2"); await flushWorkspace();
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting).toEqual({});
    setCockpitMeetingNotesDraft(second, "Identical input", "Second baseline");
    setCockpitMeetingNotesDraft(otherMeeting, "Other meeting", "");
    await Promise.resolve().then(() => acknowledgeCockpitMeetingNotesDraft(first, "Identical input"));
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[second]).toEqual({ note: "Identical input", baseNote: "Second baseline" });
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[otherMeeting]?.note).toBe("Other meeting");
    setCurrentWorkspace("team-a", "ws-1"); await flushWorkspace();
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting).toEqual({ [first]: { note: "Identical input", baseNote: "First baseline" } });
  });

  it("participates in real session cleanup without persisting a meeting or attachment snapshot", () => {
    const key = cockpitMeetingNotesDraftKey("ws-1", "meeting-1");
    setCockpitMeetingNotesDraft(key, "Evidence locations", "Original note");
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting[key]).toEqual({ note: "Evidence locations", baseNote: "Original note" });
    resetAllRegisteredDrafts();
    expect(useCockpitMeetingMaterialsDraftStore.getState().draft.byMeeting).toEqual({});
    expect(useCockpitMeetingMaterialsDraftStore.getState().hasDraft()).toBe(false);
  });
});
