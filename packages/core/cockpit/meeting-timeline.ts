// The meetings timeline: the register read as one lane per programme line.
//
// Everything positional lives here as pure arithmetic over day strings and
// pixel widths, so the view is a rendering of a tested layout and the layout
// never depends on the DOM. The component measures its container, hands the
// width in, and places what comes back.

import type { CockpitMeeting } from "../types";
import {
  cockpitMeetingTracksInUse,
  cockpitMeetingTrackColor,
  cockpitMeetingMinutes,
  formatDay,
  monthKey,
  parseDay,
  shiftMonthKey,
  sortCockpitMeetings,
} from "./model";

/** One day on a lane: every meeting the line held that day, `at` as a 0..1
 * fraction of the domain. Meetings share a card per day rather than stacking
 * three deep — the timeline is a programme view, and "three acceptances on
 * the 21st" reads better as one card than as a pile. */
export interface CockpitTimelineGroup {
  /** The shared day (YYYY-MM-DD). */
  day: string;
  /** The day's meetings, time-ordered. */
  meetings: CockpitMeeting[];
  at: number;
}

export interface CockpitTimelineLane {
  /** The line these meetings advanced; "" is the unfiled lane. */
  track: string;
  color: string;
  /** One entry per day the line met, in date order. */
  items: CockpitTimelineGroup[];
}

export interface CockpitMeetingTimeline {
  lanes: CockpitTimelineLane[];
  /** Domain bounds as day strings, aligned to whole months. */
  from: string;
  to: string;
  /** Meetings with no date have no place on a timeline; the view says how
   *  many it is holding back rather than dropping them silently. */
  undated: CockpitMeeting[];
}

/** Day string → absolute day number, the one conversion the maths needs. */
function dayNumber(day: string): number {
  const date = parseDay(day);
  return date ? Math.round(date.getTime() / 86_400_000) : 0;
}

/**
 * Lay the dated meetings out on their lanes.
 *
 * The domain is month-aligned on both ends: a board whose meetings span
 * 09-02…09-24 reads as September, not as a 22-day sliver with the month's
 * name floating over it. Today is always inside the domain — the marker is
 * the point of the view, and a programme whose meetings all ran last month
 * still wants to see where "now" fell off the end.
 */
export function buildCockpitMeetingTimeline(
  meetings: CockpitMeeting[],
  today: string,
): CockpitMeetingTimeline {
  const dated = sortCockpitMeetings(meetings.filter((m) => m.meet_date));
  const undated = meetings.filter((m) => !m.meet_date);
  if (dated.length === 0) {
    const anchor = parseDay(today) ?? new Date(Date.UTC(2026, 0, 1));
    const month = monthKey(anchor);
    return { lanes: [], from: `${month}-01`, to: `${shiftMonthKey(month, 1)}-01`, undated };
  }

  // Whole months at both ends, so the axis always opens on the 1st and the
  // final month is shown whole rather than cut at the last meeting's day —
  // and today's month is part of the domain even when every meeting ran
  // before it, because the "now" marker is the point of the view.
  const fromDate = parseDay(dated[0]!.meet_date!)!;
  const from = `${monthKey(fromDate)}-01`;
  const lastMeetingMonth = monthKey(parseDay(dated[dated.length - 1]!.meet_date!)!);
  const todayMonth = monthKey(parseDay(today) ?? fromDate);
  const endMonth = lastMeetingMonth >= todayMonth ? lastMeetingMonth : todayMonth;
  const to = `${shiftMonthKey(endMonth, 1)}-01`;
  const span = Math.max(1, dayNumber(to) - dayNumber(from));

  const lanes: CockpitTimelineLane[] = [];
  // One group per (track, day): the meetings of a day share a card, which is
  // what keeps a busy acceptance day one tier tall instead of three.
  const byTrack = new Map<string, Map<string, CockpitMeeting[]>>();
  for (const meeting of dated) {
    const track = meeting.track.trim();
    let days = byTrack.get(track);
    if (!days) byTrack.set(track, (days = new Map()));
    const day = meeting.meet_date!;
    const list = days.get(day);
    if (list) list.push(meeting);
    else days.set(day, [meeting]);
  }
  for (const track of cockpitMeetingTracksInUse(dated)) {
    const days = byTrack.get(track);
    if (!days || days.size === 0) continue;
    const items: CockpitTimelineGroup[] = [...days.entries()].map(([day, meetings]) => ({
      day,
      meetings,
      // The day's number plus its first meeting's slot within it: a timed
      // morning sits inside its day rather than on its left edge.
      at: (dayNumber(day) + cockpitTimelineDayFraction(meetings[0]!) - dayNumber(from)) / span,
    }));
    lanes.push({ track, color: cockpitMeetingTrackColor(track), items });
  }
  return { lanes, from, to, undated };
}

