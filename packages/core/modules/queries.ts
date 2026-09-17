import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const moduleKeys = {
  all: (wsId: string) => ["modules", wsId] as const,
  list: (wsId: string) => [...moduleKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) =>
    [...moduleKeys.all(wsId), "detail", id] as const,
};

/**
 * Modules of one workspace, optionally narrowed to a project server-side.
 *
 * The list key stays workspace-scoped (no projectId segment) on purpose: the
 * mutations below append/remove/reorder against this single cache, so a
 * surface that filters by project and one that lists the whole workspace
 * share one source of truth. The server orders by position ASC, created_at
 * ASC within a project.
 */
export function moduleListOptions(wsId: string, projectId?: string) {
  return queryOptions({
    queryKey: moduleKeys.list(wsId),
    // Always fetch the whole workspace and filter in `select`: keying the
    // same cache entry by a projectId that also changes the queryFn would
    // make the cached contents depend on which consumer mounted first.
    // The workspace-wide list is a superset every consumer can slice.
    queryFn: () => api.listModules(),
    select: (data) =>
      projectId ? data.modules.filter((m) => m.project_id === projectId) : data.modules,
  });
}

export function moduleDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: moduleKeys.detail(wsId, id),
    queryFn: () => api.getModule(id),
  });
}
