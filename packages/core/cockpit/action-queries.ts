import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitActionQuery, CockpitTaskQuery } from "../types";
import { cockpitKeys } from "./queries";

export const COCKPIT_TASK_PAGE_SIZE = 25;

export function cockpitIssueActionSourcesOptions(wsId: string, issueId: string, cursor?: string) {
  return queryOptions({ queryKey: [...cockpitKeys.issueActionSources(wsId, issueId), cursor ?? ""],
    queryFn: ({ signal }) => api.getCockpitIssueActionSources(issueId, cursor, signal), enabled: Boolean(wsId && issueId) });
}

export function cockpitNodeTasksOptions(wsId: string, nodeId: string, params: CockpitTaskQuery) {
  const query = { page_size: COCKPIT_TASK_PAGE_SIZE, relation: "primary" as const, ...params };
  return queryOptions({ queryKey: [...cockpitKeys.nodeTasks(wsId, nodeId), query],
    queryFn: ({ signal }) => api.getCockpitNodeTasks(nodeId, query, signal), enabled: Boolean(wsId && nodeId) });
}

export function cockpitMeetingActionsOptions(wsId: string, meetingId: string, params: CockpitActionQuery) {
  const query = { page_size: COCKPIT_TASK_PAGE_SIZE, ...params };
  return queryOptions({ queryKey: [...cockpitKeys.meetingActionPages(wsId, meetingId), query],
    queryFn: ({ signal }) => api.listCockpitMeetingActions(meetingId, query, signal), enabled: Boolean(wsId && meetingId) });
}

export function cockpitMeetingActionOptions(wsId: string, meetingId: string, actionId: string) {
  return queryOptions({ queryKey: cockpitKeys.meetingAction(wsId, meetingId, actionId),
    queryFn: ({ signal }) => api.getCockpitMeetingAction(meetingId, actionId, signal), enabled: Boolean(wsId && meetingId && actionId) });
}

export function cockpitPrimaryNodeOptions(wsId: string, issueId: string) {
  return queryOptions({ queryKey: cockpitKeys.primaryNode(wsId, issueId),
    queryFn: ({ signal }) => api.getCockpitPrimaryNode(issueId, signal), enabled: Boolean(wsId && issueId) });
}

export function cockpitActionIssueSearchOptions(wsId: string, q: string, offset: number) {
  return queryOptions({ queryKey: cockpitKeys.actionIssueSearch(wsId, q, offset),
    queryFn: ({ signal }) => api.searchIssues({ q, offset, limit: COCKPIT_TASK_PAGE_SIZE, include_closed: true, signal }),
    enabled: Boolean(wsId && q.trim()) });
}
