"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type * as Preparation from "../types/cockpit-meeting-preparation";
import { invalidateCockpitMeetingPreparationFacts } from "./meeting-preparation-queries";

function usePreparationCommand<Input, Output>(ws: string, meeting: string | undefined, identity: string[], mutationFn: (input: Input) => Promise<Output>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-preparation-command", ws, meeting ?? null, ...identity], mutationFn, retry: false,
    onSettled: () => invalidateCockpitMeetingPreparationFacts(client, ws, meeting) });
}
export function useSaveCockpitMeetingTemplate(ws: string, templateId: string | null) {
  return usePreparationCommand(ws, undefined, ["save-template", templateId ?? "new"], (body: Preparation.CockpitMeetingTemplateSaveInput) => api.saveCockpitMeetingTemplate(ws, templateId, body));
}
export function usePreviewCockpitTemplateApplication(ws: string, meeting: string) {
  return useMutation({ mutationKey: ["cockpit-preparation-preview", ws, meeting, "template"], retry: false,
    mutationFn: (body: Preparation.CockpitTemplateApplicationPreviewInput) => api.previewCockpitTemplateApplication(ws, meeting, body) });
}
export function useApplyCockpitMeetingTemplate(ws: string, meeting: string) {
  return usePreparationCommand(ws, meeting, ["apply-template"], (body: Preparation.CockpitTemplateApplicationInput) => api.applyCockpitMeetingTemplate(ws, meeting, body));
}
export function useApplyCockpitPreparationEffect(ws: string, meeting: string, operation: string) {
  return usePreparationCommand(ws, meeting, [operation, "apply-effect"], ({ effectId, body }: { effectId: string; body: Preparation.CockpitPreparationEffectApplyInput }) => api.applyCockpitPreparationEffect(ws, meeting, operation, effectId, body));
}
export function useControlCockpitPreparationOperation(ws: string, meeting: string, operation: string) {
  return usePreparationCommand(ws, meeting, [operation, "control"], (body: Preparation.CockpitPreparationControlInput) => api.controlCockpitPreparationOperation(ws, meeting, operation, body));
}
export function usePreviewCockpitMeetingCancellation(ws: string, meeting: string) {
  return useMutation({ mutationKey: ["cockpit-preparation-preview", ws, meeting, "cancellation"], retry: false,
    mutationFn: (body: Preparation.CockpitCancellationPreviewInput) => api.previewCockpitMeetingCancellation(ws, meeting, body) });
}
export function useCancelCockpitMeeting(ws: string, meeting: string) {
  return usePreparationCommand(ws, meeting, ["cancel"], (body: Preparation.CockpitCancellationInput) => api.cancelCockpitMeeting(ws, meeting, body));
}
export function useAppendCockpitMeetingDisposition(ws: string, meeting: string) {
  return usePreparationCommand(ws, meeting, ["append-disposition"], (body: Preparation.CockpitCancellationInput) => api.appendCockpitMeetingDisposition(ws, meeting, body));
}
export function useReauthorizeCockpitPreparationEffect(ws: string, meeting: string, operation: string) {
  return usePreparationCommand(ws, meeting, [operation, "reauthorize"], ({ effectId, body }: { effectId: string; body: Preparation.CockpitPreparationReauthorizationInput }) => api.reauthorizeCockpitPreparationEffect(ws, meeting, operation, effectId, body));
}
export function useCockpitMeetingDisposition(ws: string, meeting: string) {
  return usePreparationCommand(ws, meeting, ["disposition"], (body: Preparation.CockpitMeetingDispositionInput) => api.recordCockpitMeetingDisposition(ws, meeting, body));
}
