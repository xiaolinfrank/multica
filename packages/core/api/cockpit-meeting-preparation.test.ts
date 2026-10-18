// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedReadError, CockpitUnconfirmedWriteError } from "../cockpit/errors";
import type {
  CockpitPreparationOperationHeader,
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
const WS = id(1), MEETING = id(2);
const OP = id(6), EFFECT = id(7), KEY = id(8), EFFECT_KEY = id(9), USER = id(10), OTHER = id(999);
const ISSUE = id(12), RUN = id(13);
const AUTH = id(17);
const TIME = "2026-10-11T01:02:03Z", HASH = "a".repeat(64), TOKEN = "b".repeat(64);
const endpoint = `https://example.test/api/cockpit/meetings/${MEETING}`;

function operation(patch: Partial<CockpitPreparationOperationHeader> = {}): CockpitPreparationOperationHeader {
  return { workspace_id: WS, meeting_id: MEETING, id: OP, kind: "cancel_preparation", revision: 1, state: "active", command_key: KEY,
    responsible_user_name: "Preparer", created_by: USER, created_by_name: "Preparer", responsible_user_id: USER,
    created_at: TIME, updated_at: TIME, counts: { total: 1, pending: 1, applied: 0, needs_attention: 0, skipped: 0 },
    can_continue: true, can_pause: true, can_resume: false, can_claim: false, blocked_reasons: [], ...patch };
}
function effect(patch: Partial<CockpitPreparationEffect> = {}): CockpitPreparationEffect {
  return { id: EFFECT, operation_id: OP, slot_id: ISSUE, position: 1, kind: "cancel_issue", label: "Cancel the queued run", revision: 1,
    state: "pending", command_key: EFFECT_KEY, dependency_id: null, error_code: "", reason: "", targets: [], receipt: null,
    can_apply: true, can_skip: true, can_reauthorize: false, authorization_key: AUTH, authorization_revision: 1, ...patch };
}
function effectReceipt(patch: Partial<CockpitPreparationEffectReceipt> = {}): CockpitPreparationEffectReceipt {
  return { effect_id: EFFECT, command_key: EFFECT_KEY, request_hash: HASH, kind: "cancel_issue",
    issue_id: ISSUE, run_id: null, issue: null, run_status: null, stopped_wakeup_ids: [], cancelled_queue_ids: [], applied_at: TIME, authorization_key: AUTH, authorization_revision: 1, changed: true, stopped_wakeup_total: 0, cancelled_queue_total: 0, facts_hash: HASH, target_meeting_id: null, ...patch };
}
function effectResult(patch: Partial<CockpitPreparationEffectResult> = {}): CockpitPreparationEffectResult {
  return { workspace_id: WS, meeting_id: MEETING, operation_id: OP, effect_id: EFFECT, command_key: EFFECT_KEY, replayed: true,
    receipt: effectReceipt(), current: operation({ revision: 3, state: "completed", counts: { total: 1, pending: 0, applied: 1, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false }), ...patch };
}
function commandReceipt(patch: Partial<CockpitPreparationCommandReceipt> = {}): CockpitPreparationCommandReceipt {
  return { directory_effect: null, operation_id: OP, kind: "cancel_preparation", revision: 1, state: "active", effect_ids: [EFFECT], effect_id: null, reason: "",
    request_hash: HASH, occurrence: null, context_token: TOKEN, authorization: null, previous_authorization: null, ...patch };
}
function commandResult(patch: Partial<CockpitPreparationCommandResult> = {}): CockpitPreparationCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "cancel", replayed: false,
    receipt: commandReceipt(), current: operation(), ...patch };
}
function occurrence(patch: Partial<CockpitOccurrenceView> = {}): CockpitOccurrenceView {
  return { state: "scheduled", started_confirmed_at: null, started_confirmed_by: null, ended_at: null, ended_by: null, ended_source: null,
    actual_started_at: null, actual_ended_at: null, cancelled_at: null, cancelled_by: null, cancelled_reason: "", ...patch };
}
function lifecycle(patch: Partial<CockpitMeetingLifecycleHeader> = {}): CockpitMeetingLifecycleHeader {
  return { workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 4, generated_at: TIME, occurrence: occurrence(),
    materials: null, workflow_enabled: false, can_schedule: false, can_end: true, can_correct_times: false,
    can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [], archive: { archived_at: null, archived_by: null, reason: "" }, ...patch };
}
function envelope(patch: Partial<CockpitLifecycleReceipt> = {}): CockpitLifecycleReceipt {
  return { revision: 4, issue_id: null, request_hash: HASH, reason: "",
    previous_occurrence: null, occurrence: null, materials: null,
    archive: null, previous_archive: null, preparation: null, ...patch };
}
function history(patch: Partial<CockpitLifecycleCommandDetail> = {}): CockpitLifecycleCommandDetail {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action: "cancel", actor_id: USER, actor_type: "member", actor_name: "Preparer",
    created_at: TIME, revision: 4, issue_id: null, operation_id: OP, effect_id: null, receipt: envelope({ preparation: commandReceipt() }), ...patch };
}
function task(patch: Partial<CockpitTask> = {}): CockpitTask {
  return { id: ISSUE, identifier: "PREP-1", title: "Collect evidence", status: "backlog", status_category: "unstarted", priority: "high",
    assignee_type: null, assignee_id: null, assignee_name: "", due_date: null, project_id: null, module_id: null, primary_node_id: null,
    primary_node_code: "", primary_node_name: "", primary_revision: 0, creation_key: null, ...patch };
}
function issueImpact(patch: Partial<CockpitDispositionIssue> = {}): CockpitDispositionIssue {
  return { issue: task(), issue_revision: 2, can_cancel: true, can_change_due_date: true, can_link_meeting: true, cancel_status: "closed",
    blocked_reasons: [], ordinary_wakeup_count: 2, system_rule_count: 1, unstarted_wakeup_run_count: 1, other_queued_run_count: 3,
    active_run_count: 2, targets: [], targets_total: 0, parent_issue_id: null, evaluates_parent_rules: false, ...patch };
}
function run(patch: Partial<CockpitDispositionRun> = {}): CockpitDispositionRun {
  return { id: RUN, issue_id: ISSUE, agent_id: USER, agent_name: "Fixture agent", status: "running", started_at: TIME,
    is_wakeup: false, can_stop: true, blocked_reasons: [], ...patch };
}
function cancellationPreview(patch: Partial<CockpitCancellationPreview> = {}): CockpitCancellationPreview {
  return { directory_impact: null, intent: "cancel", workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 4, context_token: TOKEN, occurrence: occurrence(),
    affected_issue_total: 28, unselected_issue_total: 27, active_run_total: 9, unselected_run_total: 9,
    effects: [{ slot_id: ISSUE, kind: "cancel_issue", label: "Collect evidence", selected: true, allowed: true,
      reason_codes: [], targets: [], issue_impact: issueImpact(), scope: null }], selected_total: 1, can_confirm: true, blocked_reasons: [], ...patch };
}
function basis(patch: Partial<CockpitMeetingOperationBasis> = {}): CockpitMeetingOperationBasis {
  const allowed = () => ({ state: "allowed" as const, reason_codes: [] });
  return { workspace_id: WS, meeting_id: MEETING, schema_version: 1, generated_at: TIME, availability: "available", lifecycle_revision: 4,
    delete: { state: "blocked", reason_codes: ["preparation_history"] }, cancel: allowed(), reinstate: allowed(), archive: allowed(), unarchive: allowed(),
    append_disposition: allowed(), pending: { directory_operations: 0, minutes_review: 1, draft_actions: 2,
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








  it("keeps preparation receipt identity inside the compatible lifecycle history envelope", async () => {
    const value = history(), { client, fetchMock } = reply(value);
    await expect(client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(value);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/commands/${KEY}`);
    for (const bad of [history({ command_key: OTHER }), history({ workspace_id: OTHER }), history({ meeting_id: OTHER }),
      history({ receipt: envelope({ preparation: commandReceipt({ operation_id: OTHER }) }) }),
      history({ effect_id: OTHER }),
      history({ receipt: envelope({ preparation: commandReceipt({ request_hash: "c".repeat(64) }) }) }),
      history({ receipt: envelope({ preparation: commandReceipt({ effect_ids: [EFFECT, EFFECT] }) }) })]) {
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
    for (const key of ["responsible_user_name"]) delete legacy[key];
    await expect(reply(legacy).client.getCockpitPreparationOperation(WS, MEETING, OP)).resolves.toEqual(operation({
      responsible_user_name: "",
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
    const fixed = effectReceipt({ kind: "cancel_issue", issue_id: ISSUE, issue: task() });
    const value = effectResult({ receipt: fixed }), { client, fetchMock } = reply(value);
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/preparation-operations/${OP}/effects/${EFFECT}/apply`);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(applyBody());
    for (const bad of [effectResult({ effect_id: OTHER }), effectResult({ command_key: OTHER }), effectResult({ operation_id: OTHER }),
      effectResult({ workspace_id: OTHER }), effectResult({ meeting_id: OTHER }), effectResult({ receipt: effectReceipt({ command_key: OTHER }) }), effectResult({ receipt: effectReceipt({ authorization_key: OTHER }) }),
      effectResult({ receipt: effectReceipt({ authorization_revision: 2 }) }),
      effectResult({ receipt: { ...fixed, issue: task({ id: OTHER }) } }),
      effectResult({ current: operation({ id: OTHER }) })]) {
      await expect(reply(bad).client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });

  it("retains the exact other meeting in a link receipt and rejects an unconfirmed destination", async () => {
    const targetMeeting = id(18);
    const fixed = effectReceipt({ kind: "link_meeting", issue_id: ISSUE, target_meeting_id: targetMeeting });
    const current = operation({ kind: "cancel_preparation", revision: 7, state: "completed",
      counts: { total: 1, applied: 1, pending: 0, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false });
    const value = effectResult({ receipt: fixed, current }), { client, fetchMock } = reply(value);
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, OP, EFFECT, applyBody())).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/preparation-operations/${OP}/effects/${EFFECT}/apply`);
    expect(value.receipt.target_meeting_id).not.toBe(value.meeting_id);
    const detail = { workspace_id: WS, meeting_id: MEETING, operation_id: OP,
      effect: effect({ kind: "link_meeting", state: "applied", receipt: fixed, can_apply: false, can_skip: false }), current };
    await expect(reply(detail).client.getCockpitPreparationEffect(WS, MEETING, OP, EFFECT)).resolves.toEqual(detail);
    for (const patch of [{ target_meeting_id: null }, { issue_id: null }]) {
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
    const value = commandResult({ action: "cancel", receipt: commandReceipt({ kind: "cancel_preparation", reason: selection.reason, occurrence: fixed }),
      current: operation({ kind: "cancel_preparation" }) });
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
    const value = commandResult({ action: "cancel", receipt: commandReceipt({ kind: "cancel_preparation", effect_ids: [], reason: selection.reason, occurrence: fixed, directory_effect: effect, state: "completed" }),
      current: operation({ kind: "cancel_preparation", state: "completed", counts: { total: 0, pending: 0, applied: 0, needs_attention: 0, skipped: 0 }, can_continue: false, can_pause: false }) });
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
    expect(unknown?.cancel.state).not.toBe("allowed");
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
    const fixed = commandReceipt({ kind: "cancel_preparation", effect_id: EFFECT, revision: 5, reason: body.reason,
      authorization: next, previous_authorization: authorization() });
    const value = commandResult({ action: "preparation_reauthorize", replayed: true, receipt: fixed,
      current: operation({ kind: "cancel_preparation", revision: 9 }) });
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
    const value = commandResult({ action: "preparation_dispose", receipt: commandReceipt({ kind: "cancel_preparation", reason: body.reason, occurrence: original }),
      current: operation({ kind: "cancel_preparation" }) });
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
    const fixed = effectReceipt({ kind: "stop_run", issue_id: ISSUE, run_id: RUN, run_status: "completed", changed: false });
    const value = effectResult({ receipt: fixed, current: operation({ kind: "cancel_preparation", state: "completed",
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
    const other = reply(operation({ workspace_id: OTHER })); await expect(other.client.getCockpitPreparationOperation(OTHER, MEETING, OP)).resolves.toMatchObject({ workspace_id: OTHER });
    expect(other.fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": OTHER });
    const { client, fetchMock } = reply(commandResult());
    await expect(client.applyCockpitPreparationEffect(WS, MEETING, "", EFFECT, applyBody())).rejects.toThrow();
    await expect(client.getCockpitPreparationEffect(WS, "", OP, EFFECT)).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
