// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitMeeting } from "../types";
import {
  buildCockpitMeetingTimeline,
  cockpitTimelineDayFraction,
  cockpitTimelineLaneGeometry,
  cockpitTimelineLaneRows,
  cockpitTimelineTicks,
  layoutCockpitTimeline,
} from "./meeting-timeline";

function meeting(over: Partial<CockpitMeeting> & { id: string }): CockpitMeeting {
  return {
    meet_date: null, time_range: "", start_time: null, end_time: null, title: "",
    code: "", kind: "", status: "", track: "", parties: "", organizer: "", location: "",
    attendees: "", meet_no: "", link: "", note: "", minutes: "", decisions: "", actions: "",
    nas_dir: "", detected: false, ...over,
  };
}

describe("building the timeline", () => {
  it("lanes on the track, keeps the seeded order and files the unfiled last", () => {
    const { lanes } = buildCockpitMeetingTimeline(
      [
        meeting({ id: "pm", meet_date: "2026-09-22", track: "项目管理" }),
        meeting({ id: "data", meet_date: "2026-09-04", track: "高质量数据集" }),
        meeting({ id: "none", meet_date: "2026-09-10" }),
      ],
      "2026-09-28",
    );
    expect(lanes.map((l) => l.track)).toEqual(["高质量数据集", "项目管理", ""]);
    expect(lanes[0]!.items[0]!.meetings[0]!.id).toBe("data");
  });

  it("aligns the domain to whole months and always reaches today's month", () => {
    const timeline = buildCockpitMeetingTimeline(
      [meeting({ id: "a", meet_date: "2026-09-04" }), meeting({ id: "b", meet_date: "2026-09-24" })],
      "2026-09-28",
    );
    expect(timeline.from).toBe("2026-09-01");
    expect(timeline.to).toBe("2026-10-01");
    // Every meeting still ahead lands the domain past it; a register of old
    // meetings ends at today's month, not at the last one.
    const ahead = buildCockpitMeetingTimeline(
      [meeting({ id: "a", meet_date: "2026-09-04" }), meeting({ id: "b", meet_date: "2026-12-20" })],
      "2026-09-28",
    );
    expect(ahead.to).toBe("2027-01-01");
  });

  it("holds undated meetings back instead of dropping them", () => {
    const timeline = buildCockpitMeetingTimeline(
      [meeting({ id: "a", meet_date: "2026-09-04" }), meeting({ id: "draft" })],
      "2026-09-28",
    );
    expect(timeline.undated.map((m) => m.id)).toEqual(["draft"]);
    expect(timeline.lanes.flatMap((l) => l.items).flatMap((i) => i.meetings).map((m) => m.id)).toEqual(["a"]);
  });

  it("places a meeting by its day and its slot within it", () => {
    const { lanes } = buildCockpitMeetingTimeline(
      [
        meeting({ id: "morning", meet_date: "2026-09-22", start_time: "09:00" }),
        meeting({ id: "afternoon", meet_date: "2026-09-23", start_time: "15:00" }),
      ],
      "2026-09-28",
    );
    const [a, b] = lanes[0]!.items;
    expect(a!.meetings[0]!.id).toBe("morning");
    expect(a!.at).toBeLessThan(b!.at);
    // September has 30 days: the 22nd at 09:00 sits at 21 + 9/24 days in.
    expect(a!.at).toBeCloseTo((21 + 9 / 24) / 30, 5);
  });

  it("shares one card across a day's meetings, keyed by the first one's slot", () => {
    const { lanes } = buildCockpitMeetingTimeline(
      [
        meeting({ id: "second", meet_date: "2026-09-21", start_time: "15:00" }),
        meeting({ id: "first", meet_date: "2026-09-21", start_time: "09:00" }),
        meeting({ id: "other-track", meet_date: "2026-09-21", track: "AI平台" }),
        meeting({ id: "other-day", meet_date: "2026-09-22" }),
      ],
      "2026-09-28",
    );
    const main = lanes.find((l) => l.track === "")!;
    // Two meetings of one day fold into a single group; a different day or a
    // different track is a card of its own.
    expect(main.items.map((g) => [g.day, g.meetings.map((m) => m.id)])).toEqual([
      ["2026-09-21", ["first", "second"]],
      ["2026-09-22", ["other-day"]],
    ]);
    // The group sits at its earliest meeting's slot, not at midday.
    expect(main.items[0]!.at).toBeCloseTo((20 + 9 / 24) / 30, 5);
    expect(lanes.find((l) => l.track === "AI平台")!.items).toHaveLength(1);
  });

  it("reads an empty register as an empty timeline around today", () => {
    const timeline = buildCockpitMeetingTimeline([], "2026-09-28");
    expect(timeline.lanes).toEqual([]);
    expect(timeline.from).toBe("2026-09-01");
    expect(timeline.to).toBe("2026-10-01");
    expect(cockpitTimelineDayFraction(meeting({ id: "x" }))).toBe(0.5);
    expect(cockpitTimelineDayFraction(meeting({ id: "x", start_time: "12:00" }))).toBe(0.5);
  });
});

