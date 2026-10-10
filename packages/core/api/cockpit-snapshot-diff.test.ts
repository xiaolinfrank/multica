// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

const hash = "a".repeat(64);
const counts = { nodes: 1, payments: 0, milestones: 0 };
const page = {
  workspace_id: "workspace", snapshot_id: "snapshot", snapshot_created_at: "2026-10-10T00:00:00Z",
  snapshot_cockpit_id: "board", current_cockpit_id: "board", scope: "workspace", generated_at: "2026-10-10T01:00:00Z",
  comparable: true, reason: "", snapshot_complete: true, current_complete: true, snapshot_counts: counts, current_counts: counts,
  counts: { added: 0, removed: 0, modified: 1, unchanged: 1 }, items: [{ entity_kind: "node", id: "node", change: "modified", code: "L3-1", name: "Delivery",
    field_changes: [{ field: "name", before: { value: "Original", truncated: false, sha256: hash }, after: { value: "Delivery", truncated: false, sha256: hash } }] }],
  total: 1, page_size: 25, next_cursor: null, comparison_token: hash,
};
function reply(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
describe("stable plan comparison receipts", () => {
  it("keeps the initiating workspace and exact snapshot identity", async () => {
    const { client, fetchMock } = reply(page);
    await expect(client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toEqual(page);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Workspace-ID": "workspace" } });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/snapshots/snapshot/diff?page_size=25");
    for (const invalid of [{ ...page, workspace_id: "other" }, { ...page, snapshot_id: "other" }, { ...page, current_cockpit_id: "replacement" },
      { ...page, current_complete: false }, { ...page, total: 0 }, { ...page, comparison_token: "" }, { ...page, items: [page.items[0], page.items[0]], total: 2 }]) {
      await expect(reply(invalid).client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toBeNull();
    }
  });
  it("preserves an explicit unavailable comparison instead of reporting no differences", async () => {
    const legacy = { ...page, comparable: false, reason: "legacy_identity_missing", snapshot_complete: false, snapshot_cockpit_id: "", items: [], total: 0,
      counts: { added: 0, removed: 0, modified: 0, unchanged: 0 }, comparison_token: "" };
    await expect(reply(legacy).client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toEqual(legacy);
    await expect(reply({ ...legacy, reason: "" }).client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toBeNull();
    await expect(reply({}).client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toBeNull();
  });
  it("validates page progression and keeps unknown read-only change kinds visible", async () => {
    const one = { ...page, page_size: 1, next_cursor: "second" };
    await expect(reply(one).client.getCockpitSnapshotDiff("workspace", "snapshot", { cursor: "second", page_size: 1 })).resolves.toBeNull();
    await expect(reply(one).client.getCockpitSnapshotDiff("workspace", "snapshot", { page_size: 1 })).resolves.toEqual(one);
    const unknown = { ...page, items: [{ ...page.items[0], entity_kind: "future_entity", change: "future_change" }] };
    await expect(reply(unknown).client.getCockpitSnapshotDiff("workspace", "snapshot")).resolves.toMatchObject({ items: [{ entity_kind: "unknown", change: "unknown" }] });
  });
});
