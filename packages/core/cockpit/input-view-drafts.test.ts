// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitInputDraftKey, emptyCockpitInputForm, type CockpitInputPendingCommand } from "./input-draft-store";
import { cockpitMeetingInputDraftEntries } from "./input-view-drafts";

const ws = "b1000000-0000-4000-8000-000000000001";
const account = "b1000000-0000-4000-8000-000000000002";
const meeting = "b1000000-0000-4000-8000-000000000003";
const generation = "b1000000-0000-4000-8000-000000000004";
const selection = "b1000000-0000-4000-8000-000000000005";

describe("meeting input draft destinations", () => {
  it("only exposes exact workspace, account, meeting and command targets without removing unknown entries", () => {
    const ownKey = cockpitInputDraftKey(ws, account, "upload", meeting, "");
    const foreignKey = cockpitInputDraftKey(ws, generation, "upload", meeting, "");
    const malformedKey = `${ownKey} trailing`;
    const command: CockpitInputPendingCommand = { kind: "create", body: { commandKey: generation, title: "Recording", description: "", projectId: null, originIssueId: null } };
    const drafts = { forms: {}, commands: { [ownKey]: command, [foreignKey]: command, [malformedKey]: command } };
    expect(cockpitMeetingInputDraftEntries(drafts, ws, account, meeting)).toEqual([expect.objectContaining({ key: ownKey, kind: "upload", hasPendingCommand: true })]);
    expect(Object.keys(drafts.commands)).toHaveLength(3);
    const wrongTarget = cockpitInputDraftKey(ws, account, "reference", meeting, "", selection);
    const ref: CockpitInputPendingCommand = { kind: "reference", meetingId: generation, body: { commandKey: generation, agendaId: null, inputVersionId: selection, purpose: "material" } };
    expect(cockpitMeetingInputDraftEntries({ forms: {}, commands: { [wrongTarget]: ref } }, ws, account, meeting)).toEqual([]);
  });

  it("groups only the current NAS generation and keeps registered but unfinished children discoverable", () => {
    const parentKey = cockpitInputDraftKey(ws, account, "nas", meeting, "");
    const childKey = cockpitInputDraftKey(ws, account, "nas-selection", meeting, selection);
    const parent = { ...emptyCockpitInputForm(generation), batch: { meetingId: meeting, selectionIds: [selection], childKeys: [childKey] },
      sourceSelections: [{ selectionId: selection, rootId: ws, relativePath: "meeting/file.wav", observationToken: "selected-observation", filename: "file.wav", sizeBytes: 1, modifiedAt: null }] };
    const child = { ...emptyCockpitInputForm(selection), inputId: generation, inputRevision: 1, batchItem: { parentKey, selectionId: selection, skipped: true, skipReason: "Source unavailable" } };
    const drafts = { forms: { [parentKey]: parent, [childKey]: child }, commands: {} };
    expect(cockpitMeetingInputDraftEntries(drafts, ws, account, meeting)).toEqual([expect.objectContaining({ key: parentKey, kind: "nas", unfinishedItems: 1 })]);
    expect(cockpitMeetingInputDraftEntries({ ...drafts, forms: { ...drafts.forms, [childKey]: { ...child, generation } } }, ws, account, meeting)).toEqual([]);
    expect(drafts.forms[childKey]!.inputId).toBe(generation);
  });
});
