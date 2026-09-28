// Finding meetings in the register.
//
// The search box and the filter popover on the meetings tab are two faces of
// one predicate, kept here so the list, the calendars, the agenda and the
// timeline can never disagree about which meetings a filter lets through —
// and so the matching rules (what the quick search reads, how an undated
// meeting answers a date range) are pinned by tests rather than by the view
// that happened to implement them first.

import type { CockpitMeeting } from "../types";
import { splitCockpitMeetingParties } from "./model";

/** The register's searchable text: everything a reader might type a word of. */
export function cockpitMeetingSearchHaystack(meeting: CockpitMeeting): string {
  return [
    meeting.title,
    meeting.code,
    meeting.track,
    meeting.kind,
    meeting.status,
    meeting.parties,
    meeting.organizer,
    meeting.attendees,
    meeting.location,
    meeting.meet_no,
    meeting.note,
    meeting.minutes,
    meeting.decisions,
    meeting.actions,
  ]
    .join("\n")
    .toLowerCase();
}

/**
 * The "only show meetings that…" switches. Each is a promise the register can
 * actually check: a consensus was recorded, a folder exists, work is attached,
 * or the row still wears the scan's unchecked flag.
 */
export const COCKPIT_MEETING_ONLY_FLAGS = ["consensus", "folder", "links", "detected"] as const;
export type CockpitMeetingOnlyFlag = (typeof COCKPIT_MEETING_ONLY_FLAGS)[number];

/**
 * One active reading of the register. Empty arrays and empty strings impose no
 * constraint, so the zero value IS "everything" and a chip row can be built
 * from whichever fields differ from it.
 *
 * `tracks` may contain the empty string: it names the unfiled lane, so
 * "meetings with no line yet" is a thing the filter can ask for.
 */
export interface CockpitMeetingFilter {
  query: string;
  /** "YYYY-MM-DD" bounds; either side may be open. */
  from: string;
  to: string;
  tracks: string[];
  kinds: string[];
  statuses: string[];
  parties: string[];
  only: CockpitMeetingOnlyFlag[];
}

export function emptyCockpitMeetingFilter(): CockpitMeetingFilter {
  return { query: "", from: "", to: "", tracks: [], kinds: [], statuses: [], parties: [], only: [] };
}

/** What the link-count flag needs from the board: the count, per meeting. */
export interface CockpitMeetingFilterContext {
  linkCounts?: ReadonlyMap<string, number>;
}

function matchesOnly(meeting: CockpitMeeting, flag: CockpitMeetingOnlyFlag, ctx?: CockpitMeetingFilterContext): boolean {
  switch (flag) {
    case "consensus":
      // What leadership reads off a card: an agreement or an action. Minutes
      // alone do not count — a transcript is not a consensus.
      return meeting.decisions.trim() !== "" || meeting.actions.trim() !== "";
    case "folder":
      return meeting.nas_dir.trim() !== "";
    case "links":
      return (ctx?.linkCounts?.get(meeting.id) ?? 0) > 0;
    case "detected":
      return meeting.detected;
  }
}

/** One meeting against one reading of the register. */
export function matchCockpitMeeting(
  meeting: CockpitMeeting,
  filter: CockpitMeetingFilter,
  ctx?: CockpitMeetingFilterContext,
): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query) {
    const haystack = cockpitMeetingSearchHaystack(meeting);
    // Every word must be found: two words narrow, never widen.
    for (const token of query.split(/\s+/)) {
      if (!haystack.includes(token)) return false;
    }
  }
  if (filter.from || filter.to) {
    // A date range is a question about dates; an undated draft has no answer.
    if (!meeting.meet_date) return false;
    if (filter.from && meeting.meet_date < filter.from) return false;
    if (filter.to && meeting.meet_date > filter.to) return false;
  }
  if (filter.tracks.length > 0 && !filter.tracks.includes(meeting.track.trim())) return false;
  if (filter.kinds.length > 0 && !filter.kinds.includes(meeting.kind)) return false;
  if (filter.statuses.length > 0 && !filter.statuses.includes(meeting.status)) return false;
  if (filter.parties.length > 0) {
    const atTheTable = splitCockpitMeetingParties(meeting.parties);
    if (!filter.parties.some((party) => atTheTable.includes(party))) return false;
  }
  for (const flag of filter.only) {
    if (!matchesOnly(meeting, flag, ctx)) return false;
  }
  return true;
}

/** The meetings a filter lets through, in the order they were given. */
export function filterCockpitMeetings(
  meetings: CockpitMeeting[],
  filter: CockpitMeetingFilter,
  ctx?: CockpitMeetingFilterContext,
): CockpitMeeting[] {
  if (!isCockpitMeetingFilterActive(filter)) return meetings;
  return meetings.filter((meeting) => matchCockpitMeeting(meeting, filter, ctx));
}

export function isCockpitMeetingFilterActive(filter: CockpitMeetingFilter): boolean {
  return countCockpitMeetingFilters(filter) > 0;
}

/**
 * How many filter GROUPS are on, for the badge on the funnel button. The date
 * range is one group whether one or both ends are set; the quick search is its
 * own group, so the count matches the chip row one for one.
 */
export function countCockpitMeetingFilters(filter: CockpitMeetingFilter): number {
  let count = 0;
  if (filter.query.trim()) count += 1;
  if (filter.from || filter.to) count += 1;
  if (filter.tracks.length > 0) count += 1;
  if (filter.kinds.length > 0) count += 1;
  if (filter.statuses.length > 0) count += 1;
  if (filter.parties.length > 0) count += 1;
  count += filter.only.length;
  return count;
}
