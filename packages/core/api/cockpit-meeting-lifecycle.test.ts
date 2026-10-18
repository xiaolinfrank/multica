// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import type { CockpitLifecycleAction, CockpitLifecycleCommandResult,
  CockpitLifecycleReceipt, CockpitMeetingLifecycleHeader, CockpitOccurrenceView } from "../types/cockpit-meeting-lifecycle";

const WS = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002";
const MEETING = "20000000-0000-4000-8000-000000000001";

const USER = "60000000-0000-4000-8000-000000000001";
const KEY = "80000000-0000-4000-8000-000000000001";
const TIME = "2026-10-11T01:02:03Z", HASH = "a".repeat(64), command = { command_key: KEY, expected_revision: 1 };
const endpoint = `https://example.test/api/cockpit/meetings/${MEETING}`;
function occurrence(patch: Partial<CockpitOccurrenceView> = {}): CockpitOccurrenceView {
  return { state: "unconfirmed", started_confirmed_at: null, started_confirmed_by: null, ended_at: null, ended_by: null,
    ended_source: null, actual_started_at: null, actual_ended_at: null, ...patch };
}
function header(patch: Partial<CockpitMeetingLifecycleHeader> = {}): CockpitMeetingLifecycleHeader {
  return { workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 5, generated_at: TIME, occurrence: occurrence(),
    materials: null, workflow_enabled: false, can_schedule: true, can_end: true,
    can_correct_times: false, can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [], ...patch };
}
function receipt(patch: Partial<CockpitLifecycleReceipt> = {}): CockpitLifecycleReceipt {
  return { revision: 2, issue_id: null, request_hash: HASH,
    reason: "", previous_occurrence: null, occurrence: null, materials: null, ...patch };
}
function result(action: CockpitLifecycleAction, fixed: Partial<CockpitLifecycleReceipt>, patch: Partial<CockpitLifecycleCommandResult> = {}): CockpitLifecycleCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action, replayed: false, receipt: receipt(fixed), current: header(), ...patch };
}
function historyMetadata() { return { command_key: KEY, action: "materials", actor_id: USER, actor_type: "member", actor_name: "Reviewer", created_at: TIME,
  revision: 2, issue_id: null }; }
