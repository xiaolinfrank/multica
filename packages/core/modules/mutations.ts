import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { moduleKeys } from "./queries";
import { issueKeys } from "../issues/queries";
import { useWorkspaceId } from "../hooks";
import type { Module, CreateModuleRequest, UpdateModuleRequest, ListModulesResponse } from "../types";

export function useCreateModule() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateModuleRequest) => api.createModule(data),
    onSuccess: (newModule) => {
      // The server appends (position = MAX+1 within the project), so the new
      // row lands at the end of the position-ordered list. Dedup guards the
      // realtime refetch having already delivered the row.
      qc.setQueryData<ListModulesResponse>(moduleKeys.list(wsId), (old) =>
        old && !old.modules.some((m) => m.id === newModule.id)
          ? { ...old, modules: [...old.modules, newModule], total: old.total + 1 }
          : old,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.list(wsId) });
    },
  });
}

export function useUpdateModule() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & UpdateModuleRequest) =>
      api.updateModule(id, data),
    onMutate: ({ id, ...data }) => {
      qc.cancelQueries({ queryKey: moduleKeys.list(wsId) });
      const prevList = qc.getQueryData<ListModulesResponse>(moduleKeys.list(wsId));
      const prevDetail = qc.getQueryData<Module>(moduleKeys.detail(wsId, id));
      qc.setQueryData<ListModulesResponse>(moduleKeys.list(wsId), (old) =>
        old ? { ...old, modules: old.modules.map((m) => (m.id === id ? { ...m, ...data } : m)) } : old,
      );
      qc.setQueryData<Module>(moduleKeys.detail(wsId, id), (old) =>
        old ? { ...old, ...data } : old,
      );
      return { prevList, prevDetail, id };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(moduleKeys.list(wsId), ctx.prevList);
      if (ctx?.prevDetail) qc.setQueryData(moduleKeys.detail(wsId, ctx.id), ctx.prevDetail);
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: moduleKeys.detail(wsId, vars.id) });
      qc.invalidateQueries({ queryKey: moduleKeys.list(wsId) });
    },
  });
}

export function useDeleteModule() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (id: string) => api.deleteModule(id),
    // Deliberately NOT optimistic: the server detaches the module's issues
    // (module_id → NULL) and deletes the row in one transaction, and a row
    // vanishing before a rejected delete lands would read as success. Cache
    // removal happens only after the server confirms.
    onSuccess: (_data, id) => {
      qc.setQueryData<ListModulesResponse>(moduleKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              modules: old.modules.filter((m) => m.id !== id),
              total: Math.max(0, old.total - 1),
            }
          : old,
      );
      qc.removeQueries({ queryKey: moduleKeys.detail(wsId, id) });
      // The server detached this module's issues (module_id → NULL) in the
      // same transaction; those rows live in the issue caches this client
      // never hears about otherwise (self-initiated deletes get no
      // module:deleted echo back to the initiating client).
      qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.all(wsId) });
    },
  });
}

/**
 * Commits a drag-reorder within one project: positions become 0..n-1 in the
 * given order, in a single server-side statement.
 */
export function useReorderModules() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (moduleIds: string[]) => api.reorderModules(moduleIds),
    onMutate: async (moduleIds) => {
      await qc.cancelQueries({ queryKey: moduleKeys.list(wsId) });
      const previous = qc.getQueryData<ListModulesResponse>(moduleKeys.list(wsId));
      const positionById = new Map(moduleIds.map((id, index) => [id, index]));
      qc.setQueryData<ListModulesResponse>(moduleKeys.list(wsId), (old) =>
        old
          ? {
              ...old,
              // Re-sorted, not just re-positioned: consumers render the array
              // in order, so writing positions alone would leave the drag
              // visually undone until the refetch lands. Modules outside the
              // reorder set keep their positions and re-sort among themselves.
              modules: old.modules
                .map((m) =>
                  positionById.has(m.id) ? { ...m, position: positionById.get(m.id)! } : m,
                )
                .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)),
            }
          : old,
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(moduleKeys.list(wsId), ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: moduleKeys.list(wsId) });
    },
  });
}
