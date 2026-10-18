import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "./queries";
import type { CockpitAttentionQuery, CockpitOverviewPageQuery, CockpitOverviewQuery } from "../types";

export const cockpitDashboardKeys = {
  all: (wsId: string) => cockpitKeys.dashboard(wsId),
  projectSearch: (wsId: string, q: string, offset: number) => [...cockpitDashboardKeys.all(wsId), "project-search", q, offset] as const,
  overview: (wsId: string, query: CockpitOverviewQuery) => [...cockpitDashboardKeys.all(wsId), "overview", query] as const,
  attention: (wsId: string, query: CockpitAttentionQuery) => [...cockpitDashboardKeys.all(wsId), "attention", query] as const,
  execution: (wsId: string, query: CockpitOverviewPageQuery) => [...cockpitDashboardKeys.all(wsId), "execution", query] as const,
  meetings: (wsId: string, query: CockpitOverviewPageQuery & { days?: number }) => [...cockpitDashboardKeys.all(wsId), "meetings", query] as const,
};

export const COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE = 20;
export const COCKPIT_OVERVIEW_ATTENTION_SIZE = 8;
export const COCKPIT_OVERVIEW_SECTION_SIZE = 6;
export const COCKPIT_OVERVIEW_QUEUE_SIZE = 25;

export function cockpitWorkOverviewOptions(wsId: string, query: CockpitOverviewQuery) {
  return queryOptions({ queryKey: cockpitDashboardKeys.overview(wsId, query), queryFn: ({ signal }) => api.getCockpitWorkOverview(wsId, query, signal),
    enabled: Boolean(wsId && query.as_of), staleTime: 15_000 });
}

export function cockpitOverviewAttentionOptions(wsId: string, query: CockpitAttentionQuery) {
  return queryOptions({ queryKey: cockpitDashboardKeys.attention(wsId, query), queryFn: ({ signal }) => api.getCockpitOverviewAttention(wsId, query, signal),
    enabled: Boolean(wsId && query.as_of), staleTime: 15_000 });
}

export function cockpitOverviewExecutionOptions(wsId: string, query: CockpitOverviewPageQuery) {
  return queryOptions({ queryKey: cockpitDashboardKeys.execution(wsId, query), queryFn: ({ signal }) => api.getCockpitOverviewExecution(wsId, query, signal),
    enabled: Boolean(wsId && query.as_of), staleTime: 15_000 });
}

export function cockpitOverviewMeetingsOptions(wsId: string, query: CockpitOverviewPageQuery & { days?: number }) {
  return queryOptions({ queryKey: cockpitDashboardKeys.meetings(wsId, query), queryFn: ({ signal }) => api.getCockpitOverviewMeetings(wsId, query, signal),
    enabled: Boolean(wsId && query.as_of), staleTime: 15_000 });
}

export function cockpitDashboardProjectsOptions(wsId: string, q: string, offset: number) {
  return queryOptions({
    queryKey: cockpitDashboardKeys.projectSearch(wsId, q, offset),
    queryFn: ({ signal }) => api.searchProjects({ q, offset, limit: COCKPIT_DASHBOARD_PROJECT_PAGE_SIZE, include_closed: true, signal }),
    enabled: Boolean(wsId && q.trim()),
  });
}
