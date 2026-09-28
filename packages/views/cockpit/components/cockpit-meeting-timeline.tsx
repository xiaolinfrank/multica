"use client";

// The register as a timeline: one lane per line of the programme, the year's
// meetings strung along it by when they happened.
//
// This is the view a leadership review reads: not when the calendar says a
// meeting is, but what each line has moved — the date, who sat at the table,
// and what was agreed. The layout arithmetic (domains, lanes, ticks, which
// card stacks over which) is in @multica/core/cockpit; this file only renders
// it, so a pixel decision here can never disagree with the tested one.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CockpitMeeting } from "@multica/core/types";
import type { CockpitTimelineGroup } from "@multica/core/cockpit";
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
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import {
  CalendarDays,
  CircleCheck,
  ClipboardList,
  Crosshair,
  Download,
  ScanSearch,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useLocale, useT } from "../../i18n";
import { captureCockpitGantt, downloadCockpitPng } from "./cockpit-export";

// The card geometry. Fixed heights are what let the core layout promise no
// two cards overlap without ever measuring the DOM — every clamp below is
// part of that contract. 78px is what the four content lines (date pill,
// title, parties, consensus) occupy at tight leading; the whole geometry
// budget is set so the four programme lanes fit one screen end to end.
const CARD_PX = 208;
const CARD_H_PX = 78;
/** Vertical distance between tiers of cards on one side of the rail. */
const ROW_PITCH = CARD_H_PX + 8;
/** The rail's own band at the lane's vertical centre. */
const RAIL_PX = 20;
/** A card's edge clears the rail by this much; its stem spans the gap. */
const CARD_CLEARANCE = 4;
const LANE_LABEL_PX = 132;
/** Horizontal breathing room around the canvas inside each lane row. */
const LANE_PAD_PX = 12;
/** Vertical breathing room between the outermost card and the lane's edge. */
const LANE_VPAD_PX = 4;
/** Free-scroll mode: pixels per day. Fit mode derives its own from the box. */
const PX_PER_DAY = 18;
/** Continuous zoom bounds, in px/day. 6 fits ~a year of a dense programme in
 *  one screenful of scrollable canvas; 80 makes one day read like a diary. */
const DAY_PX_MIN = 6;
const DAY_PX_MAX = 80;
/** The mode switch and toolbar zooms animate at this length; trackpad pinch
 *  follows the gesture with no transition at all (a map, not a slideshow). */
const ZOOM_MS = 340;
const ZOOM_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Transition shorthand: 0 means "follow the gesture", anything larger is the
 *  eased zoom. Lists the box properties a scale change moves, so a card's
 *  hover transform keeps its own quick timing in TimelineCard. */
function zoomTransition(ms: number, props: string[]): string | undefined {
  if (ms <= 0) return undefined;
  return props.map((p) => `${p} ${ms}ms ${ZOOM_EASE}`).join(", ");
}

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

/**
 * One day on a lane as a card — the day's meetings folded into one — plus
 * its marker and stem on the rail. A single meeting renders the full card; a
 * busier day names its first two meetings and opens the rest in a popover, so
 * an acceptance day stays one tier tall instead of stacking three deep.
 */
