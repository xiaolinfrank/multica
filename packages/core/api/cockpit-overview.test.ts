// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import type { CockpitOverviewData, CockpitOverviewIssueCounts } from "../types/cockpit-overview";

const scope = { workspace_id: "ws-1", project_id: "project-1", project_title: "Delivery", module_id: null, module_title: "", as_of: "2026-10-10", generated_at: "2026-10-10T01:02:03Z" };
const query = { as_of: scope.as_of, project_id: scope.project_id };
const counts = (total = 1): CockpitOverviewIssueCounts => ({ total, active: total, unstarted: total, started: 0, done: 0, closed: 0, unknown: 0, overdue: 0, blocked: 0, unassigned: 0 });

function overview(empty = false): CockpitOverviewData {
  const total = empty ? 0 : 1;
  return {
    ...scope, board: empty ? null : { id: "board-1", title: "Project cockpit", goal_title: "Ship the agreed scope", goal_date: "2026-12-31" },
    actor: { user_id: "user-1", role: "member", is_human: true },
    summary: { primary_issues: counts(total), my_primary_issues: counts(total), execution_nodes: { total, with_active_issues: total },
      attention: { team_total: total, mine_total: total, team_by_kind: { workflow: 0, action: 0, nas: 0, issue: total }, mine_by_kind: { workflow: 0, action: 0, nas: 0, issue: total } } },
    attention: { ...scope, view: "mine", kind: "", total, next_cursor: null, items: empty ? [] : [{
      id: "issue-1", kind: "issue", reason: "active_issue", title: "Verify delivery", flags: [], created_at: "2026-09-01T00:00:00Z", due_date: "2026-10-20",
      responsibility: "assigned_member", assignee_type: "member", assignee_id: "user-1", assignee_name: "Reviewer", can_act: true, next_action: "open_issue",
      target: { kind: "issue", id: "issue-1", issue_id: "issue-1", node_id: "node-1", meeting_id: null, version_id: null, action_id: null, export_id: null },
      meeting_code: "", meeting_title: "", version_number: null, node_code: "L3-1", node_name: "Delivery", issue_identifier: "TES-1", issue_status: "backlog", issue_status_category: "unstarted",
    }] },
    execution_nodes: { ...scope, total, next_cursor: null, items: empty ? [] : [{ id: "node-1", code: "L3-1", name: "Delivery", project_id: "project-1", project_title: "Delivery",
      module_id: "module-1", module_title: "Platform", plan_owner: "Reviewer", plan_status: "planned", plan_start_date: null, plan_end_date: "2026-12-31", issue_counts: counts() }] },
    recent_meetings: { ...scope, range_start: "2026-09-11", range_end: "2026-10-17", total, next_cursor: null, items: empty ? [] : [{
      id: "meeting-1", code: "M-1", title: "Delivery review", meet_date: "2026-10-10", time_range: "10:00–11:00", meeting_status: "planned", ended_at: null,
      workflow_enabled: true, workflow_stage: "waiting_meeting", minutes_issue_id: "minutes-1", current_version_id: null, current_version_number: null, published_version_id: null,
    }] },
  };
}

