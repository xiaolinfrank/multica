"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitDirectorySummaryOptions, cockpitDirectoryOperationsOptions, cockpitMeetingDirectoryPath,
  cockpitRelationViewKey, useCockpitScopeViewStore, EMPTY_COCKPIT_RELATION_PAGE,
} from "@multica/core/cockpit";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink, useNavigation } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitDirectoryPrepare } from "./cockpit-directory-prepare";
import { CockpitDirectoryOperation } from "./cockpit-directory-operation";
import { CockpitDirectoryReasons, CockpitDirectoryProgressCounts, useDirectoryLabel } from "./cockpit-directory-parts";

export function CockpitMeetingDirectory({ wsId, meetingId, available, active, operationId, readOnly, onManageMeeting }: {
  wsId: string; meetingId: string; available: boolean; active: boolean; operationId: string | null; readOnly?: boolean; onManageMeeting: () => void;
}) {
  const { t } = useT("cockpit"); const navigation = useNavigation(); const client = useQueryClient(); const locale = useLocale(); const label = useDirectoryLabel();
  const [historyOpen, setHistoryOpen] = useState(false);
  const summary = useQuery({ ...cockpitDirectorySummaryOptions(wsId, meetingId), enabled: available && active });
  const key = cockpitRelationViewKey(wsId, "directory-history", meetingId);
  const cursors = useCockpitScopeViewStore((state) => state.relations[key] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const options = cockpitDirectoryOperationsOptions(wsId, meetingId, { cursor: cursors.at(-1) || undefined, page_size: 25 });
  const history = useQuery({ ...options, enabled: available && active && historyOpen && !operationId });
  const page = history.data, data = summary.data;
  const path = (id: string | null) => cockpitMeetingDirectoryPath(navigation.pathname, meetingId, id, navigation.searchParams);
  const refresh = () => { void summary.refetch(); };
  const firstPage = async () => {
    await client.invalidateQueries({ queryKey: cockpitDirectoryOperationsOptions(wsId, meetingId, { page_size: 25 }).queryKey });
    useCockpitScopeViewStore.getState().setRelationPage(key, [""]);
  };
  if (!available) return operationId ? <section className="space-y-3" aria-label={t(($) => $.meeting_directory.title)}>
    <p role="status" className="text-caption">{t(($) => $.feature_availability.unavailable)}</p>
    <AppLink href={path(null)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_directory.return_materials)}</AppLink>
  </section> : null;
  return <section className="min-w-0 space-y-3" aria-label={t(($) => $.meeting_directory.title)}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.meeting_directory.title)}</h3>
      {operationId && <AppLink href={path(null)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_directory.return_materials)}</AppLink>}
    </div>
    {summary.isError && <CockpitFlowError onRetry={refresh} />}
    {!data ? summary.isPending ? <Spinner /> : null : <>
      <div hidden={Boolean(operationId)} className="space-y-3 rounded-lg border border-border p-3">
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.summary_hint)}</p>
        <CockpitDirectoryReasons codes={data.blocked_reasons} />
        {data.blocked_reasons.some((code) => code === "meeting_cancelled" || code === "meeting_archived") && <Button variant="outline" size="sm" onClick={onManageMeeting}>{t(($) => $.meeting_disposition.actions)}</Button>}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-caption"><p>{t(($) => $.meeting_directory.unfinished, { count: data.unfinished_total })}</p><p>{t(($) => $.meeting_directory.attention, { count: data.needs_attention_total })}</p></div>
        {data.current && <div className="space-y-2"><AppLink href={path(data.current.id)} className="block line-clamp-2 break-all text-caption text-primary underline" title={data.current.target.directory}>{data.current.target.directory}</AppLink>
          <p className="text-caption text-muted-foreground">{label(data.current.state)}</p><CockpitDirectoryProgressCounts value={data.current.counts} />
          <AppLink href={path(data.current.id)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_directory.open_operation)}</AppLink></div>}
        <div className="flex flex-wrap gap-2"><CockpitDirectoryPrepare wsId={wsId} summary={data} readOnly={readOnly || summary.isError} refresh={refresh} onCreated={(id) => navigation.push(path(id))} onManageMeeting={onManageMeeting} />
          <Button variant="outline" size="sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>{t(($) => $.meeting_directory.history, { count: data.history_total })}</Button>
          <Button variant="ghost" size="sm" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>
        {historyOpen && <div className="space-y-2">
          {history.isError && <CockpitFlowError onRetry={() => void history.refetch()} />}
          {history.isPending ? <Spinner /> : page && <>
            {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.no_history)}</p>}
            <ol className="max-h-[42vh] divide-y divide-border overflow-y-auto">{page.items.map((item) => <li key={item.id} className="space-y-1 py-3 text-caption">
              <AppLink href={path(item.id)} className="block line-clamp-2 break-all text-primary underline" title={item.target.directory}>{item.target.directory}</AppLink><p>{label(item.state)}</p>
              <p className="text-muted-foreground">{item.responsible_user_name || t(($) => $.meeting_directory.no_name)}{Number.isFinite(Date.parse(item.created_at)) && <> · {new Date(item.created_at).toLocaleString(locale)}</>}</p>
            </li>)}</ol>
          </>}
          <CockpitFlowPaging page={cursors.length} shown={page?.items.length ?? 0} total={page?.total} hasNext={!history.isError && Boolean(page?.next_cursor)} busy={history.isFetching}
            onPrevious={() => useCockpitScopeViewStore.getState().setRelationPage(key, cursors.slice(0, -1))}
            onNext={() => { if (page?.next_cursor) useCockpitScopeViewStore.getState().setRelationPage(key, [...cursors, page.next_cursor]); }} />
          {cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => void firstPage()}>{t(($) => $.task_flow.first_page)}</Button>}
        </div>}
      </div>
      {operationId && <CockpitDirectoryOperation key={operationId} wsId={wsId} summary={data} operationId={operationId} active={active} readOnly={readOnly || summary.isError} onCreated={(id) => navigation.push(path(id))} onManageMeeting={onManageMeeting} refreshSummary={refresh} />}
    </>}
  </section>;
}
