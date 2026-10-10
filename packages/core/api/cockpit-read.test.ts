// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const scope = { projectId: "project-1", moduleId: "module-1" };
const header = { workspace_id: "ws-1", scope: { project_id: "project-1", module_id: "module-1", project_title: "Project", module_title: "Module" },
  cockpit: null, actor: { user_id: "user-1", role: "member", is_human: true }, has_meeting_workflows: false, has_stable_bindings: false };
function reply(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("cockpit scoped read contracts", () => {
  it("does not enable unavailable services from missing or malformed capability flags", async () => {
    for (const capabilities of [{}, { artifacts: "true", acceptance: 1 }, { artifacts: false, acceptance: false }]) {
      await expect(reply({ ...header, capabilities }).client.getCockpitContext("ws-1", scope)).resolves.toMatchObject({ capabilities: { artifacts: false, acceptance: false } });
    }
    await expect(reply({ ...header, capabilities: { artifacts: true, acceptance: false } }).client.getCockpitContext("ws-1", scope)).resolves.toMatchObject({ capabilities: { artifacts: true, acceptance: false } });
  });
  it("carries explicit workspace and rejects a different scope instead of showing an empty plan", async () => {
    const { client, fetchMock } = reply(header);
    await expect(client.getCockpitContext("ws-1", scope)).resolves.toEqual(header);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Workspace-ID": "ws-1" });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("client_contract")).toBe("artifacts-v1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("project_id=project-1&module_id=module-1");
    await expect(reply({ ...header, scope: { ...header.scope, module_id: "other" } }).client.getCockpitContext("ws-1", scope)).resolves.toBeNull();
    await expect(reply({ ...header, workspace_id: "other" }).client.getCockpitContext("ws-1", scope)).resolves.toBeNull();
  });
  it("requires complete plan counts and never fills absent arrays with apparent zeros", async () => {
    const plan = { ...header, complete: true, nodes: [], payments: [], milestones: [], node_index: [], context_node_ids: [], task_counts: [], counts: { nodes: 0, payments: 0, milestones: 0, index_nodes: 0 } };
    await expect(reply(plan).client.getCockpitPlan("ws-1", scope)).resolves.toEqual(plan);
    for (const invalid of [{ ...plan, complete: false }, { ...plan, counts: { ...plan.counts, nodes: 1 } }, { ...plan, payments: undefined }]) {
      await expect(reply(invalid).client.getCockpitPlan("ws-1", scope)).resolves.toBeNull();
    }
  });
  it("preserves repeated filter values and an empty unfiled track, and checks calendar identity", async () => {
    const page = { workspace_id: "ws-1", scope: header.scope, node_id: "node-1", node_ids: [], items: [], total: 0, next_cursor: null, day_counts: [], date_from: "2026-10-01", date_to: "2026-10-31" };
    const query = { node_id: "node-1", tracks: ["", "Clinical"], parties: ["集团（研发、临床）"], date_from: page.date_from, date_to: page.date_to };
    const { client, fetchMock } = reply(page);
    await expect(client.getCockpitMeetingRegister("ws-1", scope, query)).resolves.toEqual(page);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.getAll("tracks")).toEqual(["", "Clinical"]);
    expect(url.searchParams.getAll("parties")).toEqual(["集团（研发、临床）"]);
    for (const invalid of [{ ...page, node_id: "other" }, { ...page, date_to: "2026-09-30" }, { ...page, day_counts: undefined }]) {
      await expect(reply(invalid).client.getCockpitMeetingRegister("ws-1", scope, query)).resolves.toBeNull();
    }
  });
  it("validates object identity and bounded pages on relation continuation", async () => {
    const page = { workspace_id: "ws-1", object_id: "node-1", kind: "payments", items: [], total: 32, payment_total: 528, next_cursor: "more" };
    await expect(reply(page).client.getCockpitNodePayments("ws-1", "node-1")).resolves.toEqual(page);
    await expect(reply({ ...page, object_id: "other" }).client.getCockpitNodePayments("ws-1", "node-1")).resolves.toBeNull();
    await expect(reply({ ...page, items: Array.from({ length: 26 }, (_, i) => ({ id: `payment-${i}` })) }).client.getCockpitNodePayments("ws-1", "node-1")).resolves.toBeNull();
  });
  it("treats an unavailable or mismatched next code as unavailable", async () => {
    const preview = { workspace_id: "ws-1", date: "2026-10-10", code: "20261010-03" };
    await expect(reply(preview).client.getCockpitMeetingNextCode("ws-1", "2026-10-10")).resolves.toEqual(preview);
    await expect(reply({ ...preview, date: "2026-10-11" }).client.getCockpitMeetingNextCode("ws-1", "2026-10-10")).resolves.toBeNull();
    await expect(reply({}).client.getCockpitMeetingNextCode("ws-1", "2026-10-10")).resolves.toBeNull();
  });
  it("reads root code previews without assuming a board already exists", async () => {
    const preview = { workspace_id: "ws-1", parent_id: null, code: "L1-01" };
    await expect(reply(preview).client.getCockpitNodeCodePreview("ws-1", null)).resolves.toEqual(preview);
    await expect(reply(preview).client.getCockpitNodeCodePreview("ws-1", "parent-1")).resolves.toBeNull();
    await expect(reply({ code: "L1-01" }).client.getCockpitNodeCodePreview("ws-1", null)).resolves.toBeNull();
  });
  it("requires all export mappings and excludes context ancestor mappings", async () => {
    const exported = { ...header, complete: true, nodes: [], payments: [], milestones: [], node_index: [], context_node_ids: [], task_counts: [], counts: { nodes: 0, payments: 0, milestones: 0, index_nodes: 0 },
      issue_links: [], issue_link_total: 0, generated_at: "2026-10-10T00:00:00Z" };
    await expect(reply(exported).client.getCockpitPlanExport("ws-1", scope)).resolves.toEqual(exported);
    await expect(reply({ ...exported, issue_link_total: 1 }).client.getCockpitPlanExport("ws-1", scope)).resolves.toBeNull();
    await expect(reply({ ...exported, issue_link_total: 1, issue_links: [{ node_id: "outside", issue_identifier: "TES-1" }] }).client.getCockpitPlanExport("ws-1", scope)).resolves.toBeNull();
  });
  it("sends grouped marker filters as a bounded read body and verifies the returned union", async () => {
    const rows = [{ row_key: "merged-directions", node_ids: ["node-a", "node-b"] }];
    const query = { rows, date_from: "2026-10-01", date_to: "2026-10-31" };
    const page = { workspace_id: "ws-1", scope: header.scope, ...query,
      groups: [{ row_key: rows[0]!.row_key, date: "2026-10-10", total: 20, items: [{ id: "meeting-1", code: "M1", title: "Review", start_time: null }] }], total_groups: 1, next_cursor: null };
    const { client, fetchMock } = reply(page);
    await expect(client.getCockpitPlanMeetingMarkers("ws-1", scope, query)).resolves.toEqual(page);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual(query);
    await expect(reply({ ...page, rows: [{ row_key: "merged-directions", node_ids: ["node-a"] }] }).client.getCockpitPlanMeetingMarkers("ws-1", scope, query)).resolves.toBeNull();
    await expect(reply({ ...page, groups: [{ ...page.groups[0], row_key: "unknown" }] }).client.getCockpitPlanMeetingMarkers("ws-1", scope, query)).resolves.toBeNull();
  });
});
