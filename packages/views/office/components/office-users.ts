// Member figures for the Agent Office: which workspace members get a sprite
// on the floor, and where it stands. Pure data plumbing — no React — so the
// filter and the grid are unit-testable without mounting the scene.

import type { Agent, MemberWithUser } from "@multica/core/types";
import type { MemberSeatZone, MonologueSlot } from "@multica/core/office";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";

/**
 * An agent's own avatar, as an absolute URL. Resolving is skipped entirely
 * when there is nothing to resolve, so an office of avatar-less agents never
 * asks the API client for a base URL it does not need. It lives here rather
 * than beside the scene because the rail draws the same faces the floor does.
 */
export function agentAvatarUrl(agent: Agent | undefined): string | null {
  return agent?.avatar_url ? resolvePublicFileUrl(agent.avatar_url) : null;
}

/**
 * Fork deployment scoping (BayClaw for Fosun Pharma): only real employee
 * accounts get a figure on the office floor. Service, admin and test
 * accounts on other domains stay off the carpet.
 */
export const OFFICE_MEMBER_EMAIL_SUFFIX = "@fosunpharma.com";

/** Everything the floor needs to draw one human, resolved once. */
export interface OfficeMemberFigure {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  /** Current custom status; empty string when unset. */
  status: string;
  /** True for the signed-in viewer — only their own bubble is editable. */
  isSelf: boolean;
}

/** An office member plus the zone and monologue their recent activity puts them in. */
export type SeatedMember = OfficeMemberFigure & {
  zone: MemberSeatZone;
  monologue: MonologueSlot;
};

/** Filters the workspace member list down to office-eligible users. */
export function toOfficeMembers(
  members: readonly MemberWithUser[],
  selfUserId: string,
): OfficeMemberFigure[] {
  return members
    .filter((m) => m.email.toLowerCase().endsWith(OFFICE_MEMBER_EMAIL_SUFFIX))
    .map((m) => ({
      userId: m.user_id,
      name: m.name,
      email: m.email,
      avatarUrl: m.avatar_url ?? null,
      status: m.custom_status ?? "",
      isSelf: m.user_id === selfUserId,
    }));
}

/**
 * Standing spots for human figures, one list per zone they can land in.
 * Coordinates sit clear of the agent SEATS arrays in office-floor.tsx so
 * the two casts never overlap; the i-th member seated in a zone this phase
 * takes spot i % len.
 */
export const HUMAN_SPOTS: Record<string, ReadonlyArray<{ x: number; y: number }>> = {
  // Offset from the agents' own overflow lanes, which run at the quarter
  // points of each zone: two casts standing on the same coordinate stacked
  // their name labels and status pills into an unreadable pile. The desk row
  // sits south of the second desk row by a full label height, so a member's
  // name never lands on the nameplate of the desk behind them.
  desk: [
    { x: 158, y: 490 },
    { x: 278, y: 490 },
    { x: 398, y: 490 },
  ],
  // South of the bench, far enough that a member's name label clears its
  // backrest — the bench is the tallest thing in the smallest zone.
  waiting: [
    { x: 108, y: 814 },
    { x: 232, y: 814 },
  ],
  lounge: [
    { x: 360, y: 712 },
    { x: 560, y: 700 },
    { x: 462, y: 744 },
  ],
  tea: [
    { x: 66, y: 652 },
    { x: 120, y: 666 },
  ],
  canteen: [
    { x: 660, y: 720 },
    { x: 860, y: 720 },
  ],
  gym: [
    { x: 1000, y: 760 },
    { x: 1120, y: 790 },
    { x: 1060, y: 690 },
  ],
};

/** Floor position of the i-th human seated in a zone this phase. */
export function humanSpot(zone: string, i: number): { x: number; y: number } {
  const list = HUMAN_SPOTS[zone] ?? HUMAN_SPOTS.desk ?? [];
  return list[i % list.length] ?? { x: 100, y: 300 };
}
