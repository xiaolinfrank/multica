"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { issueKeys } from "../issues/queries";
import type {
  CockpitBoard,
  CockpitMeetingImportItem,
  CockpitMeetingPatch,
  CockpitMeetingProvision,
  CockpitMilestonePatch,
  CockpitNodePatch,
  CockpitPatch,
  CockpitPaymentPatch,
} from "../types";
import {
  cockpitKeys,
  patchCockpitBoard,
  removeCockpitMeeting,
  removeCockpitMeetingIssue,
  removeCockpitMeetingNode,
  removeCockpitMilestone,
  removeCockpitNode,
  removeCockpitNodeLink,
  removeCockpitPayment,
  replaceCockpitMeetingIssues,
  replaceCockpitMeetingNodes,
  replaceCockpitNodeLinks,
  upsertCockpitMeeting,
  upsertCockpitMilestone,
  upsertCockpitNode,
  upsertCockpitPayment,
} from "./queries";

// Cockpit writes are the canonical optimistic case: a field patch whose outcome
// is locally predictable, with the editor staying on the same screen and a
// trivial rollback (put the previous board back). Each mutation snapshots the
// board, patches it, and restores the snapshot on failure. The server's own row
// then replaces the guess on success, so a value the server normalised (a
// rounded amount, a trimmed code) still wins.
//
// Deletes are NOT optimistic: they are the one shape where a failed write leaves
// the user looking at a board missing work that still exists.

/**
 * Version snapshots. None of these are optimistic: a restore replaces the
 * whole board (never guess at that), and a save or delete only moves history
 * the server owns. All three await the server and then invalidate what the
 * `cockpit:changed` frame would have carried anyway — the explicit invalidate
 * matters for the client that acted, which is allowed to be offline-realtime
 * edge cases behind a flapping socket.
 */
export function useCreateCockpitSnapshot(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => api.createCockpitSnapshot(label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.snapshots(wsId) });
    },
  });
}

export function useRestoreCockpitSnapshot(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => api.restoreCockpitSnapshot(snapshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
      queryClient.invalidateQueries({ queryKey: cockpitKeys.snapshots(wsId) });
    },
  });
}

export function useDeleteCockpitSnapshot(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) => api.deleteCockpitSnapshot(snapshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.snapshots(wsId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Pending changes
//
// None of these are optimistic, by the state rules: whether filing even enters
// the queue is the server's judgement, and a decision either moves board data
// (apply) or removes an affordance the user is looking at (reject/withdraw) —
// both await the server and invalidate.
// ---------------------------------------------------------------------------

/** File one proposal. Resolves to the filed row, or a skipped outcome the
 * caller reads to explain "already current / already proposed". */
export function useCreateCockpitChange(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { node: string; field: string; new_value: string; reason?: string }) =>
      api.createCockpitChange(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) });
    },
  });
}

/** Apply writes the field onto the board: the returned node row settles the
 * board cache, so a value the server normalised still wins. */
export function useApplyCockpitChange(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.applyCockpitChange(id),
    onSuccess: ({ node }) => {
      patchCockpitBoard(queryClient, wsId, (board) => upsertCockpitNode(board, node));
      queryClient.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) });
    },
  });
}

export function useRejectCockpitChange(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rejectCockpitChange(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) });
    },
  });
}

export function useWithdrawCockpitChange(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.withdrawCockpitChange(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) });
    },
  });
}

/**
 * The shared optimistic write. `optimistic` guesses the new board, `settle`
 * folds the server's own row in — so a value the server normalised (a rounded
 * amount, a trimmed code) still wins over the guess.
 */
function useCockpitRowMutation<TVariables, TResult>(
  wsId: string,
  mutationFn: (vars: TVariables) => Promise<TResult>,
  optimistic: (vars: TVariables, board: CockpitBoard) => CockpitBoard,
  settle: (result: TResult) => (board: CockpitBoard) => CockpitBoard,
) {
  const queryClient = useQueryClient();
  return useMutation<TResult, Error, TVariables, { previous: CockpitBoard | undefined }>({
    mutationFn,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: cockpitKeys.board(wsId) });
      const previous = queryClient.getQueryData<CockpitBoard>(cockpitKeys.board(wsId));
      patchCockpitBoard(queryClient, wsId, (board) => optimistic(vars, board));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(cockpitKeys.board(wsId), context.previous);
      }
    },
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, settle(result));
    },
  });
}

