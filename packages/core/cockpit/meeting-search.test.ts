// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitMeeting } from "../types";
import {
  COCKPIT_MEETING_TRACKS,
  cockpitMeetingTrackColor,
  cockpitMeetingTracksInUse,
  cockpitMeetingVocabulary,
} from "./model";
import {
  countCockpitMeetingFilters,
  emptyCockpitMeetingFilter,
  filterCockpitMeetings,
  isCockpitMeetingFilterActive,
  matchCockpitMeeting,
  type CockpitMeetingFilter,
} from "./meeting-search";

function meeting(over: Partial<CockpitMeeting> & { id: string }): CockpitMeeting {
  return {
    meet_date: null, time_range: "", start_time: null, end_time: null, title: "",
    code: "", kind: "", status: "", track: "", parties: "", organizer: "", location: "",
    attendees: "", meet_no: "", link: "", note: "", minutes: "", decisions: "", actions: "",
    nas_dir: "", detected: false, ...over,
  };
}

function filter(over: Partial<CockpitMeetingFilter>): CockpitMeetingFilter {
  return { ...emptyCockpitMeetingFilter(), ...over };
}

describe("the track vocabulary", () => {
  it("seeds the programme's four lines before the board has used any", () => {
    expect(COCKPIT_MEETING_TRACKS).toEqual(["高质量数据集", "AI平台", "合规和质量体系", "项目管理"]);
    expect(cockpitMeetingVocabulary([]).tracks).toEqual([...COCKPIT_MEETING_TRACKS]);
  });

  it("keeps a line the programme invented alongside the seeded ones", () => {
    const vocabulary = cockpitMeetingVocabulary([meeting({ id: "a", track: "对外交流" })]);
    expect(vocabulary.tracks).toContain("对外交流");
    expect(vocabulary.tracks).toContain("高质量数据集");
  });

  it("colours the seeded lines stably and an invented one from the ramp", () => {
    expect(cockpitMeetingTrackColor("AI平台")).toBe("#2563eb");
    const invented = cockpitMeetingTrackColor("对外交流");
    expect(invented).toMatch(/^#/);
    expect(cockpitMeetingTrackColor("对外交流")).toBe(invented);
    expect(cockpitMeetingTrackColor("对外交流")).not.toBe(cockpitMeetingTrackColor("国际合作"));
    // The unfiled lane draws no colour by lot — it stays neutral grey.
    expect(cockpitMeetingTrackColor("")).toBe("#64748b");
  });

  it("orders lanes seeded-first, invented next, the unfiled lane last", () => {
    const rows = [
      meeting({ id: "a", meet_date: "2026-09-02", track: "项目管理" }),
      meeting({ id: "b", meet_date: "2026-09-03", track: "对外交流" }),
      meeting({ id: "c", meet_date: "2026-09-04" }),
      meeting({ id: "d", meet_date: "2026-09-05", track: "高质量数据集" }),
      // An undated meeting does not open a lane by itself.
      meeting({ id: "e", track: "AI平台" }),
    ];
    expect(cockpitMeetingTracksInUse(rows)).toEqual(["高质量数据集", "项目管理", "对外交流", ""]);
    expect(cockpitMeetingTracksInUse([meeting({ id: "x" })])).toEqual([]);
  });
});

describe("the quick search", () => {
  const row = meeting({
    id: "a",
    title: "高质量数据集一体机研讨会",
    code: "20260923-01",
    parties: "中国联通、华为制药军团",
    organizer: "杨涛",
    decisions: "双方确认 10 月出一体机样机",
  });

  it("finds a meeting by a word of anything it says", () => {
    for (const query of ["一体机", "20260923-01", "华为", "杨涛", "样机"]) {
      expect(matchCockpitMeeting(row, filter({ query }))).toBe(true);
    }
    expect(matchCockpitMeeting(row, filter({ query: "评审" }))).toBe(false);
  });

  it("is case-insensitive and every word must be found", () => {
    const withTrack = meeting({ ...row, track: "AI平台" });
    expect(matchCockpitMeeting(withTrack, filter({ query: "ai平台" }))).toBe(true);
    expect(matchCockpitMeeting(row, filter({ query: "联通 样机" }))).toBe(true);
    expect(matchCockpitMeeting(row, filter({ query: "联通 样机 评审" }))).toBe(false);
  });
});

describe("the detailed filters", () => {
  const rows = [
    meeting({ id: "held", meet_date: "2026-09-04", kind: "研讨会", status: "已召开",
      track: "合规和质量体系", parties: "复星医药、华大基因", decisions: "通过 v3 口径" }),
    meeting({ id: "planned", meet_date: "2026-10-08", kind: "对接会", status: "待确认",
      track: "AI平台", parties: "明略科技", nas_dir: "/Volumes/share/x" }),
    meeting({ id: "draft", kind: "例会" }),
  ];

  it("bounds by date, and an undated draft has no answer to a date range", () => {
    expect(filterCockpitMeetings(rows, filter({ from: "2026-09-01", to: "2026-09-30" }))
      .map((m) => m.id)).toEqual(["held"]);
    expect(filterCockpitMeetings(rows, filter({ from: "2026-10-01" })).map((m) => m.id))
      .toEqual(["planned"]);
    // No range at all leaves the drafts in.
    expect(filterCockpitMeetings(rows, filter({ kinds: ["例会"] })).map((m) => m.id))
      .toEqual(["draft"]);
  });

  it("filters by line, kind and status, several values meaning any-of", () => {
    expect(filterCockpitMeetings(rows, filter({ tracks: ["AI平台"] })).map((m) => m.id))
      .toEqual(["planned"]);
    expect(filterCockpitMeetings(rows, filter({ kinds: ["研讨会", "例会"] })).map((m) => m.id))
      .toEqual(["held", "draft"]);
    expect(filterCockpitMeetings(rows, filter({ statuses: ["已召开"] })).map((m) => m.id))
      .toEqual(["held"]);
  });

  it("can ask for the unfiled lane by name: the empty track", () => {
    expect(filterCockpitMeetings(rows, filter({ tracks: [""] })).map((m) => m.id))
      .toEqual(["draft"]);
  });

  it("matches a party against the meeting's list, not as a substring", () => {
    // "复星医药大湾区总部" must not answer a filter for "复星医药".
    const long = meeting({ id: "long", parties: "复星医药大湾区总部" });
    expect(filterCockpitMeetings([...rows, long], filter({ parties: ["复星医药"] })).map((m) => m.id))
      .toEqual(["held"]);
  });

  it("reads the only-switches one by one", () => {
    expect(filterCockpitMeetings(rows, filter({ only: ["consensus"] })).map((m) => m.id))
      .toEqual(["held"]);
    expect(filterCockpitMeetings(rows, filter({ only: ["folder"] })).map((m) => m.id))
      .toEqual(["planned"]);
    const linkCounts = new Map([["draft", 2]]);
    expect(filterCockpitMeetings(rows, filter({ only: ["links"] }), { linkCounts }).map((m) => m.id))
      .toEqual(["draft"]);
    const flagged = meeting({ id: "scan", detected: true });
    expect(filterCockpitMeetings([...rows, flagged], filter({ only: ["detected"] })).map((m) => m.id))
      .toEqual(["scan"]);
    // Two switches at once narrow rather than widen.
    expect(filterCockpitMeetings(rows, filter({ only: ["consensus", "folder"] }))).toEqual([]);
  });

  it("counts groups for the badge: the range is one group however many ends are set", () => {
    expect(isCockpitMeetingFilterActive(emptyCockpitMeetingFilter())).toBe(false);
    expect(countCockpitMeetingFilters(filter({ from: "2026-09-01", to: "2026-09-30" }))).toBe(1);
    expect(countCockpitMeetingFilters(filter({
      query: "一体机", tracks: ["AI平台"], kinds: ["研讨会"], only: ["consensus", "detected"],
    }))).toBe(5);
  });
});
