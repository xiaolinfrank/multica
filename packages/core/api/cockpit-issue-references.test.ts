// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
const node = { node_id: "node-1", code: "01", title: "Execute", available: true, relation: "reference", can_unlink: true };
const meeting = { meeting_id: "meeting-1", code: "M-1", title: "Review", meet_date: "2026-10-10", available: true, role: "task", roles: ["review"], required_roles: ["review"], can_unlink: false };
function reply(items: unknown[], extra: Record<string, unknown> = {}) {
  const body = { workspace_id: "ws-1", issue_id: "issue-1", items, total: 30, next_cursor: "next", ...extra };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock, body };
}
afterEach(() => vi.unstubAllGlobals());
describe("issue cockpit references", () => {
  it("requests a bounded explicit workspace and exact issue page", async () => {
    const { client, fetchMock, body } = reply([node]);
    await expect(client.getCockpitIssueNodeReferences("ws-1", "issue-1", { cursor: "last" })).resolves.toEqual(body);
    const url = new URL(fetchMock.mock.calls[0]![0]); expect(url.pathname).toBe("/api/cockpit/issues/issue-1/nodes");
    expect(url.searchParams.get("page_size")).toBe("25"); expect(url.searchParams.get("cursor")).toBe("last");
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws-1");
  });
  it("refuses scope drift, missing capability facts, duplicate rows and unbounded responses", async () => {
    for (const extra of [{ workspace_id: "other" }, { issue_id: "other" }, { total: -1 }, { items: [node, node] }, { items: Array.from({ length: 26 }, (_, i) => ({ ...node, node_id: String(i) })) }, { items: [{ node_id: "node-1" }] }]) {
      await expect(reply([node], extra).client.getCockpitIssueNodeReferences("ws-1", "issue-1")).resolves.toBeNull();
    }
    await expect(reply([meeting], { issue_id: "other" }).client.getCockpitIssueMeetingReferences("ws-1", "issue-1")).resolves.toBeNull();
  });
  it("keeps formal review relations protected even if a contradictory capability arrives", async () => {
    const out = await reply([{ ...meeting, required_roles: ["future-governance"], can_unlink: true }]).client.getCockpitIssueMeetingReferences("ws-1", "issue-1");
    expect(out?.items[0]?.can_unlink).toBe(false);
    expect(out?.items[0]?.required_roles).toEqual(["future-governance"]);
    const unknown = await reply([{ ...node, relation: "future-primary" }]).client.getCockpitIssueNodeReferences("ws-1", "issue-1");
    expect(unknown?.items[0]).toMatchObject({ relation: "unknown", can_unlink: false });
  });
  it("requires an exact explicit cleanup receipt and never accepts a false removal", async () => {
    const body = { workspace_id: "ws-1", issue_id: "issue-1", kind: "node", target_id: "missing", removed: true };
    const good = reply([], body);
    await expect(good.client.removeCockpitIssueNodeReference("ws-1", "issue-1", "missing")).resolves.toMatchObject(body);
    expect(new URL(good.fetchMock.mock.calls[0]![0]).pathname).toBe("/api/cockpit/issues/issue-1/nodes/missing");
    expect(good.fetchMock.mock.calls[0]![1].method).toBe("DELETE");
    for (const change of [{ workspace_id: "other" }, { issue_id: "other" }, { kind: "meeting" }, { target_id: "other" }, { removed: false }]) {
      await expect(reply([], { ...body, ...change }).client.removeCockpitIssueNodeReference("ws-1", "issue-1", "missing")).resolves.toBeNull();
    }
    await expect(reply([], { ...body, kind: "meeting" }).client.removeCockpitIssueMeetingReference("ws-1", "issue-1", "missing")).resolves.toMatchObject({ kind: "meeting", removed: true });
  });
  it("retains unavailable references and accepts a confirmed empty collection", async () => {
    const out = await reply([{ ...meeting, available: false, title: "", code: "", required_roles: [], can_unlink: true }]).client.getCockpitIssueMeetingReferences("ws-1", "issue-1");
    expect(out?.items[0]).toMatchObject({ available: false, can_unlink: true });
    const empty = reply([], { total: 0, next_cursor: null });
    await expect(empty.client.getCockpitIssueNodeReferences("ws-1", "issue-1")).resolves.toEqual(empty.body);
  });
});
