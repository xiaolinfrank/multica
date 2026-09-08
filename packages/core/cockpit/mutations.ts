"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CockpitBoard,
  CockpitMeetingPatch,
  CockpitMilestonePatch,
  CockpitNodePatch,
  CockpitPatch,
  CockpitPaymentPatch,
} from "../types";
import {
  cockpitKeys,
  patchCockpitBoard,
  removeCockpitMeeting,
  removeCockpitMilestone,
  removeCockpitNode,
  removeCockpitNodeLink,
  removeCockpitPayment,
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
