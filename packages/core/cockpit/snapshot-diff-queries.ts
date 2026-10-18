import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { requireCockpitReadResult } from "./errors";
import { cockpitReadKeys } from "./read-queries";

export function cockpitSnapshotDiffOptions(wsId: string, snapshotId: string, cursor?: string) {
  return queryOptions({
    queryKey: [...cockpitReadKeys.all(wsId), "snapshot-diff", snapshotId, cursor ?? ""],
    queryFn: ({ signal }) => api.getCockpitSnapshotDiff(wsId, snapshotId, { cursor, page_size: 25 }, signal).then(requireCockpitReadResult),
    enabled: Boolean(wsId && snapshotId), refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}
