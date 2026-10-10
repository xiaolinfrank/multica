"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitMeetingDetailOptions, cockpitMinutesVersionsOptions, cockpitMinutesVersionOptions, cockpitObjectPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitMeetingPicker } from "./cockpit-meeting-picker";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

export function CockpitArtifactSourceMeeting({ wsId, meetingId, versionId, disabled, onChange }: {
  wsId: string; meetingId: string; versionId: string; disabled: boolean;
  onChange: (patch: { sourceMeetingId?: string; sourceMinutesVersionId?: string }) => void;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const meeting = useQuery({ ...cockpitMeetingDetailOptions(wsId, meetingId, EMPTY_COCKPIT_SCOPE), enabled: Boolean(meetingId) });
  return <div className="space-y-2 text-caption"><p className="font-medium">{t(($) => $.artifact_runtime.meeting_source)}</p>
    <CockpitMeetingPicker wsId={wsId} label={t(($) => $.artifact_runtime.choose_meeting)} disabled={disabled} onSelect={async (id) => onChange({ sourceMeetingId: id })} />
    {meetingId && <><div className="flex flex-wrap gap-3"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: meetingId })} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{meeting.data?.meeting.title || meetingId}</AppLink>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onChange({ sourceMeetingId: "", sourceMinutesVersionId: "" })}>{t(($) => $.artifact_runtime.clear_source)}</Button></div>
      {meeting.isError && <CockpitFlowError onRetry={() => void meeting.refetch()} />}
      <MinutesChoice key={meetingId} wsId={wsId} meetingId={meetingId} value={versionId} disabled={disabled} onChange={(sourceMinutesVersionId) => onChange({ sourceMinutesVersionId })} />
    </>}
  </div>;
}

function MinutesChoice({ wsId, meetingId, value, disabled, onChange }: { wsId: string; meetingId: string; value: string; disabled: boolean; onChange: (id: string) => void }) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitMinutesVersionsOptions(wsId, meetingId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open });
  const page = query.data;
  const selected = useQuery({ ...cockpitMinutesVersionOptions(wsId, meetingId, value), enabled: Boolean(value) });
  return <div className="space-y-2"><p className="text-muted-foreground">{t(($) => $.artifact_runtime.meeting_source_hint)}</p>
    {value && <p>{t(($) => $.artifact_runtime.fixed_minutes)}: {selected.data?.version.version_number ?? value}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.artifact_runtime.choose_minutes)}</Button>
      {value && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange("")}>{t(($) => $.artifact_runtime.clear_minutes)}</Button>}</div>
    {selected.isError && value && <CockpitFlowError onRetry={() => void selected.refetch()} />}
    {open && <>{query.isPending ? <p role="status">{t(($) => $.workflow.loading)}</p> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} />
      : <ul className="max-h-56 overflow-y-auto">{page.items.map((version) => <li key={version.id} className="flex flex-wrap items-center gap-2"><Button size="sm" variant={value === version.id ? "secondary" : "ghost"} disabled={disabled || !version.published_at || version.decision !== "approved"} aria-pressed={value === version.id} onClick={() => { onChange(version.id); setOpen(false); }}>{t(($) => $.workflow.version, { number: version.version_number })}</Button><span className="text-micro text-muted-foreground">{version.published_at ? t(($) => $.workflow.published) : t(($) => $.workflow.unpublished)}</span></li>)}</ul>}
      {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching}
        onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        : cursors.length > 1 && <Button size="sm" variant="ghost" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    </>}
  </div>;
}
