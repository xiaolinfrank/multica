"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitMinutesVersionOptions } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, CockpitMinutesVersionDetail } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Markdown } from "@multica/ui/markdown";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitFlowError } from "./cockpit-task-flow";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";

export function useMinutesDecisionLabel() {
  const { t } = useT("cockpit");
  return (decision: string) => decision === "pending" ? t(($) => $.workflow.pending_review)
    : decision === "approved" ? t(($) => $.workflow.approved) : decision === "changes_requested" ? t(($) => $.workflow.changes_requested)
      : decision === "rejected" ? t(($) => $.workflow.rejected) : t(($) => $.workflow.unknown_decision, { decision });
}

export function CockpitMinutesReader({ wsId, workflow, versionId, versionNumber, busy, children }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; versionId: string; versionNumber: number; busy: boolean;
  children?: (detail: CockpitMinutesVersionDetail) => React.ReactNode;
}) {
  const { t } = useT("cockpit");
  const label = useMinutesDecisionLabel();
  const query = useQuery(cockpitMinutesVersionOptions(wsId, workflow.meeting_id, versionId));
  const detail = query.data;
  return <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-4xl" showCloseButton={false}>
    <DialogHeader><DialogTitle>{t(($) => $.minutes_history.reader_title, { number: versionNumber })}</DialogTitle>
      <DialogDescription>{t(($) => $.minutes_history.immutable)}</DialogDescription></DialogHeader>
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      {workflow.current_version && workflow.current_version.id !== versionId && <p role="status" className="rounded-md bg-muted p-3 text-caption">
        {t(($) => $.minutes_history.historical_notice, { number: workflow.current_version.version_number })}</p>}
      {query.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : query.isError || !detail ? <CockpitFlowError onRetry={() => void query.refetch()} />
          : <><div className="flex flex-wrap gap-2 text-caption"><span>{label(detail.version.decision)}</span>
            {detail.version.id === workflow.published_version_id && <span className="text-brand">{t(($) => $.minutes_history.official)}</span>}</div>
            {detail.version.published_at && detail.version.id !== workflow.published_version_id && <p className="text-caption text-muted-foreground">{t(($) => $.minutes_history.previously_published)}</p>}
            <WorkflowIssueLink wsId={wsId} issue={detail.version.review_issue} />
            <div className="min-w-0 max-w-full overflow-x-auto break-words"><Markdown mode="full">{detail.version.content}</Markdown></div>
            {detail.version.feedback && <section className="space-y-2 border-t pt-3"><h3 className="text-caption font-medium">{t(($) => $.workflow.feedback)}</h3>
              <p className="whitespace-pre-wrap break-words text-body">{detail.version.feedback}</p></section>}
            {!query.isFetching && children?.(detail)}
          </>}
    </div>
    <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>{t(($) => $.minutes_history.close)}</DialogClose></DialogFooter>
  </DialogContent>;
}
