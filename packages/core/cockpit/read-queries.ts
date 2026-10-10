import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";
import type { CockpitScope } from "./navigation";
import type { CockpitMeetingRegisterQuery, CockpitPlanMeetingMarkerQuery } from "../types/cockpit-read";

export const cockpitReadKeys = {
  all: (wsId: string) => cockpitKeys.surfaces(wsId),
  context: (wsId: string, scope: CockpitScope) => [...cockpitReadKeys.all(wsId), "context", scope] as const,
  plan: (wsId: string, scope: CockpitScope) => [...cockpitReadKeys.all(wsId), "plan", scope] as const,
  scopes: (wsId: string, kind: string, projectId: string | null, q: string, cursor?: string) => [...cockpitReadKeys.all(wsId), "scopes", kind, projectId, q, cursor ?? ""] as const,
  meetings: (wsId: string, scope: CockpitScope, query: CockpitMeetingRegisterQuery) => [...cockpitReadKeys.all(wsId), "meetings", scope, query] as const,
  node: (wsId: string, nodeId: string, scope: CockpitScope) => [...cockpitReadKeys.all(wsId), "node", nodeId, scope] as const,
  meeting: (wsId: string, meetingId: string, scope: CockpitScope) => [...cockpitReadKeys.all(wsId), "meeting", meetingId, scope] as const,
};
export function cockpitContextOptions(wsId: string, scope: CockpitScope) {
  return queryOptions({ queryKey: cockpitReadKeys.context(wsId, scope), queryFn: ({ signal }) => api.getCockpitContext(wsId, scope, signal).then(requireCockpitReadResult), enabled: Boolean(wsId), staleTime: 15_000 });
}
export function cockpitNodeIndexOptions(wsId: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "node-index"], queryFn: ({ signal }) => api.getCockpitNodeIndex(wsId, signal).then(requireCockpitReadResult), enabled: Boolean(wsId), staleTime: 30_000 });
}
export function cockpitPlanOptions(wsId: string, scope: CockpitScope) {
  return queryOptions({ queryKey: cockpitReadKeys.plan(wsId, scope), queryFn: ({ signal }) => api.getCockpitPlan(wsId, scope, signal).then(requireCockpitReadResult), enabled: Boolean(wsId), staleTime: 15_000 });
}
export function cockpitScopeProjectsOptions(wsId: string, q: string, cursor?: string) {
  return queryOptions({ queryKey: cockpitReadKeys.scopes(wsId, "projects", null, q, cursor), queryFn: ({ signal }) => api.searchCockpitScopes(wsId, "projects", { q, cursor }, signal).then(requireCockpitReadResult), enabled: Boolean(wsId) });
}
export function cockpitScopeModulesOptions(wsId: string, projectId: string | null, q: string, cursor?: string) {
  return queryOptions({ queryKey: cockpitReadKeys.scopes(wsId, "modules", projectId, q, cursor), queryFn: ({ signal }) => api.searchCockpitScopes(wsId, "modules", { project_id: projectId ?? undefined, q, cursor }, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && projectId) });
}
export function cockpitMeetingRegisterOptions(wsId: string, scope: CockpitScope, query: CockpitMeetingRegisterQuery) {
  return queryOptions({ queryKey: cockpitReadKeys.meetings(wsId, scope, query), queryFn: ({ signal }) => api.getCockpitMeetingRegister(wsId, scope, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId), staleTime: 15_000 });
}
export function cockpitNodeDetailOptions(wsId: string, nodeId: string, scope: CockpitScope) {
  return queryOptions({ queryKey: cockpitReadKeys.node(wsId, nodeId, scope), queryFn: ({ signal }) => api.getCockpitNodeDetail(wsId, nodeId, scope, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && nodeId) });
}
export function cockpitMeetingDetailOptions(wsId: string, meetingId: string, scope: CockpitScope) {
  return queryOptions({ queryKey: cockpitReadKeys.meeting(wsId, meetingId, scope), queryFn: ({ signal }) => api.getCockpitMeetingDetail(wsId, meetingId, scope, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId) });
}
export function cockpitNodePaymentsOptions(wsId: string, nodeId: string, cursor?: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "node-payments", nodeId, cursor ?? ""], queryFn: ({ signal }) => api.getCockpitNodePayments(wsId, nodeId, cursor, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && nodeId) });
}
export function cockpitMeetingIssuesOptions(wsId: string, meetingId: string, cursor?: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "meeting-issues", meetingId, cursor ?? ""], queryFn: ({ signal }) => api.getCockpitMeetingIssues(wsId, meetingId, cursor, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId) });
}
export function cockpitMeetingNodesOptions(wsId: string, meetingId: string, cursor?: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "meeting-nodes", meetingId, cursor ?? ""], queryFn: ({ signal }) => api.getCockpitMeetingNodes(wsId, meetingId, cursor, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId) });
}
export function cockpitNodeMeetingsOptions(wsId: string, nodeId: string, cursor?: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "node-meetings", nodeId, cursor ?? ""], queryFn: ({ signal }) => api.getCockpitNodeMeetings(wsId, nodeId, cursor, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && nodeId) });
}
export function cockpitMeetingNextCodeOptions(wsId: string, date: string) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "meeting-next-code", date], queryFn: ({ signal }) => api.getCockpitMeetingNextCode(wsId, date, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && date) });
}
export function cockpitNodeCodePreviewOptions(wsId: string, parentId: string | null) {
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "node-code-preview", parentId], queryFn: ({ signal }) => api.getCockpitNodeCodePreview(wsId, parentId, signal).then(requireCockpitReadResult), enabled: Boolean(wsId), staleTime: 0 });
}
export function cockpitPlanMeetingMarkersOptions(wsId: string, scope: CockpitScope, params: CockpitPlanMeetingMarkerQuery) {
  const query = { ...params, rows: params.rows.map((row) => ({ row_key: row.row_key, node_ids: [...new Set(row.node_ids)].sort() }))
    .sort((a, b) => a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0) };
  return queryOptions({ queryKey: [...cockpitReadKeys.all(wsId), "plan-meeting-markers", scope, query],
    queryFn: ({ signal }) => api.getCockpitPlanMeetingMarkers(wsId, scope, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && query.rows.length && query.date_from && query.date_to) });
}
