import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitChangePageQuery, CockpitGovernancePageQuery, CockpitChangePreview } from "../types/cockpit-governance";
import type { CockpitScope } from "./navigation";
import { cockpitReadKeys } from "./read-queries";
import { cockpitKeys, patchCockpitBoard, upsertCockpitNode } from "./queries";
import { requireCockpitReadResult } from "./errors";
export function cockpitChangePageOptions(wsId: string, scope: CockpitScope, query: CockpitChangePageQuery = {}) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "changes", scope, query],
    queryFn: ({ signal }) => api.listCockpitChangePage(wsId, scope, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId) });
}
export function cockpitSnapshotPageOptions(wsId: string, query: CockpitGovernancePageQuery = {}) {
  return queryOptions({ queryKey: [...cockpitKeys.snapshots(wsId), "page", query],
    queryFn: ({ signal }) => api.listCockpitSnapshotPage(wsId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId) });
}

/** A displayed review is a fixed observation; focus or realtime events must not replace it. */
export function usePreviewCockpitChange(wsId: string) {
  return useMutation({ mutationFn: (changeId: string) => api.getCockpitChangePreview(wsId, changeId).then(requireCockpitReadResult) });
}
export function useApplyReviewedCockpitChange(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (preview: CockpitChangePreview) => api.applyReviewedCockpitChange(wsId, preview),
    onSuccess: ({ node }) => { patchCockpitBoard(client, wsId, (board) => upsertCockpitNode(board, node)); },
    onSettled: () => { void client.invalidateQueries({ queryKey: cockpitReadKeys.all(wsId) }); void client.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) }); },
  });
}
