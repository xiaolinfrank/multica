import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const fleetKeys = {
  all: ["fleet"] as const,
  status: () => [...fleetKeys.all, "status"] as const,
};

// The compute pool is global infrastructure, not workspace-scoped, so the key
// carries no wsId. The collector caches ~5s server-side; the client polls a
// little slower and keeps the previous snapshot visible between refetches so
// the grid never flashes empty.
const REFETCH_MS = 5000;

export function fleetStatusOptions() {
  return queryOptions({
    queryKey: fleetKeys.status(),
    queryFn: () => api.getFleetStatus(),
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS,
  });
}