export function useUpdateCockpit(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.updateCockpit>>, Error, CockpitPatch, { previous: CockpitBoard | undefined }>({
    mutationFn: (patch: CockpitPatch) => api.updateCockpit(patch),
    onMutate: async (patch: CockpitPatch) => {
      await queryClient.cancelQueries({ queryKey: cockpitKeys.board(wsId) });
      const previous = queryClient.getQueryData<CockpitBoard>(cockpitKeys.board(wsId));
      patchCockpitBoard(queryClient, wsId, (board) => ({
        ...board,
        cockpit: { ...board.cockpit, ...patch },
      }));
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(cockpitKeys.board(wsId), context.previous);
      }
    },
    onSuccess: (cockpit) => {
      patchCockpitBoard(queryClient, wsId, (board) => ({ ...board, cockpit }));
    },
  });
}

export function useCreateCockpitNode(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CockpitNodePatch & { code: string }) => api.createCockpitNode(body),
    onSuccess: (node) => {
      patchCockpitBoard(queryClient, wsId, (board) => upsertCockpitNode(board, node));
    },
  });
}

export function useUpdateCockpitNode(wsId: string) {
  return useCockpitRowMutation(
    wsId,
    ({ id, patch }: { id: string; patch: CockpitNodePatch }) => api.updateCockpitNode(id, patch),
    ({ id, patch }, board) => ({
      ...board,
      nodes: board.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }),
    (node) => (board) => upsertCockpitNode(board, node),
  );
}

export function useDeleteCockpitNode(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCockpitNode(id),
    onSuccess: (_result, id) => {
      patchCockpitBoard(queryClient, wsId, (board) => removeCockpitNode(board, id));
    },
  });
}

export function useSetCockpitNodeIssues(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      nodeId,
      issueIds,
      replace,
    }: {
      nodeId: string;
      issueIds: string[];
      replace?: boolean;
    }) => api.setCockpitNodeIssues(nodeId, issueIds, { replace }),
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        replaceCockpitNodeLinks(board, result.node_id, result.links),
      );
    },
  });
}

export function useDeleteCockpitNodeIssue(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, issueId }: { nodeId: string; issueId: string }) =>
      api.deleteCockpitNodeIssue(nodeId, issueId),
    onSuccess: (_result, { nodeId, issueId }) => {
      patchCockpitBoard(queryClient, wsId, (board) => removeCockpitNodeLink(board, nodeId, issueId));
    },
  });
}

export function useCreateCockpitPayment(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, body }: { nodeId: string; body: CockpitPaymentPatch }) =>
      api.createCockpitPayment(nodeId, body),
    onSuccess: (payment) => {
      patchCockpitBoard(queryClient, wsId, (board) => upsertCockpitPayment(board, payment));
    },
  });
}

export function useUpdateCockpitPayment(wsId: string) {
  return useCockpitRowMutation(
    wsId,
    ({ id, patch }: { id: string; patch: CockpitPaymentPatch }) =>
      api.updateCockpitPayment(id, patch),
    ({ id, patch }, board) => ({
      ...board,
      payments: board.payments.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }),
    (payment) => (board) => upsertCockpitPayment(board, payment),
  );
}

export function useDeleteCockpitPayment(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCockpitPayment(id),
    onSuccess: (_result, id) => {
      patchCockpitBoard(queryClient, wsId, (board) => removeCockpitPayment(board, id));
    },
  });
}

export function useCreateCockpitMilestone(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CockpitMilestonePatch) => api.createCockpitMilestone(body),
    onSuccess: (milestone) => {
      patchCockpitBoard(queryClient, wsId, (board) => upsertCockpitMilestone(board, milestone));
    },
  });
}

export function useUpdateCockpitMilestone(wsId: string) {
  return useCockpitRowMutation(
    wsId,
    ({ id, patch }: { id: string; patch: CockpitMilestonePatch }) =>
      api.updateCockpitMilestone(id, patch),
    ({ id, patch }, board) => ({
      ...board,
      milestones: board.milestones.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }),
    (milestone) => (board) => upsertCockpitMilestone(board, milestone),
  );
}

export function useDeleteCockpitMilestone(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCockpitMilestone(id),
    onSuccess: (_result, id) => {
      patchCockpitBoard(queryClient, wsId, (board) => removeCockpitMilestone(board, id));
    },
  });
}

