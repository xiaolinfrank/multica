import type { QueryClient } from "@tanstack/react-query";
import type {
  CockpitBoard,
  CockpitChangedPayload,
  CockpitIssueLink,
  CockpitMeeting,
  CockpitMilestone,
  CockpitNode,
  CockpitPayment,
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

// `cockpit:changed` carries the row that moved, so a collaborator's keystroke
// patches one node in the cached board instead of triggering a re-read of a few
// hundred. The one exception is an import, which replaced everything — there is
// no row to patch, so that frame invalidates.
//
// Payload fields are read defensively: the frame is server data crossing a
// version boundary, and a board that ignores an unrecognised scope is better
// than one that throws inside the socket handler.

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entityWithId(entity: unknown): { id: string } | null {
  const record = asRecord(entity);
  const id = record?.["id"];
  return typeof id === "string" && id !== "" ? (record as unknown as { id: string }) : null;
}

function isDeletion(action: string): boolean {
  return action === "deleted" || action === "removed";
}

export function onCockpitChanged(
  qc: QueryClient,
  wsId: string,
  payload: CockpitChangedPayload,
): void {
  const { scope, action, entity } = payload;

  // An import rewrote the board; nothing here can reconstruct it from a count.
  if (scope === "board") {
    qc.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
    return;
  }

  const apply = (update: (board: CockpitBoard) => CockpitBoard) =>
    patchCockpitBoard(qc, wsId, update);

  switch (scope) {
    case "cockpit": {
      const record = asRecord(entity);
      if (!record) return;
      apply((board) => ({ ...board, cockpit: { ...board.cockpit, ...(record as object) } }));
      return;
    }
    case "node": {
      const row = entityWithId(entity);
      if (!row) return;
      apply((board) =>
        isDeletion(action) ? removeCockpitNode(board, row.id) : upsertCockpitNode(board, row as CockpitNode),
      );
      return;
    }
    case "payment": {
      const row = entityWithId(entity);
      if (!row) return;
      apply((board) =>
        isDeletion(action)
          ? removeCockpitPayment(board, row.id)
          : upsertCockpitPayment(board, row as CockpitPayment),
      );
      return;
    }
    case "milestone": {
      const row = entityWithId(entity);
      if (!row) return;
      apply((board) =>
        isDeletion(action)
          ? removeCockpitMilestone(board, row.id)
          : upsertCockpitMilestone(board, row as CockpitMilestone),
      );
      return;
    }
    case "meeting": {
      const row = entityWithId(entity);
      if (!row) return;
      apply((board) =>
        isDeletion(action)
          ? removeCockpitMeeting(board, row.id)
          : upsertCockpitMeeting(board, row as CockpitMeeting),
      );
      return;
    }
    case "issue_links": {
      const record = asRecord(entity);
      const nodeId = record?.["node_id"];
      if (typeof nodeId !== "string" || nodeId === "") return;
      if (isDeletion(action)) {
        const issueId = record?.["issue_id"];
        if (typeof issueId !== "string") return;
        apply((board) => removeCockpitNodeLink(board, nodeId, issueId));
        return;
      }
      const links = record?.["links"];
      if (!Array.isArray(links)) return;
      apply((board) => replaceCockpitNodeLinks(board, nodeId, links as CockpitIssueLink[]));
      return;
    }
    default:
      // An unknown scope from a newer backend: re-read rather than guess.
      qc.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
  }
}
