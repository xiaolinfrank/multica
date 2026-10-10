"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CockpitLifecycleCommandInput, CockpitLifecycleCommandResult, CockpitOccurrenceInput, CockpitMaterialsInput,
  CockpitAgendaInput, CockpitAgendaRemoveInput, CockpitAgendaReferenceInput, CockpitPreparationIssueInput,
} from "../types/cockpit-meeting-lifecycle";
import { issueKeys } from "../issues/queries";
import { graphKeys } from "../graph/queries";
import { cockpitKeys, invalidateCockpitTaskFlow } from "./queries";
import { cockpitReadKeys } from "./read-queries";
import { invalidateCockpitMeetingLifecycle } from "./meeting-lifecycle-queries";

/** Both a write response and later receipt recovery reconcile the same projections. */
export function invalidateCockpitMeetingCommandFacts(client: QueryClient, wsId: string, meetingId: string, action: string) {
  void invalidateCockpitMeetingLifecycle(client, wsId, meetingId);
  void client.invalidateQueries({ queryKey: cockpitKeys.workflow(wsId, meetingId) });
  void client.invalidateQueries({ queryKey: cockpitKeys.workflowHistory(wsId, meetingId) });
  void client.invalidateQueries({ queryKey: cockpitReadKeys.all(wsId) });
  void client.invalidateQueries({ queryKey: cockpitKeys.dashboard(wsId) });
  if (action.startsWith("agenda") || action.startsWith("reference") || action === "preparation_issue_create") {
    invalidateCockpitTaskFlow(client, wsId);
    void client.invalidateQueries({ queryKey: graphKeys.all(wsId) });
  }
  if (action === "preparation_issue_create") void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
}

function useMeetingCommand<T>(wsId: string, meetingId: string, action: string, mutationFn: (body: T) => Promise<CockpitLifecycleCommandResult>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-meeting-command", wsId, meetingId, action], mutationFn, retry: false,
    // The retained receipt may predate current state. Re-read active projections
    // after success or uncertainty; never overwrite live data with that receipt.
    onSettled: () => invalidateCockpitMeetingCommandFacts(client, wsId, meetingId, action),
  });
}
export function useCockpitOccurrence(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "occurrence", (body: CockpitOccurrenceInput) => api.recordCockpitOccurrence(wsId, meetingId, body));
}
export function useCockpitMaterialsConfirmation(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "materials", (body: CockpitMaterialsInput) => api.confirmCockpitMaterials(wsId, meetingId, body));
}
export function useCreateCockpitAgenda(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "agenda_create", (body: CockpitAgendaInput) => api.createCockpitAgenda(wsId, meetingId, body));
}
export function useUpdateCockpitAgenda(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "agenda_update", ({ agendaId, body }: { agendaId: string; body: CockpitAgendaInput }) => api.updateCockpitAgenda(wsId, meetingId, agendaId, body));
}
export function useRemoveCockpitAgenda(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "agenda_remove", ({ agendaId, body }: { agendaId: string; body: CockpitAgendaRemoveInput }) => api.removeCockpitAgenda(wsId, meetingId, agendaId, body));
}
export function useAttachCockpitAgendaReference(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "reference_attach", ({ agendaId, body }: { agendaId: string; body: CockpitAgendaReferenceInput }) => api.attachCockpitAgendaReference(wsId, meetingId, agendaId, body));
}
export function useRemoveCockpitAgendaReference(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "reference_remove", ({ agendaId, referenceId, body }: { agendaId: string; referenceId: string; body: CockpitLifecycleCommandInput }) => api.removeCockpitAgendaReference(wsId, meetingId, agendaId, referenceId, body));
}
export function useCreateCockpitPreparationIssue(wsId: string, meetingId: string) {
  return useMeetingCommand(wsId, meetingId, "preparation_issue_create", ({ agendaId, body }: { agendaId: string; body: CockpitPreparationIssueInput }) => api.createCockpitPreparationIssue(wsId, meetingId, agendaId, body));
}