/**
 * The meeting's slot within its day, as a fraction of a day. A timed meeting
 * sits inside its day rather than on its left edge, which is what keeps two
 * meetings of one afternoon from stacking on the same pixel.
 */
export function cockpitTimelineDayFraction(meeting: CockpitMeeting): number {
  const minutes = cockpitMeetingMinutes(meeting.start_time);
  if (minutes === null) return 0.5;
  return Math.min(1, Math.max(0, minutes / 1440));
}

// ---------------------------------------------------------------------------
// Collision: who stacks over whom
// ---------------------------------------------------------------------------

export interface CockpitTimelinePlacement {
  id: string;
  /** Horizontal centre of the card, as a fraction of the lane width. */
  at: number;
  /** The same centre in pixels, clamped so the card stays on the lane. The
   *  marker, stem and card share it — an edge day's card slides inboard, but
   *  the three never disagree about where the card hangs. */
  x: number;
  /** Cards hang alternately above and below the rail, outward from it. */
  side: "above" | "below";
  /** Distance from the rail: 0 touches it, 1 is the next tier out. */
  row: number;
  /** Stacking level across both sides, low is nearer the rail. */
  level: number;
}

/**
 * Assign every card a tier so no two cards on one tier overlap.
 *
 * Interval colouring over the cards' pixel spans, tier by tier: a card takes
 * the lowest tier whose previous card it clears. Tiers unfold outward from
 * the rail — 0 above, 0 below, 1 above, 1 below… — so a dense week reads as
 * a zigzag rather than a wall, and a quiet month sits flat on the rail.
 */
