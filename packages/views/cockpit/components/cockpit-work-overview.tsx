"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitSurfacePath, cockpitScopeViewKey, cockpitObjectPath, cockpitAttentionDestination, cockpitDashboardKeys, type CockpitScope,
  cockpitWorkOverviewOptions, cockpitOverviewAttentionOptions, cockpitOverviewExecutionOptions, cockpitOverviewMeetingsOptions,
  EMPTY_COCKPIT_DASHBOARD_VIEW, useCockpitDashboardViewStore, parseDay,
} from "@multica/core/cockpit";
import type { CockpitAttentionItem, CockpitExecutionOverviewItem, CockpitOverviewIssueCounts, CockpitRecentMeeting } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { isBuiltInIssueStatus, isIssueStatusCategory } from "@multica/core/issue-statuses";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { cn } from "@multica/ui/lib/utils";
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, CheckCheck, ChevronLeft, ChevronRight, CircleDot, ClipboardCheck, Clock3, HardDrive, Inbox, Layers3, ListTodo, RefreshCw, Target, TriangleAlert, Users, type LucideIcon } from "lucide-react";
import { AppLink } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { CockpitStatusOrbit } from "./cockpit-status-orbit";

export interface CockpitWorkOverviewProps {
  wsId: string;
  today: string;
  scope: CockpitScope;
}

function useOverviewLabels() {
  const { t } = useT("cockpit");
  const kinds: Record<string, string> = { workflow: t(($) => $.work_overview.kind_workflow), action: t(($) => $.work_overview.kind_action), nas: t(($) => $.work_overview.kind_nas), issue: t(($) => $.work_overview.kind_issue) };
  const reasons: Record<string, string> = {
    review_pending: t(($) => $.work_overview.review_pending), reviewer_missing: t(($) => $.work_overview.reviewer_missing), publish_ready: t(($) => $.work_overview.publish_ready),
    release_ready: t(($) => $.work_overview.release_ready), restore_backlog: t(($) => $.work_overview.restore_backlog), materials_needed: t(($) => $.work_overview.materials_needed),
    readiness_needed: t(($) => $.work_overview.readiness_needed), minutes_needed: t(($) => $.work_overview.minutes_needed), minutes_rework: t(($) => $.work_overview.minutes_rework),
    action_pending: t(($) => $.work_overview.action_pending), action_superseded: t(($) => $.work_overview.action_superseded),
    retry_wait: t(($) => $.nas.retry_wait), needs_attention: t(($) => $.nas.needs_attention), active_issue: t(($) => $.work_overview.active_issue),
    not_enabled: t(($) => $.work_overview.not_enabled), waiting_meeting: t(($) => $.work_overview.waiting_meeting), published: t(($) => $.workflow.published),
  };
  const actions: Record<string, string> = {
    review_minutes: t(($) => $.work_overview.review_minutes), reassign_reviewer: t(($) => $.work_overview.reassign_reviewer), publish_minutes: t(($) => $.work_overview.publish_minutes),
    release_minutes: t(($) => $.work_overview.release_minutes), restore_backlog: t(($) => $.work_overview.open_minutes_issue), manage_readiness: t(($) => $.work_overview.manage_readiness),
    submit_minutes: t(($) => $.work_overview.submit_minutes), revise_minutes: t(($) => $.work_overview.revise_minutes), resolve_action: t(($) => $.work_overview.resolve_action),
    dismiss_superseded_action: t(($) => $.work_overview.resolve_action), inspect_nas: t(($) => $.work_overview.inspect_nas), open_issue: t(($) => $.work_overview.open_issue),
  };
  return { kinds, reasons, actions };
}

function calendarDate(value: string | null, locale: string): string {
  if (!value) return "";
  const date = parseDay(value);
  return date ? date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }) : value;
}

function OverviewError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("cockpit");
  return <div role="alert" className="space-y-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-caption">
    <p>{t(($) => $.work_overview.load_failed)}</p><Button type="button" variant="outline" size="sm" onClick={onRetry}>{t(($) => $.binding.retry)}</Button>
  </div>;
}

function OverviewLoading({ rows = 3 }: { rows?: number }) {
  const { t } = useT("cockpit");
  return <div role="status" aria-label={t(($) => $.work_overview.loading)} className="space-y-4 py-3">
    {Array.from({ length: rows }, (_, index) => <div key={index} aria-hidden className="flex gap-3 motion-safe:animate-pulse">
      <div className="size-9 shrink-0 rounded-lg bg-muted" /><div className="flex-1 space-y-2 py-1"><div className="h-3 w-3/4 rounded bg-muted" /><div className="h-2 w-1/2 rounded bg-muted" /></div>
    </div>)}
  </div>;
}