function reply(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("meeting lifecycle API boundaries", () => {
  it("reads the exact meeting without initializing a workflow and sends the initiating workspace", async () => {
    const { client, fetchMock } = reply(header());
    await expect(client.getCockpitMeetingLifecycle(WS, MEETING)).resolves.toEqual(header());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle`);
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": WS });
    for (const bad of [header({ workspace_id: OTHER }), header({ meeting_id: OTHER }), { ...header(), occurrence: undefined }, header({ workflow_enabled: true })]) {
      await expect(reply(bad).client.getCockpitMeetingLifecycle(WS, MEETING)).resolves.toBeNull();
    }
    const second = reply(header({ workspace_id: OTHER }));
    await expect(second.client.getCockpitMeetingLifecycle(OTHER, MEETING)).resolves.toMatchObject({ workspace_id: OTHER });
    expect(second.fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": OTHER });
  });
  it("preserves unknown occurrence facts without enabling state transitions and rejects inconsistent known times", async () => {
    await expect(reply(header({ occurrence: occurrence({ state: "future_state" }), can_correct_times: true })).client.getCockpitMeetingLifecycle(WS, MEETING))
      .resolves.toMatchObject({ occurrence: { state: "future_state" }, can_schedule: false, can_end: false, can_correct_times: false });
    await expect(reply({ ...header(), can_end: undefined }).client.getCockpitMeetingLifecycle(WS, MEETING))
      .resolves.toMatchObject({ can_end: false });
    for (const bad of [occurrence({ state: "ended" }), occurrence({ actual_ended_at: TIME }), occurrence({ state: "ended", ended_at: TIME,
      actual_started_at: "2026-10-11T02:00:00Z", actual_ended_at: "2026-10-11T01:00:00Z" })]) {
      await expect(reply(header({ occurrence: bad })).client.getCockpitMeetingLifecycle(WS, MEETING)).resolves.toBeNull();
    }
  });
  it("reads one bounded command metadata page without prefetching history bodies", async () => {
    const value = { workspace_id: WS, meeting_id: MEETING, page_size: 25, items: [{ ...historyMetadata(), action: "future_history" }], total: 500, next_cursor: "history-next" };
    const { client, fetchMock } = reply(value); await expect(client.getCockpitLifecycleCommands(WS, MEETING, { cursor: "history-page" })).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/commands?cursor=history-page&page_size=25`); expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [{ ...value, workspace_id: OTHER }, { ...value, meeting_id: OTHER }, { ...value, page_size: 100 }, { ...value, next_cursor: undefined }, { ...value, items: [historyMetadata(), historyMetadata()] }]) {
      await expect(reply(bad).client.getCockpitLifecycleCommands(WS, MEETING)).resolves.toBeNull();
    }
  });
  it("requires single-command history and its nested object to identify the exact retained result", async () => {
    const value = { ...historyMetadata(), workspace_id: WS, meeting_id: MEETING, receipt: receipt({ occurrence: occurrence({ state: "scheduled" }) }) };
    const { client, fetchMock } = reply(value); await expect(client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/commands/${KEY}`); expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [{ ...value, command_key: OTHER }, { ...value, workspace_id: OTHER }, { ...value, meeting_id: OTHER },
      { ...value, receipt: receipt({ occurrence: occurrence(), revision: 3 }) }]) {
      await expect(reply(bad).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toBeNull();
    }
  });
  it("acknowledges an old occurrence receipt independently of the newer current header", async () => {
    const value = result("schedule", { occurrence: occurrence({ state: "scheduled" }) }, { replayed: true, current: header({ lifecycle_revision: 40,
      occurrence: occurrence({ state: "ended", ended_at: TIME, ended_source: "human_confirmation" }) }) });
    const { client, fetchMock } = reply(value), body = { ...command, transition: "schedule" as const };
    await expect(client.recordCockpitOccurrence(WS, MEETING, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/occurrence`); expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "X-Workspace-ID": WS } });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    for (const bad of [{ ...value, command_key: OTHER }, { ...value, action: "end" }, { ...value, action: "future_action" }, { ...value, workspace_id: OTHER },
      { ...value, meeting_id: OTHER }, { ...value, current: header({ meeting_id: OTHER }) }, { ...value, receipt: receipt({ occurrence: occurrence() }) }]) {
      await expect(reply(bad).client.recordCockpitOccurrence(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("distinguishes omitted times from explicit null and compares supplied instants without inventing dates", async () => {
    const ended = occurrence({ state: "ended", ended_at: TIME, actual_started_at: "2026-10-11T01:00:00Z" });
    const value = result("end", { occurrence: ended }), body = { ...command, transition: "end" as const };
    const first = reply(value); await expect(first.client.recordCockpitOccurrence(WS, MEETING, body)).resolves.toEqual(value);
    expect(JSON.parse(first.fetchMock.mock.calls[0]?.[1].body)).not.toHaveProperty("actual_started_at");
    await expect(reply(value).client.recordCockpitOccurrence(WS, MEETING, { ...body, actual_started_at: null })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    const empty = result("end", { occurrence: { ...ended, actual_started_at: null } }), second = reply(empty);
    await expect(second.client.recordCockpitOccurrence(WS, MEETING, { ...body, actual_started_at: null, actual_ended_at: null })).resolves.toEqual(empty);
    expect(JSON.parse(second.fetchMock.mock.calls[0]?.[1].body)).toMatchObject({ actual_started_at: null, actual_ended_at: null });
    await expect(reply(value).client.recordCockpitOccurrence(WS, MEETING, { ...body, actual_started_at: "2026-10-11T09:00:00+08:00" })).resolves.toEqual(value);
  });
  it("acknowledges the reverse transitions by their target state and a matching reason", async () => {
    const scheduled = occurrence({ state: "scheduled" });
    const unschedule = result("unschedule", { previous_occurrence: scheduled, occurrence: occurrence(), reason: "Rework the plan" });
    await expect(reply(unschedule).client.recordCockpitOccurrence(WS, MEETING, { ...command, transition: "unschedule", reason: "Rework the plan" })).resolves.toEqual(unschedule);
    await expect(reply({ ...unschedule, receipt: { ...unschedule.receipt, occurrence: scheduled } }).client.recordCockpitOccurrence(WS, MEETING,
      { ...command, transition: "unschedule", reason: "Rework the plan" })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply({ ...unschedule, receipt: { ...unschedule.receipt, reason: "Other reason" } }).client.recordCockpitOccurrence(WS, MEETING,
      { ...command, transition: "unschedule", reason: "Rework the plan" })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("requires correction reasons and the preserved before-fact rather than substituting current metadata", async () => {
    const ended = occurrence({ state: "ended", ended_at: TIME, actual_ended_at: "2026-10-11T01:00:00Z" });
    const value = result("correct_times", { previous_occurrence: ended, occurrence: { ...ended, actual_ended_at: null }, reason: "Time was not recorded" });
    const body = { ...command, transition: "correct_times" as const, actual_ended_at: null, reason: "  Time was not recorded  " };
    await expect(reply(value).client.recordCockpitOccurrence(WS, MEETING, body)).resolves.toEqual(value);
    for (const bad of [{ ...value, receipt: { ...value.receipt, previous_occurrence: null } }, { ...value, receipt: { ...value.receipt, reason: "Other reason" } }]) {
      await expect(reply(bad).client.recordCockpitOccurrence(WS, MEETING, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("confirms the requested materials fact even if later current readiness differs", async () => {
    const fixed = { workflow_revision: 2, ready: true, confirmed_at: TIME, confirmed_by: USER, released: false };
    const value = result("materials", { materials: fixed }, { replayed: true, current: header({ workflow_enabled: true, materials: { ...fixed, workflow_revision: 9, ready: false } }) });
    await expect(reply(value).client.confirmCockpitMaterials(WS, MEETING, { ...command, materials_ready: true })).resolves.toEqual(value);
    await expect(reply(value).client.confirmCockpitMaterials(WS, MEETING, { ...command, materials_ready: false })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("rejects missing and internally cross-scoped command evidence rather than manufacturing success", async () => {
    const value = result("materials", { materials: { workflow_revision: 1, ready: true, confirmed_at: null, confirmed_by: null, released: false } });
    for (const bad of [{ ...value, receipt: undefined }, { ...value, current: undefined }, { ...value, replayed: undefined },
      { ...value, receipt: { ...value.receipt, request_hash: "" } }]) {
      await expect(reply(bad).client.confirmCockpitMaterials(WS, MEETING, { ...command, materials_ready: true })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("refuses empty route identities before any network request", async () => {
    const { client, fetchMock } = reply({});
    for (const work of [() => client.getCockpitMeetingLifecycle("", MEETING),
      () => client.getCockpitLifecycleCommand(WS, MEETING, ""),
      () => client.confirmCockpitMaterials("", MEETING, { ...command, materials_ready: true })]) {
      await expect(work()).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
