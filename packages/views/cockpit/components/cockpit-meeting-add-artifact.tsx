"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitArtifactPath, cockpitSurfacePath, EMPTY_COCKPIT_SCOPE, cockpitArtifactsOptions, cockpitArtifactOptions } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitArtifactMeetingReferenceCreate } from "./cockpit-artifact-references";

/** The meeting is fixed; selecting a source never silently attaches it to an agenda. */
export function CockpitMeetingAddArtifact({ wsId, meetingId, readOnly = false }: { wsId: string; meetingId: string; readOnly?: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [open, setOpen] = useState(false); const [text, setText] = useState(""); const [cursors, setCursors] = useState([""]); const [artifactId, setArtifactId] = useState("");
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const query = useQuery({ ...cockpitArtifactsOptions(wsId, { q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open && !artifactId && !changing }); const page = query.data;
  const selected = useQuery({ ...cockpitArtifactOptions(wsId, artifactId), enabled: open && Boolean(artifactId) });
  return <div className="space-y-3"><Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={readOnly} onClick={() => setOpen(!open)}>{t(($) => $.meeting_lifecycle.add_fixed_artifact)}</Button>
    {open && <div className="space-y-3 rounded-lg border border-border p-3"><AppLink target="_blank" rel="noopener noreferrer" href={cockpitSurfacePath(paths.cockpit(), "artifacts", EMPTY_COCKPIT_SCOPE)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_lifecycle.open_artifact_workspace)} {t(($) => $.action_flow.new_tab)}</AppLink>{artifactId ? <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setArtifactId("")}>{t(($) => $.meeting_lifecycle.change_artifact)}</Button>
      {selected.isPending ? <Spinner /> : selected.isError || !selected.data ? <CockpitFlowError onRetry={() => void selected.refetch()} /> : <>
        <AppLink target="_blank" rel="noopener noreferrer" href={cockpitArtifactPath(paths.cockpit(), selected.data.id, EMPTY_COCKPIT_SCOPE)} className="line-clamp-3 break-words text-body font-medium text-primary underline" title={selected.data.title}>{selected.data.title} {t(($) => $.action_flow.new_tab)}</AppLink>
        {!selected.data.can_reference && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.reference_unavailable)}</p>}
        <CockpitArtifactMeetingReferenceCreate key={`${wsId}:${meetingId}:${artifactId}`} wsId={wsId} meetingId={meetingId} artifact={selected.data} disabled={readOnly || selected.isError || selected.isFetching} onCreated={() => { setOpen(false); setArtifactId(""); }} />
      </>}
    </> : <><label className="block space-y-1 text-caption">{t(($) => $.artifacts.search)}<Input name="meeting-material-artifact-search" value={text} onChange={(event) => { setText(event.target.value); setCursors([""]); }} autoComplete="off" /></label>
      {query.isPending || changing ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{page.items.map((artifact) => <li key={artifact.id}><Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => setArtifactId(artifact.id)} aria-label={artifact.title}><span className="line-clamp-2 break-words" title={artifact.title}>{artifact.title}</span></Button></li>)}</ul>
        {page.items.length === 0 && <p className="text-caption text-muted-foreground">{q ? t(($) => $.task_flow.no_matches) : t(($) => $.artifacts.empty)}</p>}
        <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.filtered_total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      </>}{!page && cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    </>}</div>}
  </div>;
}