function OverviewPager({ page, shown, total, next, loading, onPrevious, onNext }: { page: number; shown?: number; total?: number; next?: string | null; loading: boolean; onPrevious: () => void; onNext: () => void }) {
  const { t } = useT("cockpit");
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 text-caption text-muted-foreground">
    <span>{total === undefined || shown === undefined ? t(($) => $.work_overview.loading) : t(($) => $.task_flow.page_count, { page, shown, total })}</span>
    <div className="flex items-center gap-1"><Button type="button" variant="ghost" size="icon-sm" disabled={loading || page <= 1} onClick={onPrevious} aria-label={t(($) => $.task_flow.previous)}><ChevronLeft /></Button>
      <Button type="button" variant="ghost" size="icon-sm" disabled={loading || !next} onClick={onNext} aria-label={t(($) => $.task_flow.next)}><ChevronRight /></Button></div>
  </div>;
}

function PanelHeading({ title, icon: Icon, extra }: { title: string; icon: LucideIcon; extra?: React.ReactNode }) {
  return <div className="cockpit-panel-heading mb-3 flex flex-wrap items-center gap-2"><Icon className="size-4 text-muted-foreground" aria-hidden /><h2 className="min-w-0 text-title-sm font-medium">{title}</h2>{extra && <div className="ml-auto">{extra}</div>}</div>;
}