const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
function clientReply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(response(body));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("cockpit overview API boundary", () => {
  it.each([false, true])("accepts a complete %s-empty read model without inventing work", async (empty) => {
    const body = overview(empty);
    const { client, fetchMock } = clientReply(body);
    await expect(client.getCockpitWorkOverview("ws-1", query)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/cockpit/overview");
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
  });

  it("returns unavailable rather than a fabricated zero for malformed counts and calendar data", async () => {
    const body = overview();
    const malformed: unknown[] = [
      { ...body, summary: {} },
      { ...body, summary: { ...body.summary, primary_issues: { ...counts(), total: -1 } } },
      { ...body, summary: { ...body.summary, my_primary_issues: { ...counts(), active: "1" } } },
      { ...body, summary: { ...body.summary, attention: { ...body.summary.attention, team_total: 1.5 } } },
      { ...body, generated_at: "not-a-timestamp" },
      { ...body, as_of: "2026-02-30" },
      { ...body, recent_meetings: { ...body.recent_meetings, range_start: "2026-02-30" } },
      { ...body, recent_meetings: { ...body.recent_meetings, items: [{ ...body.recent_meetings.items[0], meet_date: "2026-02-30" }] } },
      { ...body, attention: { ...body.attention, total: 0 } },
      { ...body, execution_nodes: { ...body.execution_nodes, next_cursor: 23 } },
    ];
    for (const payload of malformed) {
      const { client } = clientReply(payload);
      await expect(client.getCockpitWorkOverview("ws-1", query)).resolves.toBeNull();
    }
  });

  it.each([
    { workspace_id: "other-workspace" }, { project_id: "other-project" }, { project_id: null }, { as_of: "2026-10-11" },
  ])("rejects a valid but different response scope: %j", async (wrongScope) => {
    const { client } = clientReply({ ...overview(), ...wrongScope });
    await expect(client.getCockpitWorkOverview("ws-1", query)).resolves.toBeNull();
  });

  it("requires every nested preview to belong to the same workspace, project and day", async () => {
    for (const section of ["attention", "execution_nodes", "recent_meetings"] as const) {
      for (const wrongScope of [{ workspace_id: "other" }, { project_id: "other" }, { as_of: "2026-10-11" }]) {
        const body = overview();
        const { client } = clientReply({ ...body, [section]: { ...body[section], ...wrongScope } });
        await expect(client.getCockpitWorkOverview("ws-1", query)).resolves.toBeNull();
      }
    }
  });

  it("caps home previews at 8/6/6 even when the returned total is larger", async () => {
    for (const [section, limit] of [["attention", 8], ["execution_nodes", 6], ["recent_meetings", 6]] as const) {
      const body = overview();
      const items = Array.from({ length: limit + 1 }, (_, index) => ({ ...body[section].items[0], id: `record-${index}` }));
      const { client } = clientReply({ ...body, [section]: { ...body[section], items, total: 120, next_cursor: "next-page" } });
      await expect(client.getCockpitWorkOverview("ws-1", query)).resolves.toBeNull();
    }
  });

  it("sends one scoped continuation request and verifies attention view/kind receipts", async () => {
    const body = overview().attention;
    const signal = new AbortController().signal;
    const { client, fetchMock } = clientReply({ ...body, view: "team", kind: "issue", next_cursor: "page-three", total: 120 });
    await expect(client.getCockpitOverviewAttention("ws-1", { ...query, view: "team", kind: "issue", cursor: "opaque+/cursor", page_size: 25 }, signal))
      .resolves.toMatchObject({ total: 120, next_cursor: "page-three" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[0]![0]).searchParams)).toEqual({ ...query, view: "team", kind: "issue", cursor: "opaque+/cursor", page_size: "25" });
    expect(fetchMock.mock.calls[0]![1].signal).toBe(signal);
    for (const wrong of [{ view: "mine", kind: "issue" }, { view: "team", kind: "nas" }]) {
      const next = clientReply({ ...body, ...wrong }).client;
      await expect(next.getCockpitOverviewAttention("ws-1", { ...query, view: "team", kind: "issue" })).resolves.toBeNull();
    }
  });

  it("enforces requested page sizes for all three subpages", async () => {
    const body = overview();
    const attention = { ...body.attention, items: [body.attention.items[0], { ...body.attention.items[0], id: "issue-2" }], total: 120 };
    await expect(clientReply(attention).client.getCockpitOverviewAttention("ws-1", { ...query, view: "mine", page_size: 1 })).resolves.toBeNull();
    const execution = { ...body.execution_nodes, items: [body.execution_nodes.items[0], { ...body.execution_nodes.items[0], id: "node-2" }], total: 120 };
    await expect(clientReply(execution).client.getCockpitOverviewExecution("ws-1", { ...query, page_size: 1 })).resolves.toBeNull();
    const meetings = { ...body.recent_meetings, items: [body.recent_meetings.items[0], { ...body.recent_meetings.items[0], id: "meeting-2" }], total: 120 };
    await expect(clientReply(meetings).client.getCockpitOverviewMeetings("ws-1", { ...query, page_size: 1 })).resolves.toBeNull();
    await expect(clientReply(body.execution_nodes).client.getCockpitOverviewExecution("ws-1", { ...query, page_size: 1 })).resolves.toEqual(body.execution_nodes);
    await expect(clientReply(body.recent_meetings).client.getCockpitOverviewMeetings("ws-1", { ...query, page_size: 1 })).resolves.toEqual(body.recent_meetings);
  });

  it("does not accept a valid-looking meeting window when the backend ignored the requested days", async () => {
    const body = overview();
    await expect(clientReply(body.recent_meetings).client.getCockpitOverviewMeetings("ws-1", { ...query, days: 14 })).resolves.toBeNull();
    const correct = { ...body.recent_meetings, range_start: "2026-09-27" };
    await expect(clientReply(correct).client.getCockpitOverviewMeetings("ws-1", { ...query, days: 14 })).resolves.toEqual(correct);
    const wrongPreview = { ...body, recent_meetings: { ...body.recent_meetings, range_end: "2026-10-18" } };
    await expect(clientReply(wrongPreview).client.getCockpitWorkOverview("ws-1", query)).resolves.toBeNull();
  });

  it("preserves unknown server enums while refusing malformed capability booleans", async () => {
    const body = overview();
    const item = { ...body.attention.items[0], kind: "future_work", reason: "future_reason", responsibility: "future_role", next_action: "future_action",
      issue_status: "future_status", issue_status_category: "future_category", can_act: "true", flags: ["future_flag"], target: { kind: "future_destination", id: "future-1" } };
    const { client } = clientReply({ ...body, actor: { ...body.actor, is_human: "true" }, attention: { ...body.attention, items: [item] } });
    const parsed = await client.getCockpitWorkOverview("ws-1", query);
    expect(parsed?.actor.is_human).toBe(false);
    expect(parsed?.attention.items[0]).toMatchObject({ kind: "future_work", responsibility: "future_role", next_action: "future_action", can_act: false,
      issue_status_category: "future_category", flags: ["future_flag"], target: { kind: "future_destination", id: "future-1", issue_id: null } });
  });
});
