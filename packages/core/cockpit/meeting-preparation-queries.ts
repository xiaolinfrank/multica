import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitLifecyclePageQuery } from "../types/cockpit-meeting-lifecycle";
import type { CockpitCancellationImpactQuery } from "../types/cockpit-meeting-preparation";
import { cockpitKeys, invalidateCockpitTaskFlow } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { issueKeys } from "../issues/queries";
import { graphKeys } from "../graph/queries";
import { invalidateCockpitMeetingLifecycle } from "./meeting-lifecycle-queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitPreparationKeys = {
  all: (ws: string) => [...cockpitKeys.all(ws), "preparation"] as const,
  meeting: (ws: string, meeting: string) => [...cockpitPreparationKeys.all(ws), "meeting", meeting] as const,
  operations: (ws: string, meeting: string) => [...cockpitPreparationKeys.meeting(ws, meeting), "operations"] as const,
  operation: (ws: string, meeting: string, op: string) => [...cockpitPreparationKeys.meeting(ws, meeting), "operation", op] as const,
  effects: (ws: string, meeting: string, op: string) => [...cockpitPreparationKeys.operation(ws, meeting, op), "effects"] as const,
  effect: (ws: string, meeting: string, op: string, effect: string) => [...cockpitPreparationKeys.operation(ws, meeting, op), "effect", effect] as const,
  authorization: (ws: string, meeting: string, op: string, effect: string) => [...cockpitPreparationKeys.effect(ws, meeting, op, effect), "authorization-preview"] as const,
  basis: (ws: string, meeting: string) => [...cockpitPreparationKeys.meeting(ws, meeting), "basis"] as const,
  impact: (ws: string, meeting: string) => [...cockpitPreparationKeys.meeting(ws, meeting), "impact"] as const,
  runs: (ws: string, meeting: string, issue: string) => [...cockpitPreparationKeys.meeting(ws, meeting), "runs", issue] as const,
};
function bounded(query: CockpitLifecyclePageQuery) {
  const size = query.page_size ?? 25;
  return { cursor: query.cursor || undefined, page_size: Number.isInteger(size) ? Math.min(100, Math.max(1, size)) : 25 };
}
export function cockpitPreparationOperationsOptions(ws: string, meeting: string, params: CockpitLifecyclePageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitPreparationKeys.operations(ws, meeting), query], queryFn: ({ signal }) => api.getCockpitPreparationOperations(ws, meeting, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting), retry: false });
}
export function cockpitPreparationOperationOptions(ws: string, meeting: string, op: string) {
  return queryOptions({ queryKey: cockpitPreparationKeys.operation(ws, meeting, op), queryFn: ({ signal }) => api.getCockpitPreparationOperation(ws, meeting, op, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && op), retry: false });
}
export function cockpitPreparationEffectsOptions(ws: string, meeting: string, op: string, params: CockpitLifecyclePageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitPreparationKeys.effects(ws, meeting, op), query], queryFn: ({ signal }) => api.getCockpitPreparationEffects(ws, meeting, op, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && op), retry: false });
}
export function cockpitPreparationEffectOptions(ws: string, meeting: string, op: string, effect: string) {
  return queryOptions({ queryKey: cockpitPreparationKeys.effect(ws, meeting, op, effect), queryFn: ({ signal }) => api.getCockpitPreparationEffect(ws, meeting, op, effect, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && op && effect), retry: false });
}
export function cockpitMeetingOperationBasisOptions(ws: string, meeting: string) {
  return queryOptions({ queryKey: cockpitPreparationKeys.basis(ws, meeting), queryFn: ({ signal }) => api.getCockpitMeetingOperationBasis(ws, meeting, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting), retry: false });
}
export function cockpitPreparationAuthorizationPreviewOptions(ws: string, meeting: string, op: string, effect: string) {
  return queryOptions({ queryKey: cockpitPreparationKeys.authorization(ws, meeting, op, effect), queryFn: ({ signal }) => api.getCockpitPreparationAuthorizationPreview(ws, meeting, op, effect, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && op && effect), retry: false, staleTime: 0 });
}
export function cockpitCancellationImpactOptions(ws: string, meeting: string, params: CockpitCancellationImpactQuery = {}) {
  const query = { ...bounded(params), q: params.q?.trim() ?? "" };
  return queryOptions({ queryKey: [...cockpitPreparationKeys.impact(ws, meeting), query], queryFn: ({ signal }) => api.getCockpitCancellationImpact(ws, meeting, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting), retry: false });
}
export function cockpitCancellationRunsOptions(ws: string, meeting: string, issue: string, params: CockpitLifecyclePageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitPreparationKeys.runs(ws, meeting, issue), query], queryFn: ({ signal }) => api.getCockpitCancellationRuns(ws, meeting, issue, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && issue), retry: false });
}

/** Cancel pre-change reads on both local commands and another member's events. */
export async function invalidateCockpitPreparationProjections(client: QueryClient, ws: string, meeting?: string) {
  const filters = { queryKey: meeting ? cockpitPreparationKeys.meeting(ws, meeting) : cockpitPreparationKeys.all(ws) };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}

/** Reconcile current facts after either a write or recovery of its fixed receipt. */
export async function invalidateCockpitMeetingPreparationFacts(client: QueryClient, ws: string, meeting?: string, _operation?: string) {
  await Promise.all([
    invalidateCockpitPreparationProjections(client, ws, meeting), invalidateCockpitMeetingLifecycle(client, ws, meeting),
    client.invalidateQueries({ queryKey: cockpitReadKeys.all(ws) }),
    client.invalidateQueries({ queryKey: cockpitKeys.dashboard(ws) }),
    meeting ? client.invalidateQueries({ queryKey: cockpitKeys.workflow(ws, meeting) }) : Promise.resolve(),
    client.invalidateQueries({ queryKey: issueKeys.all(ws) }),
    client.invalidateQueries({ queryKey: graphKeys.all(ws) }),
  ]);
  invalidateCockpitTaskFlow(client, ws);
}
