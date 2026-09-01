// Zone placement + monologue selection for human members in the Agent
// Office. Mirrors zones.ts: the same inputs + phase always seat the same
// person in the same zone, and the rules read like the agent ones:
//
//   1. manually set status preset (2h TTL, already resolved server-side
//      by the time it reaches us)  → the preset's zone, highest priority
//   2. subscribed issue in progress          → desk (working beside the agents)
//   3. subscribed issue that recently left   → desk (lingering, WORK_LINGER_MS)
//      in_progress
//   4. open backlog                          → waiting (queued for triage)
//   5. otherwise                             → lounge / tea / canteen / gym,
//      rotated by hash(userId + phase) like idle agents
//
// Working is driven by SUBSCRIPTIONS, not assignment: an issue's assignee is
// often an agent while the human still works alongside it, and assignment
// itself writes a subscription row anyway (server-side assignee listener),
// so the subscription set is a superset of "assigned to me".
import { hashString } from "./zones";
import { RELAX_ZONES, type MonologueSlot, type RelaxZone } from "./types";

export interface OfficeMemberActivity {
  userId: string;
  /** Open, not-yet-started issues assigned to this member. */
  open: number;
  /** Issues that reached a terminal state in the recent window. */
  recentlyDone: number;
}

export type MemberSeatZone = "desk" | "waiting" | "meeting" | RelaxZone | "absent";

export interface MemberSeat {
  userId: string;
  zone: MemberSeatZone;
  /** null when absent — an absent figure gets no bubble. */
  monologue: MonologueSlot | null;
}

/**
 * How long a member keeps their desk after every subscribed issue left
 * in_progress: finishing up, writing the wrap-up, grabbing a coffee before
 * the next thing. Purely visual — the linger window is measured from the
 * issue's `updated_at`, so every viewer derives the same answer without any
 * client-side memory.
 */
export const WORK_LINGER_MS = 30 * 60_000;

/**
 * Preset status key → floor zone. Mirrors the editor's STATUS_PRESET_KEYS
 * (views/office) and CustomStatusPresetKeys (server); the key — not the
 * localized label — is what the server stores, so routing survives a
 * language switch. `vacation` takes the figure off the floor.
 */
export const STATUS_PRESET_ZONES = {
  focus: "desk",
  meeting: "meeting",
  gym: "gym",
  coffee: "canteen",
  vacation: "absent",
} as const satisfies Record<string, MemberSeatZone>;

export type StatusPresetKey = keyof typeof STATUS_PRESET_ZONES;

/** Zones a manual preset can route to, as a runtime set for foreign keys. */
const PRESET_ZONE_BY_KEY: Readonly<Record<string, MemberSeatZone>> = STATUS_PRESET_ZONES;

/** Human monologue variant counts per mood — see `monologue.human.*` in the
 * office locale bundle; idle carries one list per relax zone. */
export const MEMBER_MONOLOGUE_VARIANTS = {
  working: 3,
  waiting: 2,
  idle: 2,
  meeting: 2,
} as const;

function variant(
  userId: string,
  phase: number,
  mood: keyof typeof MEMBER_MONOLOGUE_VARIANTS,
): number {
  return (hashString(`${userId}:human:${mood}`) + phase) % MEMBER_MONOLOGUE_VARIANTS[mood];
}

/** Issue rows the subscription classifier needs; status falls back to the
 * raw status key when the category is absent (same fallback as the
 * assigned-issue classifier). */
export interface SubscribedIssueRow {
  status_category?: string;
  status: string;
  updated_at: string | null;
}

export interface SubscriptionActivity {
  /** Subscribed issues currently in progress. */
  inProgress: number;
  /** Subscribed issues that left in_progress inside the linger window. */
  lingering: number;
}

/**
 * Classifies one member's subscribed issues into the working/lingering
 * buckets. `lingering` only counts rows whose category implies the issue
 * WAS running and no longer is (in_review / done / cancelled / blocked):
 * a freshly created todo must not park its creator at a desk.
 */
