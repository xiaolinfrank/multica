"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";
import type {
  CockpitMeetingWorkflow, CockpitMeetingWorkflowSetup, CockpitMeetingReadinessPatch,
  CockpitMinutesSubmission, CockpitMinutesReview,
  CockpitReviewerHandoffCommand,
  CockpitNasDestination, CockpitNasExport,
} from "../types";
import { cockpitKeys, patchCockpitBoard } from "./queries";
import { mergeCockpitWorkflowResponse } from "./nas-export";

function useWorkflowMutation<T extends { meetingId: string }>(wsId: string, mutationFn: (variables: T) => Promise<CockpitMeetingWorkflow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async (workflow) => {
      // An initialization read may still be returning enabled=false after the write committed.
      await client.cancelQueries({ queryKey: cockpitKeys.workflow(wsId, workflow.meeting_id), exact: true });
      client.setQueryData<CockpitMeetingWorkflow>(cockpitKeys.workflow(wsId, workflow.meeting_id), (current) =>
        mergeCockpitWorkflowResponse(current, workflow));
      patchCockpitBoard(client, wsId, (board) => ({ ...board, has_meeting_workflows: true }));
      void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, workflow.meeting_id), exact: true });
      void client.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
      void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
    onError: (_error, variables) => {
      // A lost response is not proof that a business command was rolled back.
      void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, variables.meetingId) });
    },
  });
}

export function useEnableCockpitMeetingWorkflow(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMeetingWorkflowSetup }) =>
    api.enableCockpitMeetingWorkflow(meetingId, body));
}

export function useReassignCockpitMeetingReviewer(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitReviewerHandoffCommand }) =>
    api.reassignCockpitMeetingReviewer(meetingId, body));
}

export function useUpdateCockpitMeetingReadiness(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMeetingReadinessPatch }) =>
    api.updateCockpitMeetingReadiness(meetingId, body));
}

export function useReleaseCockpitMeetingWorkflow(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, revision }: { meetingId: string; revision: number }) =>
    api.releaseCockpitMeetingWorkflow(meetingId, revision));
}

export function useSubmitCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, body }: { meetingId: string; body: CockpitMinutesSubmission }) =>
    api.submitCockpitMinutesVersion(meetingId, body));
}

export function useReviewCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, body }: { meetingId: string; versionId: string; body: CockpitMinutesReview }) =>
    api.reviewCockpitMinutesVersion(meetingId, versionId, body));
}

export function usePublishCockpitMinutesVersion(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, revision, nasExport }: { meetingId: string; versionId: string; revision: number; nasExport?: CockpitNasDestination }) =>
    api.publishCockpitMinutesVersion(meetingId, versionId, revision, nasExport));
}

export function useExportCockpitMinutesToNas(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, versionId, destination }: { meetingId: string; versionId: string; destination: CockpitNasDestination }) =>
    api.exportCockpitMinutesToNas(meetingId, versionId, destination));
}

export function useRetryCockpitNasExport(wsId: string) {
  return useWorkflowMutation(wsId, ({ meetingId, operation }: { meetingId: string; operation: CockpitNasExport }) =>
    api.retryCockpitNasExport(meetingId, operation));
}
