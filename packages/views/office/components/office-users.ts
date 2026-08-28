// Member figures for the Agent Office: which workspace members get a sprite
// on the floor, and where it stands. Pure data plumbing — no React — so the
// filter and the grid are unit-testable without mounting the scene.

import type { MemberWithUser } from "@multica/core/types";
import type { MemberSeatZone, MonologueSlot } from "@multica/core/office";

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
  desk: [{ x: 100, y: 385 }, { x: 220, y: 385 }, { x: 340, y: 385 }],
  waiting: [{ x: 88, y: 600 }, { x: 180, y: 615 }],
  lounge: [{ x: 360, y: 530 }, { x: 560, y: 525 }, { x: 460, y: 560 }],
  tea: [{ x: 66, y: 536 }, { x: 118, y: 558 }],
  canteen: [{ x: 660, y: 560 }, { x: 860, y: 560 }],
  gym: [{ x: 1000, y: 585 }, { x: 1120, y: 610 }, { x: 1060, y: 500 }],
};

/** Floor position of the i-th human seated in a zone this phase. */
export function humanSpot(zone: string, i: number): { x: number; y: number } {
  const list = HUMAN_SPOTS[zone] ?? HUMAN_SPOTS.desk ?? [];
  return list[i % list.length] ?? { x: 100, y: 300 };
}