export function subscriptionActivity(
  rows: readonly SubscribedIssueRow[],
  now: number,
): SubscriptionActivity {
  let inProgress = 0;
  let lingering = 0;
  for (const row of rows) {
    const category = row.status_category ?? row.status;
    if (category === "in_progress") {
      inProgress += 1;
      continue;
    }
    if (
      category === "in_review" ||
      category === "done" ||
      category === "cancelled" ||
      category === "blocked"
    ) {
      const updated = Date.parse(row.updated_at ?? "");
      if (!Number.isNaN(updated) && now - updated < WORK_LINGER_MS) lingering += 1;
    }
  }
  return { inProgress, lingering };
}

export interface MemberSeatOptions {
  /** The member's subscribed-issue activity; omit when unknown (offline). */
  subscriptions?: SubscriptionActivity;
  /** Manually set status preset key ("" or unknown = free text → ignore). */
  statusKey?: string;
}

/** Seat one human member from their manual status, subscriptions and
 * backlog. Manual status outranks everything; subscriptions outrank the
 * backlog; the backlog outranks the leisure rotation. */
export function assignMemberSeat(
  activity: OfficeMemberActivity,
  phase: number,
  options: MemberSeatOptions = {},
): MemberSeat {
  const manualZone = options.statusKey ? PRESET_ZONE_BY_KEY[options.statusKey] : undefined;
  if (manualZone !== undefined) return manualSeat(activity.userId, manualZone, phase);
  const subs = options.subscriptions;
  if ((subs?.inProgress ?? 0) > 0 || (subs?.lingering ?? 0) > 0) {
    return {
      userId: activity.userId,
      zone: "desk",
      monologue: { kind: "human", mood: "working", variant: variant(activity.userId, phase, "working") },
    };
  }
  if (activity.open > 0) {
    return {
      userId: activity.userId,
      zone: "waiting",
      monologue: { kind: "human", mood: "waiting", variant: variant(activity.userId, phase, "waiting") },
    };
  }
  const zone = RELAX_ZONES[(hashString(activity.userId) + phase) % RELAX_ZONES.length] ?? "lounge";
  return {
    userId: activity.userId,
    zone,
    monologue: { kind: "human", mood: "idle", zone, variant: variant(activity.userId, phase, "idle") },
  };
}

/** Manual presets override everything; monologue follows the zone the way
 * the issue-driven seats do, so a focused member chats like a working one. */
function manualSeat(userId: string, zone: MemberSeatZone, phase: number): MemberSeat {
  if (zone === "absent") return { userId, zone, monologue: null };
  if (zone === "desk") {
    return {
      userId,
      zone,
      monologue: { kind: "human", mood: "working", variant: variant(userId, phase, "working") },
    };
  }
  if (zone === "meeting") {
    return {
      userId,
      zone,
      monologue: { kind: "human", mood: "meeting", variant: variant(userId, phase, "meeting") },
    };
  }
  if (zone === "waiting") {
    return {
      userId,
      zone,
      monologue: { kind: "human", mood: "waiting", variant: variant(userId, phase, "waiting") },
    };
  }
  return {
    userId,
    zone,
    monologue: { kind: "human", mood: "idle", zone, variant: variant(userId, phase, "idle") },
  };
}

/** Terminal categories counted as "handled recently"; everything open that is
 * not in progress lands in the backlog bucket. */
export function memberActivityFromIssues(
  userIds: readonly string[],
  issues: ReadonlyArray<{
    assignee_type: string | null;
    assignee_id: string | null;
    status_category?: string;
    status: string;
  }>,
): Map<string, OfficeMemberActivity> {
  const byUser = new Map<string, OfficeMemberActivity>(
    userIds.map((id) => [id, { userId: id, open: 0, recentlyDone: 0 }]),
  );
  for (const issue of issues) {
    if (issue.assignee_type !== "member") continue;
    const row = byUser.get(issue.assignee_id ?? "");
    if (!row) continue;
    const category = issue.status_category ?? issue.status;
    if (category === "done" || category === "cancelled") row.recentlyDone += 1;
    else if (category !== "in_progress") row.open += 1;
  }
  return byUser;
}
