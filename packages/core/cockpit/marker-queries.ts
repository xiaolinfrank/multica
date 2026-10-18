import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitPlanMeetingMarkerGroup, CockpitPlanMeetingMarkerQuery } from "../types";
import type { CockpitScope } from "./navigation";
import { cockpitReadKeys } from "./read-queries";

/** Complete only the finite visible row/date window; never load meeting history. */
export function cockpitPlanMeetingWindowOptions(wsId: string, scope: CockpitScope, params: Omit<CockpitPlanMeetingMarkerQuery, "cursor">) {
  const query = { ...params, archive: params.archive ?? "active", rows: params.rows.map((row) => ({ row_key: row.row_key, node_ids: [...new Set(row.node_ids)].sort() })).sort((a, b) => a.row_key.localeCompare(b.row_key)) };
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "plan-meeting-window", scope, query],
    enabled: Boolean(wsId && query.rows.length && query.date_from && query.date_to), staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const groups: CockpitPlanMeetingMarkerGroup[] = [];
      const seen = new Set<string>(); const visited = new Set<string>();
      let cursor: string | undefined; let expectedTotal: number | null = null;
      do {
        const page = await api.getCockpitPlanMeetingMarkers(wsId, scope, { ...query, cursor }, signal);
        if (!page || (expectedTotal !== null && page.total_groups !== expectedTotal)) throw new Error("Meeting marker window changed; refresh this window");
        expectedTotal = page.total_groups;
        for (const group of page.groups) {
          const key = `${group.row_key}:${group.date}`;
          if (seen.has(key)) throw new Error("Repeated meeting marker group");
          seen.add(key); groups.push(group);
        }
        if (groups.length > query.rows.length * 93) throw new Error("Meeting marker window exceeds its bounds");
        cursor = page.next_cursor || undefined;
        if (cursor && (visited.has(cursor) || page.groups.length === 0)) throw new Error("Invalid meeting marker continuation");
        if (cursor) visited.add(cursor);
      } while (cursor);
      if (groups.length !== expectedTotal) throw new Error("Incomplete meeting marker window");
      return groups;
    },
  });
}
