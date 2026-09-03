import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CockpitBoard,
  CockpitIssueLink,
  CockpitMeeting,
  CockpitMilestone,
  CockpitNode,
  CockpitPayment,
} from "../types";

// The board is one cache entry, not six. Every view reads all of it, every
// write patches one row of it, and the realtime event names which collection
// moved — splitting it would mean six keys that always invalidate together.
export const cockpitKeys = {
  all: (wsId: string) => ["cockpit", wsId] as const,
  board: (wsId: string) => [...cockpitKeys.all(wsId), "board"] as const,
};

export function cockpitBoardOptions(wsId: string) {
  return queryOptions({
    queryKey: cockpitKeys.board(wsId),
    queryFn: () => api.getCockpit(),
    enabled: Boolean(wsId),
  });
}

/**
 * Applies `update` to the cached board, or does nothing when there is no board
 * cached yet — a patch that arrives before the first read has nothing to patch,
 * and the read that follows carries the change anyway.
 */
export function patchCockpitBoard(
  queryClient: QueryClient,
  wsId: string,
  update: (board: CockpitBoard) => CockpitBoard,
): void {
  queryClient.setQueryData<CockpitBoard>(cockpitKeys.board(wsId), (board) =>
    board ? update(board) : board,
  );
}

/** Replaces a row by id, or appends it when it is new. Order is preserved. */
function upsertById<T extends { id: string }>(rows: T[], row: T): T[] {
  const index = rows.findIndex((r) => r.id === row.id);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
}

export function upsertCockpitNode(board: CockpitBoard, node: CockpitNode): CockpitBoard {
  return { ...board, nodes: upsertById(board.nodes, node) };
}

export function removeCockpitNode(board: CockpitBoard, nodeId: string): CockpitBoard {
  // The node's own payments and links go with it, mirroring what the server
  // did — otherwise the finance roll-up keeps counting a task that is gone.
  return {
    ...board,
    nodes: board.nodes.filter((n) => n.id !== nodeId),
    payments: board.payments.filter((p) => p.node_id !== nodeId),
    issue_links: board.issue_links.filter((l) => l.node_id !== nodeId),
  };
}

export function upsertCockpitPayment(board: CockpitBoard, payment: CockpitPayment): CockpitBoard {
  return { ...board, payments: upsertById(board.payments, payment) };
}

export function removeCockpitPayment(board: CockpitBoard, paymentId: string): CockpitBoard {
  return { ...board, payments: board.payments.filter((p) => p.id !== paymentId) };
}

export function replaceCockpitNodeLinks(
  board: CockpitBoard,
  nodeId: string,
  links: CockpitIssueLink[],
): CockpitBoard {
  return {
    ...board,
    issue_links: [...board.issue_links.filter((l) => l.node_id !== nodeId), ...links],
  };
}

export function removeCockpitNodeLink(
  board: CockpitBoard,
  nodeId: string,
  issueId: string,
): CockpitBoard {
  return {
    ...board,
    issue_links: board.issue_links.filter((l) => !(l.node_id === nodeId && l.issue_id === issueId)),
  };
}

export function upsertCockpitMilestone(
  board: CockpitBoard,
  milestone: CockpitMilestone,
): CockpitBoard {
  return { ...board, milestones: upsertById(board.milestones, milestone) };
}

export function removeCockpitMilestone(board: CockpitBoard, milestoneId: string): CockpitBoard {
  return { ...board, milestones: board.milestones.filter((m) => m.id !== milestoneId) };
}

export function upsertCockpitMeeting(board: CockpitBoard, meeting: CockpitMeeting): CockpitBoard {
  return { ...board, meetings: upsertById(board.meetings, meeting) };
}

export function removeCockpitMeeting(board: CockpitBoard, meetingId: string): CockpitBoard {
  return { ...board, meetings: board.meetings.filter((m) => m.id !== meetingId) };
}
