// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitInputDraftKey, emptyCockpitInputForm, type CockpitInputPendingCommand } from "./input-draft-store";
import { cockpitInputVersionDraftEntries } from "./input-view-drafts";

const ws = "b1000000-0000-4000-8000-000000000001";
const account = "b1000000-0000-4000-8000-000000000002";
const meeting = "b1000000-0000-4000-8000-000000000003";
const generation = "b1000000-0000-4000-8000-000000000004";
const selection = "b1000000-0000-4000-8000-000000000005";

describe("meeting input draft destinations", () => {
});


describe("per-input draft destinations", () => {
  it("exposes an exact retained recovery command and never attaches a different version's command to it", () => {
    const inputId = meeting; const versionId = selection;
    const key = cockpitInputDraftKey(ws, account, "recover-input-version", inputId, versionId);
    const command: CockpitInputPendingCommand = { kind: "restart", inputId, versionId, body: { commandKey: generation, mode: "upload_matching_bytes", previousTransferId: null, expectedRevision: 2, reason: "" } };
    const drafts = { forms: { [key]: { ...emptyCockpitInputForm(generation), inputId, versionId } }, commands: { [key]: command } };
    expect(cockpitInputVersionDraftEntries(drafts, ws, account, inputId)).toEqual([{ key, kind: "recover-input-version", versionId, hasPendingCommand: true }]);
    expect(cockpitInputVersionDraftEntries(drafts, ws, generation, inputId)).toEqual([]);
    expect(cockpitInputVersionDraftEntries({ ...drafts, commands: { [key]: { ...command, versionId: generation } } }, ws, account, inputId)).toEqual([]);
  });
});
