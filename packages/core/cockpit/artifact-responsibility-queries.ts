import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitArtifactPageQuery, CockpitArtifactReferenceKind } from "../types";
import { cockpitArtifactKeys } from "./artifact-queries";
import { requireCockpitReadResult } from "./errors";

const page = (query: CockpitArtifactPageQuery) => {
  const size = query.page_size ?? 25;
  return { ...query, page_size: Number.isInteger(size) ? Math.max(1, Math.min(100, size)) : 25, cursor: query.cursor || undefined };
};
export function cockpitIssueArtifactsOptions(wsId: string, issueId: string, params: CockpitArtifactPageQuery = {}) {
  const query = page(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.issueContexts(wsId), issueId, query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitIssueArtifacts(wsId, issueId, query, signal)), enabled: Boolean(wsId && issueId) });
}
export function cockpitMeetingArtifactReferencesOptions(wsId: string, meetingId: string, params: CockpitArtifactPageQuery & { include_removed?: boolean } = {}) {
  const query = { ...page(params), include_removed: params.include_removed ?? false };
  return queryOptions({ queryKey: [...cockpitArtifactKeys.meetingReferences(wsId, meetingId), query],
    queryFn: ({ signal }) => api.getCockpitMeetingArtifactReferences(wsId, meetingId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && meetingId) });
}
export function cockpitArtifactProducerHistoryOptions(wsId: string, artifactId: string, params: CockpitArtifactPageQuery = {}) {
  const query = page(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.producerHistory(wsId, artifactId), query],
    queryFn: ({ signal }) => api.getCockpitArtifactProducerHistory(wsId, artifactId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && artifactId) });
}
export function cockpitArtifactReviewerHandoffsOptions(wsId: string, artifactId: string, params: CockpitArtifactPageQuery = {}) {
  const query = page(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.reviewerHandoffs(wsId, artifactId), query],
    queryFn: ({ signal }) => api.getCockpitArtifactReviewerHandoffs(wsId, artifactId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && artifactId) });
}
export function cockpitArtifactReferencesOptions(wsId: string, artifactId: string, kind: CockpitArtifactReferenceKind, params: CockpitArtifactPageQuery = {}) {
  const query = page(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.references(wsId, artifactId, kind), query],
    queryFn: ({ signal }) => api.getCockpitArtifactReferences(wsId, artifactId, kind, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && artifactId) });
}
export function cockpitAcceptanceReviewerHandoffsOptions(wsId: string, nodeId: string, params: CockpitArtifactPageQuery = {}) {
  const query = page(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.acceptanceHandoffs(wsId, nodeId), query],
    queryFn: ({ signal }) => api.getCockpitAcceptanceReviewerHandoffs(wsId, nodeId, query, signal).then(requireCockpitReadResult), enabled: Boolean(wsId && nodeId) });
}
