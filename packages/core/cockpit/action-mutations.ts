"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";
import type { CockpitActionDraft, CockpitActionResolution, CockpitMeetingAction, CockpitPrimaryNode, CockpitTaskCreate } from "../types";
import { cockpitKeys, invalidateCockpitTaskFlow } from "./queries";

function useActionMutation<T extends { meetingId: string }>(wsId: string, mutationFn: (variables: T) => Promise<CockpitMeetingAction>) {
  const client = useQueryClient();
  return useMutation({ mutationFn,
    onSuccess: async (action) => {
      const queryKey = cockpitKeys.meetingActions(wsId, action.meeting_id);
      await client.cancelQueries({ queryKey });
      // An action revision does not order its embedded live issue facts. Read their current projection.
      invalidateCockpitTaskFlow(client, wsId);
      void client.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
      void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
    onError: (_error, variables) => { void client.invalidateQueries({ queryKey: cockpitKeys.meetingActions(wsId, variables.meetingId) }); },
  });
}

export function useCreateCockpitMeetingAction(wsId: string) {
  return useActionMutation(wsId, ({ meetingId, versionId, body }: { meetingId: string; versionId: string; body: CockpitActionDraft & { proposal_key: string } }) =>
    api.createCockpitMeetingAction(meetingId, versionId, body));
}

export function useUpdateCockpitMeetingAction(wsId: string) {
  return useActionMutation(wsId, ({ meetingId, actionId, body }: { meetingId: string; actionId: string; body: CockpitActionDraft & { expected_revision: number } }) =>
    api.updateCockpitMeetingAction(meetingId, actionId, body));
}

export function useResolveCockpitMeetingAction(wsId: string) {
  return useActionMutation(wsId, ({ action, body }: { meetingId: string; action: Pick<CockpitMeetingAction, "id" | "meeting_id" | "version_id" | "source_content_hash">; body: CockpitActionResolution }) =>
    api.resolveCockpitMeetingAction(action, body));
}

export function useReviseCockpitMeetingAction(wsId: string) {
  return useActionMutation(wsId, ({ action, body }: { meetingId: string; action: Pick<CockpitMeetingAction, "id" | "meeting_id" | "version_id" | "source_content_hash">; body: CockpitActionResolution }) =>
    api.reviseCockpitMeetingAction(action, body));
}

export function useCreateCockpitNodeTask(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ nodeId, body }: { nodeId: string; body: CockpitTaskCreate }) => api.createCockpitNodeTask(nodeId, body),
    onSuccess: () => { invalidateCockpitTaskFlow(client, wsId); void client.invalidateQueries({ queryKey: issueKeys.all(wsId) }); },
    onError: () => { invalidateCockpitTaskFlow(client, wsId); },
  });
}

export function useSetCockpitPrimaryNode(wsId: string) {
  const client = useQueryClient();
  return useMutation({ mutationKey: ["setCockpitPrimaryNode", wsId], mutationFn: ({ issueId, nodeId, revision }: { issueId: string; nodeId: string | null; revision: number }) =>
    api.setCockpitPrimaryNode(wsId, issueId, { node_id: nodeId, expected_revision: revision }),
    onSuccess: (primary) => {
      client.setQueryData<CockpitPrimaryNode | null>(cockpitKeys.primaryNode(wsId, primary.issue_id), (current) =>
        current && current.revision > primary.revision ? current : primary);
      invalidateCockpitTaskFlow(client, wsId);
      void client.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
      void client.invalidateQueries({ queryKey: issueKeys.all(wsId) });
    },
    onError: () => { invalidateCockpitTaskFlow(client, wsId); },
  });
}