function AttentionRows({ items, human, scope }: { items: CockpitAttentionItem[]; human: boolean; scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const { t: issueT } = useT("issues");
  const locale = useLocale();
  const paths = useWorkspacePaths();
  const { kinds, reasons, actions } = useOverviewLabels();
  const icons: Record<string, LucideIcon> = { workflow: ClipboardCheck, action: ListTodo, nas: HardDrive, issue: CircleDot };
  const flagLabels: Record<string, string> = { overdue: t(($) => $.work_overview.overdue), blocked: t(($) => $.work_overview.blocked), unassigned: t(($) => $.workflow.unassigned), unknown_status: t(($) => $.task_flow.unknown), source_superseded: t(($) => $.meeting_actions.superseded) };
  return <ul className="divide-y divide-border/70">{items.map((item) => {
    const target = cockpitAttentionDestination(item.target);
    const restoreIssue = item.kind === "workflow" && item.reason === "restore_backlog" && item.next_action === "restore_backlog" ? item.target.issue_id : null;
    const href = restoreIssue ? paths.issueDetail(restoreIssue) : target ? target.kind === "issue" ? paths.issueDetail(target.id) : cockpitObjectPath(paths.cockpit(), target, scope) : null;
    const Icon = icons[item.kind] ?? Layers3;
    const action = human && item.can_act && kinds[item.kind] && reasons[item.reason]
      ? item.next_action === "restore_backlog" && !restoreIssue ? t(($) => $.work_overview.release_minutes) : actions[item.next_action] ?? t(($) => $.work_overview.view_details)
      : t(($) => $.work_overview.view_details);
    const statusKey = item.issue_status;
    const category = item.issue_status_category;
    const status = isBuiltInIssueStatus(statusKey) ? issueT(($) => $.status[statusKey])
      : isIssueStatusCategory(category) ? issueT(($) => $.status_category[category]) : t(($) => $.task_flow.unknown);
    return <li key={`${item.kind}:${item.id}`}><article aria-label={item.title} className="cockpit-attention-row group grid gap-3 rounded-lg py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 gap-3"><span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", item.kind === "workflow" ? "bg-brand/10 text-brand" : "bg-muted text-muted-foreground")}><Icon className="size-4" aria-hidden /></span>
        <div className="min-w-0 space-y-1.5"><div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted-foreground"><span>{kinds[item.kind] ?? t(($) => $.work_overview.other_work)}</span>
          <span aria-hidden>·</span><span>{item.kind === "issue" ? status : reasons[item.reason] ?? t(($) => $.work_overview.other_work)}</span></div>
          <h3 className="line-clamp-2 break-words text-body font-medium" title={item.title}>{item.title || t(($) => $.work_overview.untitled)}</h3>
          <p className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {item.issue_identifier && <span className="font-mono">{item.issue_identifier}</span>}
            {item.meeting_code && <span className="font-mono">{item.meeting_code}</span>}
            {item.version_number !== null && <span>{t(($) => $.meeting_actions.source_version, { number: item.version_number })}</span>}
            {item.node_code && <span className="font-mono">{item.node_code}</span>}
            <span className="line-clamp-1 min-w-0 max-w-full" title={item.assignee_name}>{item.assignee_name || (item.responsibility === "team_management" ? t(($) => $.work_overview.team_management) : t(($) => $.workflow.unassigned))}</span>
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-micro">{item.flags.filter((flag) => flagLabels[flag]).map((flag) => <span key={flag} className={cn("rounded px-1.5 py-0.5", flag === "overdue" ? "bg-destructive/10 text-destructive" : flag === "blocked" ? "bg-warning-subtle text-foreground" : "bg-muted text-muted-foreground")}>{flagLabels[flag]}</span>)}
            {item.due_date && <span className="text-muted-foreground">{t(($) => $.task_flow.due, { date: calendarDate(item.due_date, locale) })}</span>}</div>
        </div>
      </div>
      <div className="pl-12 sm:pl-0 sm:pt-1">{href ? <AppLink href={href} newTabTitle={item.title} className={cn(buttonVariants({ variant: human && item.can_act ? "outline" : "ghost", size: "sm" }), "max-w-full gap-1.5")}>{action}<ArrowUpRight className="size-3.5" aria-hidden /></AppLink>
        : <span className="text-caption text-muted-foreground">{t(($) => $.work_overview.destination_unavailable)}</span>}</div>
    </article></li>;
  })}</ul>;
}

function IssueDistribution({ counts }: { counts: CockpitOverviewIssueCounts }) {
  const { t } = useT("cockpit");
  const parts = [
    { count: counts.unstarted, label: t(($) => $.task_flow.unstarted), color: "bg-muted-foreground/35" },
    { count: counts.started, label: t(($) => $.task_flow.started), color: "bg-brand" },
    { count: counts.done, label: t(($) => $.task_flow.done), color: "bg-success" },
    { count: counts.closed, label: t(($) => $.task_flow.closed), color: "bg-muted-foreground/65" },
    { count: counts.unknown, label: t(($) => $.task_flow.unknown), color: "bg-warning" },
  ];
  return <div className="cockpit-distribution space-y-3">
    {counts.total > 0 && parts.reduce((sum, part) => sum + part.count, 0) === counts.total && <div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">{parts.filter((part) => part.count > 0).map((part) => <div key={part.label} className={part.color} style={{ width: `${part.count / counts.total * 100}%` }} />)}</div>}
    <dl className="cockpit-status-values grid grid-cols-2 gap-x-4 gap-y-2 text-caption">{parts.map((part) => <div key={part.label} className="flex items-center justify-between gap-2"><dt className="flex items-center gap-1.5 text-muted-foreground"><span className={cn("size-1.5 rounded-full", part.color)} aria-hidden />{part.label}</dt><dd className="font-medium tabular-nums">{part.count}</dd></div>)}</dl>
  </div>;
}

function ExecutionRows({ items, scope }: { items: CockpitExecutionOverviewItem[]; scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const paths = useWorkspacePaths();
  return <ul className="divide-y divide-border/70">{items.map((node) => <li key={node.id} className="py-3 first:pt-0"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: node.id }, scope)} newTabTitle={node.name}
    className="group block rounded-lg outline-offset-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="mb-1 line-clamp-1 text-micro text-muted-foreground" title={`${node.project_title} / ${node.module_title}`}>{node.project_title} / {node.module_title}</p>
      <h3 className="line-clamp-2 break-words text-body font-medium group-hover:underline" title={`${node.code} ${node.name}`}><span className="mr-2 font-mono text-caption text-muted-foreground">{node.code}</span>{node.name}</h3></div><ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden /></div>
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption [overflow-wrap:anywhere]"><span className="rounded bg-brand/8 px-1.5 py-0.5 font-medium text-brand">{t(($) => $.work_overview.open_task_count, { count: node.issue_counts.active })}</span>
      {node.issue_counts.overdue > 0 && <span className="text-destructive">{t(($) => $.work_overview.overdue_count, { count: node.issue_counts.overdue })}</span>}
      <span className="line-clamp-1 min-w-0 max-w-full text-muted-foreground" title={node.plan_owner}>{node.plan_owner || t(($) => $.workflow.unassigned)}</span>
      {node.plan_status && <span className="line-clamp-1 min-w-0 max-w-full text-muted-foreground" title={node.plan_status}>{node.plan_status}</span>}</div>
    {node.plan_end_date && <p className="mt-1.5 text-micro text-muted-foreground">{t(($) => $.work_overview.planned_end, { date: calendarDate(node.plan_end_date, locale) })}</p>}
  </AppLink></li>)}</ul>;
}

