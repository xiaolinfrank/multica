// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedReadError, CockpitUnconfirmedWriteError } from "../cockpit/errors";
import type {
  CockpitMeetingTemplateConfig, CockpitMeetingTemplateVersionMetadata, CockpitMeetingTemplateVersionDetail,
  CockpitMeetingTemplateHeader, CockpitMeetingTemplateSaveInput, CockpitMeetingTemplateSaveResult,
  CockpitMeetingTemplateBinding, CockpitTemplateApplicationPreview, CockpitPreparationOperationHeader,
  CockpitPreparationEffect, CockpitPreparationEffectReceipt, CockpitPreparationEffectResult,
  CockpitPreparationCommandReceipt, CockpitPreparationCommandResult, CockpitDispositionIssue,
  CockpitDispositionRun, CockpitCancellationPreview, CockpitMeetingOperationBasis,
  CockpitPreparationAuthorization, CockpitPreparationReauthorizationPreview, CockpitPreparationEffectApplyInput,
} from "../types/cockpit-meeting-preparation";
import type {
  CockpitOccurrenceView, CockpitMeetingLifecycleHeader, CockpitLifecycleReceipt,
  CockpitLifecycleCommandDetail, CockpitLifecycleCommandResult,
} from "../types/cockpit-meeting-lifecycle";
import type { CockpitTask } from "../types/cockpit";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WS = id(1), MEETING = id(2), TEMPLATE = id(3), VERSION = id(4), LATER_VERSION = id(5);
const OP = id(6), EFFECT = id(7), KEY = id(8), EFFECT_KEY = id(9), USER = id(10), OTHER = id(999);
const AGENDA = id(11), ISSUE = id(12), RUN = id(13), AGENDA_SLOT = id(14), ISSUE_SLOT = id(15), REF = id(16);
const AUTH = id(17);
const TIME = "2026-10-11T01:02:03Z", HASH = "a".repeat(64), TOKEN = "b".repeat(64);
const endpoint = `https://example.test/api/cockpit/meetings/${MEETING}`;

