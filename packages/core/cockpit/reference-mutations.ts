"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { cockpitKeys } from "./queries";
import { graphKeys } from "../graph/queries";
import { CockpitUnconfirmedWriteError } from "./errors";
import { issueKeys } from "../issues/queries";

function useReferenceMutation<T, R>(wsId: string, mutationFn: (variables: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["cockpit-reference", wsId], mutationFn, onSettled: () => {
    // An absent response cannot prove that an idempotent append did not commit.
    for (const queryKey of [cockpitKeys.surfaces(wsId), cockpitKeys.board(wsId), cockpitKeys.tasks(wsId),
      cockpitKeys.dashboard(wsId), graphKeys.all(wsId), issueKeys.all(wsId)]) void client.invalidateQueries({ queryKey });
  } });
}
export function useAppendCockpitNodeIssue(wsId: string) {
  return useReferenceMutation(wsId, ({ nodeId, issueId }: { nodeId: string; issueId: string }) => api.appendCockpitNodeIssue(wsId, nodeId, issueId));
}
export function useAppendCockpitMeetingIssue(wsId: string) {
  return useReferenceMutation(wsId, ({ meetingId, issueId }: { meetingId: string; issueId: string }) => api.appendCockpitMeetingIssue(wsId, meetingId, issueId));
}
export function useAppendCockpitMeetingNode(wsId: string) {
  return useReferenceMutation(wsId, ({ meetingId, nodeId }: { meetingId: string; nodeId: string }) => api.appendCockpitMeetingNode(wsId, meetingId, nodeId));
}
export function useSetCockpitMeetingIssueRolesCompact(wsId: string) {
  return useReferenceMutation(wsId, ({ meetingId, issueId, roles }: { meetingId: string; issueId: string; roles: string[] }) => api.setCockpitMeetingIssueRolesCompact(wsId, meetingId, issueId, roles));
}

export function useRemoveCockpitIssueNodeReference(wsId: string) {
  return useReferenceMutation(wsId, async ({ nodeId, issueId }: { nodeId: string; issueId: string }) => {
    const result = await api.removeCockpitIssueNodeReference(wsId, issueId, nodeId);
    if (!result) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
export function useRemoveCockpitIssueMeetingReference(wsId: string) {
  return useReferenceMutation(wsId, async ({ meetingId, issueId }: { meetingId: string; issueId: string }) => {
    const result = await api.removeCockpitIssueMeetingReference(wsId, issueId, meetingId);
    if (!result) throw new CockpitUnconfirmedWriteError();
    return result;
  });
}