function MeetingRows({ items, scope }: { items: CockpitRecentMeeting[]; scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const paths = useWorkspacePaths();
  const { reasons } = useOverviewLabels();
  return <ul className="divide-y divide-border/70">{items.map((meeting) => <li key={meeting.id} className="py-3 first:pt-0"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: meeting.id }, scope)} newTabTitle={meeting.title}
    className="group flex min-w-0 items-start gap-3 rounded-lg outline-offset-4"><div className="flex w-14 shrink-0 flex-col items-center rounded-xl border border-border bg-muted/40 px-1 py-2">
      <span className="text-micro text-muted-foreground">{parseDay(meeting.meet_date)?.toLocaleDateString(locale, { month: "short" })}</span><span className="text-title-lg font-medium tabular-nums">{parseDay(meeting.meet_date)?.getDate()}</span></div>
    <div className="min-w-0 flex-1"><div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-micro text-muted-foreground [overflow-wrap:anywhere]"><time dateTime={meeting.meet_date}>{meeting.meet_date}</time>{meeting.time_range && <span className="line-clamp-1 min-w-0 max-w-full" title={meeting.time_range}>{meeting.time_range}</span>}</div>
      <h3 className="mt-1 line-clamp-2 break-words text-body font-medium group-hover:underline" title={meeting.title}>{meeting.title || t(($) => $.issue_meetings.untitled)}</h3>
      <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-caption text-muted-foreground [overflow-wrap:anywhere]"><span className="line-clamp-1 min-w-0 max-w-full" title={meeting.meeting_status}>{meeting.ended_at ? t(($) => $.workflow.ended) : meeting.meeting_status || t(($) => $.work_overview.scheduled_record)}</span>
        {meeting.workflow_enabled && <><span aria-hidden>·</span><span>{reasons[meeting.workflow_stage] ?? t(($) => $.work_overview.other_work)}</span></>}
        {meeting.current_version_number !== null && <span>{t(($) => $.meeting_actions.source_version, { number: meeting.current_version_number })}</span>}</div>
    </div><ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
  </AppLink></li>)}</ul>;
}