function config(): CockpitMeetingTemplateConfig {
  return { schema_version: 1, slots: [
    { slot_id: AGENDA_SLOT, kind: "agenda", label: "Discuss the boundary", agenda_slot_id: null,
      agenda: { title: "Boundary discussion", purposes: ["boundary_confirmation"], desired_outcome: "  An explicit decision\n", notes: "  Preserve these notes\n\n" }, new_issue: null, purpose: "" },
    { slot_id: ISSUE_SLOT, kind: "preparation_issue", label: "Prepare evidence", agenda_slot_id: AGENDA_SLOT, agenda: null,
      new_issue: { title: "Collect evidence", description: "  Keep this description\n", priority: "high" }, purpose: "" },
  ] };
}
function version(patch: Partial<CockpitMeetingTemplateVersionMetadata> = {}): CockpitMeetingTemplateVersionMetadata {
  return { id: VERSION, template_id: TEMPLATE, number: 1, title: "Boundary preparation", active: true, slot_count: 2,
    config_hash: HASH, command_key: KEY, created_by: USER, created_by_name: "Template owner", created_at: TIME, ...patch };
}
function versionDetail(patch: Partial<CockpitMeetingTemplateVersionDetail> = {}): CockpitMeetingTemplateVersionDetail {
  return { ...version(), workspace_id: WS, description: "  Fixed template description\n\n", config: config(), ...patch };
}
function template(patch: Partial<CockpitMeetingTemplateHeader> = {}): CockpitMeetingTemplateHeader {
  return { workspace_id: WS, id: TEMPLATE, revision: 1, title: "Boundary preparation", description: "  Fixed template description\n\n",
    active: true, created_by: USER, created_at: TIME, updated_at: TIME, current_version: version(), can_edit: true, ...patch };
}
function saveBody(patch: Partial<CockpitMeetingTemplateSaveInput> = {}): CockpitMeetingTemplateSaveInput {
  return { command_key: KEY, expected_revision: 0, title: "Boundary preparation", description: "  Fixed template description\n\n", active: true, config: config(), ...patch };
}
function saved(patch: Partial<CockpitMeetingTemplateSaveResult> = {}): CockpitMeetingTemplateSaveResult {
  return { workspace_id: WS, template_id: TEMPLATE, command_key: KEY, request_hash: HASH, replayed: false,
    receipt: versionDetail(), current: template(), ...patch };
}
function binding(slotId: string, patch: Partial<CockpitMeetingTemplateBinding> = {}): CockpitMeetingTemplateBinding {
  return { slot_id: slotId, selected: false, node_id: null, facilitator_user_id: null, project_id: null, module_id: null,
    assignee_type: null, assignee_id: null, due_date: null, issue_id: null, material_reference_id: null, ...patch };
}
function bindings() { return [binding(AGENDA_SLOT, { selected: true }), binding(ISSUE_SLOT)]; }
function preview(patch: Partial<CockpitTemplateApplicationPreview> = {}): CockpitTemplateApplicationPreview {
  return { workspace_id: WS, meeting_id: MEETING, template_id: TEMPLATE, template_version_id: VERSION,
    lifecycle_revision: 4, agenda_revision: 8, context_token: TOKEN, config_hash: HASH,
    effects: [{ slot_id: AGENDA_SLOT, kind: "agenda", label: "Discuss the boundary", agenda_slot_id: null,
      selected: true, allowed: true, reason_codes: [], targets: [], issue_impact: null, scope: null },
    { slot_id: ISSUE_SLOT, kind: "preparation_issue", label: "Prepare evidence", agenda_slot_id: AGENDA_SLOT,
      selected: false, allowed: true, reason_codes: [], targets: [], issue_impact: null, scope: null }],
    selected_total: 1, can_confirm: true, blocked_reasons: [], ...patch };
}
function operation(patch: Partial<CockpitPreparationOperationHeader> = {}): CockpitPreparationOperationHeader {
  const templated = (patch.kind ?? "apply_template") === "apply_template";
  return { workspace_id: WS, meeting_id: MEETING, id: OP, kind: "apply_template", revision: 1, state: "active", command_key: KEY,
    template_id: TEMPLATE, template_version_id: VERSION, template_title: templated ? "Boundary preparation" : "", template_version_number: templated ? 1 : null, responsible_user_name: "Template owner", created_by: USER, created_by_name: "Template owner", responsible_user_id: USER,
    created_at: TIME, updated_at: TIME, counts: { total: 1, pending: 1, applied: 0, needs_attention: 0, skipped: 0 },
    can_continue: true, can_pause: true, can_resume: false, can_claim: false, blocked_reasons: [], ...patch };
}
function effect(patch: Partial<CockpitPreparationEffect> = {}): CockpitPreparationEffect {
  return { id: EFFECT, operation_id: OP, slot_id: AGENDA_SLOT, position: 1, kind: "agenda", label: "Discuss the boundary", revision: 1,
    state: "pending", command_key: EFFECT_KEY, dependency_id: null, error_code: "", reason: "", targets: [], receipt: null,
    can_apply: true, can_skip: true, can_reauthorize: false, authorization_key: AUTH, authorization_revision: 1, ...patch };
}
function effectReceipt(patch: Partial<CockpitPreparationEffectReceipt> = {}): CockpitPreparationEffectReceipt {
  return { effect_id: EFFECT, command_key: EFFECT_KEY, request_hash: HASH, kind: "agenda", agenda_id: AGENDA, reference_id: null,
    issue_id: null, run_id: null, issue: null, run_status: null, stopped_wakeup_ids: [], cancelled_queue_ids: [], applied_at: TIME, authorization_key: AUTH, authorization_revision: 1, changed: true, stopped_wakeup_total: 0, cancelled_queue_total: 0, facts_hash: HASH, target_meeting_id: null, ...patch };
}
function effectResult(patch: Partial<CockpitPreparationEffectResult> = {}): CockpitPreparationEffectResult {
  return { workspace_id: WS, meeting_id: MEETING, operation_id: OP, effect_id: EFFECT, command_key: EFFECT_KEY, replayed: true,
    receipt: effectReceipt(), current: operation({ revision: 3, state: "completed", counts: { total: 1, pending: 0, applied: 1, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false }), ...patch };
}
function commandReceipt(patch: Partial<CockpitPreparationCommandReceipt> = {}): CockpitPreparationCommandReceipt {
  return { directory_effect: null, operation_id: OP, kind: "apply_template", revision: 1, state: "active", effect_ids: [EFFECT], effect_id: null, reason: "",
    request_hash: HASH, occurrence: null, context_token: TOKEN, template_version_id: VERSION, authorization: null, previous_authorization: null, ...patch };
}
function commandResult(patch: Partial<CockpitPreparationCommandResult> = {}): CockpitPreparationCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "template_apply", replayed: false,
    receipt: commandReceipt(), current: operation(), ...patch };
}
function occurrence(patch: Partial<CockpitOccurrenceView> = {}): CockpitOccurrenceView {
  return { state: "scheduled", started_confirmed_at: null, started_confirmed_by: null, ended_at: null, ended_by: null, ended_source: null,
    actual_started_at: null, actual_ended_at: null, cancelled_at: null, cancelled_by: null, cancelled_reason: "", ...patch };
}
function lifecycle(patch: Partial<CockpitMeetingLifecycleHeader> = {}): CockpitMeetingLifecycleHeader {
  return { workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 4, agenda_revision: 8, generated_at: TIME, occurrence: occurrence(),
    materials: null, workflow_enabled: false, agenda_total: 1, can_schedule: false, can_end: true, can_correct_times: false,
    can_edit_agenda: true, can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [], archive: { archived_at: null, archived_by: null, reason: "" }, ...patch };
}
function envelope(patch: Partial<CockpitLifecycleReceipt> = {}): CockpitLifecycleReceipt {
  return { revision: 4, agenda_revision: 8, agenda_id: null, reference_id: null, issue_id: null, request_hash: HASH, reason: "",
    previous_occurrence: null, occurrence: null, materials: null, agenda: null, reference: null,
    archive: null, previous_archive: null, preparation: null, ...patch };
}
function history(patch: Partial<CockpitLifecycleCommandDetail> = {}): CockpitLifecycleCommandDetail {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "template_apply", actor_id: USER, actor_type: "member", actor_name: "Template owner",
    created_at: TIME, revision: 4, agenda_id: null, reference_id: null, issue_id: null, operation_id: OP, effect_id: null, receipt: envelope({ preparation: commandReceipt() }), ...patch };
}
function task(patch: Partial<CockpitTask> = {}): CockpitTask {
  return { id: ISSUE, identifier: "PREP-1", title: "Collect evidence", status: "backlog", status_category: "unstarted", priority: "high",
    assignee_type: null, assignee_id: null, assignee_name: "", due_date: null, project_id: null, module_id: null, primary_node_id: null,
    primary_node_code: "", primary_node_name: "", primary_revision: 0, creation_key: null, ...patch };
}
function issueImpact(patch: Partial<CockpitDispositionIssue> = {}): CockpitDispositionIssue {
  return { issue: task(), issue_revision: 2, can_cancel: true, can_change_due_date: true, can_link_meeting: true, cancel_status: "closed",
    blocked_reasons: [], ordinary_wakeup_count: 2, system_rule_count: 1, unstarted_wakeup_run_count: 1, other_queued_run_count: 3,
    active_run_count: 2, agenda_total: 4, targets: [], targets_total: 0, parent_issue_id: null, evaluates_parent_rules: false, ...patch };
}
function run(patch: Partial<CockpitDispositionRun> = {}): CockpitDispositionRun {
  return { id: RUN, issue_id: ISSUE, agent_id: USER, agent_name: "Fixture agent", status: "running", started_at: TIME,
    is_wakeup: false, can_stop: true, blocked_reasons: [], ...patch };
}
function cancellationPreview(patch: Partial<CockpitCancellationPreview> = {}): CockpitCancellationPreview {
  return { directory_impact: null, intent: "cancel", workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 4, context_token: TOKEN, occurrence: occurrence(),
    affected_issue_total: 28, unselected_issue_total: 27, active_run_total: 9, unselected_run_total: 9,
    effects: [{ slot_id: ISSUE, kind: "cancel_issue", label: "Collect evidence", agenda_slot_id: null, selected: true, allowed: true,
      reason_codes: [], targets: [], issue_impact: issueImpact(), scope: null }], selected_total: 1, can_confirm: true, blocked_reasons: [], ...patch };
}
function basis(patch: Partial<CockpitMeetingOperationBasis> = {}): CockpitMeetingOperationBasis {
  const allowed = () => ({ state: "allowed" as const, reason_codes: [] });
  return { workspace_id: WS, meeting_id: MEETING, schema_version: 1, generated_at: TIME, availability: "available", lifecycle_revision: 4,
    delete: { state: "blocked", reason_codes: ["preparation_history"] }, cancel: allowed(), reinstate: allowed(), archive: allowed(), unarchive: allowed(),
    add_preparation: allowed(), apply_template: allowed(), append_disposition: allowed(), can_add_preparation: true, pending: { directory_operations: 0, minutes_review: 1, draft_actions: 2,
      active_preparation_issues: 3, active_runs: 4, nas_operations: 5, preparation_operations: 1 }, current_operation: operation(), targets: [], targets_total: 0, ...patch };
}
function applyBody(patch: Partial<CockpitPreparationEffectApplyInput> = {}): CockpitPreparationEffectApplyInput {
  return { command_key: EFFECT_KEY, authorization_key: AUTH, authorization_revision: 1, ...patch };
}
function authorization(patch: Partial<CockpitPreparationAuthorization> = {}): CockpitPreparationAuthorization {
  return { key: AUTH, revision: 1, context_token: "c".repeat(64), facts_hash: HASH, confirmed_by: USER, confirmed_at: TIME, impact: issueImpact(), selected_run: null, scope: null, ...patch };
}
function authorizationPreview(patch: Partial<CockpitPreparationReauthorizationPreview> = {}): CockpitPreparationReauthorizationPreview {
  return { workspace_id: WS, meeting_id: MEETING, operation_id: OP, effect_id: EFFECT, effect_revision: 2, command_key: EFFECT_KEY,
    fixed_intent_hash: HASH, context_token: TOKEN, previous_authorization: authorization(), current_impact: issueImpact({ ordinary_wakeup_count: 3 }),
    targets: [], can_confirm: true, blocked_reasons: [], current_run: null, current_scope: null, ...patch };
}
function reply(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("meeting template and disposition API boundaries", () => {
  it("reads one workspace template page with exact filter echoes and no configuration body", async () => {
    const value = { workspace_id: WS, q: "boundary", include_inactive: true, page_size: 25, items: [template()], total: 31, next_cursor: "next/+?", can_create: true };
    const { client, fetchMock } = reply(value);
    const page = await client.getCockpitMeetingTemplates(WS, { q: "  boundary  ", include_inactive: true, cursor: "previous/+?" });
    expect(page).toEqual(value); expect(page?.items[0]).not.toHaveProperty("config"); expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]?.[0]);
    expect(url.pathname).toBe("/api/cockpit/meeting-templates"); expect(Object.fromEntries(url.searchParams)).toEqual({ q: "boundary", include_inactive: "true", cursor: "previous/+?", page_size: "25" });
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": WS });
    for (const bad of [{ ...value, workspace_id: OTHER }, { ...value, q: "different" }, { ...value, include_inactive: false }, { ...value, page_size: 100 },
      { ...value, next_cursor: undefined }, { ...value, total: undefined }, { ...value, items: [template(), template()] },
      { ...value, items: [template({ workspace_id: OTHER })] }, { ...value, items: [template({ current_version: version({ template_id: OTHER }) })] },
      { ...value, items: Array.from({ length: 26 }, (_, i) => template({ id: id(100 + i), current_version: version({ template_id: id(100 + i) }) })) }]) {
      await expect(reply(bad).client.getCockpitMeetingTemplates(WS, { q: "boundary", include_inactive: true })).resolves.toBeNull();
    }
  });

  it("binds template headers and version metadata pages to the requested template", async () => {
    const { client, fetchMock } = reply(template()); await expect(client.getCockpitMeetingTemplate(WS, TEMPLATE)).resolves.toEqual(template());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meeting-templates/${TEMPLATE}`);
    for (const bad of [template({ id: OTHER }), template({ workspace_id: OTHER }), template({ current_version: version({ template_id: OTHER }) })]) {
      await expect(reply(bad).client.getCockpitMeetingTemplate(WS, TEMPLATE)).resolves.toBeNull();
    }
    const value = { workspace_id: WS, template_id: TEMPLATE, page_size: 25, items: [version()], total: 27, next_cursor: "older" };
    const read = reply(value); const page = await read.client.getCockpitMeetingTemplateVersions(WS, TEMPLATE, { cursor: "next" });
    expect(page).toEqual(value); expect(page?.items[0]).not.toHaveProperty("config"); expect(read.fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(read.fetchMock.mock.calls[0]?.[0]).searchParams.get("cursor")).toBe("next");
    for (const bad of [{ ...value, workspace_id: OTHER }, { ...value, template_id: OTHER }, { ...value, page_size: 100 }, { ...value, next_cursor: undefined },
      { ...value, items: [version({ template_id: OTHER })] }, { ...value, items: [version(), version()] }]) {
      await expect(reply(bad).client.getCockpitMeetingTemplateVersions(WS, TEMPLATE)).resolves.toBeNull();
    }
  });

  it("loads only the selected fixed version and preserves description and configuration whitespace", async () => {
    const value = versionDetail(), { client, fetchMock } = reply(value);
    await expect(client.getCockpitMeetingTemplateVersion(WS, TEMPLATE, VERSION)).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meeting-templates/${TEMPLATE}/versions/${VERSION}`);
    for (const bad of [versionDetail({ workspace_id: OTHER }), versionDetail({ template_id: OTHER }), versionDetail({ id: OTHER }),
      { ...value, config: undefined }, { ...value, description: undefined }, { ...value, slot_count: 9 }]) {
      await expect(reply(bad).client.getCockpitMeetingTemplateVersion(WS, TEMPLATE, VERSION)).resolves.toBeNull();
    }
  });

  it("confirms the exact saved version even when a replay returns a newer current template", async () => {
    const later = template({ revision: 3, title: "Changed later", active: false, description: "Later description",
      current_version: version({ id: LATER_VERSION, number: 3, title: "Changed later", active: false, command_key: OTHER }) });
    const value = saved({ replayed: true, current: later }); const { client, fetchMock } = reply(value);
    const input = saveBody({ title: "  Boundary preparation  " });
    input.config.slots[0]!.label = "  Discuss the boundary  "; input.config.slots[0]!.agenda!.title = "  Boundary discussion  ";
    await expect(client.saveCockpitMeetingTemplate(WS, null, input)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/api/cockpit/meeting-templates");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "X-Workspace-ID": WS } });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(input);
    const updated = saved({ receipt: versionDetail({ number: 2 }), current: later }); const update = reply(updated);
    await expect(update.client.saveCockpitMeetingTemplate(WS, TEMPLATE, saveBody({ expected_revision: 1 }))).resolves.toEqual(updated);
    expect(update.fetchMock.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meeting-templates/${TEMPLATE}/versions`);
  });

  it("refuses a saved ACK with a different key, template or fixed content", async () => {
    const changedConfig = config(); changedConfig.slots[0]!.agenda!.notes = "Preserve these notes";
    for (const bad of [saved({ workspace_id: OTHER }), saved({ template_id: OTHER }), saved({ command_key: OTHER }),
      saved({ receipt: versionDetail({ template_id: OTHER }) }), saved({ receipt: versionDetail({ command_key: OTHER }) }),
      saved({ receipt: versionDetail({ description: "Fixed template description" }) }), saved({ receipt: versionDetail({ config: changedConfig }) }),
      saved({ receipt: versionDetail({ active: false }) }), saved({ current: template({ id: OTHER }) }), { ...saved(), receipt: undefined }]) {
      await expect(reply(bad).client.saveCockpitMeetingTemplate(WS, null, saveBody())).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("recovers a lost template creation by its command key without knowing a template ID or writing again", async () => {
    const value = saved({ replayed: true }), { client, fetchMock } = reply(value);
    await expect(client.getCockpitMeetingTemplateCommand(WS, KEY)).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://example.test/api/cockpit/meeting-templates/commands/${KEY}`);
    expect(fetchMock.mock.calls[0]?.[1].method ?? "GET").toBe("GET");
    for (const bad of [saved({ command_key: OTHER }), saved({ workspace_id: OTHER }), saved({ receipt: versionDetail({ command_key: OTHER }) })]) {
      await expect(reply(bad).client.getCockpitMeetingTemplateCommand(WS, KEY)).resolves.toBeNull();
    }
  });

  it("previews only the selected fixed-version effects and requires a nonempty context token", async () => {
    const body = { template_version_id: VERSION, bindings: bindings() }, { client, fetchMock } = reply(preview());
    await expect(client.previewCockpitTemplateApplication(WS, MEETING, body)).resolves.toEqual(preview());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/template-applications/preview`);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    for (const bad of [preview({ workspace_id: OTHER }), preview({ meeting_id: OTHER }), preview({ template_version_id: OTHER }), preview({ context_token: "" }),
      preview({ selected_total: 2 }), preview({ effects: [preview().effects[1]!] }),
      preview({ effects: preview().effects.map((effect) => ({ ...effect, selected: !effect.selected })) })]) {
      await expect(reply(bad).client.previewCockpitTemplateApplication(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
  });

  it("confirms the original application rather than replacing its receipt with a later operation state", async () => {
    const body = { command_key: KEY, expected_revision: 4, template_version_id: VERSION, context_token: TOKEN, bindings: bindings() };
    const value = commandResult({ replayed: true, current: effectResult().current }); const { client, fetchMock } = reply(value);
    await expect(client.applyCockpitMeetingTemplate(WS, MEETING, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/template-applications`); expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    for (const bad of [commandResult({ command_key: OTHER }), commandResult({ action: "cancel" }), commandResult({ meeting_id: OTHER }), commandResult({ workspace_id: OTHER }),
      commandResult({ receipt: commandReceipt({ context_token: "other-token" }) }), commandResult({ receipt: commandReceipt({ template_version_id: OTHER }) }),
      commandResult({ receipt: commandReceipt({ operation_id: OTHER }) }), commandResult({ receipt: commandReceipt({ effect_ids: [EFFECT, EFFECT] }) }),
      commandResult({ current: operation({ meeting_id: OTHER }) })]) {
      await expect(reply(bad).client.applyCockpitMeetingTemplate(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("keeps preparation receipt identity inside the compatible lifecycle history envelope", async () => {
    const value = history(), { client, fetchMock } = reply(value);
    await expect(client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/commands/${KEY}`);
    for (const bad of [history({ command_key: OTHER }), history({ workspace_id: OTHER }), history({ meeting_id: OTHER }),
      history({ receipt: envelope({ preparation: commandReceipt({ operation_id: OTHER }) }) }),
      history({ effect_id: OTHER }),
      history({ receipt: envelope({ preparation: commandReceipt({ request_hash: "c".repeat(64) }) }) }),
      history({ receipt: envelope({ preparation: commandReceipt({ effect_ids: [EFFECT, EFFECT] }) }) }),
      history({ action: "cancel", receipt: envelope({ preparation: commandReceipt() }) })]) {
      await expect(reply(bad).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toBeNull();
    }
  });

  it("reads one operation page and one exact header without fetching every effect", async () => {
    const value = { workspace_id: WS, meeting_id: MEETING, page_size: 25, items: [operation()], total: 30, next_cursor: "older" };
    const { client, fetchMock } = reply(value); await expect(client.getCockpitPreparationOperations(WS, MEETING, { cursor: "previous" })).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(new URL(fetchMock.mock.calls[0]?.[0]).pathname).toBe(`/api/cockpit/meetings/${MEETING}/preparation-operations`);
    for (const bad of [{ ...value, workspace_id: OTHER }, { ...value, meeting_id: OTHER }, { ...value, page_size: 100 }, { ...value, total: undefined },
      { ...value, items: [operation({ meeting_id: OTHER })] }, { ...value, items: [operation(), operation()] }]) {
      await expect(reply(bad).client.getCockpitPreparationOperations(WS, MEETING)).resolves.toBeNull();
    }
    await expect(reply(operation()).client.getCockpitPreparationOperation(WS, MEETING, OP)).resolves.toEqual(operation());
    for (const bad of [operation({ id: OTHER }), operation({ workspace_id: OTHER }), operation({ meeting_id: OTHER })]) {
      await expect(reply(bad).client.getCockpitPreparationOperation(WS, MEETING, OP)).resolves.toBeNull();
    }
  });

  it("keeps older operation metadata readable when optional display fields are absent", async () => {
    const legacy: Record<string, unknown> = { ...operation() };
    for (const key of ["template_title", "template_version_number", "responsible_user_name"]) delete legacy[key];
    await expect(reply(legacy).client.getCockpitPreparationOperation(WS, MEETING, OP)).resolves.toEqual(operation({
      template_title: "", template_version_number: null, responsible_user_name: "",
    }));
  });

  it("reads bounded effects and refuses foreign operation or nested receipt identity", async () => {
    const value = { workspace_id: WS, meeting_id: MEETING, operation_id: OP, revision: 1, page_size: 25, items: [effect()], total: 50, next_cursor: "next-effects" };
    const { client, fetchMock } = reply(value); await expect(client.getCockpitPreparationEffects(WS, MEETING, OP)).resolves.toEqual(value); expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [{ ...value, workspace_id: OTHER }, { ...value, meeting_id: OTHER }, { ...value, operation_id: OTHER }, { ...value, page_size: 100 },
      { ...value, items: [effect({ operation_id: OTHER })] }, { ...value, items: [effect(), effect()] }]) {
      await expect(reply(bad).client.getCockpitPreparationEffects(WS, MEETING, OP)).resolves.toBeNull();
    }
    const detail = { workspace_id: WS, meeting_id: MEETING, operation_id: OP, effect: effect({ state: "applied", receipt: effectReceipt(), can_apply: false, can_skip: false }), current: effectResult().current };
    await expect(reply(detail).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toEqual(detail);
    for (const bad of [{ ...detail, workspace_id: OTHER }, { ...detail, meeting_id: OTHER }, { ...detail, operation_id: OTHER },
      { ...detail, effect: { ...detail.effect, id: OTHER } }, { ...detail, effect: { ...detail.effect, command_key: OTHER } },
      { ...detail, effect: { ...detail.effect, receipt: effectReceipt({ effect_id: OTHER }) } }, { ...detail, current: operation({ id: OTHER }) }]) {
      await expect(reply(bad).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toBeNull();
    }
  });

  it("treats unknown operation, effect and run states as readable but non-actionable", async () => {
    await expect(reply(operation({ state: "future_state", can_claim: true })).client.getCockpitPreparationOperation(WS, MEETING, OP))
      .resolves.toMatchObject({ state: "future_state", can_continue: false, can_pause: false, can_resume: false, can_claim: false });
    await expect(reply(operation({ kind: "future_kind", can_claim: true })).client.getCockpitPreparationOperation(WS, MEETING, OP))
      .resolves.toMatchObject({ kind: "future_kind", can_continue: false, can_pause: false, can_resume: false, can_claim: false });
    const value = { workspace_id: WS, meeting_id: MEETING, operation_id: OP, effect: effect({ kind: "future_kind", can_reauthorize: true }), current: operation() };
    await expect(reply(value).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toMatchObject({ effect: { kind: "future_kind", can_apply: false, can_skip: false, can_reauthorize: false } });
    const runs = { workspace_id: WS, meeting_id: MEETING, issue_id: ISSUE, page_size: 25, items: [run({ status: "future_status" })], total: 1, next_cursor: null };
    await expect(reply(runs).client.getCockpitCancellationRuns(WS, MEETING, ISSUE)).resolves.toMatchObject({ items: [{ status: "future_status", can_stop: false }] });
  });

  it("uses only the effect's retained command key and returns its fixed backlog issue on replay", async () => {
    const fixed = effectReceipt({ kind: "preparation_issue", reference_id: REF, issue_id: ISSUE, issue: task() });
    const value = effectResult({ receipt: fixed }), { client, fetchMock } = reply(value);
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/preparation-operations/${OP}/effects/${EFFECT}/apply`);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(applyBody());
    for (const bad of [effectResult({ effect_id: OTHER }), effectResult({ command_key: OTHER }), effectResult({ operation_id: OTHER }),
      effectResult({ workspace_id: OTHER }), effectResult({ meeting_id: OTHER }), effectResult({ receipt: effectReceipt({ command_key: OTHER }) }), effectResult({ receipt: effectReceipt({ authorization_key: OTHER }) }),
      effectResult({ receipt: effectReceipt({ authorization_revision: 2 }) }),
      effectResult({ receipt: { ...fixed, issue: task({ id: OTHER }) } }), effectResult({ receipt: { ...fixed, issue: task({ status: "todo", status_category: "started" }) } }),
      effectResult({ current: operation({ id: OTHER }) })]) {
      await expect(reply(bad).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("retains the exact other meeting in a link receipt and rejects an unconfirmed destination", async () => {
    const targetMeeting = id(18);
    const fixed = effectReceipt({ kind: "link_meeting", issue_id: ISSUE, reference_id: REF, target_meeting_id: targetMeeting });
    const current = operation({ kind: "cancel_preparation", template_id: null, template_version_id: null, revision: 7, state: "completed",
      counts: { total: 1, applied: 1, pending: 0, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false });
    const value = effectResult({ receipt: fixed, current }), { client, fetchMock } = reply(value);
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/preparation-operations/${OP}/effects/${EFFECT}/apply`);
    expect(value.receipt.target_meeting_id).not.toBe(value.meeting_id);
    const detail = { workspace_id: WS, meeting_id: MEETING, operation_id: OP,
      effect: effect({ kind: "link_meeting", state: "applied", receipt: fixed, can_apply: false, can_skip: false }), current };
    await expect(reply(detail).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toEqual(detail);
    for (const patch of [{ target_meeting_id: null }, { agenda_id: null }, { reference_id: null }, { issue_id: null }]) {
      const receipt = { ...fixed, ...patch };
      await expect(reply({ ...value, receipt }).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
      await expect(reply({ ...detail, effect: { ...detail.effect, receipt } }).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toBeNull();
    }
  });

  it("confirms skip against the exact operation, effect and reason without using later state", async () => {
    const body = { command_key: KEY, expected_revision: 2, transition: "skip", effect_id: EFFECT, reason: "The retained source is no longer required." };
    const value = commandResult({ action: "preparation_skip", receipt: commandReceipt({ revision: 3, state: "completed", effect_id: EFFECT, reason: body.reason }), current: operation({ revision: 7, state: "paused" }) });
    await expect(reply(value).client.controlCockpitPreparationOperation(WS, MEETING, OP, body)).resolves.toEqual(value);
    for (const bad of [{ ...value, action: "preparation_pause" }, { ...value, command_key: OTHER }, { ...value, receipt: { ...value.receipt, operation_id: OTHER } },
      { ...value, receipt: { ...value.receipt, effect_id: OTHER } }, { ...value, receipt: { ...value.receipt, reason: "Different reason" } }]) {
      await expect(reply(bad).client.controlCockpitPreparationOperation(WS, MEETING, OP, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("keeps cancellation impact and exact run pages scoped and bounded without treating a task close as a run stop", async () => {
    const impact = { workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 4, q: "evidence", page_size: 25, items: [issueImpact()], total: 28, next_cursor: "next-issues" };
    const { client, fetchMock } = reply(impact); await expect(client.getCockpitCancellationImpact(WS, MEETING, { q: " evidence ", cursor: "next" })).resolves.toEqual(impact);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(Object.fromEntries(new URL(fetchMock.mock.calls[0]?.[0]).searchParams)).toEqual({ q: "evidence", cursor: "next", page_size: "25" });
    for (const bad of [{ ...impact, workspace_id: OTHER }, { ...impact, meeting_id: OTHER }, { ...impact, q: "other" }, { ...impact, items: [issueImpact(), issueImpact()] }, { ...impact, page_size: 100 }]) {
      await expect(reply(bad).client.getCockpitCancellationImpact(WS, MEETING, { q: "evidence" })).resolves.toBeNull();
    }
    const runs = { workspace_id: WS, meeting_id: MEETING, issue_id: ISSUE, page_size: 25, items: [run()], total: 2, next_cursor: "older-runs" };
    await expect(reply(runs).client.getCockpitCancellationRuns(WS, MEETING, ISSUE)).resolves.toEqual(runs);
    for (const bad of [{ ...runs, workspace_id: OTHER }, { ...runs, meeting_id: OTHER }, { ...runs, issue_id: OTHER }, { ...runs, items: [run({ issue_id: OTHER })] }, { ...runs, items: [run(), run()] }]) {
      await expect(reply(bad).client.getCockpitCancellationRuns(WS, MEETING, ISSUE)).resolves.toBeNull();
    }
  });

  it("previews and records cancellation as a fixed occurrence plus unfinished disposition operation", async () => {
    const choices = [{ issue_id: ISSUE, expected_revision: 2, action: "cancel", cancel_status: "closed", due_date: null, target_meeting_id: null, target_agenda_id: null }];
    const selection = { reason: "The external event was cancelled.", issues: choices, run_ids: [] };
    const read = reply(cancellationPreview()); await expect(read.client.previewCockpitMeetingCancellation(WS, MEETING, selection)).resolves.toEqual(cancellationPreview());
    expect(JSON.parse(read.fetchMock.mock.calls[0]?.[1].body)).toEqual(selection);
    for (const bad of [cancellationPreview({ workspace_id: OTHER }), cancellationPreview({ meeting_id: OTHER }), cancellationPreview({ context_token: "" }),
      cancellationPreview({ selected_total: 0 }), cancellationPreview({ unselected_issue_total: 29 })]) {
      await expect(reply(bad).client.previewCockpitMeetingCancellation(WS, MEETING, selection)).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
    const fixed = occurrence({ state: "cancelled", cancelled_at: TIME, cancelled_by: USER, cancelled_reason: selection.reason });
    const body = { ...selection, command_key: KEY, expected_revision: 4, context_token: TOKEN };
    const value = commandResult({ action: "cancel", receipt: commandReceipt({ kind: "cancel_preparation", template_version_id: null, reason: selection.reason, occurrence: fixed }),
      current: operation({ kind: "cancel_preparation", template_id: null, template_version_id: null }) });
    await expect(reply(value).client.cancelCockpitMeeting(WS, MEETING, body)).resolves.toEqual(value);
    for (const bad of [{ ...value, command_key: OTHER }, { ...value, action: "template_apply" }, { ...value, receipt: { ...value.receipt, occurrence: occurrence() } },
      { ...value, receipt: { ...value.receipt, reason: "Different cancellation" } }, { ...value, receipt: { ...value.receipt, context_token: "another-preview" } }]) {
      await expect(reply(bad).client.cancelCockpitMeeting(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("preserves directory pause counts and bounded identities without claiming that an active filesystem call was undone", async () => {
    const selection = { reason: "The planned discussion will not be held.", issues: [], run_ids: [] };
    const impact = { unfinished_total: 202, will_pause_total: 150, sample_operation_ids: Array.from({ length: 100 }, (_, n) => id(200 + n)), facts_hash: HASH };
    const preview = cancellationPreview({ directory_impact: impact, effects: [], selected_total: 0 });
    await expect(reply(preview).client.previewCockpitMeetingCancellation(WS, MEETING, selection)).resolves.toEqual(preview);
    for (const changed of [{ ...impact, will_pause_total: 203 }, { ...impact, sample_operation_ids: [OP, OP] }, { ...impact, facts_hash: "" }, { ...impact, will_pause_total: 99 }]) {
      await expect(reply({ ...preview, directory_impact: changed }).client.previewCockpitMeetingCancellation(WS, MEETING, selection)).rejects.toBeInstanceOf(CockpitUnconfirmedReadError);
    }
    const body = { ...selection, command_key: KEY, expected_revision: 4, context_token: TOKEN };
    const fixed = occurrence({ state: "cancelled", cancelled_at: TIME, cancelled_by: USER, cancelled_reason: selection.reason });
    const effect = { paused_total: 150, sample_operation_ids: impact.sample_operation_ids, facts_hash: HASH };
    const value = commandResult({ action: "cancel", receipt: commandReceipt({ kind: "cancel_preparation", template_version_id: null, effect_ids: [], reason: selection.reason, occurrence: fixed, directory_effect: effect, state: "completed" }),
      current: operation({ kind: "cancel_preparation", template_id: null, template_version_id: null, state: "completed", counts: { total: 0, pending: 0, applied: 0, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false }) });
    await expect(reply(value).client.cancelCockpitMeeting(WS, MEETING, body)).resolves.toEqual(value);
    await expect(reply({ ...value, receipt: { ...value.receipt, directory_effect: { ...effect, paused_total: 1 } } }).client.cancelCockpitMeeting(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    const legacy = { ...preview, directory_impact: undefined };
    await expect(reply(legacy).client.previewCockpitMeetingCancellation(WS, MEETING, selection)).resolves.toMatchObject({ directory_impact: null });
  });

  it("keeps archive, unarchive and reinstatement receipts independent from later lifecycle facts", async () => {
    const body = { command_key: KEY, expected_revision: 4, transition: "archive", reason: "Retain the completed record." };
    const fixed = { archived_at: TIME, archived_by: USER, reason: body.reason };
    const value: CockpitLifecycleCommandResult = { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "archive", replayed: true,
      receipt: envelope({ revision: 5, reason: body.reason, archive: fixed, previous_archive: { archived_at: null, archived_by: null, reason: "" } }),
      current: lifecycle({ lifecycle_revision: 8 }) };
    const { client, fetchMock } = reply(value); await expect(client.recordCockpitMeetingDisposition(WS, MEETING, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/disposition`);
    for (const bad of [{ ...value, action: "unarchive" }, { ...value, command_key: OTHER }, { ...value, meeting_id: OTHER },
      { ...value, receipt: { ...value.receipt, archive: null } }, { ...value, receipt: { ...value.receipt, reason: "Other reason" } }]) {
      await expect(reply(bad).client.recordCockpitMeetingDisposition(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    const unarchive = { ...value, action: "unarchive" as const, receipt: envelope({ revision: 5, reason: body.reason, archive: { archived_at: null, archived_by: null, reason: "" }, previous_archive: fixed }) };
    await expect(reply(unarchive).client.recordCockpitMeetingDisposition(WS, MEETING, { ...body, transition: "unarchive" })).resolves.toEqual(unarchive);
    const previous = occurrence({ state: "cancelled", cancelled_at: TIME, cancelled_by: USER, cancelled_reason: "Past cancellation" });
    const reinstated = { ...value, action: "reinstate" as const, receipt: envelope({ revision: 5, reason: body.reason, previous_occurrence: previous, occurrence: occurrence() }) };
    await expect(reply(reinstated).client.recordCockpitMeetingDisposition(WS, MEETING, { ...body, transition: "reinstate" })).resolves.toEqual(reinstated);
  });

  it("requires complete independent operation basis and never grants actions for an unknown contract", async () => {
    const { client, fetchMock } = reply(basis()); await expect(client.getCockpitMeetingOperationBasis(WS, MEETING)).resolves.toEqual(basis());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/operation-basis`); expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [basis({ workspace_id: OTHER }), basis({ meeting_id: OTHER }), { ...basis(), pending: undefined }, { ...basis(), cancel: undefined }]) {
      await expect(reply(bad).client.getCockpitMeetingOperationBasis(WS, MEETING)).resolves.toBeNull();
    }
    const unknown = await reply(basis({ schema_version: 99 })).client.getCockpitMeetingOperationBasis(WS, MEETING);
    expect(unknown?.can_add_preparation ?? false).toBe(false);
    expect(unknown?.cancel.state).not.toBe("allowed"); expect(unknown?.apply_template.state).not.toBe("allowed");
    expect(unknown?.append_disposition.state).not.toBe("allowed");
  });

  it("reads reauthorization facts for only the requested effect and confirms the exact new grant", async () => {
    const read = reply(authorizationPreview());
    await expect(read.client.getCockpitPreparationAuthorizationPreview(WS, MEETING, OP, EFFECT)).resolves.toEqual(authorizationPreview());
    expect(read.fetchMock).toHaveBeenCalledTimes(1); expect(read.fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/preparation-operations/${OP}/effects/${EFFECT}/authorization-preview`);
    for (const bad of [authorizationPreview({ workspace_id: OTHER }), authorizationPreview({ meeting_id: OTHER }), authorizationPreview({ operation_id: OTHER }),
      authorizationPreview({ effect_id: OTHER }), authorizationPreview({ context_token: "" }), authorizationPreview({ previous_authorization: authorization({ revision: 0 }) })]) {
      await expect(reply(bad).client.getCockpitPreparationAuthorizationPreview(WS, MEETING, OP, EFFECT)).resolves.toBeNull();
    }
    const body = { command_key: KEY, expected_revision: 2, context_token: TOKEN, reason: "I checked the new ordinary wakeup." };
    const next = authorization({ key: KEY, revision: 2, context_token: TOKEN, impact: issueImpact({ ordinary_wakeup_count: 3 }) });
    const fixed = commandReceipt({ kind: "cancel_preparation", template_version_id: null, effect_id: EFFECT, revision: 5, reason: body.reason,
      authorization: next, previous_authorization: authorization() });
    const value = commandResult({ action: "preparation_reauthorize", replayed: true, receipt: fixed,
      current: operation({ kind: "cancel_preparation", template_id: null, template_version_id: null, revision: 9 }) });
    await expect(reply(value).client.reauthorizeCockpitPreparationEffect(WS, MEETING, OP, EFFECT, body)).resolves.toEqual(value);
    for (const bad of [{ ...value, command_key: OTHER }, { ...value, action: "preparation_claim" }, { ...value, receipt: { ...fixed, effect_id: OTHER } },
      { ...value, receipt: { ...fixed, authorization: { ...next, key: OTHER } } }, { ...value, receipt: { ...fixed, authorization: { ...next, revision: 4 } } },
      { ...value, receipt: { ...fixed, authorization: { ...next, context_token: "another-observation" } } }, { ...value, receipt: { ...fixed, previous_authorization: null } }]) {
      await expect(reply(bad).client.reauthorizeCockpitPreparationEffect(WS, MEETING, OP, EFFECT, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("appends a later disposition without rewriting the original cancellation or silently adding runs", async () => {
    const original = occurrence({ state: "cancelled", cancelled_at: TIME, cancelled_by: USER, cancelled_reason: "Original cancellation" });
    const body = { command_key: KEY, expected_revision: 8, context_token: TOKEN, reason: "Close one retained preparation issue.",
      issues: [{ issue_id: ISSUE, expected_revision: 2, action: "cancel", cancel_status: "closed", due_date: null, target_meeting_id: null, target_agenda_id: null }], run_ids: [] };
    const value = commandResult({ action: "preparation_dispose", receipt: commandReceipt({ kind: "cancel_preparation", template_version_id: null, reason: body.reason, occurrence: original }),
      current: operation({ kind: "cancel_preparation", template_id: null, template_version_id: null }) });
    const { client, fetchMock } = reply(value); await expect(client.appendCockpitMeetingDisposition(WS, MEETING, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/cancellation/dispositions`); expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    await expect(reply({ ...value, action: "cancel" }).client.appendCockpitMeetingDisposition(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply({ ...value, receipt: { ...value.receipt, effect_ids: [EFFECT, OTHER] } }).client.appendCockpitMeetingDisposition(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    const selection = { reason: body.reason, issues: body.issues, run_ids: [] };
    await expect(reply(cancellationPreview({ intent: "append_disposition", occurrence: original })).client.previewCockpitMeetingCancellation(WS, MEETING, selection))
      .resolves.toMatchObject({ intent: "append_disposition", occurrence: original });
    await expect(reply(cancellationPreview({ intent: "future_intent" })).client.previewCockpitMeetingCancellation(WS, MEETING, selection))
      .resolves.toMatchObject({ intent: "future_intent", can_confirm: false });
  });

  it("preserves an already-terminal run observation instead of claiming a new external stop", async () => {
    const fixed = effectReceipt({ kind: "stop_run", agenda_id: null, issue_id: ISSUE, run_id: RUN, run_status: "completed", changed: false });
    const value = effectResult({ receipt: fixed, current: operation({ kind: "cancel_preparation", template_id: null, template_version_id: null, state: "completed",
      counts: { total: 1, pending: 0, applied: 1, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false }) });
    for (const run_status of ["running", "future_status"]) {
      await expect(reply({ ...value, receipt: { ...fixed, run_status, changed: true } }).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody()))
        .rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    await expect(reply(value).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).resolves.toEqual(value);
    await expect(reply(value).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody({ authorization_key: OTHER }))).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply(value).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody({ authorization_revision: 2 }))).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });

  it("uses the explicitly requested workspace after a route switch and rejects missing scope before sending", async () => {
    const other = reply(template({ workspace_id: OTHER })); await expect(other.client.getCockpitMeetingTemplate(OTHER, TEMPLATE)).resolves.toMatchObject({ workspace_id: OTHER });
    expect(other.fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": OTHER });
    const { client, fetchMock } = reply(saved());
    await expect(client.saveCockpitMeetingTemplate("", null, saveBody())).rejects.toThrow();
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, "", EFFECT, applyBody())).rejects.toThrow();
    await expect(client.getCockpitPreparationEffect(WS, "", OP, EFFECT)).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
