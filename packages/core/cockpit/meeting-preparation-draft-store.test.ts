// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllRegisteredDrafts } from "../drafts/cleanup-registry";
import {
  clearCockpitPreparationForm, cockpitMeetingPreparationDraftKey, prepareCockpitPreparationCommand,
  rememberCockpitPreparationInstance, setCockpitPreparationForm, settleCockpitPreparationCommand, cockpitPreparationGrantReplaced,
  useCockpitMeetingPreparationDraftStore, type CockpitTemplateEditorDraft, type CockpitPreparationPendingCommand,
} from "./meeting-preparation-draft-store";

vi.mock("../platform/storage", () => ({ defaultStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));
const meetingId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const commandKey = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const key = cockpitMeetingPreparationDraftKey("ws-a", "application", meetingId);
const editor: CockpitTemplateEditorDraft = { kind: "template", observedRevision: 4, title: "Boundary review", description: "", active: true,
  config: { schema_version: 1, slots: [{ slot_id: versionId, kind: "agenda", label: "Review boundary", agenda_slot_id: null, purpose: "",
    agenda: { title: "Review boundary", purposes: ["boundary_confirmation"], desired_outcome: "  Keep whitespace\n", notes: "Draft" }, new_issue: null }] } };
const command: CockpitPreparationPendingCommand = { kind: "application", meetingId,
  body: { command_key: commandKey, expected_revision: 7, template_version_id: versionId, context_token: "observed-context", bindings: [] } };
beforeEach(() => useCockpitMeetingPreparationDraftStore.getState().clearDraft());

describe("meeting preparation intent persistence", () => {
  it("preserves slot identities and exact text while a late save cannot clear a newer edit", () => {
    setCockpitPreparationForm(key, editor);
    const submitted = useCockpitMeetingPreparationDraftStore.getState().draft.forms[key]!;
    setCockpitPreparationForm(key, { ...editor, title: "A new title" });
    clearCockpitPreparationForm(key, submitted);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.forms[key]).toEqual({ ...editor, title: "A new title" });
  });
  it("retains the exact preview version, token and command after an unknown response", () => {
    setCockpitPreparationForm(key, editor);
    expect(prepareCockpitPreparationCommand(key, command)).toEqual(command);
    setCockpitPreparationForm(key, { ...editor, observedRevision: 12, title: "Changed during a request" });
    expect(prepareCockpitPreparationCommand(key, { ...command, body: { ...command.body, command_key: operationId, expected_revision: 12, context_token: "new-context" } })).toEqual(command);
    settleCockpitPreparationCommand(key, operationId);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands[key]).toEqual(command);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.forms[key]).toEqual(editor);
  });
  it("keeps original inputs editable after a definitive rejection and does not reuse the key across meetings", () => {
    setCockpitPreparationForm(key, editor); prepareCockpitPreparationCommand(key, command);
    expect(() => prepareCockpitPreparationCommand(key, { ...command, meetingId: versionId })).toThrow("meeting_preparation_command_scope_changed");
    settleCockpitPreparationCommand(key, commandKey);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.forms[key]).toEqual(editor);
    setCockpitPreparationForm(key, { ...editor, observedRevision: 8 });
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.forms[key]).toMatchObject({ observedRevision: 8 });
  });
  it("keeps a confirmed instance pointer separate from effect progress and clears session drafts on logout", () => {
    const other = cockpitMeetingPreparationDraftKey("ws-b", "application", meetingId);
    rememberCockpitPreparationInstance(key, operationId); rememberCockpitPreparationInstance(other, versionId);
    setCockpitPreparationForm(other, editor); prepareCockpitPreparationCommand(key, command);
    settleCockpitPreparationCommand(key, commandKey);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.instances).toEqual({ [key]: operationId, [other]: versionId });
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.forms[other]).toEqual(editor);
    resetAllRegisteredDrafts();
    expect(useCockpitMeetingPreparationDraftStore.getState().draft).toEqual({ forms: {}, commands: {}, instances: {} });
  });
  it("does not let an old effect grant settle a newer pending grant with the same durable effect key", () => {
    const effect: CockpitPreparationPendingCommand = { kind: "effect", meetingId, operationId, effectId: versionId,
      body: { command_key: commandKey, authorization_key: operationId, authorization_revision: 1 } };
    prepareCockpitPreparationCommand(key, effect);
    expect(prepareCockpitPreparationCommand(key, { ...effect, body: { ...effect.body, authorization_key: meetingId, authorization_revision: 2 } })).toEqual(effect);
    settleCockpitPreparationCommand(key, commandKey, effect.body);
    const next = { ...effect, body: { ...effect.body, authorization_key: meetingId, authorization_revision: 2 } };
    prepareCockpitPreparationCommand(key, next);
    settleCockpitPreparationCommand(key, commandKey, effect.body);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands[key]).toEqual(next);
    settleCockpitPreparationCommand(key, commandKey, next.body);
    expect(useCockpitMeetingPreparationDraftStore.getState().draft.commands[key]).toBeUndefined();
  });
  it("only recognizes a newer grant for the exact effect as replacing the unresolved request", () => {
    const effect: CockpitPreparationPendingCommand = { kind: "effect", meetingId, operationId, effectId: versionId,
      body: { command_key: commandKey, authorization_key: operationId, authorization_revision: 1 } };
    const detail = { meeting_id: meetingId, operation_id: operationId, effect: { operation_id: operationId, id: versionId, command_key: commandKey, authorization_key: meetingId, authorization_revision: 2 } };
    expect(cockpitPreparationGrantReplaced(effect, detail)).toBe(true);
    expect(cockpitPreparationGrantReplaced(effect, { ...detail, effect: { ...detail.effect, authorization_revision: 1 } })).toBe(false);
    expect(cockpitPreparationGrantReplaced(effect, { ...detail, effect: { ...detail.effect, authorization_key: operationId } })).toBe(false);
    expect(cockpitPreparationGrantReplaced(effect, { ...detail, meeting_id: versionId })).toBe(false);
    expect(cockpitPreparationGrantReplaced(effect, { ...detail, effect: { ...detail.effect, id: meetingId } })).toBe(false);
  });
});
