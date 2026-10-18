import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitMeetingDirectoryPageQuery } from "../types/cockpit-meeting-directory";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { invalidateCockpitMeetingLifecycle } from "./meeting-lifecycle-queries";
import { requireCockpitReadResult } from "./errors";

export const cockpitDirectoryKeys = {
  all: (ws: string) => [...cockpitKeys.all(ws), "directory-preparation"] as const,
  roots: (ws: string) => [...cockpitDirectoryKeys.all(ws), "roots"] as const,
  root: (ws: string, root: string) => [...cockpitDirectoryKeys.all(ws), "root", root] as const,
  meeting: (ws: string, meeting: string) => [...cockpitDirectoryKeys.all(ws), "meeting", meeting] as const,
  summary: (ws: string, meeting: string) => [...cockpitDirectoryKeys.meeting(ws, meeting), "summary"] as const,
  operations: (ws: string, meeting: string) => [...cockpitDirectoryKeys.meeting(ws, meeting), "operations"] as const,
  operation: (ws: string, meeting: string, operation: string) => [...cockpitDirectoryKeys.meeting(ws, meeting), "operation", operation] as const,
  steps: (ws: string, meeting: string, operation: string) => [...cockpitDirectoryKeys.operation(ws, meeting, operation), "steps"] as const,
  attempts: (ws: string, meeting: string, operation: string, step: string) => [...cockpitDirectoryKeys.operation(ws, meeting, operation), "attempts", step] as const,
  attempt: (ws: string, meeting: string, operation: string, step: string, attempt: string) => [...cockpitDirectoryKeys.attempts(ws, meeting, operation, step), "attempt", attempt] as const,
};
function bounded(query: CockpitMeetingDirectoryPageQuery) {
  const size = query.page_size ?? 25;
  return { cursor: query.cursor || undefined, page_size: Number.isInteger(size) ? Math.min(100, Math.max(1, size)) : 25 };
}
export function cockpitDirectoryRootsOptions(ws: string, params: CockpitMeetingDirectoryPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitDirectoryKeys.roots(ws), query], queryFn: ({ signal }) => api.getCockpitDirectoryRoots(ws, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws), retry: false });
}
export function cockpitDirectoryRootOptions(ws: string, root: string) {
  return queryOptions({ queryKey: cockpitDirectoryKeys.root(ws, root), queryFn: ({ signal }) => api.getCockpitDirectoryRoot(ws, root, signal).then(requireCockpitReadResult), enabled: Boolean(ws && root), retry: false });
}
export function cockpitDirectorySummaryOptions(ws: string, meeting: string) {
  return queryOptions({ queryKey: cockpitDirectoryKeys.summary(ws, meeting), queryFn: ({ signal }) => api.getCockpitMeetingDirectorySummary(ws, meeting, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting), retry: false });
}
export function cockpitDirectoryOperationsOptions(ws: string, meeting: string, params: CockpitMeetingDirectoryPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitDirectoryKeys.operations(ws, meeting), query], queryFn: ({ signal }) => api.getCockpitDirectoryOperations(ws, meeting, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting), retry: false });
}
export function cockpitDirectoryOperationOptions(ws: string, meeting: string, operation: string) {
  return queryOptions({ queryKey: cockpitDirectoryKeys.operation(ws, meeting, operation), queryFn: ({ signal }) => api.getCockpitDirectoryOperation(ws, meeting, operation, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && operation), retry: false });
}
export function cockpitDirectoryStepsOptions(ws: string, meeting: string, operation: string) {
  return queryOptions({ queryKey: cockpitDirectoryKeys.steps(ws, meeting, operation), queryFn: ({ signal }) => api.getCockpitDirectorySteps(ws, meeting, operation, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && operation), retry: false });
}
export function cockpitDirectoryAttemptsOptions(ws: string, meeting: string, operation: string, step: string, params: CockpitMeetingDirectoryPageQuery = {}) {
  const query = bounded(params);
  return queryOptions({ queryKey: [...cockpitDirectoryKeys.attempts(ws, meeting, operation, step), query], queryFn: ({ signal }) => api.getCockpitDirectoryAttempts(ws, meeting, operation, step, query, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && operation && step), retry: false });
}
export function cockpitDirectoryAttemptOptions(ws: string, meeting: string, operation: string, step: string, attempt: string) {
  return queryOptions({ queryKey: cockpitDirectoryKeys.attempt(ws, meeting, operation, step, attempt), queryFn: ({ signal }) => api.getCockpitDirectoryAttempt(ws, meeting, operation, step, attempt, signal).then(requireCockpitReadResult), enabled: Boolean(ws && meeting && operation && step && attempt), retry: false });
}

/** Cancel in-flight reads before refetching current progress, including first-load races. */
export async function invalidateCockpitDirectoryProjections(client: QueryClient, ws: string, meeting?: string) {
  const filters = { queryKey: meeting ? cockpitDirectoryKeys.meeting(ws, meeting) : cockpitDirectoryKeys.all(ws) };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
export async function invalidateCockpitMeetingDirectoryFacts(client: QueryClient, ws: string, meeting?: string) {
  const reads = { queryKey: cockpitReadKeys.all(ws) };
  await client.cancelQueries(reads);
  await Promise.all([
    invalidateCockpitDirectoryProjections(client, ws, meeting), invalidateCockpitMeetingLifecycle(client, ws, meeting),
    client.invalidateQueries(reads), client.invalidateQueries({ queryKey: cockpitKeys.dashboard(ws) }),
    meeting ? client.invalidateQueries({ queryKey: cockpitKeys.workflow(ws, meeting) }) : Promise.resolve(),
  ]);
}
