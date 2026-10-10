"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addDays, cockpitMeetingRegisterOptions, cockpitMonthGrid, cockpitScopeViewKey, cockpitWeekDays,
  EMPTY_COCKPIT_MEETING_CONTEXT, emptyCockpitMeetingFilter, formatDay, isCockpitMeetingFilterActive,
  monthKey, parseDay, shiftMonthKey, cockpitSurfacePath, useCockpitScopeViewStore, type CockpitMeetingFilter, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitMeetingRegisterQuery } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { cn } from "@multica/ui/lib/utils";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, ScanSearch } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { CockpitMeetingCards } from "./cockpit-meeting-cards";
import { CockpitMeetingFilterBar, CockpitMeetingFilterChips } from "./cockpit-meeting-filter";
import { CockpitMeetingTimeline } from "./cockpit-meeting-timeline";
import { CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export type CockpitMeetingsView = "list" | "month" | "week" | "agenda" | "timeline";
const VIEWS: CockpitMeetingsView[] = ["list", "month", "week", "agenda", "timeline"];

export interface CockpitMeetingsProps {
  wsId: string;
  scope: CockpitScope;
  today: string;
  selectedId: string | null;
  onSelect: (meetingId: string) => void;
  onCreate: () => void;
  onScan: () => void;
  readOnly?: boolean;
}

/** Server-filtered metadata pages. Calendar counts cover the window, never just the first metadata page. */
export function CockpitMeetings({ wsId, scope, today, selectedId, onSelect, onCreate, onScan, readOnly }: CockpitMeetingsProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const navigation = useNavigation();
  const relatedNodeIds = [...new Set((navigation.searchParams.get("meeting_nodes") || "").split(",").filter(Boolean))];
  const relatedNodeId = navigation.searchParams.get("meeting_node") || "";
  const routeFrom = navigation.searchParams.get("from") || "";
  const routeTo = navigation.searchParams.get("to") || "";
  const key = JSON.stringify([cockpitScopeViewKey(wsId, scope), relatedNodeId, relatedNodeIds]);
  const initial = useMemo(() => ({ ...EMPTY_COCKPIT_MEETING_CONTEXT, from: routeFrom, to: routeTo }), [routeFrom, routeTo]);
  const state = useCockpitScopeViewStore((store) => store.meetings[key] ?? initial);
  const update = (patch: Parameters<ReturnType<typeof useCockpitScopeViewStore.getState>["updateMeeting"]>[1]) => useCockpitScopeViewStore.getState().updateMeeting(key, patch);
  useEffect(() => {
    const current = useCockpitScopeViewStore.getState().meetings[key];
    if ((routeFrom || routeTo) && (current?.from !== routeFrom || current?.to !== routeTo)) useCockpitScopeViewStore.getState().updateMeeting(key, { from: routeFrom, to: routeTo, selectedDay: null });
  }, [key, routeFrom, routeTo]);
  const filter: CockpitMeetingFilter = useMemo(() => ({ query: state.query, from: state.from, to: state.to, tracks: state.tracks,
    kinds: state.kinds, statuses: state.statuses, parties: state.parties, only: state.only }), [state]);
  const changeFilter = (next: CockpitMeetingFilter) => {
    update({ ...next, selectedDay: null });
    if (next.from !== filter.from || next.to !== filter.to) {
      const params = new URLSearchParams(navigation.searchParams);
      if (next.from) params.set("from", next.from); else params.delete("from");
      if (next.to) params.set("to", next.to); else params.delete("to");
      navigation.replace(`${navigation.pathname}${params.size ? `?${params}` : ""}`);
    }
  };
  const q = useCockpitSearch(state.query);
  const searching = q !== state.query.trim();
  const view = state.view;
  const anchor = state.anchorDay ?? today;
  const calendar = view === "month" || view === "week";
  const month = monthKey(parseDay(anchor) ?? new Date(`${today}T00:00:00Z`));
  const days = useMemo(() => view === "month" ? cockpitMonthGrid(month) : cockpitWeekDays(anchor), [view, month, anchor]);
  const selectedDay = calendar && state.selectedDay && days.includes(state.selectedDay) && (!filter.from || state.selectedDay >= filter.from) && (!filter.to || state.selectedDay <= filter.to) ? state.selectedDay : null;
  const windowFrom = calendar ? days[0] ?? "" : "";
  const windowTo = calendar ? days.at(-1) ?? "" : "";
  const from = windowFrom && filter.from ? (windowFrom > filter.from ? windowFrom : filter.from) : windowFrom || filter.from;
  const to = windowTo && filter.to ? (windowTo < filter.to ? windowTo : filter.to) : windowTo || filter.to;
  const disjointDates = Boolean(from && to && from > to);
  const query: CockpitMeetingRegisterQuery = { node_id: relatedNodeId || undefined, node_ids: relatedNodeIds.length ? relatedNodeIds : undefined, q: q || undefined, date_from: from || undefined, date_to: to || undefined,
    tracks: filter.tracks, kinds: filter.kinds, statuses: filter.statuses, parties: filter.parties, only: filter.only,
    page_size: calendar ? 1 : 25 };
  const signature = JSON.stringify([scope, query]);
  const cursors = state.cursorKey === signature ? state.cursors : [""];
  const register = useQuery({ ...cockpitMeetingRegisterOptions(wsId, scope, { ...query, cursor: calendar ? undefined : cursors.at(-1) || undefined }), enabled: Boolean(wsId && !searching && !disjointDates) });
  const day = useQuery({ ...cockpitMeetingRegisterOptions(wsId, scope, { ...query, date_from: selectedDay ?? undefined, date_to: selectedDay ?? undefined,
    page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: Boolean(wsId && calendar && selectedDay && !searching && !disjointDates) });
  const pageQuery = calendar ? day : register;
  const page = pageQuery.data;
  const listRef = useRef<HTMLDivElement>(null);
  useCockpitScrollMemory(listRef, JSON.stringify(["meeting-list", key, view, cursors.at(-1) ?? ""]), Boolean(page), JSON.stringify([filter, selectedDay]));
  const data = register.data;
  const dayCounts = new Map(data?.day_counts.map((entry) => [entry.date, entry.total]) ?? []);
  const viewLabels: Record<CockpitMeetingsView, string> = { list: t(($) => $.meetings.view_list), month: t(($) => $.meetings.view_month), week: t(($) => $.meetings.view_week), agenda: t(($) => $.meetings.view_agenda), timeline: t(($) => $.meetings.view_timeline) };
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const monthName = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" });
  const period = view === "month" ? monthName.format(new Date(`${month}-01T00:00:00Z`)) : `${days[0]} – ${days.at(-1)}`;
  const shift = (direction: -1 | 1) => {
    const date = parseDay(anchor);
    if (view === "month") update({ anchorDay: `${shiftMonthKey(month, direction)}-01`, selectedDay: null });
    else if (date) update({ anchorDay: formatDay(addDays(date, direction * 7)), selectedDay: null });
  };
  const reset = () => changeFilter(emptyCockpitMeetingFilter());
  const previous = () => { if (cursors.length > 1) update({ cursorKey: signature, cursors: cursors.slice(0, -1) }); };
  const pager = page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={pageQuery.isFetching || searching}
    onPrevious={previous} onNext={() => { if (page.next_cursor) update({ cursorKey: signature, cursors: [...cursors, page.next_cursor] }); }} />
    : cursors.length > 1 ? <Button type="button" variant="outline" size="sm" disabled={pageQuery.isFetching} onClick={previous}>{t(($) => $.task_flow.previous)}</Button> : null;
  const error = (retry: () => void) => <div role="alert" className="space-y-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-caption">
    <p>{t(($) => $.errors.load_failed)}</p><Button type="button" variant="outline" size="sm" onClick={retry}>{t(($) => $.binding.retry)}</Button></div>;
  const loading = <div role="status" className="flex items-center gap-2 p-5 text-caption text-muted-foreground"><Spinner />{t(($) => $.work_overview.loading)}</div>;
  const empty = <div className="space-y-3 rounded-xl border border-dashed border-border p-6 text-caption text-muted-foreground">
    <p>{isCockpitMeetingFilterActive(filter) || selectedDay ? t(($) => $.meetings.no_results) : t(($) => $.meetings.empty)}</p>
    {isCockpitMeetingFilterActive(filter) ? <Button type="button" variant="outline" size="sm" onClick={reset}>{t(($) => $.meetings.filter_clear)}</Button>
      : !readOnly && <Button type="button" variant="outline" size="sm" onClick={onCreate}><Plus className="size-3.5" />{t(($) => $.meeting.new)}</Button>}
  </div>;

  return <section aria-label={t(($) => $.shell.meetings)} className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/60 px-4 py-3">
      <div role="group" aria-label={t(($) => $.meetings.view)} className="flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
        {VIEWS.map((value) => <Button key={value} type="button" variant={view === value ? "secondary" : "ghost"} size="sm" aria-pressed={view === value}
          onClick={() => update({ view: value })}>{viewLabels[value]}</Button>)}
      </div>
      <CockpitMeetingFilterBar filter={filter} onChange={changeFilter} meetings={page?.items ?? data?.items ?? []} today={today} />
      {!readOnly && <div className="ml-auto flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={onScan}><ScanSearch className="size-3.5" />{t(($) => $.meetings.scan)}</Button>
        <Button type="button" size="sm" onClick={onCreate}><Plus className="size-3.5" />{t(($) => $.meeting.new)}</Button></div>}
    </div>
    {(relatedNodeId || relatedNodeIds.length > 0) && <div className="border-b border-border bg-muted/40 px-4 py-2 text-caption"><span>{t(($) => $.meeting_center.related_work_item)}</span> <AppLink href={cockpitSurfacePath(navigation.pathname, "meetings", scope)} className="text-primary hover:underline">{t(($) => $.meeting_center.back_to_register)}</AppLink></div>}
    {data && <CockpitMeetingFilterChips filter={filter} onChange={changeFilter} shown={calendar ? data.total : data.items.length} total={data.total} />}
    <div className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-5">
      <div className="mx-auto flex h-full min-h-0 max-w-[1480px] flex-col gap-4">
        {calendar && <div className="flex flex-wrap items-center gap-2"><CalendarDays className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="mr-auto text-title-sm font-medium">{period}</h2><Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.meetings.previous)} onClick={() => shift(-1)}><ChevronLeft /></Button>
          <Button type="button" variant="outline" size="sm" onClick={() => update({ anchorDay: today, selectedDay: today })}>{t(($) => $.meetings.today)}</Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.meetings.next)} onClick={() => shift(1)}><ChevronRight /></Button></div>}
        {disjointDates ? empty : register.isError && !data ? error(() => void register.refetch()) : register.isPending || searching ? loading : <>
          {register.isError && data && <div role="alert" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.work_overview.refresh_failed)}<Button type="button" variant="ghost" size="sm" onClick={() => void register.refetch()}>{t(($) => $.binding.retry)}</Button></div>}
          {calendar && <div className="shrink-0 overflow-x-auto rounded-xl border border-border bg-card"><div className="grid min-w-[560px] grid-cols-7 gap-px bg-border/65">
            {days.slice(0, 7).map((date) => <div key={`head-${date}`} className="bg-card py-2 text-center text-caption text-muted-foreground">{dayName.format(new Date(`${date}T00:00:00Z`))}</div>)}
            {days.map((date) => <Button key={date} type="button" variant="ghost" aria-label={t(($) => $.meeting_center.open_day, { date, count: dayCounts.get(date) ?? 0 })} aria-pressed={selectedDay === date}
              onClick={() => update({ selectedDay: date })} className={cn("h-auto min-h-20 flex-col items-start justify-start gap-2 rounded-none p-3 text-left", date === selectedDay ? "bg-accent hover:bg-accent" : "bg-card hover:bg-muted", view === "month" && !date.startsWith(month) && "text-muted-foreground")}>
              <span className={cn("text-caption tabular-nums", date === today && "rounded bg-brand px-1.5 text-brand-foreground")}>{date.slice(8)}</span>
              {(dayCounts.get(date) ?? 0) > 0 && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-micro text-brand">{t(($) => $.meetings.count, { n: dayCounts.get(date) ?? 0 })}</span>}
            </Button>)}
          </div></div>}
          {calendar && !selectedDay ? <p className="text-caption text-muted-foreground">{t(($) => $.meeting_center.choose_day)}</p> : <>
            {selectedDay && <h3 className="text-title-sm font-medium">{selectedDay}</h3>}
            <div className="shrink-0">{pager}</div>
            {pageQuery.isError && !page ? error(() => void pageQuery.refetch()) : pageQuery.isPending ? loading : page && <>
              {pageQuery.isError && <p role="alert" className="text-caption text-destructive">{t(($) => $.work_overview.refresh_failed)}</p>}
              {page.items.length === 0 ? empty : view === "timeline" ? <><p className="text-caption text-muted-foreground">{t(($) => $.meeting_center.page_timeline)}</p><div className="min-h-[480px] flex-1"><CockpitMeetingTimeline meetings={page.items} today={today} selectedId={selectedId} onSelect={onSelect} /></div></>
                : <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card"><CockpitMeetingCards items={page.items} scope={scope} selectedId={selectedId} /></div>}
            </>}
          </>}
        </>}
      </div>
    </div>
  </section>;
}
