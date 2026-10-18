// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const node = { id: "node-1", title: "Delivery", code: "07.12", project_id: "project-1", module_id: "module-1", eligible: true, reason: "" };
const nodes = () => ({ workspace_id: "ws-1", scope: { project_id: "project-1", module_id: "module-1", q: "", eligible: true }, items: [node], total: 30, filtered_total: 30, next_cursor: "next" });
const member = { id: "user-1", title: "Reviewer", avatar_url: "", email: "reviewer@example.test", role: "member" };
const members = () => ({ workspace_id: "ws-1", scope: { q: "", ids: [] }, items: [member], total: 35, filtered_total: 35, next_cursor: "next" });
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded cockpit scope choices", () => {
  it("sends explicit workspace and scoped node pagination without consulting a full board", async () => {
    const body = nodes();
    const { client, fetchMock } = reply(body);
    await expect(client.searchCockpitScopeNodes("ws-1", { project_id: "project-1", module_id: "module-1", cursor: "previous" })).resolves.toEqual(body);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/api/cockpit/scopes/nodes");
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ project_id: "project-1", module_id: "module-1", cursor: "previous", eligible: "true", page_size: "20" });
    expect(new Headers(options.headers).get("X-Workspace-ID")).toBe("ws-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects wrong scope, ineligible results and invalid collection counts", async () => {
    for (const body of [
      { ...nodes(), workspace_id: "other" },
      { ...nodes(), scope: { ...nodes().scope, project_id: "other" } },
      { ...nodes(), scope: { ...nodes().scope, q: "other" } },
      { ...nodes(), items: [{ ...node, module_id: "other" }] },
      { ...nodes(), items: [{ ...node, eligible: false, reason: "not_leaf" }] },
      { ...nodes(), items: [{ ...node, module_id: null }] },
      { ...nodes(), total: -1 },
      { ...nodes(), filtered_total: 0 },
    ]) {
      await expect(reply(body).client.searchCockpitScopeNodes("ws-1", { project_id: "project-1", module_id: "module-1" })).resolves.toBeNull();
    }
  });

  it("honors the requested page bound for both collections", async () => {
    await expect(reply({ ...nodes(), items: [node, { ...node, id: "node-2" }] }).client.searchCockpitScopeNodes("ws-1", { project_id: "project-1", module_id: "module-1", page_size: 1 })).resolves.toBeNull();
    await expect(reply({ ...members(), items: [member, { ...member, id: "user-2" }] }).client.searchCockpitScopeMembers("ws-1", { page_size: 1 })).resolves.toBeNull();
  });

  it("recovers selected people only within the requested identity set, including a departed member's empty result", async () => {
    const body = { ...members(), scope: { q: "", ids: ["user-1"] }, total: 1, filtered_total: 1, next_cursor: null };
    const { client, fetchMock } = reply(body);
    await expect(client.searchCockpitScopeMembers("ws-1", { ids: ["user-1"] })).resolves.toEqual(body);
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("ids")).toBe("user-1");
    const empty = { ...body, items: [], total: 0, filtered_total: 0 };
    await expect(reply(empty).client.searchCockpitScopeMembers("ws-1", { ids: ["user-1"] })).resolves.toEqual(empty);
    for (const changed of [{ ...body, workspace_id: "other" }, { ...body, items: [{ ...member, id: "other" }] }, { ...body, next_cursor: "unexpected" }, { ...body, scope: { q: "", ids: [] } }]) {
      await expect(reply(changed).client.searchCockpitScopeMembers("ws-1", { ids: ["user-1"] })).resolves.toBeNull();
    }
  });

  it("defaults an omitted email to empty without inventing an account address", async () => {
    const { email: _email, ...oldMember } = member;
    const body = { ...members(), items: [oldMember] };
    const result = await reply(body).client.searchCockpitScopeMembers("ws-1");
    expect(result?.items[0]?.email).toBe("");
    expect(result?.items[0]?.id).toBe("user-1");
  });

  it("preserves an unknown eligibility reason as a disabled choice without inventing authority", async () => {
    const body = { ...nodes(), scope: { ...nodes().scope, eligible: false }, items: [{ ...node, eligible: false, reason: "future_constraint" }] };
    await expect(reply(body).client.searchCockpitScopeNodes("ws-1", { project_id: "project-1", module_id: "module-1", eligible: false })).resolves.toEqual(body);
  });
});