export function CockpitWorkOverview({ wsId, today, scope }: CockpitWorkOverviewProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const paths = useWorkspacePaths();
  const client = useQueryClient();
  const viewKey = cockpitScopeViewKey(wsId, scope);
  const view = useCockpitDashboardViewStore((state) => state.views[viewKey] ?? EMPTY_COCKPIT_DASHBOARD_VIEW);
  const update = (patch: Parameters<ReturnType<typeof useCockpitDashboardViewStore.getState>["update"]>[1]) => useCockpitDashboardViewStore.getState().update(viewKey, patch);
  const { kinds } = useOverviewLabels();
  const scroll = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const lastScroll = useRef(0);
  const overview = useQuery({ ...cockpitWorkOverviewOptions(wsId, { as_of: today, project_id: scope.projectId || undefined, module_id: scope.moduleId || undefined, attention_view: view.audience }),
    placeholderData: (previous) => previous?.workspace_id === wsId && previous.project_id === scope.projectId && (previous.module_id ?? null) === scope.moduleId && previous.as_of === today ? previous : undefined });
  const data = overview.data;
  const full = view.mode === "attention";
  const size = full ? 25 : 8;
  const queueSection = full ? "attention-full" : "attention-preview";
  const signature = JSON.stringify([wsId, today, scope.projectId, scope.moduleId, view.audience, view.kind, size]);
  const queueCursors = view.pages[queueSection]?.signature === signature ? view.pages[queueSection]!.cursors : [""];
  const pageSignature = JSON.stringify([wsId, today, scope.projectId, scope.moduleId, 6]);
  const executionCursors = view.pages.execution?.signature === pageSignature ? view.pages.execution.cursors : [""];
  const meetingCursors = view.pages.meetings?.signature === pageSignature ? view.pages.meetings.cursors : [""];
  const bundledQueue = !full && !view.kind && queueCursors.length === 1;
  const attentionQuery = useQuery({ ...cockpitOverviewAttentionOptions(wsId, { as_of: today, project_id: scope.projectId || undefined, module_id: scope.moduleId || undefined, view: view.audience, kind: view.kind || undefined, page_size: size, cursor: queueCursors.at(-1) || undefined }), enabled: Boolean(wsId && today && !bundledQueue) });
  const executionQuery = useQuery({ ...cockpitOverviewExecutionOptions(wsId, { as_of: today, project_id: scope.projectId || undefined, module_id: scope.moduleId || undefined, page_size: 6, cursor: executionCursors.at(-1) || undefined }), enabled: Boolean(wsId && today && !full && executionCursors.length > 1) });
  const meetingsQuery = useQuery({ ...cockpitOverviewMeetingsOptions(wsId, { as_of: today, project_id: scope.projectId || undefined, module_id: scope.moduleId || undefined, days: 30, page_size: 6, cursor: meetingCursors.at(-1) || undefined }), enabled: Boolean(wsId && today && !full && meetingCursors.length > 1) });
  const attention = bundledQueue ? data?.attention.view === view.audience ? data.attention : undefined : attentionQuery.data;
  const attentionLoading = bundledQueue ? overview.isPending || (!attention && overview.isFetching) : attentionQuery.isPending;
  const attentionError = bundledQueue ? overview.isError || (!attentionLoading && !attention) : attentionQuery.isError || (!attentionLoading && !attention);
  const execution = executionCursors.length === 1 ? data?.execution_nodes : executionQuery.data;
  const meetings = meetingCursors.length === 1 ? data?.recent_meetings : meetingsQuery.data;
  const executionLoading = executionCursors.length === 1 ? overview.isPending : executionQuery.isPending;
  const meetingsLoading = meetingCursors.length === 1 ? overview.isPending : meetingsQuery.isPending;
  const setPage = (section: string, scope: string, cursors: string[]) => useCockpitDashboardViewStore.getState().setPage(viewKey, section, scope, cursors);
  const refresh = () => { void client.invalidateQueries({ queryKey: cockpitDashboardKeys.all(wsId) }); };
  const scrollToTop = () => { if (scroll.current) scroll.current.scrollTop = 0; lastScroll.current = 0; };
  const openQueue = (kind = view.kind, audience = view.audience) => {
    update({ mode: "attention", kind, audience, scrollTop: 0 });
    setPage("attention-full", "", [""]);
    scrollToTop();
  };
  useEffect(() => { restored.current = false; lastScroll.current = useCockpitDashboardViewStore.getState().views[viewKey]?.scrollTop ?? 0; }, [viewKey]);
  useEffect(() => {
    if (!data || restored.current || attentionLoading || !attention || (!full && (executionLoading || meetingsLoading || !execution || !meetings))) return;
    restored.current = true;
    if (scroll.current) scroll.current.scrollTop = lastScroll.current;
  }, [data, viewKey, attentionLoading, attention, full, executionLoading, meetingsLoading, execution, meetings]);
  useEffect(() => {
    const element = scroll.current;
    const generation = useCockpitDashboardViewStore.getState().sessionGeneration;
    return () => {
      const state = useCockpitDashboardViewStore.getState();
      if (element && state.sessionGeneration === generation) state.update(viewKey, { scrollTop: element.isConnected ? element.scrollTop : lastScroll.current });
    };
  }, [viewKey]);
  const counts = data ? view.audience === "mine" ? data.summary.my_primary_issues : data.summary.primary_issues : null;
  const kindOptions = [{ value: "__all__", label: t(($) => $.work_overview.all_work) }, ...Object.entries(kinds).map(([value, label]) => ({ value, label }))];
  return <section aria-label={t(($) => $.work_overview.work)} className="cockpit-skin cockpit-work-overview flex h-full min-h-0 flex-col">
    <div ref={scroll} onScroll={(event) => { lastScroll.current = event.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-y-auto">
      <div className="cockpit-overview-grid mx-auto max-w-[1480px] space-y-4 p-4 lg:space-y-6 lg:p-6">
        <div className={cn("cockpit-briefing", full && "cockpit-briefing-compact")}>
          <div className="cockpit-briefing-copy">
            {full && <Button type="button" variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => { update({ mode: "overview", scrollTop: 0 }); scrollToTop(); }}><ArrowLeft className="size-3.5" />{t(($) => $.work_overview.back)}</Button>}
            <p className="cockpit-eyebrow text-caption">{t(($) => $.work_overview.working_date, { date: calendarDate(today, locale) })}</p>
            <h1 className="mt-3 text-display font-semibold tracking-tight">{full ? t(($) => $.work_overview.next_actions) : t(($) => $.work_overview.work)}</h1>
            {data?.board?.goal_title && !scope.projectId && !full && <><p className="cockpit-briefing-goal mt-3 line-clamp-3 max-w-xl break-words text-title-lg" title={data.board.goal_title}>{data.board.goal_title}</p>
              {data.board.goal_date && <time dateTime={data.board.goal_date} className="mt-3 inline-flex items-center gap-2 whitespace-nowrap text-caption text-muted-foreground"><CalendarDays className="size-3.5" aria-hidden />{calendarDate(data.board.goal_date, locale)}</time>}</>}
            {!full && <AppLink href={cockpitSurfacePath(paths.cockpit(), "plan", scope)} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "cockpit-briefing-link mt-5 self-start")}>{t(($) => $.work_overview.open_plan)}<ArrowUpRight className="size-3.5" aria-hidden /></AppLink>}
            <Button type="button" variant="ghost" size="icon-sm" className="cockpit-briefing-refresh" aria-label={t(($) => $.work_overview.refresh)} onClick={refresh} disabled={overview.isFetching}><RefreshCw className={cn("size-4", overview.isFetching && "motion-safe:animate-spin")} /></Button>
          </div>
          {!full && counts && <section aria-label={t(($) => $.work_overview.execution_snapshot)} className="cockpit-briefing-instrument">
            <PanelHeading title={t(($) => $.work_overview.execution_snapshot)} icon={Target} extra={<span className="text-micro text-muted-foreground">{view.audience === "mine" ? t(($) => $.work_overview.your_primary) : t(($) => $.work_overview.team_primary)}</span>} />
            <div className="cockpit-instrument-body"><CockpitStatusOrbit counts={counts} /><div className="cockpit-status-legend min-w-0 flex-1">
              <div className="cockpit-status-total mb-4 flex items-baseline justify-between gap-3"><p className="text-caption text-muted-foreground">{t(($) => $.work_overview.total_tasks)}</p><p className="text-title-lg font-semibold tabular-nums">{counts.total}</p></div>
              <IssueDistribution counts={counts} />
            </div></div><p className="mt-3 text-micro text-muted-foreground">{t(($) => $.work_overview.acceptance_basis)}</p>
          </section>}
        </div>
        {!data ? overview.isPending ? <div className="cockpit-card p-6"><OverviewLoading rows={5} /></div> : <OverviewError onRetry={() => void overview.refetch()} /> : <>
          {overview.isError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-warning-subtle px-4 py-3 text-caption"><TriangleAlert className="size-4" />{t(($) => $.work_overview.refresh_failed)}<Button type="button" variant="ghost" size="sm" onClick={() => void overview.refetch()}>{t(($) => $.binding.retry)}</Button></div>}
          {!data.board && <div className="cockpit-card flex flex-wrap items-center justify-between gap-4 p-4 lg:p-6"><div><h2 className="text-title-sm font-medium">{t(($) => $.work_overview.no_plan)}</h2><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.work_overview.no_plan_hint)}</p></div><AppLink href={cockpitSurfacePath(paths.cockpit(), "plan", scope)} className={buttonVariants({ size: "sm" })}>{t(($) => $.work_overview.open_plan)}<ArrowRight className="ml-1 size-3.5" /></AppLink></div>}
          <div className={cn("grid min-w-0 gap-4 lg:gap-6", !full && "xl:grid-cols-12")}>
            <section aria-label={t(($) => $.work_overview.next_actions)} className={cn("cockpit-card cockpit-attention-card min-w-0 overflow-hidden", !full && "xl:col-span-7")}>
              <div className="space-y-3 border-b border-border/70 p-4 lg:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"><h2 className="flex items-center gap-2 text-title-sm font-medium"><Inbox className="size-4 text-muted-foreground" aria-hidden />{t(($) => $.work_overview.next_actions)}</h2>
                <div className="flex items-baseline gap-1.5"><span className="text-title-lg font-semibold tabular-nums">{attention?.total ?? "—"}</span><span className="text-caption text-muted-foreground">{t(($) => $.work_overview.items)}</span></div></div>
                <div className="inline-flex rounded-lg border border-border bg-card p-1"><Button type="button" size="sm" variant={view.audience === "mine" ? "brandSubtle" : "ghost"} aria-pressed={view.audience === "mine"} onClick={() => update({ audience: "mine" })}>{t(($) => $.work_overview.mine)}</Button>
                  <Button type="button" size="sm" variant={view.audience === "team" ? "brandSubtle" : "ghost"} aria-pressed={view.audience === "team"} onClick={() => update({ audience: "team" })}><Users className="size-3.5" aria-hidden />{t(($) => $.work_overview.team)}</Button></div></div>
                <div className="flex flex-wrap items-center justify-between gap-3"><Select value={view.kind || "__all__"} items={kindOptions} onValueChange={(kind) => { if (kind !== null) update({ kind: kind === "__all__" ? "" : kind }); }}><SelectTrigger className="w-full bg-card sm:w-48" aria-label={t(($) => $.work_overview.work_type)}><SelectValue /></SelectTrigger><SelectContent>{kindOptions.map((kind) => <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>)}</SelectContent></Select>
                  {!full && <Button type="button" size="sm" variant="ghost" onClick={() => openQueue()}>{t(($) => $.work_overview.view_all)}<ArrowRight className="size-3.5" /></Button>}</div>
              </div>
              <div className="space-y-3 p-4 lg:p-6"><OverviewPager page={queueCursors.length} shown={attention?.items.length} total={attention?.total} next={attention?.next_cursor} loading={attentionLoading || attentionQuery.isFetching || (bundledQueue && overview.isFetching)}
                onPrevious={() => setPage(queueSection, signature, queueCursors.slice(0, -1))} onNext={() => { if (attention?.next_cursor) setPage(queueSection, signature, [...queueCursors, attention.next_cursor]); }} />
                {attentionLoading ? <OverviewLoading /> : attentionError || !attention ? <OverviewError onRetry={() => { if (bundledQueue) void overview.refetch(); else void attentionQuery.refetch(); }} />
                  : attention.items.length > 0 ? <div className={cn("overflow-y-auto overscroll-contain", full ? "max-h-[62vh]" : "max-h-64")}><AttentionRows scope={scope} items={attention.items} human={data.actor.is_human} /></div>
                    : <div className="space-y-3 py-8 text-center"><Inbox className="mx-auto size-7 text-muted-foreground/60" aria-hidden /><h3 className="text-body font-medium">{t(($) => $.work_overview.queue_empty)}</h3>
                      {view.audience === "mine" && data.summary.attention.team_total > 0 && <Button type="button" variant="outline" size="sm" onClick={() => update({ audience: "team", kind: "" })}>{t(($) => $.work_overview.open_team, { count: data.summary.attention.team_total })}</Button>}</div>}
                <p className="border-t border-border/70 pt-3 text-micro text-muted-foreground">{t(($) => $.work_overview.queue_basis)}</p>
              </div>
            </section>
            {!full && counts && <div className="cockpit-signal-stack min-w-0 space-y-4 xl:col-span-5 lg:space-y-6">
              <div className="cockpit-metric-pair">
                <div className="cockpit-metric-tile"><Layers3 className="size-5" aria-hidden /><p className="text-caption">{t(($) => $.work_overview.execution_items)}</p><p className="text-display font-semibold tabular-nums">{data.summary.execution_nodes.total}</p></div>
                <div className="cockpit-metric-tile"><CalendarDays className="size-5" aria-hidden /><p className="text-caption">{t(($) => $.work_overview.recent_meetings)}</p><p className="text-display font-semibold tabular-nums">{meetings?.total ?? "—"}</p></div>
              </div>
            <section aria-label={t(($) => $.work_overview.needs_attention)} className="cockpit-card p-4 lg:p-6"><PanelHeading title={t(($) => $.work_overview.needs_attention)} icon={TriangleAlert} />
              <div className="grid gap-2 sm:grid-cols-2">{[
                { key: "overdue", label: view.audience === "mine" ? t(($) => $.work_overview.your_overdue) : t(($) => $.work_overview.team_overdue), count: counts.overdue, icon: Clock3, kind: "issue", audience: view.audience },
                { key: "blocked", label: view.audience === "mine" ? t(($) => $.work_overview.your_blocked) : t(($) => $.work_overview.team_blocked), count: counts.blocked, icon: TriangleAlert, kind: "issue", audience: view.audience },
                { key: "nas", label: t(($) => $.work_overview.team_nas), count: data.summary.attention.team_by_kind.nas ?? 0, icon: HardDrive, kind: "nas", audience: "team" as const },
                { key: "actions", label: t(($) => $.work_overview.team_actions), count: data.summary.attention.team_by_kind.action ?? 0, icon: ListTodo, kind: "action", audience: "team" as const },
              ].map((item) => <Button key={item.key} type="button" variant="ghost" className="h-auto min-h-11 w-full justify-between gap-2 rounded-lg px-2 py-2 text-left whitespace-normal" onClick={() => openQueue(item.kind, item.audience)} disabled={item.count === 0}
                aria-label={`${item.label}: ${item.count}. ${item.kind === "issue" ? t(($) => $.work_overview.open_issue_queue) : t(($) => $.work_overview.view_details)}`}><span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2 text-caption"><item.icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />{item.label}</span>
                  {item.kind === "issue" && <span className="mt-1 block pl-5.5 text-micro font-normal text-muted-foreground">{t(($) => $.work_overview.open_issue_queue)}</span>}</span><span className="ml-auto font-mono text-title-sm tabular-nums">{item.count}</span><ChevronRight className="size-3.5 text-muted-foreground" aria-hidden /></Button>)}</div>
            </section></div>}
          </div>
          {!full && <div className="grid min-w-0 gap-4 lg:grid-cols-2 lg:gap-6"><section aria-label={t(($) => $.work_overview.execution_items)} className="cockpit-card min-w-0 p-4 lg:p-6"><PanelHeading title={t(($) => $.work_overview.execution_items)} icon={Layers3} extra={<span className="text-caption tabular-nums text-muted-foreground">{data.summary.execution_nodes.total}</span>} />
            <p className="mb-3 text-micro text-muted-foreground">{t(($) => $.work_overview.execution_basis)}</p><OverviewPager page={executionCursors.length} shown={execution?.items.length} total={execution?.total} next={execution?.next_cursor} loading={executionLoading || executionQuery.isFetching}
              onPrevious={() => setPage("execution", pageSignature, executionCursors.slice(0, -1))} onNext={() => { if (execution?.next_cursor) setPage("execution", pageSignature, [...executionCursors, execution.next_cursor]); }} />
            <div className="mt-3 max-h-[32rem] overflow-y-auto overscroll-contain">{executionLoading ? <OverviewLoading /> : executionQuery.isError || !execution ? <OverviewError onRetry={() => { if (executionCursors.length === 1) void overview.refetch(); else void executionQuery.refetch(); }} />
              : execution.items.length ? <ExecutionRows scope={scope} items={execution.items} /> : <p className="py-8 text-center text-caption text-muted-foreground">{t(($) => $.work_overview.execution_empty)}</p>}</div>
            <AppLink href={cockpitSurfacePath(paths.cockpit(), "plan", scope)} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mt-2 w-full justify-between")}>{t(($) => $.work_overview.open_plan)}<ArrowRight className="size-3.5" /></AppLink>
          </section><section aria-label={t(($) => $.work_overview.recent_meetings)} className="cockpit-card min-w-0 p-4 lg:p-6"><PanelHeading title={t(($) => $.work_overview.recent_meetings)} icon={CalendarDays} />
            <p className="mb-3 text-micro text-muted-foreground">{meetings ? `${calendarDate(meetings.range_start, locale)} – ${calendarDate(meetings.range_end, locale)}` : t(($) => $.work_overview.loading)}</p>
            <OverviewPager page={meetingCursors.length} shown={meetings?.items.length} total={meetings?.total} next={meetings?.next_cursor} loading={meetingsLoading || meetingsQuery.isFetching}
              onPrevious={() => setPage("meetings", pageSignature, meetingCursors.slice(0, -1))} onNext={() => { if (meetings?.next_cursor) setPage("meetings", pageSignature, [...meetingCursors, meetings.next_cursor]); }} />
            <div className="mt-3 max-h-[32rem] overflow-y-auto overscroll-contain">{meetingsLoading ? <OverviewLoading /> : meetingsQuery.isError || !meetings ? <OverviewError onRetry={() => { if (meetingCursors.length === 1) void overview.refetch(); else void meetingsQuery.refetch(); }} />
              : meetings.items.length ? <MeetingRows scope={scope} items={meetings.items} /> : <p className="py-8 text-center text-caption text-muted-foreground">{t(($) => $.work_overview.meetings_empty)}</p>}</div>
            <AppLink href={cockpitSurfacePath(paths.cockpit(), "meetings", scope)} className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mt-2 w-full justify-between")}>{t(($) => $.work_overview.open_meetings)}<ArrowRight className="size-3.5" /></AppLink>
          </section></div>}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 text-micro text-muted-foreground"><span className="flex items-center gap-1.5"><CheckCheck className="size-3.5" aria-hidden />{t(($) => $.work_overview.live_source)}</span><time dateTime={data.generated_at}>{t(($) => $.work_overview.updated, { time: new Date(data.generated_at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</time></div>
        </>}
      </div>
    </div>
  </section>;
}
