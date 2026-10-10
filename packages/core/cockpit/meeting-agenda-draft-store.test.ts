// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import { cockpitMeetingAgendaDraftKey, useCockpitMeetingAgendaDraftStore, updateCockpitAgendaDraft, rebaseCockpitAgendaDraft, clearCockpitAgendaDraft, prepareCockpitMeetingCommand, settleCockpitMeetingCommand, setCockpitMeetingFormDraft, clearCockpitMeetingFormDraft, type CockpitAgendaDraft, type CockpitMeetingPendingCommand } from "./meeting-agenda-draft-store";

vi.mock("../platform/storage", () => ({ defaultStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const initial: CockpitAgendaDraft = { observedRevision: 3, title: "Boundary review", purposes: ["boundary_confirmation"], desiredOutcome: "", notes: "", facilitatorId: "", nodeId: "" };
const key = cockpitMeetingAgendaDraftKey("ws-a", "meeting", "agenda");
const first: CockpitMeetingPendingCommand = { kind: "agenda_update", agendaId: "agenda", body: { command_key: "11111111-1111-4111-8111-111111111111", expected_revision: 3, notes: "  Preserve this whitespace\n" } };
beforeEach(() => useCockpitMeetingAgendaDraftStore.getState().clearDraft());

describe("meeting agenda command and draft persistence", () => {
  it("keeps the observed revision and exact notes until the author explicitly reviews a new revision", () => {
    updateCockpitAgendaDraft(key, initial, { notes: "  Draft\n" });
    updateCockpitAgendaDraft(key, { ...initial, observedRevision: 8 }, { title: "Changed title" });
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]).toMatchObject({ observedRevision: 3, notes: "  Draft\n", title: "Changed title" });
    rebaseCockpitAgendaDraft(key, 8);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]?.observedRevision).toBe(8);
  });
  it("replays one frozen intent after another actor changes the topic or the dialog reopens", () => {
    updateCockpitAgendaDraft(key, initial, { notes: "  Draft\n" });
    expect(prepareCockpitMeetingCommand(key, first)).toEqual(first);
    rebaseCockpitAgendaDraft(key, 9);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]?.observedRevision).toBe(3);
    expect(prepareCockpitMeetingCommand(key, { ...first, body: { ...first.body, command_key: "22222222-2222-4222-8222-222222222222", expected_revision: 9, notes: "Different" } })).toEqual(first);
    settleCockpitMeetingCommand(key, "other-key");
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.commands[key]).toEqual(first);
  });
  it("does not let an earlier acknowledgement clear a newer draft or another workspace", () => {
    const other = cockpitMeetingAgendaDraftKey("ws-b", "meeting", "agenda");
    updateCockpitAgendaDraft(key, initial, { notes: "First" });
    const submitted = useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]!;
    updateCockpitAgendaDraft(key, initial, { notes: "Newer" }); updateCockpitAgendaDraft(other, initial, { notes: "Other workspace" });
    clearCockpitAgendaDraft(key, submitted);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]?.notes).toBe("Newer");
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[other]?.notes).toBe("Other workspace");
    prepareCockpitMeetingCommand(key, first); settleCockpitMeetingCommand(key, first.body.command_key);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.commands[key]).toBeUndefined();
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.agendas[key]?.notes).toBe("Newer");
  });
  it("retains unsent time reasons and preparation descriptions without letting old confirmation clear new input", () => {
    const form = { kind: "occurrence" as const, transition: "correct_times" as const, observedRevision: 2, start: "2026-01-01T09:00", end: "", reason: "Minutes lacked the actual start" };
    setCockpitMeetingFormDraft(key, form);
    setCockpitMeetingFormDraft(key, { ...form, reason: "New correction explanation" });
    clearCockpitMeetingFormDraft(key, form);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.forms[key]).toMatchObject({ reason: "New correction explanation", observedRevision: 2 });
  });
  it("keeps an unassigned backlog preparation intent independent of the edited agenda fields", () => {
    const preparation: CockpitMeetingPendingCommand = { kind: "preparation_issue_create", agendaId: "agenda", body: { command_key: "33333333-3333-4333-8333-333333333333", expected_revision: 3, primary_node_id: null, new_issue: { title: "Prepare evidence", description: "", assignee_type: null, assignee_id: null, priority: "none", due_date: null, project_id: null, module_id: null } } };
    prepareCockpitMeetingCommand(key, preparation);
    expect(useCockpitMeetingAgendaDraftStore.getState().draft.commands[key]).toEqual(preparation);
    resetAllRegisteredDrafts();
    expect(useCockpitMeetingAgendaDraftStore.getState().draft).toEqual({ agendas: {}, commands: {}, forms: {} });
  });
});
