import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitLifecyclePageQuery } from "../types/cockpit-meeting-lifecycle";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitLifecycleKeys = {
  all: (wsId: string) => [...cockpitKeys.all(wsId), "meeting-lifecycle"] as const,
  meeting: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.all(wsId), meetingId] as const,
  header: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "header"] as const,
  commands: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "commands"] as const,
  command: (wsId: string, meetingId: string, commandKey: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "command", commandKey] as const,
};
function bounded(query: CockpitLifecyclePageQuery) {
  const value = query.page_size ?? 25;
  return { cursor: query.cursor || undefined, page_size: Number.isInteger(value) ? Math.min(100, Math.max(1, value)) : 25 };
}

export function cockpitMeetingLifecycleOptions(wsId: string, meetingId: string) {
  return queryOptions({ queryKey: cockpitLifecycleKeys.header(wsId, meetingId),
    queryFn: ({ signal }) => api.getCockpitMeetingLifecycle(wsId, meetingId, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId), retry: false });
}



export function cockpitLifecycleCommandsOptions(wsId: string, meetingId: string, params: CockpitLifecyclePageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitLifecycleKeys.commands(wsId, meetingId), query],
    queryFn: ({ signal }) => api.getCockpitLifecycleCommands(wsId, meetingId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId), retry: false });
}
export function cockpitLifecycleCommandOptions(wsId: string, meetingId: string, commandKey: string) {
  return queryOptions({ queryKey: cockpitLifecycleKeys.command(wsId, meetingId, commandKey),
    queryFn: ({ signal }) => api.getCockpitLifecycleCommand(wsId, meetingId, commandKey, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId && commandKey), retry: false });
}

export async function invalidateCockpitMeetingLifecycle(client: QueryClient, wsId: string, meetingId?: string) {
  const filters = { queryKey: meetingId ? cockpitLifecycleKeys.meeting(wsId, meetingId) : cockpitLifecycleKeys.all(wsId),
    // Exact command receipts are immutable and may be resolving an unknown write.
    predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[4] !== "command" };
  // Invalidation alone can reuse an initial read with no cached data. Cancel it
  // explicitly so a read started before the change cannot become the final view.
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