describe("stacking cards", () => {
  it("keeps meetings that clear each other on the rail and zigzags the rest", () => {
    const layout = layoutCockpitTimeline(
      [
        { id: "a", at: 0.05 },
        { id: "b", at: 0.06 },
        { id: "c", at: 0.07 },
        { id: "far", at: 0.9 },
      ],
      1000,
      200,
    );
    const byId = new Map(layout.map((p) => [p.id, p]));
    // a spans [0,100] clamped; b's centre is 60 → overlaps a on tier 0, so it
    // hangs below; c's is 70 → still inside b's span below, so tier 2 (above
    // again, one row out).
    expect(byId.get("a")).toMatchObject({ side: "above", row: 0 });
    expect(byId.get("b")).toMatchObject({ side: "below", row: 0 });
    expect(byId.get("c")).toMatchObject({ side: "above", row: 1 });
    expect(byId.get("far")).toMatchObject({ side: "above", row: 0 });
  });

  it("counts the tiers a lane must make room for", () => {
    const layout = layoutCockpitTimeline(
      [{ id: "a", at: 0.05 }, { id: "b", at: 0.06 }, { id: "c", at: 0.07 }, { id: "d", at: 0.08 }],
      1000,
      200,
    );
    expect(cockpitTimelineLaneRows(layout)).toEqual({ above: 2, below: 2 });
  });

  it("clamps the last card onto the lane instead of past its right edge", () => {
    // 0.99 of 1000px centres the card at 990 → its right edge would leave the
    // lane; clamping pulls it back in, which the NEXT card then overlaps.
    const layout = layoutCockpitTimeline(
      [{ id: "edge", at: 0.99 }, { id: "edge2", at: 1 }],
      1000,
      200,
    );
    const byId = new Map(layout.map((p) => [p.id, p]));
    expect(byId.get("edge")!.x).toBeLessThanOrEqual(1000 - 100);
    expect(byId.get("edge2")!.level).toBeGreaterThan(byId.get("edge")!.level);
  });
});

describe("lane geometry", () => {
  // Mirrors the view's fixed card geometry; the lane must hold exactly these
  // pixels. If the view's card grows, grow this too.
  const geom = { cardH: 78, rowPitch: 86, railPx: 20, clearance: 4, pad: 4 };

  it("sizes the lane so the outermost card never crosses its edge", () => {
    // The regression this guards: a lane sized (above+below)*pitch + rail
    // puts an above-row-0 card's top 34px into the lane above it.
    const { height, railY } = cockpitTimelineLaneGeometry({ above: 1, below: 0 }, geom);
    // Above row 0: card bottom sits rail/2 + clearance above the rail, top a
    // card-height further — and must land exactly on the pad, not past it.
    const cardTop = railY - (20 / 2 + 4 + 78);
    expect(cardTop).toBe(geom.pad);
    expect(height).toBe(railY + 20 / 2 + geom.pad);
  });

  it("pays only for the side the cards are on", () => {
    const flat = cockpitTimelineLaneGeometry({ above: 0, below: 0 }, geom);
    expect(flat.height).toBe(20 + 2 * geom.pad);
    const oneSided = cockpitTimelineLaneGeometry({ above: 2, below: 0 }, geom);
    const symmetric = cockpitTimelineLaneGeometry({ above: 2, below: 2 }, geom);
    // A lopsided lane is two tiers + the rail, not double that.
    expect(oneSided.height).toBe((20 / 2 + 4 + 86 + 78) + 20 / 2 + 2 * geom.pad);
    expect(symmetric.height).toBe(2 * (20 / 2 + 4 + 86 + 78) + 2 * geom.pad);
    expect(symmetric.railY).toBe(symmetric.height / 2);
  });

  it("holds the tallest tier inside the lane on both sides", () => {
    const rows = { above: 2, below: 1 };
    const { height, railY } = cockpitTimelineLaneGeometry(rows, geom);
    const topmost = railY - (20 / 2 + 4 + 86 + 78);
    const bottommost = railY + (20 / 2 + 4 + 78);
    expect(topmost).toBe(geom.pad);
    expect(height - bottommost).toBe(geom.pad);
  });
});

describe("axis ticks", () => {
  it("names weeks while a week is wide enough, months after that", () => {
    // 40 days at 1000px is 25px/day: weekly ticks, landing on Mondays. A tick
    // before the domain's first day is off the axis and dropped.
    const weekly = cockpitTimelineTicks("2026-09-01", "2026-10-01", 1000);
    expect(weekly.every((t) => t.step === "week")).toBe(true);
    expect(weekly[0]!.day).toBe("2026-09-07");
    expect(weekly.map((t) => t.day)).toContain("2026-09-28");

    // 40 days at 200px is 5px/day: months.
    const monthly = cockpitTimelineTicks("2026-09-01", "2026-10-01", 200);
    expect(monthly.map((t) => t.day)).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("coarsens to quarters and years as the domain outgrows the width", () => {
    // A year at 400px names a month in 33px — too tight, so quarters.
    const quarters = cockpitTimelineTicks("2026-01-01", "2027-01-01", 400);
    expect(quarters.every((t) => t.step === "quarter")).toBe(true);
    expect(quarters.map((t) => t.day)).toEqual(
      ["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01", "2027-01-01"],
    );
    const years = cockpitTimelineTicks("2026-01-01", "2031-01-01", 800);
    expect(years.every((t) => t.step === "year")).toBe(true);
    expect(years.length).toBeGreaterThanOrEqual(5);
  });
});
