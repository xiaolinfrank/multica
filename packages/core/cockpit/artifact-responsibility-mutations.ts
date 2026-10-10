"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { CockpitArtifactProducerCommand, CockpitArtifactReviewerCommand, CockpitArtifactReferenceKind, CockpitArtifactNodeReferenceCreate, CockpitArtifactMeetingReferenceCreate } from "../types";
import { invalidateCockpitArtifactFacts } from "./artifact-mutations";
import { CockpitUnconfirmedWriteError } from "./errors";

function useArtifactCommand<V, R>(wsId: string, mutationFn: (variables: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => invalidateCockpitArtifactFacts(client, wsId) });
}
export function useAssignCockpitArtifactProducer(wsId: string) {
  return useArtifactCommand(wsId, async ({ artifactId, body }: { artifactId: string; body: CockpitArtifactProducerCommand }) => {
    const result = await api.assignCockpitArtifactProducer(wsId, artifactId, body);
    if (!result || result.workspace_id !== wsId || result.artifact.id !== artifactId || result.assignment.artifact_id !== artifactId
      || result.assignment.command_key !== body.command_key || result.assignment.to_issue_id !== result.to_issue.id || (body.issue_id !== undefined && result.assignment.to_issue_id !== body.issue_id)
      || result.assignment.reason !== body.reason.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useReassignCockpitArtifactReviewer(wsId: string) {
  return useArtifactCommand(wsId, async ({ artifactId, body }: { artifactId: string; body: CockpitArtifactReviewerCommand }) => {
    const result = await api.reassignCockpitArtifactReviewer(wsId, artifactId, body);
    if (!result || result.workspace_id !== wsId || result.artifact.id !== artifactId || result.handoff.artifact_id !== artifactId
      || result.handoff.handoff_key !== body.handoff_key || result.handoff.to_reviewer_id !== body.reviewer_id || result.handoff.reason !== body.reason.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useArchiveCockpitArtifact(wsId: string) {
  return useArtifactCommand(wsId, async ({ artifactId, archived, expectedRevision }: { artifactId: string; archived: boolean; expectedRevision: number }) => {
    const result = await api.setCockpitArtifactArchived(wsId, artifactId, archived, expectedRevision);
    if (!result || result.workspace_id !== wsId || result.id !== artifactId || result.revision < expectedRevision || Boolean(result.archived_at) !== archived) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useCreateCockpitArtifactReference(wsId: string) {
  return useArtifactCommand(wsId, async ({ artifactId, kind, body }: { artifactId: string; kind: CockpitArtifactReferenceKind; body: CockpitArtifactNodeReferenceCreate | CockpitArtifactMeetingReferenceCreate }) => {
    const result = await api.createCockpitArtifactReference(wsId, artifactId, kind, body);
    if (!result || result.workspace_id !== wsId || result.reference.artifact_id !== artifactId || result.reference.reference_key !== body.reference_key
      || result.reference.version_id !== body.version_id || result.reference.purpose !== body.purpose
      || (kind === "node" ? !("node_id" in body) || result.reference.node_id !== body.node_id : !("meeting_id" in body) || result.reference.meeting_id !== body.meeting_id)) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useRemoveCockpitArtifactReference(wsId: string) {
  return useArtifactCommand(wsId, async ({ artifactId, kind, referenceId }: { artifactId: string; kind: CockpitArtifactReferenceKind; referenceId: string }) => {
    const result = await api.removeCockpitArtifactReference(wsId, artifactId, kind, referenceId);
    if (!result || result.workspace_id !== wsId || result.reference.artifact_id !== artifactId || result.reference.id !== referenceId || !result.reference.removed_at) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useReassignCockpitAcceptanceReviewer(wsId: string) {
  return useArtifactCommand(wsId, async ({ nodeId, requestId, body }: { nodeId: string; requestId: string; body: CockpitArtifactReviewerCommand }) => {
    const result = await api.reassignCockpitAcceptanceReviewer(wsId, nodeId, requestId, body);
    if (!result || result.workspace_id !== wsId || result.acceptance.node_id !== nodeId || result.request.request.id !== requestId || result.handoff.node_id !== nodeId
      || result.handoff.request_id !== requestId || result.handoff.handoff_key !== body.handoff_key || result.handoff.to_reviewer_id !== body.reviewer_id
      || result.handoff.reason !== body.reason.trim()) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
