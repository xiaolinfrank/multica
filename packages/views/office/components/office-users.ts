// Member figures for the Agent Office: which workspace members get a sprite
// on the floor, and where it stands. Pure data plumbing — no React — so the
// filter and the grid are unit-testable without mounting the scene.

import type { MemberWithUser } from "@multica/core/types";

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
 * The members-corner grid: four standing slots on the south side of the
 * standup table, then a back row on the north side. Mirrors the geometry in
 * office-floor.tsx (MEMBERS zone x 952..1150); kept here so placement is a
 * pure function the node suite can pin.
 */
export const MEMBER_GRID = {
  zoneX: 952,
  zoneW: 198,
  perRow: 4,
  frontY: 302,
  backY: 206,
  slot: 38,
} as const;

export interface MemberSpot {
  x: number;
  y: number;
  slot: number;
}

/** Floor position of the i-th member figure, in scene units. */
export function memberSpot(i: number): MemberSpot {
  return {
    x: MEMBER_GRID.zoneX + ((i % MEMBER_GRID.perRow) + 0.5) * (MEMBER_GRID.zoneW / MEMBER_GRID.perRow),
    y: i < MEMBER_GRID.perRow ? MEMBER_GRID.frontY : MEMBER_GRID.backY,
    slot: MEMBER_GRID.slot,
  };
}
