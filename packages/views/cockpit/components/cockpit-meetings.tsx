"use client";

// The meeting register: the board's diary, in whichever shape the question
// needs. A list to audit the year, a month to see the rhythm, a week to plan
// the next one, an agenda to read what is coming. Four views over one sorted
// set — the derivations live in @multica/core/cockpit so the register, the
// overview card and the gantt can never disagree about what is upcoming.

import { useMemo, useState } from "react";
import type { CockpitBoard, CockpitMeeting } from "@multica/core/types";
import {
  cockpitMeetingSpan,
  cockpitMeetingsByDay,
  cockpitMonthGrid,
  cockpitWeekDays,
  groupMeetingIssues,
  groupMeetingNodes,
  monthKey,
  parseDay,
  shiftMonthKey,
  splitCockpitMeetings,
  addDays,
  formatDay,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Badge } from "@multica/ui/components/ui/badge";
import { CalendarDays, ChevronLeft, ChevronRight, FolderOpen, Link2, Plus } from "lucide-react";
import { useLocale, useT } from "../../i18n";

export type CockpitMeetingsView = "list" | "month" | "week" | "agenda";

const VIEWS: CockpitMeetingsView[] = ["list", "month", "week", "agenda"];

export interface CockpitMeetingsProps {
  board: CockpitBoard;
  today: string;
  selectedId: string | null;
  onSelect: (meetingId: string) => void;
  onCreate: () => void;
  readOnly?: boolean;
}

/** One meeting as a chip inside a calendar cell. */
function MeetingChip({
  meeting,
  selected,
  onSelect,
  label,
}: {
  meeting: CockpitMeeting;
  selected: boolean;
  onSelect: () => void;
  label: string;
}) {
  const span = cockpitMeetingSpan(meeting);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-left text-micro",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected && "bg-accent",
      )}
    >
      {span && <span className="shrink-0 tabular-nums text-muted-foreground">{span.slice(0, 5)}</span>}
      <span className="min-w-0 flex-1 truncate">{meeting.title}</span>
    </button>
  );
}

