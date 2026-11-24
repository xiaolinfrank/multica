import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { PlanDirectoryStatus } from "../types";

/** The panel's own directory reads. Keys carry `wsId`, and the plan read is
 *  keyed by the exact id set asked for: opening a second node is a different
 *  question, not a cache miss on the first. */
export const directoryKeys = {
  all: (wsId: string) => ["directory", wsId] as const,
  plan: (wsId: string) => ["directory", wsId, "plan"] as const,
  planNodes: (wsId: string, nodeIds: string[]) => ["directory", wsId, "plan", [...nodeIds].sort().join(",")] as const,
  issue: (wsId: string, issueId: string) => ["directory", wsId, "issue", issueId] as const,
};

/** The server caps one status request at 100 ids. */
const DIRECTORY_BATCH = 100;

export function planDirectoriesOptions(wsId: string, nodeIds: string[]) {
  const ids = [...new Set(nodeIds.filter(Boolean))];
  return queryOptions({
    queryKey: directoryKeys.planNodes(wsId, ids),
    queryFn: async ({ signal }): Promise<PlanDirectoryStatus[]> => {
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += DIRECTORY_BATCH) batches.push(ids.slice(i, i + DIRECTORY_BATCH));
      const pages = await Promise.all(batches.map((batch) => api.listPlanDirectories(wsId, batch, signal)));
      return pages.flat();
    },
    enabled: Boolean(wsId) && ids.length > 0,
    // A folder's state is a fact about the share, not a cacheable projection.
    staleTime: 0,
  });
}

export function issueDirectoryOptions(wsId: string, issueId: string) {
  return queryOptions({
    queryKey: directoryKeys.issue(wsId, issueId),
    queryFn: ({ signal }) => api.getIssueDirectory(issueId, signal),
    enabled: Boolean(wsId && issueId),
    staleTime: 0,
  });
}
