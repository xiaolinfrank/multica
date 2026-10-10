"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitMeetingArtifactReferencesOptions, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

export function CockpitMeetingArtifactReferences({ wsId, meetingId }: { wsId: string; meetingId: string }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [open, setOpen] = useState(false); const [includeRemoved, setIncludeRemoved] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitMeetingArtifactReferencesOptions(wsId, meetingId, { include_removed: includeRemoved, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open }); const page = query.data;
  const purposeLabel = (value: string) => value === "input" || value === "output" || value === "evidence" || value === "reference" ? t(($) => $.artifact_runtime.purposes[value]) : value;
  return <section className="space-y-3 rounded-lg border border-border p-4"><Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.artifact_runtime.meeting_fixed_artifacts)}</Button>
    {open && <><p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.reference_hint)}</p>
      <label className="flex items-start gap-2 text-caption"><Checkbox checked={includeRemoved} onCheckedChange={(value) => { setIncludeRemoved(value === true); setCursors([""]); }} />{t(($) => $.artifact_runtime.include_removed)}</label>
      {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        : cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
      {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-80 space-y-3 overflow-y-auto">{page.items.map((item) => <li key={item.id} className="space-y-1 text-caption">
        <AppLink href={cockpitArtifactPath(paths.cockpit(), item.artifact_id, EMPTY_COCKPIT_SCOPE, item.version_id)} target="_blank" rel="noopener noreferrer" className="line-clamp-2 break-words text-primary hover:underline" title={item.artifact_title}>
          {item.artifact_title} · {t(($) => $.workflow.version, { number: item.version_number })} {t(($) => $.action_flow.new_tab)}</AppLink>
        <p className="text-micro text-muted-foreground">{purposeLabel(item.purpose)}</p>
        {item.removed_at && <p className="text-muted-foreground">{t(($) => $.artifact_runtime.reference_removed)}</p>}
      </li>)}</ul>}
      {page?.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.no_references)}</p>}
    </>}
  </section>;
}
