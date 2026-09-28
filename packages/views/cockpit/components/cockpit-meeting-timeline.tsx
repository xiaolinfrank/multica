"use client";

// The register as a timeline: one lane per line of the programme, the year's
// meetings strung along it by when they happened.
//
// This is the view a leadership review reads: not when the calendar says a
// meeting is, but what each line has moved — the date, who sat at the table,
// and what was agreed. The layout arithmetic (domains, lanes, ticks, which
// card stacks over which) is in @multica/core/cockpit; this file only renders
// it, so a pixel decision here can never disagree with the tested one.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CockpitMeeting } from "@multica/core/types";
import {
  buildCockpitMeetingTimeline,
  cockpitMeetingSpan,
  cockpitTimelineLaneGeometry,
  cockpitTimelineLaneRows,
  cockpitTimelineTicks,
  layoutCockpitTimeline,
  parseDay,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import {
  CalendarDays,
  CircleCheck,
  ClipboardList,
  Crosshair,
  Download,
  ScanSearch,
  Users,
} from "lucide-react";
import { useLocale, useT } from "../../i18n";
import { captureCockpitGantt, downloadCockpitPng } from "./cockpit-export";

// The card geometry. Fixed heights are what let the core layout promise no
// two cards overlap without ever measuring the DOM — every clamp below is
// part of that contract. 88px is what the four content lines (date pill,
// title, parties, consensus) plus padding actually occupy; anything shorter
// and the flex column squeezes the title line flat.
const CARD_PX = 208;
const CARD_H_PX = 88;
/** Vertical distance between tiers of cards on one side of the rail. */
const ROW_PITCH = CARD_H_PX + 10;
/** The rail's own band at the lane's vertical centre. */
const RAIL_PX = 26;
/** A card's edge clears the rail by this much; its stem spans the gap. */
const CARD_CLEARANCE = 8;
const LANE_LABEL_PX = 132;
/** Horizontal breathing room around the canvas inside each lane row. */
const LANE_PAD_PX = 12;
/** Vertical breathing room between the outermost card and the lane's edge. */
const LANE_VPAD_PX = 10;
/** Free-scroll mode: pixels per day. Fit mode derives its own from the box. */
const PX_PER_DAY = 18;

/** The fixed card geometry handed to the core lane-sizing arithmetic. */
const LANE_GEOM = {
  cardH: CARD_H_PX,
  rowPitch: ROW_PITCH,
  railPx: RAIL_PX,
  clearance: CARD_CLEARANCE,
  pad: LANE_VPAD_PX,
};

export interface CockpitMeetingTimelineProps {
  meetings: CockpitMeeting[];
  today: string;
  selectedId: string | null;
  onSelect: (meetingId: string) => void;
}

/** What a card says about what the meeting produced, and with which icon. */
function consensusOf(meeting: CockpitMeeting): { icon: "decision" | "agenda"; text: string } | null {
  const firstLine = (value: string) => value.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const decision = firstLine(meeting.decisions) || firstLine(meeting.actions);
  if (decision) return { icon: "decision", text: decision };
  const agenda = firstLine(meeting.note);
  if (agenda) return { icon: "agenda", text: agenda };
  return null;
}

/** One meeting as a card on its lane, plus its marker and stem on the rail. */
function TimelineCard({
  meeting,
  x,
  side,
  row,
  laneColor,
  today,
  selected,
  onSelect,
}: {
  meeting: CockpitMeeting;
  x: number;
  side: "above" | "below";
  row: number;
  laneColor: string;
  today: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useT("cockpit");
  const past = (meeting.meet_date ?? "") < today;
  const cancelled = meeting.status.trim() === "已取消";
  const consensus = consensusOf(meeting);
  const span = cockpitMeetingSpan(meeting);

  // Marker, stem and card share one horizontal centre — the clamped one — so
  // an edge day's card sliding inboard never disconnects from its marker.
  // Vertically they hang off a zero-height context pinned at the rail, so the
  // card's distance from the rail is exactly the stem's length.
  const stemLength = RAIL_PX / 2 + CARD_CLEARANCE + row * ROW_PITCH;

  return (
    <>
      {/* The stem: from the rail to the card's near edge. */}
      <div
        aria-hidden
        className="absolute w-px"
        style={{
          left: x,
          height: stemLength,
          backgroundColor: `color-mix(in oklab, ${laneColor} 40%, transparent)`,
          ...(side === "above" ? { bottom: 0 } : { top: 0 }),
        }}
      />
      {/* The marker on the rail: solid for a meeting that ran, a ring for one
          still ahead, dimmed for one that was cancelled. */}
      <span
        aria-hidden
        className={cn(
          "absolute z-10 size-2.5 rounded-full",
          past && !cancelled ? "" : "border-2 bg-card",
          cancelled && "opacity-40",
        )}
        style={{
          left: x,
          top: 0,
          transform: "translate(-50%, -50%)",
          backgroundColor: past && !cancelled ? laneColor : undefined,
          borderColor: laneColor,
        }}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-label={t(($) => $.meetings.select, { title: meeting.title })}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group/card absolute z-10 flex -translate-x-1/2 flex-col justify-center gap-0.5 overflow-hidden rounded-lg border bg-card px-2 py-1.5 text-left",
          "shadow-xs transition-all duration-150 hover:z-20 hover:shadow-md",
          side === "above" ? "hover:-translate-y-0.5" : "hover:translate-y-0.5",
          "focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          cancelled && "opacity-50",
        )}
        style={{
          left: x,
          width: CARD_PX,
          height: CARD_H_PX,
          borderColor: selected
            ? laneColor
            : `color-mix(in oklab, ${laneColor} ${past ? "18%" : "38%"}, var(--border))`,
          ...(side === "above" ? { bottom: stemLength } : { top: stemLength }),
          ...(selected ? { boxShadow: `0 0 0 1.5px ${laneColor}` } : {}),
        }}
      >
        <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
          <span
            className="inline-flex items-center gap-1 rounded-sm px-1 py-px font-medium tabular-nums"
            style={{
              color: laneColor,
              backgroundColor: `color-mix(in oklab, ${laneColor} 10%, transparent)`,
            }}
          >
            <CalendarDays className="size-3" aria-hidden />
            {meeting.meet_date?.slice(5).replace("-", ".")}
          </span>
          {span && <span className="tabular-nums">{span}</span>}
          {meeting.kind && <span className="truncate">{meeting.kind}</span>}
          {meeting.detected && (
            <ScanSearch className="size-3 shrink-0" aria-label={t(($) => $.meeting.detected)} />
          )}
        </span>
        <span
          className={cn(
            "line-clamp-1 shrink-0 text-caption leading-snug font-medium",
            cancelled && "line-through",
          )}
        >
          {meeting.title || t(($) => $.meeting.title_placeholder)}
        </span>
        {meeting.parties && (
          <span className="flex items-center gap-1 text-micro text-muted-foreground">
            <Users className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{meeting.parties}</span>
          </span>
        )}
        {consensus && (
          <span className="flex items-center gap-1 text-micro">
            {consensus.icon === "decision" ? (
              <CircleCheck className="size-3 shrink-0 text-success" aria-hidden />
            ) : (
              <ClipboardList className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="truncate text-muted-foreground">{consensus.text}</span>
          </span>
        )}
      </button>
    </>
  );
}

export function CockpitMeetingTimeline({
  meetings,
  today,
  selectedId,
  onSelect,
}: CockpitMeetingTimelineProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const captureRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  // Fit is the review answer — the whole programme in one eyeful. Free scroll
  // is the working answer for a dense year: every day gets its pixels and the
  // view pans.
  const [fit, setFit] = useState(true);
  const [exporting, setExporting] = useState(false);

  const timeline = useMemo(() => buildCockpitMeetingTimeline(meetings, today), [meetings, today]);

  const spanDays = useMemo(() => {
    const from = parseDay(timeline.from);
    const to = parseDay(timeline.to);
    return from && to ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000)) : 1;
  }, [timeline.from, timeline.to]);

  // The canvas the lanes paint on: the container's width in fit mode, the
  // domain's worth of days in scroll mode.
  const canvasPx = fit
    ? Math.max(320, boxWidth - LANE_LABEL_PX - LANE_PAD_PX * 2)
    : Math.max(640, spanDays * PX_PER_DAY);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    setBoxWidth(box.clientWidth);
    return () => observer.disconnect();
  }, []);

  const ticks = useMemo(
    () => cockpitTimelineTicks(timeline.from, timeline.to, canvasPx),
    [timeline.from, timeline.to, canvasPx],
  );

  const todayX = useMemo(() => {
    const from = parseDay(timeline.from);
    const to = parseDay(timeline.to);
    const now = parseDay(today);
    if (!from || !to || !now) return null;
    const at = (now.getTime() - from.getTime()) / (to.getTime() - from.getTime());
    if (at < 0 || at > 1) return null;
    // A half-day nudge puts the line inside today rather than on its edge.
    return (at + 0.5 / spanDays) * canvasPx;
  }, [timeline.from, timeline.to, today, spanDays, canvasPx]);

  // Alternate-month banding: the background rhythm that keeps the eye honest
  // about which month a card belongs to without a gridline per week.
  const bands = useMemo(() => {
    const from = parseDay(timeline.from);
    const to = parseDay(timeline.to);
    if (!from || !to) return [];
    const span = to.getTime() - from.getTime();
    const out: { left: number; width: number }[] = [];
    let cursor = from;
    let i = 0;
    while (cursor.getTime() < to.getTime()) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      const left = ((cursor.getTime() - from.getTime()) / span) * canvasPx;
      const width = ((Math.min(next.getTime(), to.getTime()) - cursor.getTime()) / span) * canvasPx;
      if (i % 2 === 1) out.push({ left, width });
      cursor = next;
      i += 1;
    }
    return out;
  }, [timeline.from, timeline.to, canvasPx]);

  const laneLayouts = useMemo(
    () =>
      timeline.lanes.map((lane) => {
        const placements = layoutCockpitTimeline(
          lane.items.map((item) => ({ id: item.meeting.id, at: item.at })),
          canvasPx,
          CARD_PX,
          10,
        );
        const byId = new Map(placements.map((p) => [p.id, p]));
        const rows = cockpitTimelineLaneRows(placements);
        return { lane, byId, rows };
      }),
    [timeline, canvasPx],
  );

  const tickLabel = useMemo(() => {
    const week = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", timeZone: "UTC" });
    const month = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" });
    const year = new Intl.DateTimeFormat(locale, { year: "numeric", timeZone: "UTC" });
    return { week, month, quarter: month, year };
  }, [locale]);

  const scrollToToday = () => {
    const box = scrollRef.current;
    if (!box || todayX === null) return;
    box.scrollTo({
      left: LANE_LABEL_PX + LANE_PAD_PX + todayX - box.clientWidth / 2,
      behavior: "smooth",
    });
  };

  const exportPng = async () => {
    const root = captureRef.current;
    if (!root || exporting) return;
    setExporting(true);
    try {
      const canvas = await captureCockpitGantt(root, false, "Timeline");
      await downloadCockpitPng(canvas, `meetings-timeline-${today}.png`);
    } finally {
      setExporting(false);
    }
  };

  if (timeline.lanes.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-4">
        <p className="text-body text-muted-foreground">{t(($) => $.timeline.empty)}</p>
        {timeline.undated.length > 0 && (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.timeline.undated, { n: timeline.undated.length })}
          </p>
        )}
      </div>
    );
  }

  const anyTrack = timeline.lanes.some((lane) => lane.track !== "");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The view's own toolbar: scale, "back to today", and the PNG a review
          deck is made of. Kept out of the capture ref below. */}
      <div className="flex items-center justify-end gap-2 px-4 pb-2">
        {todayX !== null && !fit && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={scrollToToday}>
            <Crosshair className="size-3.5" />
            {t(($) => $.meetings.today)}
          </Button>
        )}
        <div
          className="flex items-center rounded-md bg-muted p-0.5"
          role="group"
          aria-label={t(($) => $.timeline.scale)}
        >
          {(["fit", "free"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={fit === (mode === "fit")}
              onClick={() => setFit(mode === "fit")}
              className={cn(
                "rounded-sm px-2 py-0.5 text-micro transition-colors",
                fit === (mode === "fit")
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "fit" ? t(($) => $.timeline.fit) : t(($) => $.timeline.free)}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2"
          disabled={exporting}
          aria-busy={exporting}
          onClick={() => void exportPng()}
        >
          <Download className="size-3.5" />
          {t(($) => $.timeline.export_png)}
        </Button>
      </div>

      <div ref={captureRef} className="flex min-h-0 flex-1 flex-col" data-cockpit-timeline>
        <div ref={scrollRef} data-cockpit-scroll className="min-h-0 flex-1 overflow-auto">
          <div style={{ width: LANE_LABEL_PX + LANE_PAD_PX * 2 + canvasPx, minWidth: "100%" }}>
            {/* The axis: ticks on a strip the lanes share. */}
            <div className="sticky top-0 z-30 flex bg-card/95 backdrop-blur-xs">
              <div
                className="sticky left-0 z-40 shrink-0 border-b border-border bg-card"
                style={{ width: LANE_LABEL_PX }}
              />
              <div
                className="relative h-8 shrink-0 border-b border-border"
                style={{ width: LANE_PAD_PX * 2 + canvasPx }}
              >
                {ticks.map((tick) => {
                  const date = parseDay(tick.day);
                  if (!date) return null;
                  return (
                    <div
                      key={`${tick.step}-${tick.day}`}
                      className="absolute top-0 flex h-full flex-col items-start"
                      style={{ left: LANE_PAD_PX + tick.at * canvasPx }}
                    >
                      <span
                        className={cn(
                          "text-micro whitespace-nowrap tabular-nums",
                          tick.step === "week"
                            ? "pt-1.5 text-faint-foreground"
                            : "pt-1 font-medium text-muted-foreground",
                        )}
                      >
                        {tick.step === "week"
                          ? tickLabel.week.format(date)
                          : tick.step === "year"
                            ? tickLabel.year.format(date)
                            : tickLabel.month.format(date)}
                      </span>
                      <span className="mt-auto h-1.5 w-px bg-border" aria-hidden />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* The lanes. */}
            <div className="relative">
              {laneLayouts.map(({ lane, byId, rows }) => {
                // The rail sits between the tiers actually in use, not at the
                // lane's midpoint — a lane whose cards all hang one way stays
                // compact, and no card ever crosses the lane's own edge.
                const { height, railY } = cockpitTimelineLaneGeometry(rows, LANE_GEOM);
                return (
                  <div key={lane.track || "__unfiled__"} className="flex border-b border-border/60">
                    <div
                      className="sticky left-0 z-30 flex shrink-0 flex-col justify-center gap-0.5 border-r border-border/60 bg-card px-3"
                      style={{ width: LANE_LABEL_PX, height }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: lane.color }}
                          aria-hidden
                        />
                        <span className="truncate text-caption font-medium">
                          {lane.track || t(($) => $.meetings.track_none)}
                        </span>
                      </span>
                      <span className="text-micro text-muted-foreground tabular-nums">
                        {t(($) => $.timeline.lane_count, { n: lane.items.length })}
                      </span>
                    </div>

                    <div
                      className="relative shrink-0"
                      style={{ width: LANE_PAD_PX * 2 + canvasPx, height }}
                    >
                      {/* Month banding behind the cards. */}
                      {bands.map((band, i) => (
                        <div
                          key={i}
                          aria-hidden
                          className="absolute top-0 bottom-0 bg-muted/25"
                          style={{ left: LANE_PAD_PX + band.left, width: band.width }}
                        />
                      ))}
                      {/* The rail the meetings hang from. */}
                      <div
                        aria-hidden
                        className="absolute rounded-full"
                        style={{
                          top: railY,
                          left: LANE_PAD_PX,
                          width: canvasPx,
                          height: 2,
                          marginTop: -1,
                          background: `linear-gradient(to right, color-mix(in oklab, ${lane.color} 12%, transparent), color-mix(in oklab, ${lane.color} 55%, transparent), color-mix(in oklab, ${lane.color} 12%, transparent))`,
                        }}
                      />
                      {/* Zero-height context at the rail: everything a meeting
                          paints measures its distance from here. */}
                      <div
                        className="absolute"
                        style={{ top: railY, left: LANE_PAD_PX, width: canvasPx, height: 0 }}
                      >
                        {lane.items.map((item) => {
                          const placement = byId.get(item.meeting.id)!;
                          return (
                            <TimelineCard
                              key={item.meeting.id}
                              meeting={item.meeting}
                              x={placement.x}
                              side={placement.side}
                              row={placement.row}
                              laneColor={lane.color}
                              today={today}
                              selected={selectedId === item.meeting.id}
                              onSelect={() => onSelect(item.meeting.id)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Today, drawn once across every lane. */}
              {todayX !== null && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute top-0 bottom-0 z-10"
                  style={{ left: LANE_LABEL_PX + LANE_PAD_PX + todayX }}
                >
                  <div className="h-full w-px border-l border-dashed border-brand/70" />
                  <span className="absolute top-0 -translate-x-1/2 rounded-full bg-brand px-1.5 py-px text-micro font-medium whitespace-nowrap text-brand-foreground">
                    {t(($) => $.timeline.today_at, { date: today.slice(5).replace("-", ".") })}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* What the timeline cannot place still gets said. */}
        {(timeline.undated.length > 0 || !anyTrack) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2">
            {timeline.undated.length > 0 && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.timeline.undated, { n: timeline.undated.length })}
              </p>
            )}
            {!anyTrack && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.timeline.untracked_hint)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
