"use client";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitDirectoryNaturalKey, CockpitDirectoryPageQuery, CockpitDirectoryWrite } from "../types/cockpit-directory";
import { cockpitKeys } from "./queries";
import { normalizedCockpitDirectoryQuery } from "./directory-page";
import { requireCockpitReadResult } from "./errors";
export function cockpitDirectoryPageOptions(wsId: string, params: CockpitDirectoryPageQuery = {}) {
  return queryOptions({ queryKey: [...cockpitKeys.directory(wsId), "page", normalizedCockpitDirectoryQuery(params), params.cursor ?? ""],
    queryFn: async () => requireCockpitReadResult(await api.getCockpitDirectoryPage(wsId, params)), staleTime: 30_000 });
}
export function useUpsertCockpitDirectoryCompact(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: CockpitDirectoryWrite) => api.upsertCockpitDirectoryCompact(wsId, body),
    onSettled: () => { void client.invalidateQueries({ queryKey: cockpitKeys.directory(wsId) }); } });
}
export function useDeleteCockpitDirectoryCompact(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (entry: CockpitDirectoryNaturalKey) => api.deleteCockpitDirectoryCompact(wsId, entry),
    onSettled: () => { void client.invalidateQueries({ queryKey: cockpitKeys.directory(wsId) }); } });
}
