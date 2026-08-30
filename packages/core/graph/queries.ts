import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";

// Graph cache keys live under the issueKeys prefix on purpose: issue
// create/update/delete events invalidate ["issues", wsId, ...] wholesale, so
// the graph snapshot refreshes with them for free. Comment events carry no
// Issue snapshot, so use-realtime-sync adds a targeted graph invalidation
// there (mention edges are extracted from comment bodies).
export const graphKeys = {
  all: (wsId: string) => [...issueKeys.all(wsId), "graph"] as const,
  detail: (wsId: string, projectId: string | null) =>
    [...graphKeys.all(wsId), projectId ?? "workspace"] as const,
};

export function issueGraphOptions(wsId: string, projectId: string | null) {
  return queryOptions({
    queryKey: graphKeys.detail(wsId, projectId),
    queryFn: () =>
      api.getIssueGraph(projectId ? { project_id: projectId } : undefined),
  });
}
