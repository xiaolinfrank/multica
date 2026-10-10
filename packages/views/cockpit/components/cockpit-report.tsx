"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, CalendarDays, CircleCheck, ClipboardList, Printer, RefreshCw, Target, TriangleAlert } from "lucide-react";
import { cockpitReportOptions, cockpitObjectPath, cockpitSurfacePath, cockpitAttentionDestination, type CockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink } from "../../navigation";
import { useLocale, useT } from "../../i18n";

export interface CockpitReportProps {
  wsId: string; scope: CockpitScope; asOf: string; returnHref: string;
  /** The host supplies a real print capability; its absence removes the affordance. */
  onPrint?: (element: HTMLElement) => Promise<void>;
}
export function CockpitReport(props: CockpitReportProps) {
  return <ReportSession key={JSON.stringify([props.wsId, props.scope])} {...props} />;
}
function ReportSession({ wsId, scope, asOf: initialAsOf, returnHref, onPrint }: CockpitReportProps) {
  const { t } = useT("cockpit"); const locale = useLocale(); const paths = useWorkspacePaths();
  const [asOf] = useState(initialAsOf);
  const sessionId = useId(); const report = useQuery(cockpitReportOptions(wsId, scope, asOf, sessionId)); const data = report.data; const { refetch } = report;
  const initialized = useRef(false), paper = useRef<HTMLDivElement>(null), printLock = useRef(false);
  const [printing, setPrinting] = useState(false), [printError, setPrintError] = useState("");
  useEffect(() => { if (!initialized.current && wsId && asOf) { initialized.current = true; void refetch(); } }, [refetch, wsId, asOf]);
  const refresh = () => { setPrintError(""); void report.refetch(); };
  const print = async () => {
    if (!onPrint || !paper.current || !data || report.isError || report.isFetching || printLock.current) return;
    printLock.current = true; setPrinting(true); setPrintError("");
    try { await onPrint(paper.current); } catch (cause) { setPrintError(cause instanceof Error ? cause.message : t(($) => $.report.print_failed)); }
    finally { printLock.current = false; setPrinting(false); }
  };
  const scopeTitle = data ? [data.scope.projectTitle || data.scope.projectId, data.scope.moduleTitle || data.scope.moduleId].filter(Boolean).join(" / ") || t(($) => $.shell.all_projects) : "";
  const sourceLink = (href: string, text: string) => <AppLink href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-caption text-primary hover:underline">{text}<ArrowUpRight className="size-3.5" aria-hidden /></AppLink>;
  return <section className="flex min-h-0 flex-1 flex-col bg-muted/20" aria-label={t(($) => $.report.title)}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 lg:px-8">
      <AppLink href={returnHref} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-4" />{t(($) => $.report.back)}</AppLink>
      <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={report.isFetching || printing} onClick={refresh}>{report.isFetching ? <Spinner /> : <RefreshCw className="size-4" />}{t(($) => $.report.refresh)}</Button>
        {onPrint && <Button type="button" size="sm" disabled={!data || report.isFetching || report.isError || printing} onClick={() => void print()}>{printing ? <Spinner /> : <Printer className="size-4" />}{t(($) => $.report.print)}</Button>}</div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 lg:p-8">
      {report.isError && <div role="alert" className="mx-auto mb-4 max-w-6xl space-y-2 rounded-xl border border-destructive/30 bg-card p-4 text-caption"><p>{data ? t(($) => $.report.refresh_failed) : t(($) => $.report.load_failed)}</p><Button type="button" size="sm" variant="outline" disabled={report.isFetching} onClick={refresh}>{t(($) => $.binding.retry)}</Button></div>}
      {!data && !report.isError && <div role="status" className="mx-auto flex max-w-6xl items-center gap-2 rounded-xl border bg-card p-6 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>}
      {printError && <p role="alert" className="mx-auto mb-4 max-w-6xl text-caption text-destructive">{printError}</p>}
      {data && <div ref={paper} className="mx-auto max-w-6xl space-y-6 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-8 lg:p-10">
        <header className="space-y-4 border-b border-border/70 pb-6"><p className="text-caption font-medium tracking-wide text-primary">{t(($) => $.report.title)}</p>
          <h1 className="break-words text-display-sm sm:text-display font-semibold">{data.title || t(($) => $.header.title_placeholder)}</h1>
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-caption"><div><dt className="text-muted-foreground">{t(($) => $.shell.scope)}</dt><dd className="mt-1 break-words font-medium">{scopeTitle}</dd></div>
            <div><dt className="text-muted-foreground">{t(($) => $.report.as_of)}</dt><dd className="mt-1 tabular-nums">{data.asOf}</dd></div>
            <div><dt className="text-muted-foreground">{t(($) => $.report.retrieved_at)}</dt><dd className="mt-1 tabular-nums">{new Date(data.retrievedAt).toLocaleString(locale)}</dd></div></dl>
          <p className="max-w-4xl text-caption text-muted-foreground">{t(($) => $.report.basis)}</p>
        </header>
        <section className="rounded-xl bg-primary/5 p-5"><h2 className="mb-2 flex items-center gap-2 text-title-sm font-medium"><Target className="size-4" />{t(($) => $.report.workspace_goal)}</h2>
          <p className="whitespace-pre-wrap break-words text-title-sm leading-relaxed">{data.goal || t(($) => $.report.goal_missing)}</p>{data.goalDate && <p className="mt-3 text-caption text-muted-foreground">{t(($) => $.report.goal_date, { date: data.goalDate })}</p>}
        </section>
        <section aria-label={t(($) => $.report.execution_summary)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
          [t(($) => $.report.work_items), data.summary.workItems], [t(($) => $.report.active_issues), data.summary.issues.active],
          [t(($) => $.report.done_issues), data.summary.issues.done], [t(($) => $.report.attention_total), data.summary.attention],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-border/70 px-5 py-4"><p className="text-caption text-muted-foreground">{label}</p><p className="mt-2 text-display-sm sm:text-display font-semibold tabular-nums">{value}</p></div>)}</section>
        <p className="text-caption text-muted-foreground">{t(($) => $.report.issue_basis, { closed: data.summary.issues.closed, unknown: data.summary.issues.unknown })}</p>
        <section className="rounded-xl border border-warning-foreground/20 bg-warning-foreground/5 p-5"><h2 className="mb-3 flex items-center gap-2 text-title-sm font-medium"><TriangleAlert className="size-4" />{t(($) => $.report.exceptions)}</h2>
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-body">{[[t(($) => $.work_overview.overdue), data.summary.issues.overdue], [t(($) => $.work_overview.blocked), data.summary.issues.blocked], [t(($) => $.workflow.unassigned), data.summary.issues.unassigned]].map(([label, count]) => <div key={label} className="flex items-center gap-3"><dt>{label}</dt><dd className="font-semibold tabular-nums">{count}</dd></div>)}</dl>
        </section>
        <div className="grid gap-6 lg:grid-cols-2"><section className="min-w-0"><h2 className="mb-2 flex items-center gap-2 text-title-sm font-medium"><ClipboardList className="size-4" />{t(($) => $.report.execution)}</h2>
          <p className="mb-3 text-caption text-muted-foreground">{t(($) => $.report.preview, { shown: data.execution.items.length, total: data.execution.total })}</p>
          <ul className="divide-y divide-border">{data.execution.items.map((item) => <li key={item.id} className="min-w-0 space-y-2 py-3"><p className="line-clamp-2 break-words text-body font-medium" title={`${item.code} ${item.title}`}>{item.code} {item.title}</p>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground"><span className="break-words">{item.owner || t(($) => $.workflow.unassigned)}</span><span>{item.end || t(($) => $.report.no_date)}</span><span className="break-words">{item.status || t(($) => $.common.unset)}</span></p>
            <p className="text-caption">{t(($) => $.report.active_count, { count: item.activeIssues })}</p>{sourceLink(cockpitObjectPath(paths.cockpit(), { kind: "node", id: item.id }, scope), t(($) => $.report.source))}</li>)}</ul>
          {data.execution.items.length === 0 && <p className="py-4 text-caption text-muted-foreground">{t(($) => $.report.no_execution)}</p>}
          {sourceLink(cockpitSurfacePath(paths.cockpit(), "plan", scope, "table"), t(($) => $.report.open_plan))}
        </section><section className="min-w-0"><h2 className="mb-2 flex items-center gap-2 text-title-sm font-medium"><CircleCheck className="size-4" />{t(($) => $.report.attention)}</h2>
          <p className="mb-3 text-caption text-muted-foreground">{t(($) => $.report.preview, { shown: data.attention.items.length, total: data.attention.total })}</p>
          <ul className="divide-y divide-border">{data.attention.items.map((item) => { const target = cockpitAttentionDestination(item.target); const href = target ? target.kind === "issue" ? paths.issueDetail(target.id) : cockpitObjectPath(paths.cockpit(), target, scope) : null;
            return <li key={item.id} className="space-y-2 py-3"><p className="line-clamp-2 break-words text-body font-medium" title={item.title}>{item.title}</p>{item.dueDate && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.due, { date: item.dueDate })}</p>}{href && sourceLink(href, t(($) => $.report.source))}</li>; })}</ul>
          {data.attention.items.length === 0 && <p className="py-4 text-caption text-muted-foreground">{t(($) => $.report.no_attention)}</p>}
          {sourceLink(cockpitSurfacePath(paths.cockpit(), "work", scope), t(($) => $.report.open_work))}
        </section></div>
        <section className="border-t border-border/70 pt-5"><h2 className="mb-2 flex items-center gap-2 text-title-sm font-medium"><CalendarDays className="size-4" />{t(($) => $.report.meetings)}</h2>
          <p className="mb-3 text-caption text-muted-foreground">{t(($) => $.report.meeting_window, { from: data.meetings.rangeStart, to: data.meetings.rangeEnd })} · {t(($) => $.report.preview, { shown: data.meetings.items.length, total: data.meetings.total })}</p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.meetings.items.map((item) => <li key={item.id} className="min-w-0 space-y-2 rounded-xl border border-border/70 p-4"><p className="line-clamp-2 break-words text-body font-medium" title={item.title}>{item.title}</p><p className="flex flex-wrap gap-2 text-caption text-muted-foreground"><span>{item.date}</span><span className="break-all">{item.time}</span></p>{sourceLink(cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: item.id }, scope), t(($) => $.report.source))}</li>)}</ul>
          {data.meetings.items.length === 0 && <p className="py-3 text-caption text-muted-foreground">{t(($) => $.report.no_meetings)}</p>}
        </section>
        <footer className="border-t border-border/70 pt-4 text-micro text-muted-foreground">{t(($) => $.report.exclusions)}</footer>
      </div>}
    </div>
  </section>;
}
