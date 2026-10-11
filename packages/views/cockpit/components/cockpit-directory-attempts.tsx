"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitDirectoryAttemptsOptions, cockpitDirectoryAttemptOptions,
  cockpitRelationViewKey, EMPTY_COCKPIT_RELATION_PAGE, useCockpitScopeViewStore,
} from "@multica/core/cockpit";
import type { CockpitDirectoryStepMetadata, CockpitDirectoryObservation } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { LocalPathLink } from "../../common/local-path-link";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitDirectoryReasons, useDirectoryLabel } from "./cockpit-directory-parts";

export function CockpitDirectoryAttempts({ wsId, meetingId, step }: { wsId: string; meetingId: string; step: CockpitDirectoryStepMetadata }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const label = useDirectoryLabel(); const client = useQueryClient();
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const key = cockpitRelationViewKey(wsId, "directory-attempts", JSON.stringify([meetingId, step.operation_id, step.id]));
  const cursors = useCockpitScopeViewStore((state) => state.relations[key] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const setCursors = (next: string[]) => useCockpitScopeViewStore.getState().setRelationPage(key, next);
  const query = useQuery({ ...cockpitDirectoryAttemptsOptions(wsId, meetingId, step.operation_id, step.id, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open }); const page = query.data;
  const detail = useQuery({ ...cockpitDirectoryAttemptOptions(wsId, meetingId, step.operation_id, step.id, selected ?? ""), enabled: open && Boolean(selected) });
  const first = async () => { await client.invalidateQueries({ queryKey: cockpitDirectoryAttemptsOptions(wsId, meetingId, step.operation_id, step.id, { page_size: 25 }).queryKey }); setCursors([""]); };
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button variant="outline" size="sm" />}>{t(($) => $.meeting_directory.attempts, { count: step.attempt_count })}</DialogTrigger>
    <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl"><DialogHeader><DialogTitle className="line-clamp-3 break-words" title={step.label}>{step.label}</DialogTitle></DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain">{selected ? <>
        <Button size="sm" variant="outline" onClick={() => setSelected(null)}>{t(($) => $.meeting_directory.back_attempts)}</Button>
        {detail.isPending ? <Spinner /> : detail.isError || !detail.data ? <CockpitFlowError onRetry={() => void detail.refetch()} /> : <div className="space-y-3 text-caption">
          <h3 className="text-body font-medium">{t(($) => $.meeting_directory.attempt_number, { number: detail.data.attempt_number })} · {label(detail.data.state)}</h3>
          <p className="text-muted-foreground">{new Date(detail.data.started_at).toLocaleString(locale)}</p>
          {detail.data.error_code && <CockpitDirectoryReasons codes={[detail.data.error_code]} />}
          {detail.data.error_message && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{detail.data.error_message}</p>}
          {detail.data.receipt && <DirectoryObservation value={detail.data.receipt} />}
          {detail.data.late_receipt && <section className="space-y-2 rounded-md border border-border p-3"><h4 className="font-medium">{t(($) => $.meeting_directory.late_observation)}</h4><p className="text-muted-foreground">{t(($) => $.meeting_directory.late_hint)}</p><DirectoryObservation value={detail.data.late_receipt} /></section>}
        </div>}
      </> : <>
        {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
          <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
          <ol className="max-h-[48vh] divide-y divide-border overflow-y-auto">{page.items.map((attempt) => <li key={attempt.id} className="py-2"><Button variant="ghost" className="h-auto w-full flex-wrap justify-start whitespace-normal text-left" onClick={() => setSelected(attempt.id)}>
            <span>{t(($) => $.meeting_directory.attempt_number, { number: attempt.attempt_number })} · {label(attempt.state)}</span><span className="text-caption text-muted-foreground">{new Date(attempt.started_at).toLocaleString(locale)}</span>
          </Button></li>)}</ol>
          {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory.no_attempts)}</p>}
        </>}
        {cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => void first()}>{t(($) => $.task_flow.first_page)}</Button>}
      </>}</div>
    </DialogContent>
  </Dialog>;
}

function DirectoryObservation({ value }: { value: CockpitDirectoryObservation }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const label = useDirectoryLabel();
  return <div className="space-y-2 text-caption"><p>{label(value.outcome)}</p><p className="text-muted-foreground">{t(($) => $.meeting_directory.checked_at, { time: new Date(value.observed_at).toLocaleString(locale) })}</p>
    <LocalPathLink path={value.directory} wrap="truncate" />
    <details><summary className="cursor-pointer text-muted-foreground">{t(($) => $.meeting_directory.details)}</summary><div className="space-y-2 break-all"><p dir="ltr">{value.directory}</p><p>{value.root_identity}</p><p>{value.directory_identity}</p></div></details>
  </div>;
}
