// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
import type { CockpitAgendaDetail, CockpitAgendaReferenceView, CockpitLifecycleAction, CockpitLifecycleCommandResult,
  CockpitLifecycleReceipt, CockpitMeetingLifecycleHeader, CockpitOccurrenceView, CockpitPreparationIssueInput } from "../types/cockpit-meeting-lifecycle";
import type { CockpitTask } from "../types/cockpit";

const WS = "10000000-0000-4000-8000-000000000001", OTHER = "10000000-0000-4000-8000-000000000002";
const MEETING = "20000000-0000-4000-8000-000000000001", AGENDA = "30000000-0000-4000-8000-000000000001";
const REF = "40000000-0000-4000-8000-000000000001", ISSUE = "50000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001", NODE = "70000000-0000-4000-8000-000000000001";
const KEY = "80000000-0000-4000-8000-000000000001", PROJECT = "90000000-0000-4000-8000-000000000001", MODULE = "90000000-0000-4000-8000-000000000002";
const TIME = "2026-10-11T01:02:03Z", HASH = "a".repeat(64), command = { command_key: KEY, expected_revision: 1 };
const endpoint = `https://example.test/api/cockpit/meetings/${MEETING}`;
function occurrence(patch: Partial<CockpitOccurrenceView> = {}): CockpitOccurrenceView {
  return { state: "unconfirmed", started_confirmed_at: null, started_confirmed_by: null, ended_at: null, ended_by: null,
    ended_source: null, actual_started_at: null, actual_ended_at: null, ...patch };
}
function header(patch: Partial<CockpitMeetingLifecycleHeader> = {}): CockpitMeetingLifecycleHeader {
  return { workspace_id: WS, meeting_id: MEETING, lifecycle_revision: 5, agenda_revision: 9, generated_at: TIME, occurrence: occurrence(),
    materials: null, workflow_enabled: false, agenda_total: 1, can_schedule: true, can_end: true,
    can_correct_times: false, can_edit_agenda: true, can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [], ...patch };
}
function agenda(patch: Partial<CockpitAgendaDetail> = {}): CockpitAgendaDetail {
  return { id: AGENDA, workspace_id: WS, meeting_id: MEETING, revision: 2, title: "Check the boundary", purposes: ["boundary_confirmation"],
    sort_order: 3, facilitator_user_id: USER, facilitator_name: "Reviewer", node_id: NODE, node_code: "01.01.01", node_title: "Delivery",
    reference_count: 1, created_at: TIME, updated_at: TIME, removed_at: null, can_edit: true, can_remove: true,
    desired_outcome: "Agree the tested limit", notes: "  Original notes\n\n", ...patch };
}
function metadata() { return { ...agenda(), notes: undefined, desired_outcome: undefined }; }
function task(patch: Partial<CockpitTask> = {}): CockpitTask {
  return { id: ISSUE, identifier: "DEL-1", title: "Collect evidence", status: "backlog", status_category: "unstarted", priority: "high",
    assignee_type: "member", assignee_id: USER, assignee_name: "Reviewer", due_date: null, project_id: PROJECT, module_id: MODULE,
    primary_node_id: NODE, primary_node_code: "01.01.01", primary_node_name: "Delivery", primary_revision: 1, creation_key: null, ...patch };
}
function reference(patch: Partial<CockpitAgendaReferenceView> = {}): CockpitAgendaReferenceView {
  return { id: REF, workspace_id: WS, meeting_id: MEETING, agenda_id: AGENDA, kind: "issue", target_id: ISSUE, purpose: "preparation",
    available: true, label: "DEL-1 Collect evidence", issue: task(), artifact_id: null, version_id: null, version_number: null,
    content_hash: null, version_decision: null, created_at: TIME, removed_at: null, can_remove: true, ...patch };
}
function receipt(patch: Partial<CockpitLifecycleReceipt> = {}): CockpitLifecycleReceipt {
  return { revision: 2, agenda_revision: 9, agenda_id: null, reference_id: null, issue_id: null, request_hash: HASH,
    reason: "", previous_occurrence: null, occurrence: null, materials: null, agenda: null, reference: null, ...patch };
}
function result(action: CockpitLifecycleAction, fixed: Partial<CockpitLifecycleReceipt>, patch: Partial<CockpitLifecycleCommandResult> = {}): CockpitLifecycleCommandResult {
  return { workspace_id: WS, meeting_id: MEETING, command_key: KEY, action, replayed: false, receipt: receipt(fixed), current: header(), ...patch };
}
function page() { return { workspace_id: WS, meeting_id: MEETING, agenda_revision: 9, q: "risk", include_removed: false,
  page_size: 25, items: [metadata()], total: 1000, next_cursor: "page-two" }; }
