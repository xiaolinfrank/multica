"use client";

import { CockpitInputPageFailure } from "./cockpit-input-page-failure";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitMeetingIssuesOptions, cockpitMeetingContextPath, cockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitMeetingRoleLabels } from "./cockpit-meeting-issue-links";
import { CockpitIssueInputManifestPanel } from "./cockpit-issue-input-manifest";
import { CockpitFlowPaging } from "./cockpit-task-flow";

export function CockpitInputMeetingHandoff({ wsId, accountId, meetingId, versionId, disabled }: {
  wsId: string; accountId: string; meetingId: string; versionId: string; disabled?: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const [open, setOpen] = useState(false); const [selected, setSelected] = useState<{ id: string; label: string } | null>(null); const [cursors, setCursors] = useState([""]);
  const query = useQuery({ ...cockpitMeetingIssuesOptions(wsId, meetingId, cursors.at(-1) || undefined), enabled: open && !selected });
  return <><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>{t(($) => $.input_materials.handoff)}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.handoff)}</DialogTitle></DialogHeader>
      {open && (selected ? <div className="space-y-3"><div className="flex flex-wrap justify-between gap-2"><AppLink href={paths.issueDetail(selected.id)} target="_blank" rel="noopener noreferrer" className="break-words text-caption text-primary underline">{selected.label} · {t(($) => $.action_flow.new_tab)}</AppLink><Button type="button" variant="outline" size="sm" onClick={() => setSelected(null)}>{t(($) => $.input_materials.choose_other_issue)}</Button></div>
        <CockpitIssueInputManifestPanel key={`${selected.id}:${versionId}`} wsId={wsId} accountId={accountId} issueId={selected.id} suggestedVersionId={versionId} />
      </div> : <div className="space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.handoff_hint)}</p>
        {query.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : query.isError || !query.data ? <CockpitInputPageFailure onRetry={() => void query.refetch()} onFirstPage={cursors.length > 1 ? () => setCursors([""]) : undefined} /> : <>
          <ul className="max-h-80 space-y-2 overflow-y-auto">{query.data.items.map((issue) => <li key={issue.issue_id} className="space-y-1 rounded-lg border border-border p-3"><Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => setSelected({ id: issue.issue_id, label: `${issue.issue_identifier} ${issue.issue_title}` })}><span className="min-w-0 break-words">{issue.issue_identifier} {issue.issue_title}</span></Button><CockpitMeetingRoleLabels link={issue} /></li>)}</ul>
          {query.data.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting.no_issues)}</p>}
          <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total} hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (query.data.next_cursor) setCursors([...cursors, query.data.next_cursor]); }} />
        </>}
        <AppLink href={cockpitMeetingContextPath(paths.cockpit(), meetingId, cockpitScope(navigation.searchParams), navigation.searchParams, "resources")} className="text-caption text-primary underline">{t(($) => $.input_materials.manage_meeting_tasks)}</AppLink>
      </div>)}
    </DialogContent></Dialog>
  </>;
}