export function useCreateCockpitMeeting(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CockpitMeetingPatch) => api.createCockpitMeeting(body),
    onSuccess: (meeting) => {
      patchCockpitBoard(queryClient, wsId, (board) => upsertCockpitMeeting(board, meeting));
    },
  });
}

export function useUpdateCockpitMeeting(wsId: string) {
  return useCockpitRowMutation(
    wsId,
    ({ id, patch }: { id: string; patch: CockpitMeetingPatch }) =>
      api.updateCockpitMeeting(id, patch),
    ({ id, patch }, board) => ({
      ...board,
      meetings: board.meetings.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }),
    (meeting) => (board) => upsertCockpitMeeting(board, meeting),
  );
}

export function useDeleteCockpitMeeting(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCockpitMeeting(id),
    onSuccess: (_result, id) => {
      patchCockpitBoard(queryClient, wsId, (board) => removeCockpitMeeting(board, id));
    },
  });
}

/**
 * Opens the meeting's task and creates its folder.
 *
 * Deliberately not optimistic, and not foldable into the create: it has side
 * effects the client cannot predict — an issue in a project this cache knows
 * nothing about, and a directory on a share that may not be mounted — and it
 * reports each part's outcome separately so the caller can show what actually
 * happened and retry only the part that did not.
 */
export function useProvisionCockpitMeeting(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CockpitMeetingProvision }) =>
      api.provisionCockpitMeeting(id, body),
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        replaceCockpitMeetingIssues(upsertCockpitMeeting(board, result.meeting), result.meeting.id, result.issues),
      );
      // The board is not the only cache that moved: an issue was filed into a
      // project whose lists are cached elsewhere.
      if (result.task) {
        queryClient.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      }
    },
  });
}

/**
 * Turns archive folders the scan found into meeting rows.
 *
 * The rows land flagged as read-off-the-share rather than typed, so the
 * register can show that their fields are guesses. Not optimistic for the
 * same reason provisioning is not: the server decides which folders were
 * still there, and reports the ones it skipped.
 */
export function useImportCockpitMeetingFolders(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      items: CockpitMeetingImportItem[];
      project_id?: string;
      module_id?: string;
      node_id?: string;
      create_task?: boolean;
    }) => api.importCockpitMeetingFolders(body),
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, (board) => {
        let next = board;
        for (const meeting of result.meetings) {
          next = upsertCockpitMeeting(next, meeting);
        }
        for (const meeting of result.meetings) {
          const links = result.issues.filter((link) => link.meeting_id === meeting.id);
          if (links.length > 0) next = replaceCockpitMeetingIssues(next, meeting.id, links);
        }
        return next;
      });
      if (result.issues.length > 0) {
        queryClient.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      }
      // The folders that were just imported are no longer unrecorded.
      queryClient.invalidateQueries({ queryKey: [...cockpitKeys.all(wsId), "meeting-scan"] });
    },
  });
}

export function useSetCockpitMeetingIssues(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      meetingId,
      issueIds,
      replace,
    }: {
      meetingId: string;
      issueIds: string[];
      replace?: boolean;
    }) => api.setCockpitMeetingIssues(meetingId, issueIds, { replace }),
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        replaceCockpitMeetingIssues(board, result.meeting_id, result.links),
      );
    },
  });
}

export function useDeleteCockpitMeetingIssue(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ meetingId, issueId }: { meetingId: string; issueId: string }) =>
      api.deleteCockpitMeetingIssue(meetingId, issueId),
    onSuccess: (_result, { meetingId, issueId }) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        removeCockpitMeetingIssue(board, meetingId, issueId),
      );
    },
  });
}

export function useSetCockpitMeetingNodes(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      meetingId,
      nodeIds,
      replace,
    }: {
      meetingId: string;
      nodeIds: string[];
      replace?: boolean;
    }) => api.setCockpitMeetingNodes(meetingId, nodeIds, { replace }),
    onSuccess: (result) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        replaceCockpitMeetingNodes(board, result.meeting_id, result.links),
      );
    },
  });
}

export function useDeleteCockpitMeetingNode(wsId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ meetingId, nodeId }: { meetingId: string; nodeId: string }) =>
      api.deleteCockpitMeetingNode(meetingId, nodeId),
    onSuccess: (_result, { meetingId, nodeId }) => {
      patchCockpitBoard(queryClient, wsId, (board) =>
        removeCockpitMeetingNode(board, meetingId, nodeId),
      );
    },
  });
}