export function layoutCockpitTimeline(
  items: { id: string; at: number }[],
  widthPx: number,
  cardPx: number,
  gapPx = 8,
): CockpitTimelinePlacement[] {
  const sorted = [...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  // lastRight[tier] = the right edge of the card last placed on that tier.
  const lastRight: number[] = [];
  const placements: CockpitTimelinePlacement[] = [];
  for (const item of sorted) {
    const centre = item.at * widthPx;
    // Clamp at the lane's edges: a card's centre is its meeting's day, but the
    // card itself must stay on the lane.
    const left = Math.min(Math.max(centre - cardPx / 2, 0), Math.max(0, widthPx - cardPx));
    let tier = lastRight.findIndex((right) => left >= right + gapPx);
    if (tier === -1) {
      tier = lastRight.length;
      lastRight.push(-Infinity);
    }
    lastRight[tier] = left + cardPx;
    placements.push({
      id: item.id,
      at: item.at,
      x: left + cardPx / 2,
      side: tier % 2 === 0 ? "above" : "below",
      row: Math.floor(tier / 2),
      level: tier,
    });
  }
  return placements;
}

/** The tier budget one lane needs, as {above, below} row counts. */
export function cockpitTimelineLaneRows(placements: CockpitTimelinePlacement[]): {
  above: number;
  below: number;
} {
  let above = 0;
  let below = 0;
  for (const p of placements) {
    if (p.side === "above") above = Math.max(above, p.row + 1);
    else below = Math.max(below, p.row + 1);
  }
  return { above, below };
}

// ---------------------------------------------------------------------------
// Lane geometry: how tall a lane is and where its rail sits
// ---------------------------------------------------------------------------

/** The card geometry a lane's vertical size is derived from. */
export interface CockpitTimelineLaneGeom {
  cardH: number;
  /** Vertical distance between tiers of cards on one side of the rail. */
  rowPitch: number;
  /** The rail's own band. */
  railPx: number;
  /** A card's edge clears the rail by this much; its stem spans the gap. */
  clearance: number;
  /** Breathing room between the outermost card and the lane's edge. */
  pad: number;
}

/** Vertical space one side of the rail needs for `rows` tiers of cards. */
export function cockpitTimelineSideSpace(
  rows: number,
  geom: Pick<CockpitTimelineLaneGeom, "cardH" | "rowPitch" | "railPx" | "clearance">,
): number {
  if (rows <= 0) return geom.railPx / 2;
  return geom.railPx / 2 + geom.clearance + (rows - 1) * geom.rowPitch + geom.cardH;
}

/**
 * A lane's height and its rail's offset from the top. The rail is NOT the
 * lane's vertical centre: it sits between the tiers actually in use, so a
 * lane whose cards all hang one way stays compact instead of paying for the
 * empty side. The view positions the marker, stem and card relative to this
 * offset, which is what keeps every card inside the lane's own box.
 */
export function cockpitTimelineLaneGeometry(
  rows: { above: number; below: number },
  geom: CockpitTimelineLaneGeom,
): { height: number; railY: number } {
  const above = cockpitTimelineSideSpace(rows.above, geom);
  const below = cockpitTimelineSideSpace(rows.below, geom);
  return { railY: above + geom.pad, height: above + below + geom.pad * 2 };
}

// ---------------------------------------------------------------------------
// Axis ticks
// ---------------------------------------------------------------------------

export interface CockpitTimelineTick {
  /** First day of the tick's period. */
  day: string;
  at: number;
  /** "week" ticks land on Mondays; the rest on period boundaries. */
  step: "week" | "month" | "quarter" | "year";
}

/**
 * Axis ticks for a domain at a pixel width, coarse enough that labels never
 * crowd: weeks while a week is wide enough to name, then months, quarters,
 * years.
 */
export function cockpitTimelineTicks(from: string, to: string, widthPx: number): CockpitTimelineTick[] {
  const start = dayNumber(from);
  const end = dayNumber(to);
  const span = Math.max(1, end - start);
  const pxPerDay = widthPx / span;

  const ticks: CockpitTimelineTick[] = [];
  const push = (day: string, step: CockpitTimelineTick["step"]) => {
    const at = (dayNumber(day) - start) / span;
    if (at >= 0 && at <= 1) ticks.push({ day, at, step });
  };

  if (pxPerDay >= 10) {
    // Weekly: walk Mondays from the domain's first week.
    const first = parseDay(from)!;
    const mondayOffset = (first.getUTCDay() + 6) % 7;
    let cursor = first.getTime() - mondayOffset * 86_400_000;
    while (cursor <= end * 86_400_000) {
      push(formatDay(new Date(cursor)), "week");
      cursor += 7 * 86_400_000;
    }
    return ticks;
  }

  const months = span / 30.4;
  const monthStep = pxPerDay * 30.4 >= 56 ? 1 : pxPerDay * 91.3 >= 56 ? 3 : 12;
  const step = monthStep === 1 ? "month" : monthStep === 3 ? "quarter" : "year";
  const firstMonth = monthKey(parseDay(from)!);
  const total = Math.ceil(months) + 1;
  for (let i = 0; i <= total; i += monthStep) {
    push(`${shiftMonthKey(firstMonth, i)}-01`, step);
  }
  return ticks;
}
