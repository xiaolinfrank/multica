// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const item = { id: "agent-1", type: "agent", title: "Visible offline agent", email: "", avatar_url: "", status: "offline", runtime_bound: true, can_assign: true, reason: "" };
const page = () => ({ workspace_id: "ws-1", q: "", kind: "all", selected_type: null, selected_id: null, items: [item], total: 12, next_cursor: "next" });
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded cockpit assignee API", () => {
  it("requests an explicit workspace and page, retaining offline planning eligibility", async () => {
    const body = page(); const { client, fetchMock } = reply(body);
    await expect(client.searchCockpitAssignees("ws-1", { cursor: "previous" })).resolves.toEqual(body);
    expect(new URL(fetchMock.mock.calls[0]![0]).pathname).toBe("/api/cockpit/scopes/assignees");
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("page_size")).toBe("20");
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws-1");
  });

  it("refuses wrong workspace, filter, page size and selected identity acknowledgements", async () => {
    for (const body of [{ ...page(), workspace_id: "other" }, { ...page(), kind: "member" }, { ...page(), q: "different" },
      { ...page(), items: [item, { ...item, id: "agent-2" }] }, { ...page(), total: -1 }]) {
      await expect(reply(body).client.searchCockpitAssignees("ws-1", { page_size: 1 })).resolves.toBeNull();
    }
    const selected = { ...page(), selected_type: "agent", selected_id: "agent-1", total: 1, next_cursor: null };
    await expect(reply(selected).client.searchCockpitAssignees("ws-1", { selected_type: "agent", selected_id: "agent-1" })).resolves.toEqual(selected);
    await expect(reply({ ...selected, items: [{ ...item, id: "agent-2" }] }).client.searchCockpitAssignees("ws-1", { selected_type: "agent", selected_id: "agent-1" })).resolves.toBeNull();
  });

  it("keeps archived selected actors visible but cannot turn them into new assignments", async () => {
    const body = { ...page(), selected_type: "agent", selected_id: "agent-1", total: 1, next_cursor: null,
      items: [{ ...item, status: "archived", reason: "archived", can_assign: false }] };
    await expect(reply(body).client.searchCockpitAssignees("ws-1", { selected_type: "agent", selected_id: "agent-1" })).resolves.toEqual(body);
  });

  it("fails closed on unknown types, statuses and missing runtime facts even if a new server grants a capability", async () => {
    for (const patch of [{ type: "future-worker" }, { status: "future-state" }, { runtime_bound: null }, { type: "squad", status: "active", runtime_bound: false }, { reason: "future-policy" }]) {
      const response = await reply({ ...page(), items: [{ ...item, ...patch }] }).client.searchCockpitAssignees("ws-1");
      expect(response?.items[0]?.can_assign).toBe(false);
      expect(response?.items[0]?.id).toBe("agent-1");
    }
  });
});
