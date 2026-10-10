import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitWorkflowExportQuery, CockpitWorkflowHistoryQuery } from "../types";
import { cockpitKeys } from "./queries";

export function cockpitMinutesVersionsOptions(wsId: string, meetingId: string, query: CockpitWorkflowHistoryQuery) {
  return queryOptions({ queryKey: [...cockpitKeys.workflowHistory(wsId, meetingId), "versions", query],
    queryFn: ({ signal }) => api.getCockpitMinutesVersions(wsId, meetingId, query, signal), enabled: Boolean(wsId && meetingId) });
}
export function cockpitReviewerHandoffsOptions(wsId: string, meetingId: string, query: CockpitWorkflowHistoryQuery) {
  return queryOptions({ queryKey: [...cockpitKeys.workflowHistory(wsId, meetingId), "handoffs", query],
    queryFn: ({ signal }) => api.getCockpitReviewerHandoffs(wsId, meetingId, query, signal), enabled: Boolean(wsId && meetingId) });
}
export function cockpitNasExportsOptions(wsId: string, meetingId: string, query: CockpitWorkflowExportQuery) {
  return queryOptions({ queryKey: [...cockpitKeys.workflowHistory(wsId, meetingId), "exports", query],
    queryFn: ({ signal }) => api.getCockpitNasExports(wsId, meetingId, query, signal), enabled: Boolean(wsId && meetingId) });
}
export function cockpitMinutesVersionOptions(wsId: string, meetingId: string, versionId: string) {
  return queryOptions({ queryKey: [...cockpitKeys.workflowHistory(wsId, meetingId), "version", versionId],
    queryFn: ({ signal }) => api.getCockpitMinutesVersion(wsId, meetingId, versionId, signal), enabled: Boolean(wsId && meetingId && versionId) });
}
