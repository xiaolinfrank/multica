"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import { cockpitMeetingHasDirectReference, cockpitIssueMeetingReferencesOptions, cockpitObjectPath, useRemoveCockpitIssueMeetingReference, useAppendCockpitMeetingIssue } from "@multica/core/cockpit";
import { ChevronRight, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitMeetingPicker, cockpitMeetingLabel } from "../../cockpit/components/cockpit-meeting-picker";
import { CockpitMeetingRoleLabels } from "../../cockpit/components/cockpit-meeting-issue-links";
import { CockpitFlowError, CockpitFlowPaging } from "../../cockpit/components/cockpit-task-flow";
import { CockpitActionSources } from "./cockpit-action-sources";

export function CockpitMeetingsSection({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceId();
  return <><CockpitActionSources issueId={issueId} /><CockpitReferenceMeetings key={`${wsId}:${issueId}`} wsId={wsId} issueId={issueId} /></>;
}
function CockpitReferenceMeetings({ wsId, issueId }: { wsId: string; issueId: string }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitIssueMeetingReferencesOptions(wsId, issueId, { cursor: cursors.at(-1) || undefined }), enabled: open });
  const link = useAppendCockpitMeetingIssue(wsId); const unlink = useRemoveCockpitIssueMeetingReference(wsId); const busy = link.isPending || unlink.isPending;
  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  return <div>
    <button type="button" className="mb-2 flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium hover:bg-accent/70" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="truncate">{t(($) => $.issue_meetings.title)}</span><ChevronRight className={`size-3 shrink-0 ${open ? "rotate-90" : ""}`} />
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{query.data?.total ?? "—"}</span>
    </button>
    {open && <div className="space-y-2 pl-2">
      {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : <>
        {query.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.issue_meetings.none)}</p>}
        <ul className="max-h-80 space-y-1 overflow-y-auto overscroll-contain">{query.data.items.map((row) => {
          const label = row.available ? cockpitMeetingLabel({ code: row.code || row.meet_date, title: row.title || t(($) => $.issue_meetings.untitled) }) : t(($) => $.issue_meetings.unavailable);
          const locked = row.required_roles.length > 0 || !row.can_unlink;
          return <li key={row.meeting_id} className="flex min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-accent/50">
            <div className="min-w-0 flex-1 py-1">{row.available ? <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: row.meeting_id })} newTabTitle={label} title={label} className="block truncate text-caption hover:underline">{label}</AppLink>
              : <span className="block text-caption text-muted-foreground">{label}<span className="block break-all font-mono text-micro">{row.meeting_id}</span></span>}
              {cockpitMeetingHasDirectReference(row) && <CockpitMeetingRoleLabels link={row} />}
              {row.has_agenda_reference && <div className="space-y-1 text-micro text-muted-foreground"><p>{t(($) => $.meeting_lifecycle.agenda_source, { count: row.agenda_total ?? 1 })}</p>{row.agenda_id && <AppLink className="text-primary underline" href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: row.meeting_id, view: "agenda", agendaId: row.agenda_id })}>{t(($) => $.meeting_lifecycle.open_agenda)}</AppLink>}</div>}{row.required_roles.length > 0 && <p className="text-micro text-muted-foreground">{t(($) => $.workflow.managed_link)}</p>}
            </div>
            {cockpitMeetingHasDirectReference(row) && <Button type="button" variant="ghost" size="icon-xs" disabled={busy || locked} aria-label={row.has_agenda_reference ? t(($) => $.meeting_lifecycle.unlink_direct, { name: label }) : row.available ? t(($) => $.issue_meetings.unlink, { label }) : t(($) => $.issue_meetings.remove_unavailable, { id: row.meeting_id })}
              onClick={() => unlink.mutate({ meetingId: row.meeting_id, issueId }, { onError: fail })}><X className="size-3.5" /></Button>}
          </li>;
        })}</ul>
        {(query.data.total > 25 || cursors.length > 1) && <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total} hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching || busy}
          onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (query.data.next_cursor) setCursors((old) => [...old, query.data.next_cursor!]); }} />}
      </>}
      <CockpitMeetingPicker wsId={wsId} label={t(($) => $.issue_meetings.link)} disabled={unlink.isPending} onSelect={(meetingId) => link.mutateAsync({ meetingId, issueId })} />
    </div>}
  </div>;
}
