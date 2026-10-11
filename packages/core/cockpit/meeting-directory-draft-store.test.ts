// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import {
  cockpitMeetingDirectoryDraftKey, setCockpitDirectoryForm, clearCockpitDirectoryForm,
  prepareCockpitDirectoryCommand, settleCockpitDirectoryCommand, useCockpitMeetingDirectoryDraftStore,
  type CockpitDirectoryPrepareDraft, type CockpitDirectoryPendingCommand,
} from "./meeting-directory-draft-store";

vi.mock("../platform/storage", () => ({ defaultStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const meeting = id(1), root = id(2), operation = id(3), commandKey = id(4);
const key = cockpitMeetingDirectoryDraftKey("ws-a", meeting, "prepare");
const form: CockpitDirectoryPrepareDraft = { kind: "prepare", mode: "prepare", rootId: root, relativeDirectory: "meetings/delivery",
  partitions: ["会议材料", "照片"], observedNasDir: "", observedBindingRevision: 1, bindAfterBase: true };
const command: Extract<CockpitDirectoryPendingCommand, { kind: "prepare" }> = { kind: "prepare", meetingId: meeting,
  body: { command_key: commandKey, expected_revision: 1, mode: "prepare", root_id: root, relative_directory: "meetings/delivery", partitions: ["会议材料", "照片"],
    observed_nas_dir: "", observed_binding_revision: 1, bind_after_base: true, context_token: "verified-preview" } };
beforeEach(() => useCockpitMeetingDirectoryDraftStore.getState().clearDraft());

describe("meeting directory drafts", () => {
  it("preserves path and partition corrections without silently advancing the observed binding", () => {
    setCockpitDirectoryForm(key, form);
    const edited = { ...form, relativeDirectory: "meetings/revised name", partitions: ["会议材料"] };
    setCockpitDirectoryForm(key, edited);
    clearCockpitDirectoryForm(key, form);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[key]).toEqual(edited);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[key]).toMatchObject({ observedBindingRevision: 1, observedNasDir: "" });
  });
  it("retains an unknown command's exact target, observed binding and token instead of taking a newer preview", () => {
    setCockpitDirectoryForm(key, form); prepareCockpitDirectoryCommand(key, command);
    setCockpitDirectoryForm(key, { ...form, observedBindingRevision: 3, relativeDirectory: "different" });
    const newer = { ...command, body: { ...command.body, command_key: id(5), relative_directory: "different", observed_binding_revision: 3, context_token: "new-observation" } };
    expect(prepareCockpitDirectoryCommand(key, newer)).toEqual(command);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[key]).toEqual(form);
    settleCockpitDirectoryCommand(key, id(5));
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.commands[key]).toEqual(command);
    expect(() => prepareCockpitDirectoryCommand(key, { ...command, meetingId: id(6) })).toThrow("directory_command_scope_changed");
  });
  it("freezes selected retry steps and preserves the reason when a definitively rejected command is released", () => {
    const retryKey = cockpitMeetingDirectoryDraftKey("ws-a", meeting, "retry", operation);
    const retryForm = { kind: "retry" as const, observedRevision: 4, stepIds: [id(10), id(11)], reason: "  Mount restored; retry these missing partitions.\n" };
    const retry: Extract<CockpitDirectoryPendingCommand, { kind: "retry" }> = { kind: "retry", meetingId: meeting, operationId: operation,
      body: { command_key: commandKey, expected_revision: 4, step_ids: retryForm.stepIds, context_token: "step-preview", reason: retryForm.reason.trim() } };
    setCockpitDirectoryForm(retryKey, retryForm); prepareCockpitDirectoryCommand(retryKey, retry);
    expect(prepareCockpitDirectoryCommand(retryKey, { ...retry, body: { ...retry.body, step_ids: [id(12)] } })).toEqual(retry);
    settleCockpitDirectoryCommand(retryKey, commandKey);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[retryKey]).toEqual(retryForm);
    const next = { ...retry, body: { ...retry.body, command_key: id(13), expected_revision: 5, context_token: "reviewed-again" } };
    prepareCockpitDirectoryCommand(retryKey, next); settleCockpitDirectoryCommand(retryKey, commandKey);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.commands[retryKey]).toEqual(next);
  });
  it("keeps workspace drafts separate and clears user input and pending commands through the real logout registry", () => {
    const other = cockpitMeetingDirectoryDraftKey("ws-b", meeting, "prepare");
    setCockpitDirectoryForm(key, form); setCockpitDirectoryForm(other, { ...form, relativeDirectory: "other-workspace" });
    prepareCockpitDirectoryCommand(key, command); prepareCockpitDirectoryCommand(other, { ...command, body: { ...command.body, command_key: id(15) } });
    settleCockpitDirectoryCommand(key, commandKey); clearCockpitDirectoryForm(key, form);
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.forms[other]).toMatchObject({ relativeDirectory: "other-workspace" });
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft.commands[other]?.body.command_key).toBe(id(15));
    resetAllRegisteredDrafts();
    expect(useCockpitMeetingDirectoryDraftStore.getState().draft).toEqual({ forms: {}, commands: {} });
  });
});