function TimelineCard({
  group,
  x,
  side,
  row,
  laneColor,
  today,
  selectedId,
  onSelect,
  zoomMs,
}: {
  group: CockpitTimelineGroup;
  x: number;
  side: "above" | "below";
  row: number;
  laneColor: string;
  today: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** >0 eases position changes (mode switch); 0 follows a pinch gesture. */
  zoomMs: number;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const single = group.meetings.length === 1 ? group.meetings[0]! : null;
  const past = group.day < today;
  const allCancelled = group.meetings.every((m) => m.status.trim() === "已取消");
  const cancelled = single ? single.status.trim() === "已取消" : allCancelled;
  const consensus = single ? consensusOf(single) : null;
  const span = single ? cockpitMeetingSpan(single) : null;
  const selected = group.meetings.some((m) => m.id === selectedId);

  // Marker, stem and card share one horizontal centre — the clamped one — so
  // an edge day's card sliding inboard never disconnects from its marker.
  // Vertically they hang off a zero-height context pinned at the rail, so the
  // card's distance from the rail is exactly the stem's length.
  const stemLength = RAIL_PX / 2 + CARD_CLEARANCE + row * ROW_PITCH;

  const cardClassName = cn(
    "group/card absolute z-10 flex -translate-x-1/2 flex-col justify-center gap-0.5 overflow-hidden rounded-lg border bg-card px-2 py-1 text-left",
    "shadow-xs transition-all duration-150 hover:z-20 hover:shadow-md",
    side === "above" ? "hover:-translate-y-0.5" : "hover:translate-y-0.5",
    "focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    cancelled && "opacity-50",
  );
  const cardStyle = {
    left: x,
    width: CARD_PX,
    height: CARD_H_PX,
    borderColor: selected
      ? laneColor
      : `color-mix(in oklab, ${laneColor} ${past ? "18%" : "38%"}, var(--border))`,
    ...(side === "above" ? { bottom: stemLength } : { top: stemLength }),
    ...(selected ? { boxShadow: `0 0 0 1.5px ${laneColor}` } : {}),
    // The zoom glides the box properties; hover's transform keeps its own
    // quick timing so the card still feels responsive mid-zoom.
    transition: [
      zoomTransition(zoomMs, ["left", "top", "bottom"]),
      "transform 150ms ease, box-shadow 150ms ease",
    ]
      .filter(Boolean)
      .join(", "),
  } as const;

  const datePill = (
    <span
      className="inline-flex items-center gap-1 rounded-sm px-1 py-px font-medium tabular-nums"
      style={{
        color: laneColor,
        backgroundColor: `color-mix(in oklab, ${laneColor} 10%, transparent)`,
      }}
    >
      <CalendarDays className="size-3" aria-hidden />
      {group.day.slice(5).replace("-", ".")}
    </span>
  );

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
          transition: zoomTransition(zoomMs, ["left", "height"]),
          ...(side === "above" ? { bottom: 0 } : { top: 0 }),
        }}
      />
      {/* The marker on the rail: solid for a day that ran, a ring for one
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
          transition: zoomTransition(zoomMs, ["left"]),
        }}
      />
      {single ? (
        <button
          type="button"
          onClick={() => onSelect(single.id)}
          aria-label={t(($) => $.meetings.select, { title: single.title })}
          aria-current={selected ? "true" : undefined}
          className={cardClassName}
          style={cardStyle}
        >
          <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
            {datePill}
            {span && <span className="tabular-nums">{span}</span>}
            {single.kind && <span className="truncate">{single.kind}</span>}
            {single.detected && (
              <ScanSearch className="size-3 shrink-0" aria-label={t(($) => $.meeting.detected)} />
            )}
          </span>
          <span
            className={cn(
              "line-clamp-1 shrink-0 text-caption leading-tight font-medium",
              cancelled && "line-through",
            )}
          >
            {single.title || t(($) => $.meeting.title_placeholder)}
          </span>
          {single.parties && (
            <span className="flex items-center gap-1 text-micro text-muted-foreground">
              <Users className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{single.parties}</span>
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
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={t(($) => $.timeline.group_aria, {
                  date: group.day,
                  count: group.meetings.length,
                })}
                aria-current={selected ? "true" : undefined}
                className={cardClassName}
                style={cardStyle}
              />
            }
          >
            <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
              {datePill}
              <span
                className="rounded-sm px-1 py-px font-medium tabular-nums"
                style={{
                  color: laneColor,
                  backgroundColor: `color-mix(in oklab, ${laneColor} 14%, transparent)`,
                }}
              >
                ×{group.meetings.length}
              </span>
              {group.meetings.every((m) => m.detected) && (
                <ScanSearch className="size-3 shrink-0" aria-label={t(($) => $.meeting.detected)} />
              )}
            </span>
            {group.meetings.slice(0, 2).map((m) => (
              <span
                key={m.id}
                className={cn(
                  "line-clamp-1 shrink-0 text-caption leading-tight font-medium",
                  m.status.trim() === "已取消" && "line-through",
                )}
              >
                {m.title || t(($) => $.meeting.title_placeholder)}
              </span>
            ))}
            {group.meetings.length > 2 ? (
              <span className="text-micro text-muted-foreground">
                {t(($) => $.timeline.group_more, { count: group.meetings.length - 2 })}
              </span>
            ) : (
              (() => {
                const parties = group.meetings.map((m) => m.parties.trim()).filter(Boolean);
                return parties.length > 0 ? (
                  <span className="flex items-center gap-1 text-micro text-muted-foreground">
                    <Users className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{parties[0]}</span>
                  </span>
                ) : null;
              })()
            )}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side={side === "above" ? "bottom" : "top"}
            className="flex w-72 flex-col gap-0.5 p-1.5"
          >
            <div className="px-1.5 pt-0.5 pb-1 text-micro font-medium text-muted-foreground tabular-nums">
              {group.day}
            </div>
            {group.meetings.map((m) => {
              const rowSpan = cockpitMeetingSpan(m);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelect(m.id);
                  }}
                  className="flex flex-col gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="flex items-center gap-1.5 text-micro text-muted-foreground">
                    <span className="tabular-nums">{rowSpan || t(($) => $.meeting.all_day)}</span>
                    {m.kind && <span className="truncate">{m.kind}</span>}
                  </span>
                  <span className="line-clamp-1 text-caption leading-tight font-medium">
                    {m.title || t(($) => $.meeting.title_placeholder)}
                  </span>
                  {m.parties && (
                    <span className="truncate text-micro text-muted-foreground">{m.parties}</span>
                  )}
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
      )}
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
  /** Free-scroll density. Fit mode ignores it, but a pinch that starts in fit
   *  mode reseeds it from fit's own density, so the zoom never jumps. */
  const [dayPx, setDayPx] = useState(PX_PER_DAY);
  /** First paint must not animate (every card would fly in from x=0). */
  const [mounted, setMounted] = useState(false);
  /** Pinch zooms track the gesture frame-by-frame; buttons and the mode
   *  switch glide. Set by whichever interaction ran last. */
  const [instant, setInstant] = useState(false);
  const zoomMs = mounted && !instant ? ZOOM_MS : 0;

  const timeline = useMemo(() => buildCockpitMeetingTimeline(meetings, today), [meetings, today]);

  const spanDays = useMemo(() => {
    const from = parseDay(timeline.from);
    const to = parseDay(timeline.to);
    return from && to ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000)) : 1;
  }, [timeline.from, timeline.to]);

  // The canvas the lanes paint on: the container's width in fit mode, the
  // domain's worth of days in scroll mode. No floor beyond the wrapper's
  // min-width — a floor would make the pinch feel stuck at the far end.
  const canvasPx = fit
    ? Math.max(320, boxWidth - LANE_LABEL_PX - LANE_PAD_PX * 2)
    : Math.max(1, spanDays * dayPx);

  // The wheel listener and the anchor compensation read live values through
  // refs — a gesture can outpace the render that would rebind their closures.
  const liveRef = useRef({ fit, dayPx, spanDays, canvasPx });
  liveRef.current = { fit, dayPx, spanDays, canvasPx };
  /** Where a pinch is anchored: the domain fraction under the cursor, kept
   *  still by compensating scrollLeft once the new density has rendered. */
  const anchorRef = useRef<{ frac: number; mouseX: number } | null>(null);

  useEffect(() => setMounted(true), []);

  // The scrollable box only exists once the board has dated meetings (the
  // empty state renders no scroller), so effects that attach to it re-run
  // when the lanes first appear.
  const hasLanes = timeline.lanes.length > 0;

  // Ctrl/Cmd+wheel (and trackpad pinch, which Chrome reports as ctrl+wheel)
  // zooms the day scale around the cursor instead of scrolling the page.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { fit: isFit, canvasPx: canvas, spanDays: days } = liveRef.current;
      const rect = box.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      anchorRef.current = {
        frac: (box.scrollLeft + mouseX - LANE_LABEL_PX - LANE_PAD_PX) / canvas,
        mouseX,
      };
      setInstant(true);
      setDayPx((prev) => {
        const base = isFit ? canvas / days : prev;
        const next = base * Math.exp(-e.deltaY * 0.0016);
        return Math.min(DAY_PX_MAX, Math.max(DAY_PX_MIN, next));
      });
      if (isFit) setFit(false);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [hasLanes]);

  // Once a pinch's new density has rendered, put the cursor's day back under
  // the cursor. Only meaningful in free mode (fit has nothing to scroll).
  useLayoutEffect(() => {
    const box = scrollRef.current;
    const anchor = anchorRef.current;
    if (!box || !anchor || fit) return;
    anchorRef.current = null;
    box.scrollLeft =
      anchor.frac * canvasPx + LANE_LABEL_PX + LANE_PAD_PX - anchor.mouseX;
  }, [canvasPx, fit]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setBoxWidth(box.clientWidth));
    observer.observe(box);
    setBoxWidth(box.clientWidth);
    return () => observer.disconnect();
  }, [hasLanes]);

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
          lane.items.map((item) => ({ id: item.day, at: item.at })),
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
              onClick={() => {
                // Seeding the density from fit's own keeps the mode switch a
                // pure zoom — the cards glide wider, never jump.
                if (mode === "free" && fit) {
                  setDayPx(
                    Math.min(
                      DAY_PX_MAX,
                      Math.max(DAY_PX_MIN, canvasPx / Math.max(1, spanDays)),
                    ),
                  );
                }
                setInstant(false);
                setFit(mode === "fit");
              }}
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
        {!fit && (
          <div
            className="flex items-center rounded-md bg-muted p-0.5"
            role="group"
            aria-label={t(($) => $.timeline.zoom)}
          >
            <button
              type="button"
              aria-label={t(($) => $.timeline.zoom_out)}
              onClick={() => {
                setInstant(false);
                setDayPx((v) => Math.max(DAY_PX_MIN, v / 1.3));
              }}
              className="rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ZoomOut className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t(($) => $.timeline.zoom_reset)}
              title={t(($) => $.timeline.zoom_reset)}
              onClick={() => {
                setInstant(false);
                setDayPx(PX_PER_DAY);
              }}
              className="min-w-10 rounded-sm px-1 py-0.5 text-center text-micro tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            >
              {Math.round((dayPx / PX_PER_DAY) * 100)}%
            </button>
            <button
              type="button"
              aria-label={t(($) => $.timeline.zoom_in)}
              onClick={() => {
                setInstant(false);
                setDayPx((v) => Math.min(DAY_PX_MAX, v * 1.3));
              }}
              className="rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <ZoomIn className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
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
                className="relative h-6 shrink-0 border-b border-border"
                style={{ width: LANE_PAD_PX * 2 + canvasPx }}
              >
                {ticks.map((tick) => {
                  const date = parseDay(tick.day);
                  if (!date) return null;
                  return (
                    <div
                      key={`${tick.step}-${tick.day}`}
                      className="absolute top-0 flex h-full flex-col items-start"
                      style={{
                        left: LANE_PAD_PX + tick.at * canvasPx,
                        transition: zoomTransition(zoomMs, ["left"]),
                      }}
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
                      style={{
                        width: LANE_LABEL_PX,
                        height,
                        transition: zoomTransition(zoomMs, ["height"]),
                      }}
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
                        {t(($) => $.timeline.lane_count, {
                          n: lane.items.reduce((n, g) => n + g.meetings.length, 0),
                        })}
                      </span>
                    </div>

                    <div
                      className="relative shrink-0"
                      style={{
                        width: LANE_PAD_PX * 2 + canvasPx,
                        height,
                        transition: zoomTransition(zoomMs, ["width", "height"]),
                      }}
                    >
                      {/* Month banding behind the cards. */}
                      {bands.map((band, i) => (
                        <div
                          key={i}
                          aria-hidden
                          className="absolute top-0 bottom-0 bg-muted/25"
                          style={{
                            left: LANE_PAD_PX + band.left,
                            width: band.width,
                            transition: zoomTransition(zoomMs, ["left", "width"]),
                          }}
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
                          transition: zoomTransition(zoomMs, ["top", "width"]),
                          background: `linear-gradient(to right, color-mix(in oklab, ${lane.color} 12%, transparent), color-mix(in oklab, ${lane.color} 55%, transparent), color-mix(in oklab, ${lane.color} 12%, transparent))`,
                        }}
                      />
                      {/* Zero-height context at the rail: everything a meeting
                          paints measures its distance from here. */}
                      <div
                        className="absolute"
                        style={{
                          top: railY,
                          left: LANE_PAD_PX,
                          width: canvasPx,
                          height: 0,
                          transition: zoomTransition(zoomMs, ["top"]),
                        }}
                      >
                        {lane.items.map((item) => {
                          const placement = byId.get(item.day)!;
                          return (
                            <TimelineCard
                              key={item.day}
                              group={item}
                              x={placement.x}
                              side={placement.side}
                              row={placement.row}
                              laneColor={lane.color}
                              today={today}
                              selectedId={selectedId}
                              onSelect={onSelect}
                              zoomMs={zoomMs}
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
                  style={{
                    left: LANE_LABEL_PX + LANE_PAD_PX + todayX,
                    transition: zoomTransition(zoomMs, ["left"]),
                  }}
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 pt-1 pb-0.5">
            {timeline.undated.length > 0 && (
              <p className="text-micro text-muted-foreground">
                {t(($) => $.timeline.undated, { n: timeline.undated.length })}
              </p>
            )}
            {!anyTrack && (
              <p className="text-micro text-muted-foreground">
                {t(($) => $.timeline.untracked_hint)}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
