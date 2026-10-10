import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitArtifactPageQuery, CockpitArtifactQuery, CockpitArtifactVersionMetadata, CockpitArtifactSourceAttachmentQuery } from "../types";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const COCKPIT_ARTIFACT_PAGE_SIZE = 25;
export const cockpitArtifactKeys = {
  all: (wsId: string) => [...cockpitKeys.all(wsId), "artifacts"] as const,
  pages: (wsId: string) => [...cockpitArtifactKeys.all(wsId), "pages"] as const,
  artifact: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.all(wsId), "artifact", artifactId] as const,
  versions: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "versions"] as const,
  version: (wsId: string, artifactId: string, versionId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "version", versionId] as const,
  sourceAttachments: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "source-attachments"] as const,
  selectedAttachment: (wsId: string, artifactId: string, sourceIssueId: string, attachmentId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "selected-attachment", sourceIssueId, attachmentId] as const,
  acceptances: (wsId: string) => [...cockpitKeys.all(wsId), "acceptance"] as const,
  acceptance: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptances(wsId), nodeId] as const,
  criteria: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "criteria"] as const,
  requests: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "requests"] as const,
  request: (wsId: string, nodeId: string, requestId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "request", requestId] as const,
};

function boundedPage(query: CockpitArtifactPageQuery) {
  const size = query.page_size ?? COCKPIT_ARTIFACT_PAGE_SIZE;
  return { ...query, page_size: Number.isInteger(size) ? Math.max(1, Math.min(100, size)) : COCKPIT_ARTIFACT_PAGE_SIZE, cursor: query.cursor || undefined };
}

export function cockpitArtifactsOptions(wsId: string, params: CockpitArtifactQuery = {}) {
  const query = { ...params, ...boundedPage(params), q: params.q?.trim() || undefined };
  return queryOptions({ queryKey: [...cockpitArtifactKeys.pages(wsId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifacts(wsId, query, signal)), enabled: Boolean(wsId) });
}
export function cockpitArtifactOptions(wsId: string, artifactId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.artifact(wsId, artifactId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifact(wsId, artifactId, signal)), enabled: Boolean(wsId && artifactId) });
}
export function cockpitArtifactVersionsOptions(wsId: string, artifactId: string, params: CockpitArtifactPageQuery = {}) {
  const query = boundedPage(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.versions(wsId, artifactId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifactVersions(wsId, artifactId, query, signal)), enabled: Boolean(wsId && artifactId) });
}
export function cockpitArtifactVersionOptions(wsId: string, artifactId: string, versionId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.version(wsId, artifactId, versionId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifactVersion(wsId, artifactId, versionId, signal)), enabled: Boolean(wsId && artifactId && versionId) });
}
export function cockpitArtifactSourceAttachmentsOptions(wsId: string, artifactId: string, params: CockpitArtifactSourceAttachmentQuery = {}) {
  const query = { ...boundedPage(params), q: params.q?.trim() || undefined };
  return queryOptions({ queryKey: [...cockpitArtifactKeys.sourceAttachments(wsId, artifactId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifactSourceAttachments(wsId, artifactId, query, signal)), enabled: Boolean(wsId && artifactId) });
}
export function cockpitArtifactSelectedAttachmentOptions(wsId: string, artifactId: string, sourceIssueId: string, attachmentId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.selectedAttachment(wsId, artifactId, sourceIssueId, attachmentId),
    queryFn: async () => {
      const attachment = await api.getAttachment(attachmentId);
      if (attachment.id !== attachmentId || attachment.workspace_id !== wsId || attachment.issue_id !== sourceIssueId
        || !Number.isSafeInteger(attachment.size_bytes) || attachment.size_bytes < 0 || !attachment.filename || !attachment.content_type) {
        throw new Error("The selected attachment is not available in this artifact's source issue.");
      }
      return attachment;
    }, enabled: Boolean(wsId && artifactId && sourceIssueId && attachmentId) });
}
export function cockpitAcceptanceOptions(wsId: string, nodeId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.acceptance(wsId, nodeId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitAcceptance(wsId, nodeId, signal)), enabled: Boolean(wsId && nodeId) });
}
export function cockpitAcceptanceCriteriaOptions(wsId: string, nodeId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.criteria(wsId, nodeId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitAcceptanceCriteria(wsId, nodeId, signal)), enabled: Boolean(wsId && nodeId) });
}
export function cockpitAcceptanceRequestsOptions(wsId: string, nodeId: string, params: CockpitArtifactPageQuery = {}) {
  const query = boundedPage(params);
  return queryOptions({ queryKey: [...cockpitArtifactKeys.requests(wsId, nodeId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitAcceptanceRequests(wsId, nodeId, query, signal)), enabled: Boolean(wsId && nodeId) });
}
export function cockpitAcceptanceRequestOptions(wsId: string, nodeId: string, requestId: string) {
  return queryOptions({ queryKey: cockpitArtifactKeys.request(wsId, nodeId, requestId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitAcceptanceRequest(wsId, nodeId, requestId, signal)), enabled: Boolean(wsId && nodeId && requestId) });
}

/** Ordinary task status or assignee edits cannot create formal review authority. */
export function cockpitArtifactVersionActions(version: CockpitArtifactVersionMetadata | null | undefined, userId: string, readOnly = false) {
  const knownPayload = version?.payload_kind === "text" || version?.payload_kind === "attachment";
  return {
    canReview: Boolean(!readOnly && userId && knownPayload && version?.can_review === true && version.capture_status === "ready"
      && version.content_hash && version.review_issue && version.decision === "pending" && version.reviewer_id === userId),
    canRetryCapture: Boolean(!readOnly && userId && knownPayload && version?.can_retry_capture === true
      && ["retry_wait", "needs_attention"].includes(version.capture_status) && version.decision === "not_requested"),
  };
}