export function CockpitMeetings({
  board,
  today,
  selectedId,
  onSelect,
  onCreate,
  readOnly,
}: CockpitMeetingsProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const [view, setView] = useState<CockpitMeetingsView>("list");
  // The period the calendar views are looking at. Both start on today and are
  // moved by the same two arrows, so switching between them keeps the place.
  const [anchor, setAnchor] = useState(today);

  const meetings = board.meetings;
  const byDay = useMemo(() => cockpitMeetingsByDay(meetings), [meetings]);
  const split = useMemo(() => splitCockpitMeetings(meetings, today), [meetings, today]);
  const issuesByMeeting = useMemo(() => groupMeetingIssues(board.meeting_issues), [board.meeting_issues]);
  const nodesByMeeting = useMemo(() => groupMeetingNodes(board.meeting_nodes), [board.meeting_nodes]);

  const month = useMemo(() => {
    const date = parseDay(anchor);
    return date ? monthKey(date) : monthKey(new Date(Date.UTC(2026, 0, 1)));
  }, [anchor]);
  const monthDays = useMemo(() => cockpitMonthGrid(month), [month]);
  const weekDays = useMemo(() => cockpitWeekDays(anchor), [anchor]);

  const dayName = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }),
    [locale],
  );
  const monthName = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }),
    [locale],
  );

  const shift = (direction: -1 | 1) => {
    if (view === "month") {
      setAnchor(`${shiftMonthKey(month, direction)}-01`);
      return;
    }
    const date = parseDay(anchor);
    if (date) setAnchor(formatDay(addDays(date, direction * 7)));
  };

  const periodLabel = useMemo(() => {
    const date = parseDay(view === "month" ? `${month}-01` : anchor);
    if (!date) return "";
    if (view === "month") return monthName.format(date);
    const days = weekDays;
    return days.length ? `${days[0]} – ${days[days.length - 1]}` : "";
  }, [view, month, anchor, monthName, weekDays]);

  const linkCount = (meeting: CockpitMeeting) =>
    (issuesByMeeting.get(meeting.id)?.length ?? 0) + (nodesByMeeting.get(meeting.id)?.length ?? 0);

  const rows = useMemo(
    () => [...split.upcoming].reverse().concat(split.past, split.undated),
    [split],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-1" role="group" aria-label={t(($) => $.meetings.view)}>
          {VIEWS.map((key) => (
            <Button
              key={key}
              variant={view === key ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2"
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {key === "list"
                ? t(($) => $.meetings.view_list)
                : key === "month"
                  ? t(($) => $.meetings.view_month)
                  : key === "week"
                    ? t(($) => $.meetings.view_week)
                    : t(($) => $.meetings.view_agenda)}
            </Button>
          ))}
        </div>

        {(view === "month" || view === "week") && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(($) => $.meetings.previous)}
              onClick={() => shift(-1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="min-w-40 text-center text-caption tabular-nums">{periodLabel}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(($) => $.meetings.next)}
              onClick={() => shift(1)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setAnchor(today)}>
              {t(($) => $.meetings.today)}
            </Button>
          </div>
        )}

        {/* The page toolbar carries "New meeting" — this bar says what is on
            screen, it does not repeat the primary action beside it. */}
        <span className="ml-auto text-caption text-muted-foreground">
          {t(($) => $.meetings.count, { n: meetings.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {meetings.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-body text-muted-foreground">{t(($) => $.meetings.empty)}</p>
            {!readOnly && (
              <Button size="sm" className="h-7 gap-1 px-2" onClick={onCreate}>
                <Plus className="size-3.5" />
                {t(($) => $.meeting.new)}
              </Button>
            )}
          </div>
        ) : view === "list" ? (
          <table className="w-full border-collapse text-caption">
            <thead>
              <tr className="border-b border-border text-left text-micro tracking-wide text-muted-foreground uppercase">
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meetings.column_code)}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meetings.column_when)}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meetings.column_title)}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meeting.kind)}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meetings.column_parties)}</th>
                <th scope="col" className="py-1 pr-3 font-medium">{t(($) => $.meetings.column_links)}</th>
                <th scope="col" className="py-1 font-medium">{t(($) => $.meetings.column_folder)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((meeting) => (
                <tr
                  key={meeting.id}
                  className={cn(
                    "border-b border-border/60",
                    selectedId === meeting.id && "bg-accent",
                  )}
                >
                  <td className="py-1 pr-3 font-mono text-micro text-muted-foreground">
                    {meeting.code}
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap tabular-nums">
                    {meeting.meet_date ?? t(($) => $.meetings.undated_section)}
                    {cockpitMeetingSpan(meeting) && (
                      <span className="ml-1 text-muted-foreground">
                        {cockpitMeetingSpan(meeting)}
                      </span>
                    )}
                  </td>
                  <td className="max-w-80 py-1 pr-3">
                    <button
                      type="button"
                      onClick={() => onSelect(meeting.id)}
                      aria-label={t(($) => $.meetings.select, { title: meeting.title })}
                      className="w-full truncate rounded-sm px-1 text-left hover:bg-accent"
                    >
                      {meeting.title || t(($) => $.meeting.title_placeholder)}
                    </button>
                  </td>
                  <td className="py-1 pr-3">
                    {meeting.kind && <Badge variant="secondary">{meeting.kind}</Badge>}
                  </td>
                  <td className="max-w-56 truncate py-1 pr-3 text-muted-foreground">
                    {meeting.parties}
                  </td>
                  <td className="py-1 pr-3 text-muted-foreground">
                    {linkCount(meeting) > 0 && (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Link2 className="size-3" aria-hidden />
                        {linkCount(meeting)}
                      </span>
                    )}
                  </td>
                  <td className="py-1 text-muted-foreground">
                    {meeting.nas_dir && <FolderOpen className="size-3.5" aria-hidden />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : view === "month" ? (
          <div className="grid grid-cols-7 gap-px rounded-md border border-border bg-border">
            {monthDays.slice(0, 7).map((day) => {
              const date = parseDay(day);
              return (
                <div
                  key={`head-${day}`}
                  className="bg-card px-1 py-1 text-center text-micro text-muted-foreground"
                >
                  {date ? dayName.format(date) : ""}
                </div>
              );
            })}
            {monthDays.map((day) => {
              const inMonth = day.startsWith(month);
              const dayMeetings = byDay.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "flex min-h-24 flex-col gap-0.5 bg-card p-1",
                    !inMonth && "bg-muted/40",
                    day === today && "ring-1 ring-inset ring-brand",
                  )}
                >
                  <span
                    className={cn(
                      "text-micro tabular-nums",
                      inMonth ? "text-muted-foreground" : "text-muted-foreground/60",
                      day === today && "font-semibold text-foreground",
                    )}
                  >
                    {day.slice(8)}
                  </span>
                  {dayMeetings.map((meeting) => (
                    <MeetingChip
                      key={meeting.id}
                      meeting={meeting}
                      selected={selectedId === meeting.id}
                      onSelect={() => onSelect(meeting.id)}
                      label={t(($) => $.meetings.select, { title: meeting.title })}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ) : view === "week" ? (
          <div className="grid grid-cols-7 gap-px rounded-md border border-border bg-border">
            {weekDays.map((day) => {
              const date = parseDay(day);
              const dayMeetings = byDay.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "flex min-h-64 flex-col gap-1 bg-card p-2",
                    day === today && "ring-1 ring-inset ring-brand",
                  )}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-micro text-muted-foreground">
                      {date ? dayName.format(date) : ""}
                    </span>
                    <span
                      className={cn(
                        "text-caption tabular-nums",
                        day === today && "font-semibold",
                      )}
                    >
                      {day.slice(5)}
                    </span>
                  </div>
                  {dayMeetings.length === 0 ? (
                    <span className="text-micro text-muted-foreground/60">—</span>
                  ) : (
                    dayMeetings.map((meeting) => (
                      <button
                        key={meeting.id}
                        type="button"
                        onClick={() => onSelect(meeting.id)}
                        aria-label={t(($) => $.meetings.select, { title: meeting.title })}
                        aria-current={selectedId === meeting.id ? "true" : undefined}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-sm border border-border p-1 text-left",
                          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          selectedId === meeting.id && "bg-accent",
                        )}
                      >
                        <span className="text-micro tabular-nums text-muted-foreground">
                          {cockpitMeetingSpan(meeting) || t(($) => $.meeting.all_day)}
                        </span>
                        <span className="text-caption leading-tight">{meeting.title}</span>
                        {meeting.parties && (
                          <span className="truncate text-micro text-muted-foreground">
                            {meeting.parties}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {([
              ["upcoming", split.upcoming, t(($) => $.meetings.upcoming_section)],
              ["past", split.past, t(($) => $.meetings.past_section)],
              ["undated", split.undated, t(($) => $.meetings.undated_section)],
            ] as const).map(([key, list, heading]) =>
              list.length === 0 ? null : (
                <section key={key} className="flex flex-col gap-1">
                  <h3 className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
                    {heading}
                  </h3>
                  <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {list.map((meeting) => (
                      <li key={meeting.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(meeting.id)}
                          aria-label={t(($) => $.meetings.select, { title: meeting.title })}
                          aria-current={selectedId === meeting.id ? "true" : undefined}
                          className={cn(
                            "flex w-full items-baseline gap-3 px-3 py-2 text-left",
                            "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            selectedId === meeting.id && "bg-accent",
                          )}
                        >
                          <span className="w-40 shrink-0 text-caption tabular-nums text-muted-foreground">
                            <CalendarDays className="mr-1 inline size-3" aria-hidden />
                            {meeting.meet_date ?? "—"}
                            {cockpitMeetingSpan(meeting) && ` ${cockpitMeetingSpan(meeting)}`}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body">
                              {meeting.title || t(($) => $.meeting.title_placeholder)}
                            </span>
                            {(meeting.parties || meeting.location) && (
                              <span className="block truncate text-caption text-muted-foreground">
                                {[meeting.parties, meeting.location].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </span>
                          {meeting.status && <Badge variant="secondary">{meeting.status}</Badge>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
