"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CockpitLifecycleCommandResult, CockpitOccurrenceInput, CockpitMaterialsInput,
} from "../types/cockpit-meeting-lifecycle";
import { cockpitKeys } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { invalidateCockpitMeetingLifecycle } from "./meeting-lifecycle-queries";

/** Both a write response and later receipt recovery reconcile the same projections. */
export function invalidateCockpitMeetingCommandFacts(client: QueryClient, wsId: string, meetingId: string) {
  void invalidateCockpitMeetingLifecycle(client, wsId, meetingId);
  void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, meetingId) });
  void client.invalidateQueries({ queryKey: cockpitKeys.workflowHistory(wsId, meetingId) });
  void client.invalidateQueries({ queryKey: cockpitReadKeys.all(wsId) });
  void client.invalidateQueries({ queryKey: cockpitKeys.dashboard(wsId) });
}

function useMeetingCommand<T>(wsId: string, meetingId: string, action: string, mutationFn: (body: T) => Promise<CockpitLifecycleCommandResult>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-meeting-command", wsId, meetingId, action], mutationFn, retry: false,
    // The retained receipt may predate current state. Re-read active projections
    // after success or uncertainty; never overwrite live data with that receipt.
    onSettled: () => invalidateCockpitMeetingCommandFacts(client, wsId, meetingId),
  });
}
export function useCockpitOccurrence(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "occurrence", (body: CockpitOccurrenceInput) => api.recordCockpitOccurrence(wsId, meetingId, body));
}
export function useCockpitMaterialsConfirmation(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "materials", (body: CockpitMaterialsInput) => api.confirmCockpitMaterials(wsId, meetingId, body));
}
