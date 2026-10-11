// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import {
  useCockpitInputDraftStore, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm,
  advanceCockpitInputForm, clearCockpitInputForm, prepareCockpitInputCommand, settleCockpitInputCommand,
  type CockpitInputPendingCommand,
  endCockpitInputRegistration, removeEndedCockpitInputRegistration, beginCockpitInputNASBatch, skipCockpitInputNASItem, completeCockpitInputNASBatch,
} from "./input-draft-store";

import { cockpitEndedInputRegistrations } from "./input-view-drafts";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = cockpitInputDraftKey(id(1), id(2), "upload", id(3));
const draft = { ...emptyCockpitInputForm(id(4)), title: "Original recording", description: "  exact note  \n" };
const command: CockpitInputPendingCommand = { kind: "create", body: { commandKey: id(5), title: draft.title, description: draft.description, projectId: null, originIssueId: null } };
beforeEach(() => useCockpitInputDraftStore.getState().clearDraft());

describe("input command drafts", () => {
  it("preserves an unknown command's original intent and keeps a later result from clearing its replacement", () => {
    setCockpitInputForm(key, draft);
    prepareCockpitInputCommand(key, command);
    const replacement = { ...command, body: { ...command.body, commandKey: id(6), title: "Replacement" } };
    expect(prepareCockpitInputCommand(key, replacement)).toEqual(command);
    setCockpitInputForm(key, { ...draft, title: "Unconfirmed edit" });
    expect(useCockpitInputDraftStore.getState().draft.forms[key]).toEqual(draft);
    settleCockpitInputCommand(key, id(6));
    expect(useCockpitInputDraftStore.getState().draft.commands[key]).toEqual(command);
    settleCockpitInputCommand(key, id(5));
    prepareCockpitInputCommand(key, replacement);
    settleCockpitInputCommand(key, id(5));
    expect(useCockpitInputDraftStore.getState().draft.commands[key]).toEqual(replacement);
  });

  it("advances only the same form generation and never clears a changed form", () => {
    setCockpitInputForm(key, draft);
    advanceCockpitInputForm(key, id(10), { inputId: id(9), inputRevision: 1 });
    expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputId).toBeNull();
    advanceCockpitInputForm(key, draft.generation, { inputId: id(9), inputRevision: 1 });
    clearCockpitInputForm(key, draft);
    expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputId).toBe(id(9));
    setCockpitInputForm(key, { ...draft, generation: id(11), title: "New intent" });
    advanceCockpitInputForm(key, draft.generation, { versionId: id(12) });
    expect(useCockpitInputDraftStore.getState().draft.forms[key]).toMatchObject({ title: "New intent", versionId: null });
  });

  it("persists file declarations and accepted pointers without retaining File bytes", () => {
    const file = new File(["secret bytes"], "recording.txt");
    setCockpitInputForm(key, { ...draft, declaration: { filename: file.name, contentType: "text/plain", sizeBytes: file.size, lastModified: file.lastModified },
      inputId: id(9), inputRevision: 1, file } as typeof draft);
    const retained = useCockpitInputDraftStore.getState().draft.forms[key];
    expect(retained).toMatchObject({ declaration: { filename: "recording.txt", sizeBytes: 12 }, inputId: id(9) });
    expect(retained).not.toHaveProperty("file");
    expect(JSON.stringify(retained)).not.toContain("secret bytes");
  });

  it("isolates account and workspace intents and clears them through the actual logout registry", () => {
    const otherAccount = cockpitInputDraftKey(id(1), id(7), "upload", id(3));
    const otherWorkspace = cockpitInputDraftKey(id(8), id(2), "upload", id(3));
    for (const scope of [key, otherAccount, otherWorkspace]) { setCockpitInputForm(scope, draft); prepareCockpitInputCommand(scope, command); }
    settleCockpitInputCommand(key, id(5)); clearCockpitInputForm(key, draft);
    expect(useCockpitInputDraftStore.getState().draft.forms[otherAccount]).toEqual(draft);
    expect(useCockpitInputDraftStore.getState().draft.commands[otherWorkspace]).toEqual(command);
    resetAllRegisteredDrafts();
    expect(useCockpitInputDraftStore.getState().draft).toEqual({ forms: {}, commands: {} });
  });

  it("freezes all 27 cross-page NAS selections atomically before any registration", () => {
    const selected = { ...draft, sourceSelections: Array.from({ length: 27 }, (_, index) => ({ selectionId: id(20 + index), rootId: id(10),
      relativePath: `meeting/file-${index}.wav`, observationToken: `observation-${index}`, filename: `file-${index}.wav`, sizeBytes: 100, modifiedAt: null })) };
    setCockpitInputForm(key, selected);
    const batch = beginCockpitInputNASBatch(id(1), id(2), id(3), key, useCockpitInputDraftStore.getState().draft.forms[key]!);
    expect(batch.childKeys).toHaveLength(27);
    for (const [index, childKey] of batch.childKeys.entries()) {
      expect(useCockpitInputDraftStore.getState().draft.forms[childKey]).toMatchObject({ agendaId: null, purpose: "material",
        source: { kind: "nas_file", nasFile: { observationToken: `observation-${index}` } }, batchItem: { parentKey: key, skipped: false } });
    }
    setCockpitInputForm(key, { ...selected, sourceSelections: [] });
    expect(useCockpitInputDraftStore.getState().draft.forms[key]?.sourceSelections).toHaveLength(27);
  });

  it("preserves a registered but unbound item after explicit skip instead of losing its recovery entry", () => {
    const selected = { ...draft, sourceSelections: [{ selectionId: id(20), rootId: id(10), relativePath: "meeting/file.wav", observationToken: "original-proof", filename: "file.wav", sizeBytes: 100, modifiedAt: null }] };
    setCockpitInputForm(key, selected);
    const batch = beginCockpitInputNASBatch(id(1), id(2), id(3), key, useCockpitInputDraftStore.getState().draft.forms[key]!);
    const childKey = batch.childKeys[0]!;
    advanceCockpitInputForm(childKey, id(20), { inputId: id(30), inputRevision: 1 });
    skipCockpitInputNASItem(childKey, id(20), "Meeting permission changed; keep the registration");
    expect(() => completeCockpitInputNASBatch(key, draft.generation, id(40))).toThrow("input_batch_unfinished");
    expect(useCockpitInputDraftStore.getState().draft.forms[childKey]).toMatchObject({ inputId: id(30), batchItem: { skipped: true } });
    advanceCockpitInputForm(childKey, id(20), { versionId: id(31) });
    completeCockpitInputNASBatch(key, draft.generation, id(40));
    expect(useCockpitInputDraftStore.getState().draft.forms[key]).toMatchObject({ batch: null, generation: id(40), sourceSelections: [] });
    expect(useCockpitInputDraftStore.getState().draft.forms[childKey]).toBeUndefined();
  });
  it("ends a registered NAS item without a fixed version, retains its exact local pointer across batches, and removes it only by explicit scoped request", () => {
    const parentKey = cockpitInputDraftKey(id(1), id(2), "nas", id(3), "");
    const selected = { ...draft, sourceSelections: [{ selectionId: id(20), rootId: id(10), relativePath: "meeting/file.wav", observationToken: "observed", filename: "file.wav", sizeBytes: 100, modifiedAt: null }] };
    setCockpitInputForm(parentKey, selected);
    const batch = beginCockpitInputNASBatch(id(1), id(2), id(3), parentKey, useCockpitInputDraftStore.getState().draft.forms[parentKey]!);
    const childKey = batch.childKeys[0]!;
    advanceCockpitInputForm(childKey, id(20), { inputId: id(30), inputRevision: 1 });
    prepareCockpitInputCommand(childKey, command);
    expect(() => endCockpitInputRegistration(id(1), id(2), id(3), childKey, id(20), "No longer needed")).toThrow("input_registration_context_changed");
    expect(useCockpitInputDraftStore.getState().draft.commands[childKey]).toEqual(command);
    settleCockpitInputCommand(childKey, command.body.commandKey);
    expect(() => endCockpitInputRegistration(id(1), id(9), id(3), childKey, id(20), "No longer needed")).toThrow();
    endCockpitInputRegistration(id(1), id(2), id(3), childKey, id(20), "  No longer needed  ");
    expect(() => removeEndedCockpitInputRegistration(id(1), id(2), id(3), childKey, id(20))).toThrow();
    expect(() => prepareCockpitInputCommand(childKey, command)).toThrow("input_registration_ended");
    completeCockpitInputNASBatch(parentKey, draft.generation, id(40));
    const records = cockpitEndedInputRegistrations(useCockpitInputDraftStore.getState().draft, id(1), id(2), id(3));
    expect(records).toEqual([expect.objectContaining({ inputId: id(30), reason: "No longer needed", sourcePath: "meeting/file.wav", inActiveBatch: false })]);
    expect(useCockpitInputDraftStore.getState().draft.forms[childKey]).toMatchObject({ inputId: id(30), versionId: null, transferId: null });
    expect(useCockpitInputDraftStore.getState().draft.forms[parentKey]).toMatchObject({ generation: id(40), batch: null });
    expect(cockpitEndedInputRegistrations(useCockpitInputDraftStore.getState().draft, id(1), id(9), id(3))).toEqual([]);
    expect(() => removeEndedCockpitInputRegistration(id(1), id(9), id(3), childKey, id(20))).toThrow();
    removeEndedCockpitInputRegistration(id(1), id(2), id(3), childKey, id(20));
    expect(useCockpitInputDraftStore.getState().draft.forms[childKey]).toBeUndefined();
  });

  it.each(["upload", "source-input"])("atomically frees a %s registration slot while retaining the ended generation and rejecting later fixed-version termination", (kind) => {
    const activeKey = cockpitInputDraftKey(id(1), id(2), kind, id(3), "");
    const value = { ...draft, inputId: id(30), inputRevision: 1 };
    setCockpitInputForm(activeKey, value);
    endCockpitInputRegistration(id(1), id(2), id(3), activeKey, draft.generation, "User ended this intent");
    const records = cockpitEndedInputRegistrations(useCockpitInputDraftStore.getState().draft, id(1), id(2), id(3));
    expect(records).toHaveLength(1);
    expect(useCockpitInputDraftStore.getState().draft.forms[activeKey]).toBeUndefined();
    expect(useCockpitInputDraftStore.getState().draft.forms[records[0]!.key]).toMatchObject({ generation: draft.generation, inputId: id(30), title: draft.title, description: draft.description, registrationEnd: { originalKey: activeKey } });
    setCockpitInputForm(activeKey, { ...value, generation: id(40), inputId: id(31), versionId: id(32) });
    expect(() => endCockpitInputRegistration(id(1), id(2), id(3), activeKey, id(40), "Cannot end a fixed version")).toThrow();
    removeEndedCockpitInputRegistration(id(1), id(2), id(3), records[0]!.key, draft.generation);
    expect(useCockpitInputDraftStore.getState().draft.forms[activeKey]).toMatchObject({ generation: id(40), inputId: id(31), versionId: id(32) });
  });

});
