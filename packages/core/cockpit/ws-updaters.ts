import type { QueryClient } from "@tanstack/react-query";
import type { ZodType } from "zod";
import type {
  CockpitBoard,
  CockpitChangedPayload,
  CockpitIssueLink,
  CockpitMeeting,
  CockpitMeetingIssueLink,
  CockpitMeetingNodeLink,
  CockpitMilestone,
  CockpitNode,
  CockpitPayment,
} from "../types";
import {
  CockpitIssueLinkSchema,
  CockpitMeetingIssueLinkSchema,
  CockpitMeetingNodeLinkSchema,
  CockpitMeetingSchema,
  CockpitMilestoneSchema,
  CockpitNodeSchema,
  CockpitPaymentSchema,
  CockpitSchema,
} from "../api/schemas";
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

// `cockpit:changed` carries the row that moved, so a collaborator's keystroke
// patches one node in the cached board instead of triggering a re-read of a few
// hundred. The one exception is an import, which replaced everything — there is
// no row to patch, so that frame invalidates.
//
// Payload fields are read defensively: the frame is server data crossing a
// version boundary, and a board that ignores an unrecognised scope is better
// than one that throws inside the socket handler.
//
// The row inside the frame gets the same treatment, through the same schemas
// the HTTP responses go through. A server older than this build leaves out the
// columns it does not have, and the board's types promise those columns are
// there — the register trims and splits them while rendering. Casting the row
// in puts the hole in the cache and the crash three renders later, nowhere
// near the socket.

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

/**
 * The frame's row in the shape the board promises, or null if it is not one.
 *
 * Merged over what the cache already holds before parsing: a column the frame
 * leaves out is one its sender had no opinion about, and the row on the board
 * is a better answer than the schema's default. A column the frame does carry
 * wins, empty string included — that is how a field gets cleared.
 */
function rowFromFrame<T>(
  schema: ZodType,
  row: Record<string, unknown>,
  cached: T | undefined,
): T | null {
  const result = schema.safeParse(cached ? { ...cached, ...row } : row);
  return result.success ? (result.data as T) : null;
}

function linksFromFrame<T>(schema: ZodType, links: unknown[]): T[] | null {
  const out: T[] = [];
  for (const link of links) {
    const result = schema.safeParse(link);
    if (!result.success) return null;
    out.push(result.data as T);
  }
  return out;
}

