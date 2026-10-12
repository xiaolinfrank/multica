"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";
import type {
  CockpitMeetingWorkflowSummary, CockpitWorkflowCommandResponse, CockpitMeetingWorkflowSetup, CockpitMeetingReadinessPatch,
  CockpitMinutesSubmission, CockpitMinutesReview,
  CockpitReviewerHandoffCommand,
  CockpitNasDestination, CockpitWorkflowNasExport,
} from "../types";
import { cockpitKeys, patchCockpitBoard } from "./queries";
import { mergeCockpitWorkflowSummary } from "./workflow-history";

function useWorkflowMutation<T extends { meetingId: string }>(wsId: string, mutationFn: (variables: T) => Promise<CockpitWorkflowCommandResponse>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (result) => {
      const workflow = result.workflow;
      void client.invalidateQueries({ queryKey: cockpitKeys.dashboard(wsId) });
      // An initialization read may still be returning enabled=false after the write committed.
      await client.cancelQueries({ queryKey: cockpitKeys.workflow(wsId, workflow.meeting_id), exact: true });
      client.setQueryData<CockpitMeetingWorkflowSummary>(cockpitKeys.workflow(wsId, workflow.meeting_id), (current) =>
        mergeCockpitWorkflowSummary(current, workflow));
      patchCockpitBoard(client, wsId, (board) => ({ ...board, has_meeting_workflows: true }));
      void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, workflow.meeting_id), exact: true });
      void client.invalidateQueries({ queryKey: cockpitKeys.workflowHistory(wsId, workflow.meeting_id) });
      void client.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
      void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
    onError: (_error, variables) => {
      void client.invalidateQueries({ queryKey: cockpitKeys.dashboard(wsId) });
      // A lost response is not proof that a business command was rolled back.
      void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, variables.meetingId) });
      void client.invalidateQueries({ queryKey: cockpitKeys.workflowHistory(wsId, variables.meetingId) });
    },
  });
}

export function useEnableCockpitMeetingWorkflow(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMeetingWorkflowSetup }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "enabled", body }));
}

export function useBindCockpitMinutesIssue(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, issueId, revision }: { meetingId: string; issueId: string; revision: number }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "bound", body: { issue_id: issueId, expected_revision: revision } }));
}

export function useUnbindCockpitMinutesIssue(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, issueId, revision }: { meetingId: string; issueId: string; revision: number }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "unbound", issue_id: issueId, expected_revision: revision }));
}

export function useFocusCockpitMinutesIssue(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, issueId, revision }: { meetingId: string; issueId: string; revision: number }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "focused", body: { issue_id: issueId, expected_revision: revision } }));
}

export function useReassignCockpitMeetingReviewer(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitReviewerHandoffCommand }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "reviewer_reassigned", body }));
}

export function useUpdateCockpitMeetingReadiness(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMeetingReadinessPatch }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "readiness", body }));
}

export function useReleaseCockpitMeetingWorkflow(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, revision }: { meetingId: string; revision: number }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "released", body: { expected_revision: revision } }));
}

export function useSubmitCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMinutesSubmission }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "submitted", body }));
}

export function useReviewCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, body }: { meetingId: string; versionId: string; body: CockpitMinutesReview }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "reviewed", version_id: versionId, body }));
}

export function usePublishCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, revision, nasExport }: { meetingId: string; versionId: string; revision: number; nasExport?: CockpitNasDestination }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "published", version_id: versionId, body: { expected_revision: revision, ...(nasExport ? { nas_export: nasExport } : {}) } }));
}

export function useExportCockpitMinutesToNas(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, destination }: { meetingId: string; versionId: string; destination: CockpitNasDestination }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "nas_export_queued", version_id: versionId, body: destination }));
}

export function useRetryCockpitNasExport(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, operation }: { meetingId: string; operation: CockpitWorkflowNasExport }) =>
    api.commandCockpitMeetingWorkflow(wsId, meetingId, { action: "nas_export_retried", operation }));
}
