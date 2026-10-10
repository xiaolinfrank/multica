import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";
import type { CockpitIssueReferenceQuery } from "../types/cockpit-issue-references";

export function cockpitIssueNodeReferencesOptions(wsId: string, issueId: string, query: CockpitIssueReferenceQuery = {}) {
  return queryOptions({ queryKey: [...cockpitKeys.surfaces(wsId), "issue-node-references", issueId, query],
    queryFn: ({ signal }) => api.getCockpitIssueNodeReferences(wsId, issueId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && issueId) });
}
export function cockpitIssueMeetingReferencesOptions(wsId: string, issueId: string, query: CockpitIssueReferenceQuery = {}) {
  return queryOptions({ queryKey: [...cockpitKeys.surfaces(wsId), "issue-meeting-references", issueId, query],
    queryFn: ({ signal }) => api.getCockpitIssueMeetingReferences(wsId, issueId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && issueId) });
}
