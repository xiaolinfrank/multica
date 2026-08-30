// Zone placement + monologue selection for human members in the Agent
// Office. Mirrors zones.ts: the same inputs + phase always seat the same
// person in the same zone, and the rules read like the agent ones:
//
//   1. issues in progress → desk (working beside the agents)
//   2. open backlog       → waiting (queued for triage or scheduling)
//   3. otherwise          → lounge / tea / canteen / gym, rotated by
//                           hash(userId + phase) like idle agents
import { hashString } from "./zones";
import { RELAX_ZONES, type MonologueSlot, type RelaxZone } from "./types";

export interface OfficeMemberActivity {
  userId: string;
  /** Issues currently in progress and assigned to this member. */
  inProgress: number;
  /** Open, not-yet-started issues assigned to this member. */
  open: number;
  /** Issues that reached a terminal state in the recent window. */
  recentlyDone: number;
}

export type MemberSeatZone = "desk" | "waiting" | RelaxZone;

export interface MemberSeat {
  userId: string;
  zone: MemberSeatZone;
  monologue: MonologueSlot;
}

/** Human monologue variant counts per mood — see `monologue.human.*` in the
 * office locale bundle; idle carries one list per relax zone. */
export const MEMBER_MONOLOGUE_VARIANTS = {
  working: 3,
  waiting: 2,
  idle: 2,
} as const;

function variant(
  userId: string,
  phase: number,
  mood: keyof typeof MEMBER_MONOLOGUE_VARIANTS,
): number {
  return (hashString(`${userId}:human:${mood}`) + phase) % MEMBER_MONOLOGUE_VARIANTS[mood];
}

/** Seat one human member from their recent issue activity. */
export function assignMemberSeat(activity: OfficeMemberActivity, phase: number): MemberSeat {
  if (activity.inProgress > 0) {
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
    userIds.map((id) => [id, { userId: id, inProgress: 0, open: 0, recentlyDone: 0 }]),
  );
  for (const issue of issues) {
    if (issue.assignee_type !== "member") continue;
    const row = byUser.get(issue.assignee_id ?? "");
    if (!row) continue;
    const category = issue.status_category ?? issue.status;
    if (category === "in_progress") row.inProgress += 1;
    else if (category === "done" || category === "cancelled") row.recentlyDone += 1;
    else row.open += 1;
  }
  return byUser;
}
