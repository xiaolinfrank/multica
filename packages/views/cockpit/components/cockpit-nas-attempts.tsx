"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitNasExportAttemptsOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { LocalPathLink } from "../../common/local-path-link";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

function AttemptPage({ wsId, meetingId, exportId }: { wsId: string; meetingId: string; exportId: string }) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery(cockpitNasExportAttemptsOptions(wsId, meetingId, exportId, { cursor: cursors.at(-1) || undefined, page_size: 25 }));
  const page = query.data;
  function statusLabel(status: string) {
    switch (status) {
      case "planned": return t(($) => $.nas.attempt_planned);
      case "failed": return t(($) => $.nas.attempt_failed);
      case "verified": return t(($) => $.nas.attempt_verified);
      case "recovered": return t(($) => $.nas.attempt_recovered);
      default: return t(($) => $.nas.unknown_status, { status });
    }
  }
  return <div className="space-y-3" role="region" aria-label={t(($) => $.nas.attempts)}>
    {page && <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching}
      onPrevious={() => setCursors((current) => current.slice(0, -1))}
      onNext={() => { if (page.next_cursor) setCursors((current) => [...current, page.next_cursor!]); }} />}
    {query.isPending ? <div role="status"><Spinner />{t(($) => $.workflow.loading)}</div>
      : query.isError || !page ? <div className="space-y-2"><CockpitFlowError onRetry={() => void query.refetch()} />
        {cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}</div>
        : page.items.length === 0 ? <p className="text-caption text-muted-foreground">{t(($) => $.nas.no_attempts)}</p>
          : <div className="max-h-[40vh] space-y-3 overflow-y-auto overscroll-contain">{page.items.map((attempt) => <article key={attempt.id} className="space-y-2 text-caption">
            <p className="flex flex-wrap justify-between gap-2 font-medium"><span>{t(($) => $.nas.attempt_number, { number: attempt.attempt_number })}</span><span>{statusLabel(attempt.status)}</span></p>
            <time dateTime={attempt.created_at} className="text-muted-foreground">{Number.isFinite(Date.parse(attempt.created_at)) ? new Date(attempt.created_at).toLocaleString(locale) : attempt.created_at}</time>
            <p dir="ltr" className="break-all font-mono text-micro">{attempt.target_path}</p>
            {["verified", "recovered"].includes(attempt.status) && attempt.verified_path && attempt.verified_receipt_path && <div className="flex flex-wrap gap-3">
              <LocalPathLink path={attempt.verified_path}>{t(($) => $.nas.open_verified_copy)}</LocalPathLink>
              <LocalPathLink path={attempt.verified_receipt_path}>{t(($) => $.nas.open_completion_record)}</LocalPathLink></div>}
            {(attempt.last_error_code || attempt.last_error) && <details><summary className="cursor-pointer text-destructive">{t(($) => $.nas.error_details)}</summary>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-destructive"><p>{attempt.last_error_code}</p><p>{attempt.last_error}</p></div></details>}
          </article>)}</div>}
  </div>;
}

export function CockpitNasAttempts(props: { wsId: string; meetingId: string; exportId: string }) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  return <div className="space-y-3"><Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.nas.attempts)}</Button>
    {open && <AttemptPage key={`${props.wsId}:${props.meetingId}:${props.exportId}`} {...props} />}</div>;
}
