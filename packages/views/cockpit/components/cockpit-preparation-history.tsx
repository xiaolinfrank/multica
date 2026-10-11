"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitPreparationOperationsOptions, cockpitMeetingPreparationPath } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

export function CockpitPreparationHistory({ wsId, meetingId }: { wsId: string; meetingId: string }) {
  const { t } = useT("cockpit"); const locale = useLocale(); const paths = useWorkspacePaths(); const navigation = useNavigation(); const [open, setOpen] = useState(false); const [cursors, setCursors] = useState([""]);
  const query = useQuery({ ...cockpitPreparationOperationsOptions(wsId, meetingId, { page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: open }); const page = query.data;
  return <section className="space-y-2"><Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.meeting_preparation.history)}</Button>
    {open && <div className="space-y-2 rounded-lg border border-border p-3">{query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-64 divide-y divide-border overflow-y-auto">{page.items.map((item) => <li key={item.id} className="space-y-1 py-3 text-caption"><AppLink className="block break-words text-primary underline" href={cockpitMeetingPreparationPath(paths.cockpit(), meetingId, item.id, navigation.searchParams)}>{item.template_title || (item.kind === "apply_template" ? t(($) => $.meeting_preparation.template_application) : item.kind === "cancel_preparation" ? t(($) => $.meeting_preparation.cancellation) : t(($) => $.artifacts.unknown))}{item.template_version_number !== null && <> · {t(($) => $.workflow.version, { number: item.template_version_number })}</>}</AppLink>
        <p className="text-muted-foreground">{item.created_by_name || t(($) => $.meeting_preparation.responsible_unknown)} · {Number.isFinite(Date.parse(item.created_at)) ? new Date(item.created_at).toLocaleString(locale) : t(($) => $.common.unset)} · {t(($) => $.meeting_preparation.progress_count, { applied: item.counts.applied, total: item.counts.total, remaining: item.counts.pending + item.counts.needs_attention })}</p></li>)}</ul>
      {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_preparation.empty)}</p>}
    </>}{cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}</div>}
  </section>;
}
