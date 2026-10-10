import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitArtifactHeader, CockpitArtifactPageQuery, CockpitArtifactQuery, CockpitArtifactVersionMetadata, CockpitArtifactSourceAttachmentQuery } from "../types";
import { cockpitKeys } from "./queries";
import { requireCockpitReadResult } from "./errors";

export const COCKPIT_ARTIFACT_PAGE_SIZE = 25;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function mentionsIssue(value: unknown, issueId: string): boolean {
  const row = object(value);
  if (!row) return false;
  if (["source_issue", "producer_issue", "review_issue"].some((field) => object(row[field])?.id === issueId)) return true;
  if (["current_version", "approved_version", "version", "current_request", "last_approved_request", "request"].some((field) => object(object(row[field])?.review_issue)?.id === issueId)) return true;
  if (row.from_issue_id === issueId || row.to_issue_id === issueId) return true;
  return Array.isArray(row.items) && row.items.some((item) => mentionsIssue(item, issueId));
}

/** An unrelated Issue update must not restart expensive fixed-content probes. */
export function invalidateCockpitArtifactIssueFacts(client: QueryClient, wsId: string, issueId: string) {
  for (const prefix of [cockpitArtifactKeys.all(wsId), cockpitArtifactKeys.acceptances(wsId)]) {
    void client.invalidateQueries({ queryKey: prefix, predicate: (query) => mentionsIssue(query.state.data, issueId) });
  }
  void client.invalidateQueries({ queryKey: [...cockpitArtifactKeys.issueContexts(wsId), issueId] });
}

export function invalidateCockpitArtifactLabels(client: QueryClient, wsId: string) {
  void client.invalidateQueries({
    queryKey: cockpitArtifactKeys.all(wsId),
    predicate: (query) => query.queryKey[3] === "pages" || query.queryKey[3] === "meeting-references"
      || (query.queryKey[3] === "artifact" && (query.queryKey.length === 5 || query.queryKey[5] === "references" || query.queryKey[5] === "evidence-context")),
  });
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.issueContexts(wsId) });
}

export function invalidateCockpitArtifactEvent(client: QueryClient, wsId: string, scope: "artifacts" | "acceptance", entity: unknown) {
  const row = object(entity);
  const candidate = scope === "artifacts" ? row?.artifact_id ?? row?.id : row?.node_id ?? row?.id;
  const id = typeof candidate === "string" && candidate ? candidate : undefined;
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.pages(wsId) });
  if (scope === "artifacts") {
    void client.invalidateQueries({ queryKey: typeof id === "string" ? cockpitArtifactKeys.artifact(wsId, id) : cockpitArtifactKeys.all(wsId) });
    void client.invalidateQueries({ queryKey: [...cockpitArtifactKeys.all(wsId), "meeting-references"] });
    void client.invalidateQueries({
      queryKey: cockpitArtifactKeys.acceptances(wsId),
      predicate: (query) => {
        if (query.queryKey[4] !== "request" || typeof id !== "string") return true;
        const evidence = object(query.state.data)?.evidence;
        return Array.isArray(evidence) && evidence.some((entry) => {
          const versions = object(entry)?.versions;
          return Array.isArray(versions) && versions.some((version) => object(version)?.artifact_id === id);
        });
      },
    });
  } else {
    void client.invalidateQueries({ queryKey: typeof id === "string" ? cockpitArtifactKeys.acceptance(wsId, id) : cockpitArtifactKeys.acceptances(wsId) });
  }
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.issueContexts(wsId) });
}

/** Uploads affect mutable source choices, not frozen content or its verification probe. */
export function invalidateCockpitArtifactSourceAttachments(client: QueryClient, wsId: string, issueId: string) {
  void client.invalidateQueries({
    queryKey: cockpitArtifactKeys.all(wsId),
    predicate: (query) => {
      const key = query.queryKey;
      if (key[3] !== "artifact" || typeof key[4] !== "string") return false;
      if (key[5] === "selected-attachment") return key[6] === issueId;
      if (key[5] !== "source-attachments") return false;
      const header = client.getQueryData<CockpitArtifactHeader>(cockpitArtifactKeys.artifact(wsId, key[4]));
      return !header || header.producer_issue.id === issueId;
    },
  });
}
export const cockpitArtifactKeys = {
  all: (wsId: string) => [...cockpitKeys.all(wsId), "artifacts"] as const,
  pages: (wsId: string) => [...cockpitArtifactKeys.all(wsId), "pages"] as const,
  artifact: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.all(wsId), "artifact", artifactId] as const,
  versions: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "versions"] as const,
  version: (wsId: string, artifactId: string, versionId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "version", versionId] as const,
  sourceAttachments: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "source-attachments"] as const,
  producerHistory: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "producer-history"] as const,
  reviewerHandoffs: (wsId: string, artifactId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "reviewer-handoffs"] as const,
  references: (wsId: string, artifactId: string, kind: "node" | "meeting") => [...cockpitArtifactKeys.artifact(wsId, artifactId), "references", kind] as const,
  issueContexts: (wsId: string) => [...cockpitKeys.all(wsId), "artifact-issue-contexts"] as const,
  meetingReferences: (wsId: string, meetingId: string) => [...cockpitArtifactKeys.all(wsId), "meeting-references", meetingId] as const,
  selectedAttachment: (wsId: string, artifactId: string, sourceIssueId: string, attachmentId: string) => [...cockpitArtifactKeys.artifact(wsId, artifactId), "selected-attachment", sourceIssueId, attachmentId] as const,
  acceptances: (wsId: string) => [...cockpitKeys.all(wsId), "acceptance"] as const,
  acceptance: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptances(wsId), nodeId] as const,
  criteria: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "criteria"] as const,
  acceptanceHandoffs: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "reviewer-handoffs"] as const,
  requests: (wsId: string, nodeId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "requests"] as const,
  request: (wsId: string, nodeId: string, requestId: string) => [...cockpitArtifactKeys.acceptance(wsId, nodeId), "request", requestId] as const,
};

function boundedPage(query: CockpitArtifactPageQuery) {
  const size = query.page_size ?? COCKPIT_ARTIFACT_PAGE_SIZE;
  return { ...query, page_size: Number.isInteger(size) ? Math.max(1, Math.min(100, size)) : COCKPIT_ARTIFACT_PAGE_SIZE, cursor: query.cursor || undefined };
}

export function cockpitArtifactsOptions(wsId: string, params: CockpitArtifactQuery = {}) {
  const query = { ...params, ...boundedPage(params), q: params.q?.trim() || undefined, ...(params.ids ? { ids: [...new Set(params.ids)].sort() } : {}) };
  return queryOptions({ queryKey: [...cockpitArtifactKeys.pages(wsId), query],
    queryFn: async ({ signal }) => requireCockpitReadResult(await api.getCockpitArtifacts(wsId, query, signal)), enabled: Boolean(wsId) });
}
export function cockpitArtifactOptions(wsId: string, artifactId: string, nodeId?: string) {
  return queryOptions({ queryKey: nodeId ? [...cockpitArtifactKeys.artifact(wsId, artifactId), "evidence-context", nodeId] : cockpitArtifactKeys.artifact(wsId, artifactId),
    queryFn: async ({ signal }) => requireCockpitReadResult(await (nodeId ? api.getCockpitArtifact(wsId, artifactId, signal, nodeId) : api.getCockpitArtifact(wsId, artifactId, signal))), enabled: Boolean(wsId && artifactId) });
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
