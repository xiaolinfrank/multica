// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { cockpitPlanMeetingWindowOptions } from "./marker-queries";
import type { CockpitPlanMeetingMarkerPage } from "../types";
vi.mock("../api", () => ({ api: { getCockpitPlanMeetingMarkers: vi.fn() } }));
afterEach(() => vi.clearAllMocks());
const scope = { projectId: "project", moduleId: "module" };
const request = { rows: [{ row_key: "union-row", node_ids: ["node-b", "node-a"] }], date_from: "2026-10-01", date_to: "2026-10-02" };
const page = (patch: Partial<CockpitPlanMeetingMarkerPage> = {}): CockpitPlanMeetingMarkerPage => ({ workspace_id: "ws", scope: { project_id: "project", module_id: "module", project_title: "P", module_title: "M" }, rows: request.rows,
  date_from: request.date_from, date_to: request.date_to, total_groups: 2, next_cursor: "next", groups: [{ row_key: "union-row", date: "2026-10-01", total: 12, items: [] }], ...patch });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
describe("visible plan meeting windows", () => {
  it("finishes only the requested union row and finite date window before exposing its markers", async () => {
    vi.mocked(api.getCockpitPlanMeetingMarkers).mockResolvedValueOnce(page()).mockResolvedValueOnce(page({ next_cursor: null, groups: [{ row_key: "union-row", date: "2026-10-02", total: 1, items: [] }] }));
    const queryClient = client(); const groups = await queryClient.fetchQuery(cockpitPlanMeetingWindowOptions("ws", scope, request));
    expect(groups).toHaveLength(2); expect(groups[0]?.total).toBe(12);
    expect(api.getCockpitPlanMeetingMarkers).toHaveBeenNthCalledWith(2, "ws", scope, { ...request, archive: "active", rows: [{ row_key: "union-row", node_ids: ["node-a", "node-b"] }], cursor: "next" }, expect.any(AbortSignal)); queryClient.clear();
  });
  it("keeps archive-inclusive markers separate while reusing the default active window", async () => {
    vi.mocked(api.getCockpitPlanMeetingMarkers).mockResolvedValueOnce(page({ total_groups: 1, next_cursor: null, archive: "active" }))
      .mockResolvedValueOnce(page({ total_groups: 1, next_cursor: null, archive: "all", groups: [{ row_key: "union-row", date: "2026-10-01", total: 30, items: [] }] }));
    const qc = client();
    const active = await qc.fetchQuery(cockpitPlanMeetingWindowOptions("ws", scope, request));
    const all = await qc.fetchQuery(cockpitPlanMeetingWindowOptions("ws", scope, { ...request, archive: "all" }));
    expect(active[0]?.total).toBe(12); expect(all[0]?.total).toBe(30);
    await expect(qc.fetchQuery(cockpitPlanMeetingWindowOptions("ws", scope, { ...request, archive: "active" }))).resolves.toEqual(active);
    expect(api.getCockpitPlanMeetingMarkers).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.getCockpitPlanMeetingMarkers).mock.calls.map((call) => call[2].archive)).toEqual(["active", "all"]);
    qc.clear();
  });
  it("does not present a partially read or changing marker set as a complete window", async () => {
    for (const tail of [page({ next_cursor: null, groups: [] }), page({ total_groups: 3 }), page()]) {
      vi.mocked(api.getCockpitPlanMeetingMarkers).mockReset().mockResolvedValueOnce(page()).mockResolvedValueOnce(tail);
      const queryClient = client(); await expect(queryClient.fetchQuery(cockpitPlanMeetingWindowOptions("ws", scope, request))).rejects.toThrow(); queryClient.clear();
    }
  });
});
