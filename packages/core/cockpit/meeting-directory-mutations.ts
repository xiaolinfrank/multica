"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type * as Directory from "../types/cockpit-meeting-directory";
import { invalidateCockpitMeetingDirectoryFacts } from "./meeting-directory-queries";

function useDirectoryCommand<Input, Output>(ws: string, meeting: string, identity: string[], mutationFn: (input: Input) => Promise<Output>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-directory-command", ws, meeting, ...identity], mutationFn, retry: false,
    onSettled: () => invalidateCockpitMeetingDirectoryFacts(client, ws, meeting) });
}
export function usePreviewCockpitMeetingDirectory(ws: string, meeting: string) {
  return useMutation({ mutationKey: ["cockpit-directory-preview", ws, meeting, "create"], retry: false,
    mutationFn: (body: Directory.CockpitDirectoryPreviewInput) => api.previewCockpitMeetingDirectory(ws, meeting, body) });
}
export function useCreateCockpitMeetingDirectory(ws: string, meeting: string) {
  return useDirectoryCommand(ws, meeting, ["create"], (body: Directory.CockpitDirectoryCreateInput) => api.createCockpitMeetingDirectory(ws, meeting, body));
}
export function usePreviewCockpitDirectoryRetry(ws: string, meeting: string, operation: string) {
  return useMutation({ mutationKey: ["cockpit-directory-preview", ws, meeting, operation, "retry"], retry: false,
    mutationFn: (body: Directory.CockpitDirectoryRetryPreviewInput) => api.previewCockpitDirectoryRetry(ws, meeting, operation, body) });
}
export function useRetryCockpitDirectory(ws: string, meeting: string, operation: string) {
  return useDirectoryCommand(ws, meeting, [operation, "retry"], (body: Directory.CockpitDirectoryRetryInput) => api.retryCockpitDirectory(ws, meeting, operation, body));
}
export function useControlCockpitDirectory(ws: string, meeting: string, operation: string) {
  return useDirectoryCommand(ws, meeting, [operation, "control"], (body: Directory.CockpitDirectoryControlInput) => api.controlCockpitDirectory(ws, meeting, operation, body));
}
