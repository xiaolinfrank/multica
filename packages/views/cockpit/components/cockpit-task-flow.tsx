"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitActionIssueSearchOptions, COCKPIT_TASK_PAGE_SIZE } from "@multica/core/cockpit";
import type { CockpitTask, Issue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { isIssueStatusCategory } from "@multica/core/issue-statuses";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { StatusIcon } from "../../issues/components/status-icon";
import { useStatusLabel } from "../../issues/utils/status-label";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function useCockpitSearch(value: string) {
  const [query, setQuery] = useState(value.trim());
  useEffect(() => { const timer = setTimeout(() => setQuery(value.trim()), 250); return () => clearTimeout(timer); }, [value]);
  return query;
}

export function CockpitFlowError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("cockpit");
  return <div role="alert" className="space-y-2 text-caption text-destructive"><p>{t(($) => $.task_flow.load_failed)}</p>
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>{t(($) => $.binding.retry)}</Button></div>;
}

export function CockpitFlowPaging({ page, shown, total, hasNext, busy, onPrevious, onNext }: {
  page: number; shown: number; total?: number; hasNext: boolean; busy: boolean; onPrevious: () => void; onNext: () => void;
}) {
  const { t } = useT("cockpit");
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
    <p className="text-caption text-muted-foreground">{total === undefined ? t(($) => $.task_flow.page_shown, { page, shown })
      : t(($) => $.task_flow.page_count, { page, shown, total })}</p>
    <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={busy || page <= 1} onClick={onPrevious}>{t(($) => $.task_flow.previous)}</Button>
      <Button type="button" variant="outline" size="sm" disabled={busy || !hasNext} onClick={onNext}>{t(($) => $.task_flow.next)}</Button></div>
  </div>;
}

export function CockpitTaskRows({ wsId, items, trailing }: { wsId: string; items: CockpitTask[]; trailing?: (issue: CockpitTask) => React.ReactNode }) {
  const paths = useWorkspacePaths();
  const label = useStatusLabel(wsId);
  const { t } = useT("cockpit");
  return <ul className="max-h-[45vh] overflow-y-auto overscroll-contain divide-y divide-border">{items.map((issue) => <li key={issue.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3">
    <AppLink href={paths.issueDetail(issue.identifier || issue.id)} newTabTitle={issue.title} title={`${issue.identifier} ${issue.title}`}
      aria-label={`${issue.identifier} ${issue.title}`} className="line-clamp-2 min-w-0 break-words text-body hover:underline">
      <span className="mr-2 font-mono text-caption text-muted-foreground">{issue.identifier}</span>{issue.title || t(($) => $.issue_detail.untitled)}</AppLink>
    <span className="inline-flex min-w-0 max-w-32 items-center gap-1.5 text-caption"><StatusIcon status={issue.status}
      category={isIssueStatusCategory(issue.status_category) ? issue.status_category : undefined} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={label(issue.status)}>{label(issue.status)}</span></span>
    <p className="flex min-w-0 flex-wrap gap-x-3 text-caption text-muted-foreground">
      <span>{issue.assignee_name || issue.assignee_id || t(($) => $.workflow.unassigned)}</span>
      {issue.due_date && <span>{t(($) => $.task_flow.due, { date: issue.due_date })}</span>}
    </p>
    {trailing && <div className="flex justify-end">{trailing(issue)}</div>}
  </li>)}</ul>;
}

/** The selected item is explicit user intent and survives searching another bounded result page. */
export function CockpitIssueChoice({ wsId, selected, onSelect, disabled }: {
  wsId: string; selected: Issue | null; onSelect: (issue: Issue) => void; disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const [text, setText] = useState("");
  const q = useCockpitSearch(text);
  const [page, setPage] = useState({ query: "", index: 0 });
  const index = page.query === q ? page.index : 0;
  const query = useQuery(cockpitActionIssueSearchOptions(wsId, q, index * COCKPIT_TASK_PAGE_SIZE));
  const items = query.data?.issues ?? [];
  const changing = text.trim() !== q;
  return <section className="space-y-2" aria-label={t(($) => $.task_flow.issue_search)}>
    <label className="block text-caption">{t(($) => $.task_flow.issue_search)}<Input className="mt-1" value={text} disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (next !== text) setPage({ query: next.trim(), index: 0 });
        setText(next);
      }} placeholder={t(($) => $.task_flow.search_hint)} /></label>
    {selected && <p className="break-words rounded-md bg-accent p-2 text-caption">{t(($) => $.task_flow.selected_issue, { name: `${selected.identifier} ${selected.title}` })}</p>}
    {!q ? <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.search_hint)}</p>
      : query.isError || items.length > COCKPIT_TASK_PAGE_SIZE ? <CockpitFlowError onRetry={() => void query.refetch()} />
        : query.isPending || changing ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
          : <>
            <ul className="max-h-64 overflow-y-auto divide-y divide-border">{items.map((issue) => <li key={issue.id}>
              <Button type="button" variant={selected?.id === issue.id ? "secondary" : "ghost"} className="h-auto min-h-9 w-full justify-start whitespace-normal text-left"
                disabled={disabled} aria-label={`${issue.identifier} ${issue.title}`} aria-pressed={selected?.id === issue.id} onClick={() => onSelect(issue)}>
                <span className="shrink-0 font-mono text-caption">{issue.identifier}</span><span className="line-clamp-2 min-w-0 break-words" title={issue.title}>{issue.title}</span>
              </Button></li>)}</ul>
            {items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
            <CockpitFlowPaging page={index + 1} shown={items.length} hasNext={items.length === COCKPIT_TASK_PAGE_SIZE} busy={query.isFetching}
              onPrevious={() => setPage({ query: q, index: Math.max(0, index - 1) })} onNext={() => setPage({ query: q, index: index + 1 })} />
          </>}
  </section>;
}
