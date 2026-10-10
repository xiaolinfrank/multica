"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CockpitArtifactCreate, CockpitArtifactEdit, CockpitArtifactHeader, CockpitArtifactSubmit, CockpitArtifactReview,
  CockpitArtifactVersionCommandResponse, CockpitAcceptanceCriteriaUpdate, CockpitAcceptanceRequestCreate,
  CockpitAcceptanceRequestDetail,
} from "../types";
import { issueKeys } from "../issues/queries";
import { cockpitKeys, invalidateCockpitTaskFlow } from "./queries";
import { cockpitArtifactKeys } from "./artifact-queries";
import { CockpitUnconfirmedWriteError } from "./errors";
import { invalidateCockpitMeetingLifecycle } from "./meeting-lifecycle-queries";

export function invalidateCockpitArtifactFacts(client: QueryClient, wsId: string) {
  invalidateCockpitMeetingLifecycle(client, wsId);
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.all(wsId) });
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.acceptances(wsId) });
  void client.invalidateQueries({ queryKey: cockpitKeys.dashboard(wsId) });
  void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  void client.invalidateQueries({ queryKey: cockpitArtifactKeys.issueContexts(wsId) });
  invalidateCockpitTaskFlow(client, wsId);
}

function headerMatches(value: CockpitArtifactHeader | null, wsId: string, artifactId?: string): value is CockpitArtifactHeader {
  return Boolean(value?.id && value.workspace_id === wsId && (!artifactId || value.id === artifactId));
}
function versionMatches(value: CockpitArtifactVersionCommandResponse | null, wsId: string, artifactId: string, versionId?: string): value is CockpitArtifactVersionCommandResponse {
  return Boolean(value && value.workspace_id === wsId && headerMatches(value.artifact, wsId, artifactId)
    && value.version.workspace_id === wsId && value.version.artifact_id === artifactId && value.version.version.artifact_id === artifactId
    && value.version.version.id && (!versionId || value.version.version.id === versionId));
}
function requestMatches(value: CockpitAcceptanceRequestDetail | null, wsId: string, nodeId: string, requestId?: string): value is CockpitAcceptanceRequestDetail {
  return Boolean(value && value.workspace_id === wsId && value.node_id === nodeId && value.request.node_id === nodeId
    && value.request.id && (!requestId || value.request.id === requestId));
}

export function useCreateCockpitArtifact(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async (body: CockpitArtifactCreate) => {
    const result = await api.createCockpitArtifact(wsId, body);
    // A replay may follow a later rename or review handover; its stable creation identity is authoritative.
    if (!headerMatches(result, wsId) || result.creation_key !== body.creation_key || result.node_id !== body.node_id || result.source_issue.id !== body.source_issue_id) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useUpdateCockpitArtifact(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ artifactId, body }: { artifactId: string; body: CockpitArtifactEdit }) => {
    const result = await api.updateCockpitArtifact(wsId, artifactId, body);
    if (!headerMatches(result, wsId, artifactId) || result.revision < body.expected_revision || result.title !== body.title.trim() || result.description !== body.description.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useSubmitCockpitArtifactVersion(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ artifactId, body }: { artifactId: string; body: CockpitArtifactSubmit }) => {
    const result = await api.submitCockpitArtifactVersion(wsId, artifactId, body);
    if (!versionMatches(result, wsId, artifactId) || result.version.version.submission_key !== body.submission_key || result.version.version.payload_kind !== body.payload.kind
      || result.version.version.producer_issue_id !== body.producer_issue_id || result.version.version.source_meeting_id !== (body.source_meeting_id || null)
      || result.version.version.source_minutes_version_id !== (body.source_minutes_version_id || null)) throw new CockpitUnconfirmedWriteError();
    if (body.payload.kind === "text" ? result.version.content !== body.payload.content || !result.version.version.content_hash || result.version.version.capture_status !== "ready"
      : result.version.version.source_attachment_id !== body.payload.attachment_id || !["queued", "running", "retry_wait", "ready", "needs_attention"].includes(result.version.version.capture_status)) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useReviewCockpitArtifactVersion(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ artifactId, versionId, body }: { artifactId: string; versionId: string; body: CockpitArtifactReview }) => {
    const result = await api.reviewCockpitArtifactVersion(wsId, artifactId, versionId, body);
    if (!versionMatches(result, wsId, artifactId, versionId) || result.version.version.revision < body.expected_revision || result.version.version.decision !== body.decision
      || !result.version.version.reviewed_at || result.version.feedback !== body.feedback.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useRetryCockpitArtifactCapture(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ artifactId, versionId, body }: { artifactId: string; versionId: string; body: { expected_revision: number } }) => {
    const result = await api.retryCockpitArtifactCapture(wsId, artifactId, versionId, body);
    if (!versionMatches(result, wsId, artifactId, versionId) || result.version.version.revision < body.expected_revision || !["queued", "running", "ready"].includes(result.version.version.capture_status)) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useSaveCockpitAcceptanceCriteria(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ nodeId, body }: { nodeId: string; body: CockpitAcceptanceCriteriaUpdate }) => {
    const result = await api.saveCockpitAcceptanceCriteria(wsId, nodeId, body);
    if (!result || result.workspace_id !== wsId || result.node_id !== nodeId || result.revision < body.expected_revision || result.items.length !== body.criteria.length
      || result.items.some((entry, index) => entry.id !== body.criteria[index]?.id || entry.title !== body.criteria[index]?.title.trim() || entry.description !== body.criteria[index]?.description.trim())) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useCreateCockpitAcceptanceRequest(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ nodeId, body }: { nodeId: string; body: CockpitAcceptanceRequestCreate }) => {
    const result = await api.createCockpitAcceptanceRequest(wsId, nodeId, body);
    if (!requestMatches(result, wsId, nodeId) || result.request.request_key !== body.request_key || result.request.criteria_revision !== body.expected_criteria_revision
      || result.request.supersedes_request_id !== (body.supersedes_request_id || null) || result.note !== body.note.trim() || result.evidence.length !== body.evidence.length || result.evidence.some((entry) => {
        const expected = body.evidence.find((item) => item.criterion_id === entry.criterion.id);
        const actual = entry.versions.map((version) => version.id).sort();
        return !expected || actual.join("\n") !== [...expected.version_ids].sort().join("\n");
      })) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useReviewCockpitAcceptanceRequest(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ nodeId, requestId, body }: { nodeId: string; requestId: string; body: CockpitArtifactReview }) => {
    const result = await api.reviewCockpitAcceptanceRequest(wsId, nodeId, requestId, body);
    if (!requestMatches(result, wsId, nodeId, requestId) || result.request.revision < body.expected_revision || result.request.decision !== body.decision
      || !result.request.reviewed_at || result.feedback !== body.feedback.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  }, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
