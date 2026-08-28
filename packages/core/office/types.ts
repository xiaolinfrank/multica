// Types for the Agent Office floor plan (the `/{ws}/office` page).
//
// Everything in this module is pure data: the zone assignment itself is a
// pure function (zones.ts) so it can be unit-tested without React, and the
// actual copy never lives here — slots carry structure only and the views
// layer renders them through the `office` locale bundle (see #7411: a label
// inside a translated package is a second, untranslatable source).

import type { AgentPresenceDetail } from "../agents/types";

/** One section of the office floor plan. */
export type OfficeZoneId =
  | "desk" // working — at a desk with tasks running
  | "meeting" // squad room — idle member of a squad with work in flight
  | "lounge" // idle — sofa area
  | "tea" // idle — tea corner
  | "canteen" // idle — cafeteria
  | "gym" // idle — gym corner
  | "waiting" // queued — tasks on the plate but nothing running
  | "absent"; // offline / unstable / unbound — not in the office today

/** The four zones idle agents rotate through, in display order. */
export const RELAX_ZONES = ["lounge", "tea", "canteen", "gym"] as const;
export type RelaxZone = (typeof RELAX_ZONES)[number];

/** An agent seated at a desk, with what is on their plate. */
export interface DeskAssignment {
  agentId: string;
  runningCount: number;
  capacity: number;
  /** Newest running task, if any — the desk monitor renders this. */
  focusTaskId: string | null;
}

/** A squad room. Attendees are idle members; the rest are at their desks. */
export interface MeetingAssignment {
  squadId: string;
  squadName: string;
  /** Idle members seated around the table. */
  attendeeAgentIds: string[];
  /** Members currently working at their desks (not seated here). */
  supportingAgentIds: string[];
}

/** Why an agent is not in the office. Drives the door plaque copy. */
export type AbsentReason = "offline" | "unstable" | "unbound";

export interface AbsentAssignment {
  agentId: string;
  reason: AbsentReason;
}

/** Complete floor plan: every non-archived agent appears in exactly one zone. */
export interface OfficeFloorPlan {
  desks: DeskAssignment[];
  meetings: MeetingAssignment[];
  waiting: string[];
  lounge: string[];
  tea: string[];
  canteen: string[];
  gym: string[];
  absent: AbsentAssignment[];
  /** agent.id → zone, for spot lookups (monologue, hover cards). */
  zoneByAgent: ReadonlyMap<string, OfficeZoneId>;
}

/**
 * Structured monologue slot. The views layer maps `kind` + `variant` to a
 * line in the `office` locale bundle; numeric context rides along as
 * interpolation params.
 */
export type MonologueSlot =
  | { kind: "working"; variant: number; runningCount: number }
  | { kind: "queued"; variant: number; queuedCount: number }
  | { kind: "idle"; variant: number; zone: RelaxZone }
  | { kind: "meeting"; variant: number }
  | { kind: "waiting"; variant: number; queuedCount: number }
  | { kind: "completed"; variant: number; count: number }
  | { kind: "failed"; variant: number }
  | { kind: "offline"; variant: number }
  | { kind: "unbound"; variant: number };

/** One row of the recent-activity rail, derived from the task snapshot. */
export interface OfficeTimelineEntry {
  taskId: string;
  agentId: string;
  issueId: string;
  kind: "running" | "completed" | "failed";
  at: string;
}

/** One back-and-forth exchange in the tea-corner chatter panel. */
export interface OfficeChatterLine {
  speakerAgentId: string;
  slot: MonologueSlot;
}

export interface OfficeChatter {
  aAgentId: string;
  bAgentId: string;
  lines: OfficeChatterLine[];
}

/** One bar of the token leaderboard. Names/avatars resolve in the views. */
export interface OfficeTokenRow {
  agentId: string;
  totalTokens: number;
  taskCount: number;
}

/** Convenience alias so consumers don't import presence internals. */
export type OfficePresence = AgentPresenceDetail;
