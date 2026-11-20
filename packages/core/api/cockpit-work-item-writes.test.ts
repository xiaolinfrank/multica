// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitNodeSchema, IssueSchema } from "./schemas";

function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

const key = "8f9c7b6a-0000-4000-8000-000000000001";
const node = { id: "w1", cockpit_id: "c1", parent_id: "m1", code: "01.01.02", name: "注册路径设计", position: 1,
  directory_name: "01.01.02注册路径设计", kind: "work_item", project_id: null, module_id: null };

describe("work-item write contracts (S4)", () => {
  it("creates by module with a creation key and tells a replay apart", async () => {
    const { client, fetchMock } = reply({ ...node, workspace_id: "ws-1", creation_key: key, replayed: false });
    await expect(client.createCockpitWorkItem({ module_id: "m1", name: "注册路径设计", creation_key: key }, "ws-1"))
      .resolves.toMatchObject({ id: "w1", code: "01.01.02", replayed: false });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Workspace-ID": "ws-1" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ module_id: "m1", creation_key: key });
  });

  it("refuses to confirm a keyed create that does not echo the key", async () => {
    const { client } = reply({ ...node, workspace_id: "ws-1", creation_key: "11111111-2222-4333-8444-555555555555", replayed: true });
    await expect(client.createCockpitWorkItem({ module_id: "m1", name: "注册路径设计", creation_key: key }, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
  });

  it("keeps what a move carried: refiled issues and mapped statuses", async () => {
    const { client } = reply({ ...node, parent_id: "m2", code: "02.01.01", refiled_issues: 3, status_mapped: 1 });
    await expect(client.moveCockpitWorkItem("w1", { parent_id: "m2" }))
      .resolves.toMatchObject({ code: "02.01.01", refiled_issues: 3, status_mapped: 1 });
  });

  it("refuses a malformed create: no id, a different name, or a foreign workspace", async () => {
    const keyed = { ...node, workspace_id: "ws-1", creation_key: key, replayed: false };
    await expect(reply({ ...keyed, id: "" }).client.createCockpitWorkItem({ module_id: "m1", name: "注册路径设计" }, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
    await expect(reply({ ...keyed, name: "别的名称" }).client.createCockpitWorkItem({ module_id: "m1", name: "注册路径设计" }, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
    await expect(reply({ ...keyed, workspace_id: "ws-2" }).client.createCockpitWorkItem({ module_id: "m1", name: "注册路径设计" }, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
  });

  it("refuses a malformed move: no id, or a row that is not the one asked for", async () => {
    await expect(reply({ ...node, id: "" }).client.moveCockpitWorkItem("w1", { parent_id: "m2" }))
      .rejects.toThrow("cockpit_write_not_confirmed");
    await expect(reply({ ...node, id: "w9" }).client.moveCockpitWorkItem("w1", { parent_id: "m2" }))
      .rejects.toThrow("cockpit_write_not_confirmed");
  });

  it("reads the renumber receipt by its changed count", async () => {
    const { client } = reply({ id: "m1", changed: 2 });
    await expect(client.renumberCockpitChildren("m1")).resolves.toEqual({ id: "m1", changed: 2 });
    await expect(reply({ id: "other", changed: 2 }).client.renumberCockpitChildren("m1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
  });

  it("posts the reconcile with its apply flag and survives a report with unknown rows", async () => {
    const { client, fetchMock } = reply({ workspace_id: "ws-1", apply: true, generated_at: "2026-11-20T00:00:00Z",
      new_roots: [{ future: "shape" }], blockers: [], groups: [], projects: [], reflows: [], title_splits: [],
      directory_names: [], dangling_links: [] });
    await expect(client.reconcileCockpitPlan(true, "ws-1")).resolves.toMatchObject({ apply: true, blockers: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ apply: true });
  });

  it("refuses an unconfirmable reconcile: a body that will not parse, or another workspace's report", async () => {
    await expect(reply({ apply: true }).client.reconcileCockpitPlan(true, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
    await expect(reply({ workspace_id: "ws-2", apply: true }).client.reconcileCockpitPlan(true, "ws-1"))
      .rejects.toThrow("cockpit_write_not_confirmed");
  });

  it("asks for closed projects only when include_closed is set", async () => {
    const planBody = { workspace_id: "ws-1", scope: { project_id: null, module_id: null, project_title: "", module_title: "" },
      nodes: [], payments: [], milestones: [], node_index: [], meetings: [], meeting_issues: [], meeting_nodes: [],
      issue_links: [], has_input_references: false, input_reference_meetings: [], input_reference_meetings_total: 0 };
    const open = reply(planBody);
    await open.client.getCockpitPlan("ws-1", { projectId: null, moduleId: null });
    expect(String(open.fetchMock.mock.calls[0]?.[0])).not.toContain("include_closed");
    const closed = reply(planBody);
    await closed.client.getCockpitPlan("ws-1", { projectId: null, moduleId: null }, true);
    expect(new URL(String(closed.fetchMock.mock.calls[0]?.[0])).searchParams.get("include_closed")).toBe("1");
  });
});

describe("tolerant plan and issue schemas (S4)", () => {
  it("keeps a tree when a newer server sends an unknown level", () => {
    expect(CockpitNodeSchema.parse({ id: "n1", kind: "milestone" }).kind).toBeUndefined();
    expect(CockpitNodeSchema.parse({ id: "n1", kind: "module" }).kind).toBe("module");
  });

  it("defaults the new fields instead of failing an older backend", () => {
    expect(CockpitNodeSchema.parse({ id: "n1" }).directory_name).toBeNull();
    expect(CockpitNodeSchema.parse({ id: "n1", directory_name: "01.01.01名称" }).directory_name).toBe("01.01.01名称");
    const issue = IssueSchema.parse({ id: "i1", workspace_id: "ws", number: 1, identifier: "TES-1", title: "t", description: null,
      status: "todo", priority: "none", assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "u",
      parent_issue_id: null, project_id: null, position: 0, start_date: null, due_date: null, metadata: {}, properties: {},
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(issue.work_item_id).toBeNull();
    expect(IssueSchema.parse({ ...issue, work_item_id: "w1" }).work_item_id).toBe("w1");
  });
});

describe("work-item facets on the issue list (S4)", () => {
  it("sends work_item_ids like module_ids, including an explicit empty window", async () => {
    const listBody = { issues: [], total: 0 };
    const filtered = reply(listBody);
    await filtered.client.listIssues({ work_item_ids: ["w1", "w2"] });
    expect(new URL(String(filtered.fetchMock.mock.calls[0]?.[0])).searchParams.get("work_item_ids")).toBe("w1,w2");
    // Present-but-empty means "no work items", not "no restriction".
    const empty = reply(listBody);
    await empty.client.listIssues({ work_item_ids: [] });
    expect(new URL(String(empty.fetchMock.mock.calls[0]?.[0])).searchParams.get("work_item_ids")).toBe("");
    const unfiltered = reply(listBody);
    await unfiltered.client.listIssues({});
    expect(new URL(String(unfiltered.fetchMock.mock.calls[0]?.[0])).searchParams.has("work_item_ids")).toBe(false);
  });

  it("carries work_item_ids on the table groups request as given", async () => {
    const { client, fetchMock } = reply({ groups: [], total: 0 });
    await client.listIssueTableGroups({ group: { kind: "work_item" }, filters: { work_item_ids: ["w1"] } } as never);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ group: { kind: "work_item" }, filters: { work_item_ids: ["w1"] } });
  });
});