export function onCockpitChanged(
  qc: QueryClient,
  wsId: string,
  payload: CockpitChangedPayload,
): void {
  const { scope, action, entity } = payload;

  // An import or restore rewrote the board; nothing here can reconstruct it
  // from a count. Both freeze a version on the way in, so history moves too.
  if (scope === "board") {
    qc.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });
    qc.invalidateQueries({ queryKey: cockpitKeys.snapshots(wsId) });
    return;
  }

  // Versions were saved or deleted without the board changing (a manual save,
  // a history cleanup). The list is metadata-only; re-read it whole.
  if (scope === "snapshots") {
    qc.invalidateQueries({ queryKey: cockpitKeys.snapshots(wsId) });
    return;
  }

  // The review queue moved: filed, applied, rejected or withdrawn. The queue
  // is judged server-side, so re-read it; an apply also carries its own
  // "node updated" frame that patches the board separately.
  if (scope === "changes") {
    qc.invalidateQueries({ queryKey: cockpitKeys.changes(wsId) });
    return;
  }

  const apply = (update: (board: CockpitBoard) => CockpitBoard) =>
    patchCockpitBoard(qc, wsId, update);

  // A frame this build cannot make sense of is not applied at all: re-reading
  // the board is slower than patching it and always right, which is the trade
  // to make when the alternative is a cache nobody can render.
  const reread = () => qc.invalidateQueries({ queryKey: cockpitKeys.board(wsId) });

  /** Upserts one row from the frame, or re-reads the board if it will not parse. */
  const upsertRow = <T extends { id: string }>(
    schema: ZodType,
    row: { id: string },
    find: (board: CockpitBoard) => T | undefined,
    upsert: (board: CockpitBoard, value: T) => CockpitBoard,
  ) => {
    let rejected = false;
    apply((board) => {
      const parsed = rowFromFrame<T>(schema, row as unknown as Record<string, unknown>, find(board));
      if (!parsed) {
        rejected = true;
        return board;
      }
      return upsert(board, parsed);
    });
    if (rejected) reread();
  };

  switch (scope) {
    case "cockpit": {
      const record = asRecord(entity);
      if (!record) return;
      let rejected = false;
      apply((board) => {
        const parsed = rowFromFrame<CockpitBoard["cockpit"]>(CockpitSchema, record, board.cockpit);
        if (!parsed) {
          rejected = true;
          return board;
        }
        return { ...board, cockpit: parsed };
      });
      if (rejected) reread();
      return;
    }
    case "node": {
      const row = entityWithId(entity);
      if (!row) return;
      if (isDeletion(action)) {
        apply((board) => removeCockpitNode(board, row.id));
        return;
      }
      upsertRow<CockpitNode>(
        CockpitNodeSchema,
        row,
        (board) => board.nodes.find((n) => n.id === row.id),
        upsertCockpitNode,
      );
      return;
    }
    case "payment": {
      const row = entityWithId(entity);
      if (!row) return;
      if (isDeletion(action)) {
        apply((board) => removeCockpitPayment(board, row.id));
        return;
      }
      upsertRow<CockpitPayment>(
        CockpitPaymentSchema,
        row,
        (board) => board.payments.find((p) => p.id === row.id),
        upsertCockpitPayment,
      );
      return;
    }
    case "milestone": {
      const row = entityWithId(entity);
      if (!row) return;
      if (isDeletion(action)) {
        apply((board) => removeCockpitMilestone(board, row.id));
        return;
      }
      upsertRow<CockpitMilestone>(
        CockpitMilestoneSchema,
        row,
        (board) => board.milestones.find((m) => m.id === row.id),
        upsertCockpitMilestone,
      );
      return;
    }
    case "meeting": {
      const row = entityWithId(entity);
      if (!row) return;
      if (isDeletion(action)) {
        apply((board) => removeCockpitMeeting(board, row.id));
        return;
      }
      upsertRow<CockpitMeeting>(
        CockpitMeetingSchema,
        row,
        (board) => board.meetings.find((m) => m.id === row.id),
        upsertCockpitMeeting,
      );
      return;
    }
    case "meeting_issues": {
      const record = asRecord(entity);
      const meetingId = record?.["meeting_id"];
      if (typeof meetingId !== "string" || meetingId === "") return;
      if (isDeletion(action)) {
        const issueId = record?.["issue_id"];
        if (typeof issueId !== "string") return;
        apply((board) => removeCockpitMeetingIssue(board, meetingId, issueId));
        return;
      }
      const raw = record?.["links"];
      if (!Array.isArray(raw)) return;
      const links = linksFromFrame<CockpitMeetingIssueLink>(CockpitMeetingIssueLinkSchema, raw);
      if (!links) {
        reread();
        return;
      }
      apply((board) => replaceCockpitMeetingIssues(board, meetingId, links));
      // Provisioning opens a task as well as linking it, and the meeting row
      // it echoes carries the folder that was created.
      const meeting = entityWithId(record?.["meeting"]);
      if (meeting) {
        upsertRow<CockpitMeeting>(
          CockpitMeetingSchema,
          meeting,
          (board) => board.meetings.find((m) => m.id === meeting.id),
          upsertCockpitMeeting,
        );
      }
      return;
    }
    case "meeting_nodes": {
      const record = asRecord(entity);
      const meetingId = record?.["meeting_id"];
      if (typeof meetingId !== "string" || meetingId === "") return;
      if (isDeletion(action)) {
        const nodeId = record?.["node_id"];
        if (typeof nodeId !== "string") return;
        apply((board) => removeCockpitMeetingNode(board, meetingId, nodeId));
        return;
      }
      const raw = record?.["links"];
      if (!Array.isArray(raw)) return;
      const links = linksFromFrame<CockpitMeetingNodeLink>(CockpitMeetingNodeLinkSchema, raw);
      if (!links) {
        reread();
        return;
      }
      apply((board) => replaceCockpitMeetingNodes(board, meetingId, links));
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
      const raw = record?.["links"];
      if (!Array.isArray(raw)) return;
      const links = linksFromFrame<CockpitIssueLink>(CockpitIssueLinkSchema, raw);
      if (!links) {
        reread();
        return;
      }
      apply((board) => replaceCockpitNodeLinks(board, nodeId, links));
      return;
    }
    default:
      // An unknown scope from a newer backend: re-read rather than guess.
      reread();
  }
}