function referencePage() { return { workspace_id: WS, meeting_id: MEETING, agenda_id: AGENDA, agenda_revision: 9,
  include_removed: false, page_size: 25, items: [reference()], total: 27, next_cursor: "next-references" }; }
function historyMetadata() { return { command_key: KEY, action: "agenda_update", actor_id: USER, actor_type: "member", actor_name: "Reviewer", created_at: TIME,
  revision: 2, agenda_id: AGENDA, reference_id: null, issue_id: null }; }
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
  it("requests one metadata page and validates the query, size and removed-item echoes", async () => {
    const { client, fetchMock } = reply({ ...page(), include_removed: true });
    const read = await client.getCockpitMeetingAgenda(WS, MEETING, { q: "  risk  ", include_removed: true, cursor: "opaque/+?", page_size: 25 });
    expect(read).toMatchObject({ total: 1000, next_cursor: "page-two", items: [{ id: AGENDA }] }); expect(read?.items[0]).not.toHaveProperty("notes");
    expect(fetchMock).toHaveBeenCalledTimes(1); const url = new URL(fetchMock.mock.calls[0]?.[0]);
    expect(url.pathname).toBe(`/api/cockpit/meetings/${MEETING}/agenda`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "risk", include_removed: "true", cursor: "opaque/+?", page_size: "25" });
    for (const bad of [{ ...page(), q: "other" }, { ...page(), include_removed: true }, { ...page(), page_size: 100 }, { ...page(), total: undefined },
      { ...page(), items: [metadata(), metadata()] }, { ...page(), items: [{ ...metadata(), workspace_id: OTHER }] },
      { ...page(), items: [{ ...metadata(), meeting_id: OTHER }] }, { ...page(), items: [{ ...metadata(), removed_at: TIME }] },
      { ...page(), items: Array.from({ length: 26 }, (_, i) => ({ ...metadata(), id: `agenda-${i}` })) }]) {
      await expect(reply(bad).client.getCockpitMeetingAgenda(WS, MEETING, { q: "risk" })).resolves.toBeNull();
    }
  });
  it("loads only the selected agenda body and retains its exact whitespace", async () => {
    const { client, fetchMock } = reply(agenda()); await expect(client.getCockpitAgendaDetail(WS, MEETING, AGENDA)).resolves.toMatchObject({ notes: "  Original notes\n\n" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}`); expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const bad of [agenda({ id: OTHER }), agenda({ workspace_id: OTHER }), agenda({ meeting_id: OTHER }), { ...agenda(), notes: undefined }]) {
      await expect(reply(bad).client.getCockpitAgendaDetail(WS, MEETING, AGENDA)).resolves.toBeNull();
    }
  });
  it("binds references to the exact agenda and requires fixed identity for available material", async () => {
    const { client, fetchMock } = reply(referencePage()); await expect(client.getCockpitAgendaReferences(WS, MEETING, AGENDA, { cursor: "refs-next" })).resolves.toMatchObject({ total: 27 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}/references?cursor=refs-next&include_removed=false&page_size=25`);
    for (const bad of [{ ...referencePage(), agenda_id: OTHER }, { ...referencePage(), include_removed: true },
      { ...referencePage(), items: [reference({ agenda_id: OTHER })] }, { ...referencePage(), items: [reference({ issue: task({ id: OTHER }) })] },
      { ...referencePage(), items: [reference({ kind: "artifact_reference", issue: null })] }]) {
      await expect(reply(bad).client.getCockpitAgendaReferences(WS, MEETING, AGENDA)).resolves.toBeNull();
    }
    const fixed = reference({ kind: "artifact_reference", target_id: OTHER, issue: null, purpose: "material", artifact_id: ISSUE,
      version_id: NODE, version_number: 1, content_hash: HASH, version_decision: "pending" });
    await expect(reply({ ...referencePage(), items: [fixed] }).client.getCockpitAgendaReferences(WS, MEETING, AGENDA))
      .resolves.toMatchObject({ items: [{ target_id: OTHER, version_id: NODE, version_decision: "pending" }] });
    await expect(reply({ ...referencePage(), items: [{ ...fixed, version_decision: "approved" }] }).client.getCockpitAgendaReferences(WS, MEETING, AGENDA))
      .resolves.toMatchObject({ items: [{ version_id: NODE, version_number: 1, version_decision: "approved" }] });
    await expect(reply({ ...referencePage(), items: [{ ...fixed, version_decision: 1 }] }).client.getCockpitAgendaReferences(WS, MEETING, AGENDA)).resolves.toBeNull();
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
    const value = { ...historyMetadata(), workspace_id: WS, meeting_id: MEETING, receipt: receipt({ agenda_id: AGENDA, agenda: agenda() }) };
    const { client, fetchMock } = reply(value); await expect(client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/lifecycle/commands/${KEY}`); expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(reply({ ...value, actor_type: undefined }).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(value);
    for (const bad of [{ ...value, command_key: OTHER }, { ...value, workspace_id: OTHER }, { ...value, meeting_id: OTHER },
      { ...value, receipt: receipt({ agenda_id: AGENDA, agenda: agenda({ id: OTHER }) }) }, { ...value, receipt: receipt({ agenda_id: AGENDA, agenda: agenda(), revision: 3 }) }]) {
      await expect(reply(bad).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toBeNull();
    }
    const linked = { ...value, action: "reference_attach", reference_id: REF,
      receipt: receipt({ agenda_id: AGENDA, reference_id: REF, reference: reference() }) };
    await expect(reply(linked).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toEqual(linked);
    for (const fixed of [reference({ id: OTHER }), reference({ agenda_id: OTHER }), reference({ meeting_id: OTHER })]) {
      await expect(reply({ ...linked, receipt: { ...linked.receipt, reference: fixed } }).client.getCockpitLifecycleCommand(WS, MEETING, KEY)).resolves.toBeNull();
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
  it("preserves notes and explicit empty edits while matching the exact saved agenda", async () => {
    const body = { ...command, title: "  Check the boundary  ", notes: "  New notes\n\n", purposes: ["planning" as const, "planning" as const] };
    const saved = agenda({ notes: body.notes, purposes: ["planning"] }), value = result("agenda_update", { agenda_id: AGENDA, agenda: saved });
    const { client, fetchMock } = reply(value); await expect(client.updateCockpitAgenda(WS, MEETING, AGENDA, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}`); expect(fetchMock.mock.calls[0]?.[1].method).toBe("PATCH"); expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    await expect(reply({ ...value, receipt: { ...value.receipt, agenda: { ...saved, notes: body.notes.trim() } } }).client.updateCockpitAgenda(WS, MEETING, AGENDA, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply(value).client.updateCockpitAgenda(WS, MEETING, OTHER, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    const cleared = result("agenda_update", { agenda_id: AGENDA, agenda: agenda({ notes: "", desired_outcome: "", node_id: null, facilitator_user_id: null }) });
    await expect(reply(cleared).client.updateCockpitAgenda(WS, MEETING, AGENDA, { ...command, notes: "", desired_outcome: "", node_id: null, facilitator_user_id: null })).resolves.toEqual(cleared);
    const created = result("agenda_create", { agenda_id: AGENDA, agenda: saved }), creation = reply(created);
    await expect(creation.client.createCockpitAgenda(WS, MEETING, body)).resolves.toEqual(created); expect(creation.fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda`);
    const removed = result("agenda_remove", { agenda_id: AGENDA, agenda: agenda({ removed_at: TIME }), reason: "Combined elsewhere" });
    await expect(reply(removed).client.removeCockpitAgenda(WS, MEETING, AGENDA, { ...command, reason: " Combined elsewhere " })).resolves.toEqual(removed);
  });
  it("matches the reference target and exact removal identity instead of acknowledging another relation", async () => {
    const body = { ...command, kind: "issue" as const, target_id: ISSUE, purpose: "preparation" as const };
    const value = result("reference_attach", { agenda_id: AGENDA, reference_id: REF, reference: reference() }), attached = reply(value);
    await expect(attached.client.attachCockpitAgendaReference(WS, MEETING, AGENDA, body)).resolves.toEqual(value); expect(attached.fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}/references`);
    for (const patch of [{ target_id: OTHER }, { purpose: "material" as const }]) {
      await expect(reply(value).client.attachCockpitAgendaReference(WS, MEETING, AGENDA, { ...body, ...patch })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    const removed = result("reference_remove", { agenda_id: AGENDA, reference_id: REF, reference: reference({ removed_at: TIME }) }), removal = reply(removed);
    await expect(removal.client.removeCockpitAgendaReference(WS, MEETING, AGENDA, REF, command)).resolves.toEqual(removed);
    expect(removal.fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}/references/${REF}/remove`);
    await expect(reply(removed).client.removeCockpitAgendaReference(WS, MEETING, AGENDA, OTHER, command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    await expect(reply({ ...removed, receipt: { ...removed.receipt, reference: reference() } }).client.removeCockpitAgendaReference(WS, MEETING, AGENDA, REF, command)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("requires preparation tasks to remain fixed backlog with the selected responsibility and primary owner", async () => {
    const body: CockpitPreparationIssueInput = { ...command, primary_node_id: NODE, new_issue: { title: " Collect evidence ", description: "  Preserve brief\n", assignee_type: "member", assignee_id: USER, priority: "high", due_date: null, project_id: null, module_id: null } };
    const value = result("preparation_issue_create", { agenda_id: AGENDA, reference_id: REF, issue_id: ISSUE, reference: reference() });
    const { client, fetchMock } = reply(value); await expect(client.createCockpitPreparationIssue(WS, MEETING, AGENDA, body)).resolves.toEqual(value);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/agenda/${AGENDA}/preparation-issues`); expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "X-Workspace-ID": WS }); expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toEqual(body);
    for (const patch of [{ status: "todo" }, { id: OTHER }, { primary_node_id: OTHER }, { assignee_id: OTHER }, { title: "Other intent" }, { priority: "low" }]) {
      await expect(reply({ ...value, receipt: { ...value.receipt, reference: reference({ issue: task(patch) }) } }).client.createCockpitPreparationIssue(WS, MEETING, AGENDA, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
    const unassigned: CockpitPreparationIssueInput = { ...body, primary_node_id: null, new_issue: { ...body.new_issue, assignee_type: null, assignee_id: null, project_id: PROJECT, module_id: MODULE } };
    const direct = result("preparation_issue_create", { agenda_id: AGENDA, reference_id: REF, issue_id: ISSUE, reference: reference({ issue: task({ primary_node_id: null, assignee_type: null, assignee_id: null }) }) });
    await expect(reply(direct).client.createCockpitPreparationIssue(WS, MEETING, AGENDA, unassigned)).resolves.toEqual(direct);
    await expect(reply(direct).client.createCockpitPreparationIssue(WS, MEETING, AGENDA, { ...unassigned, new_issue: { ...unassigned.new_issue, module_id: OTHER } })).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
  });
  it("rejects missing and internally cross-scoped command evidence rather than manufacturing success", async () => {
    const value = result("agenda_update", { agenda_id: AGENDA, agenda: agenda() }), body = { ...command, notes: agenda().notes };
    for (const bad of [{ ...value, receipt: undefined }, { ...value, current: undefined }, { ...value, replayed: undefined },
      { ...value, receipt: { ...value.receipt, request_hash: "" } }, { ...value, receipt: { ...value.receipt, agenda: agenda({ workspace_id: OTHER }) } },
      { ...value, receipt: { ...value.receipt, agenda: agenda({ id: OTHER }) } }]) {
      await expect(reply(bad).client.updateCockpitAgenda(WS, MEETING, AGENDA, body)).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("refuses empty route identities before any network request", async () => {
    const { client, fetchMock } = reply({});
    for (const work of [() => client.getCockpitMeetingLifecycle("", MEETING), () => client.getCockpitMeetingAgenda(WS, ""),
      () => client.getCockpitAgendaDetail(WS, MEETING, ""), () => client.getCockpitLifecycleCommand(WS, MEETING, ""),
      () => client.removeCockpitAgendaReference(WS, MEETING, AGENDA, "", command), () => client.confirmCockpitMaterials("", MEETING, { ...command, materials_ready: true })]) {
      await expect(work()).rejects.toBeInstanceOf(RangeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
