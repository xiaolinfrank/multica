"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, cockpitMeetingRegisterOptions, cockpitMeetingSpan, cockpitObjectPath, cockpitSurfacePath, cockpitWeekDays, formatDay, parseDay, type CockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { CalendarDays, Plus } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitNarrativeCard } from "./cockpit-narrative-card";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

function BusinessMeetingWindow({ wsId, scope, today, onOpenMeeting, onCreate, readOnly }: {
  wsId: string; scope: CockpitScope; today: string; onOpenMeeting: (meetingId: string) => void; onCreate: () => void; readOnly?: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const week = cockpitWeekDays(today); const weekStart = week[0] ?? today; const weekEnd = week.at(-1) ?? today;
  const endDate = parseDay(weekEnd); const end = endDate ? formatDay(addDays(endDate, 30)) : weekEnd;
  // The count window is complete even when there are more than six meetings.
  const counts = useQuery(cockpitMeetingRegisterOptions(wsId, scope, { date_from: weekStart, date_to: end, page_size: 1 }));
  const days = counts.data?.day_counts ?? [];
  const weekCount = days.filter((day) => day.date >= weekStart && day.date <= weekEnd).reduce((total, day) => total + day.total, 0);
  const next = days.filter((day) => day.date > weekEnd && day.total > 0).map((day) => day.date).sort()[0];
  const from = weekCount ? weekStart : next; const to = weekCount ? weekEnd : next;
  const signature = JSON.stringify([from, to]);
  const [paging, setPaging] = useState<{ signature: string; cursors: string[] }>({ signature: "", cursors: [""] });
  const cursors = paging.signature === signature ? paging.cursors : [""];
  useEffect(() => { setPaging((current) => current.signature === signature ? current : { signature, cursors: [""] }); }, [signature]);
  const query = useQuery({ ...cockpitMeetingRegisterOptions(wsId, scope, { date_from: from, date_to: to, page_size: 6, cursor: cursors.at(-1) || undefined }),
    enabled: Boolean(from && to && counts.data && !counts.isError) });
  const data = query.data;
  return <CockpitNarrativeCard title={t(($) => $.overview.card_meetings)} icon={<CalendarDays className="size-4" />} cap="meetings"
    hint={t(($) => $.overview.card_meetings_hint)} action={<div className="flex flex-wrap items-center gap-2">
      <AppLink href={cockpitSurfacePath(paths.cockpit(), "meetings", scope)} className="text-caption text-primary hover:underline">{t(($) => $.meetings.open_register)}</AppLink>
      {!readOnly && <Button type="button" variant="ghost" size="sm" onClick={onCreate}><Plus className="size-3.5" />{t(($) => $.meeting.new)}</Button>}
    </div>}>
    <p className="mb-3 text-micro text-muted-foreground">{t(($) => $.business_meetings.window, { from: weekStart, to: end })}</p>
    {counts.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : counts.isError || !counts.data ? <CockpitFlowError onRetry={() => void counts.refetch()} />
        : !from ? <p className="text-caption text-muted-foreground">{t(($) => $.business_meetings.empty)}</p>
          : <section aria-label={t(($) => $.business_meetings.results)} className="space-y-3">
            <p className="text-caption font-medium">{weekCount ? t(($) => $.business_meetings.week_count, { count: weekCount }) : t(($) => $.business_meetings.next_day, { date: next })}</p>
            {data && <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching}
              onPrevious={() => setPaging({ signature, cursors: cursors.slice(0, -1) })}
              onNext={() => { if (data.next_cursor) setPaging({ signature, cursors: [...cursors, data.next_cursor] }); }} />}
            {query.isPending ? <div role="status"><Spinner />{t(($) => $.workflow.loading)}</div>
              : query.isError || !data ? <div className="space-y-2"><CockpitFlowError onRetry={() => void query.refetch()} />
                {cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setPaging({ signature, cursors: [""] })}>{t(($) => $.task_flow.first_page)}</Button>}</div>
                : <ul className="max-h-80 divide-y divide-border overflow-y-auto">{data.items.map((meeting) => <li key={meeting.id} className="space-y-2 py-3">
                  <div className="flex items-start gap-2"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: meeting.id }, scope)} className="min-w-0 flex-1 text-body hover:underline"
                    onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onOpenMeeting(meeting.id); } }}>
                    <span className="line-clamp-2 break-words">{meeting.title || t(($) => $.meeting.title_placeholder)}</span></AppLink>
                    {!readOnly && <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: meeting.id, view: "details" }, scope)} className="shrink-0 text-caption text-primary hover:underline">{t(($) => $.meeting.edit)}</AppLink>}</div>
                  <p className="flex flex-wrap gap-2 text-micro text-muted-foreground"><span>{meeting.meet_date}</span><span>{cockpitMeetingSpan(meeting)}</span>{meeting.parties && <span className="line-clamp-1" title={meeting.parties}>{meeting.parties}</span>}</p>
                </li>)}</ul>}
          </section>}
  </CockpitNarrativeCard>;
}

/** A scope switch drops only this preview's ephemeral continuation cursor. */
export function CockpitBusinessMeetings(props: Parameters<typeof BusinessMeetingWindow>[0]) {
  return <BusinessMeetingWindow key={JSON.stringify([props.wsId, props.scope, props.today])} {...props} />;
}
