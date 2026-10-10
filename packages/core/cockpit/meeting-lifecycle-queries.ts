import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitAgendaQuery, CockpitAgendaReferenceQuery, CockpitLifecyclePageQuery, CockpitAgendaReferencePage } from "../types/cockpit-meeting-lifecycle";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitLifecycleKeys = {
  all: (wsId: string) => [...cockpitKeys.all(wsId), "meeting-lifecycle"] as const,
  meeting: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.all(wsId), meetingId] as const,
  header: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "header"] as const,
  agendas: (wsId: string, meetingId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "agenda-pages"] as const,
  agenda: (wsId: string, meetingId: string, agendaId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "agenda", agendaId] as const,
  references: (wsId: string, meetingId: string, agendaId: string) => [...cockpitLifecycleKeys.meeting(wsId, meetingId), "references", agendaId] as const,
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
export function cockpitAgendaOptions(wsId: string, meetingId: string, params: CockpitAgendaQuery = {}) {
  const query = { ...bounded(params), q: params.q?.trim() ?? "", include_removed: params.include_removed ?? false };
  return queryOptions({ queryKey: [...cockpitLifecycleKeys.agendas(wsId, meetingId), query],
    queryFn: ({ signal }) => api.getCockpitMeetingAgenda(wsId, meetingId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId), retry: false });
}
export function cockpitAgendaDetailOptions(wsId: string, meetingId: string, agendaId: string) {
  return queryOptions({ queryKey: cockpitLifecycleKeys.agenda(wsId, meetingId, agendaId),
    queryFn: ({ signal }) => api.getCockpitAgendaDetail(wsId, meetingId, agendaId, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId && agendaId), retry: false });
}
export function cockpitAgendaReferencesOptions(wsId: string, meetingId: string, agendaId: string, params: CockpitAgendaReferenceQuery = {}) {
  const query = { ...bounded(params), include_removed: params.include_removed ?? false };
  return queryOptions({ queryKey: [...cockpitLifecycleKeys.references(wsId, meetingId, agendaId), query],
    queryFn: ({ signal }) => api.getCockpitAgendaReferences(wsId, meetingId, agendaId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId && agendaId), retry: false });
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
export function invalidateCockpitMeetingIssueFacts(client: QueryClient, wsId: string, issueId: string) {
  void client.invalidateQueries({ queryKey: cockpitLifecycleKeys.all(wsId), predicate: (query) => {
    if (query.queryKey[4] !== "references") return false;
    const page = query.state.data as CockpitAgendaReferencePage | undefined;
    return Array.isArray(page?.items) && page.items.some((item) => item.kind === "issue" && item.target_id === issueId);
  } }, { cancelRefetch: false });
}
