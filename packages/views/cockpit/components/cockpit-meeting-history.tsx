"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitHistoryViewKey, cockpitMinutesVersionsOptions, cockpitReviewerHandoffsOptions, cockpitNasExportsOptions,
  EMPTY_COCKPIT_HISTORY_VIEW, useCockpitHistoryViewStore } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, CockpitMinutesVersionMetadata, MemberWithUser } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitNasExportList } from "./cockpit-minutes-nas";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { useMinutesDecisionLabel } from "./cockpit-minutes-reader";

export function CockpitMeetingHistory({ wsId, workflow, members, userId, readOnly, disabled, open, onOpenChange, onRead }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; members: MemberWithUser[]; userId: string; readOnly?: boolean; disabled: boolean;
  open: boolean; onOpenChange: (open: boolean) => void; onRead: (version: CockpitMinutesVersionMetadata) => void;
}) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const label = useMinutesDecisionLabel();
  const key = cockpitHistoryViewKey(wsId, workflow.meeting_id);
  const view = useCockpitHistoryViewStore((state) => state.views[key] ?? EMPTY_COCKPIT_HISTORY_VIEW);
  const update = useCockpitHistoryViewStore((state) => state.update);
  const cursors = view.cursors[view.section];
  const versions = useQuery({ ...cockpitMinutesVersionsOptions(wsId, workflow.meeting_id, { page_size: 25, cursor: view.cursors.versions.at(-1) || undefined }), enabled: open && view.section === "versions" });
  const handoffs = useQuery({ ...cockpitReviewerHandoffsOptions(wsId, workflow.meeting_id, { page_size: 25, cursor: view.cursors.handoffs.at(-1) || undefined }), enabled: open && view.section === "handoffs" });
  const exports = useQuery({ ...cockpitNasExportsOptions(wsId, workflow.meeting_id, { page_size: 25, cursor: view.cursors.exports.at(-1) || undefined, status: view.exportStatus || undefined }), enabled: open && view.section === "exports" });
  const active = view.section === "versions" ? versions : view.section === "handoffs" ? handoffs : exports;
  const page = active.data;
  const memberName = (id: string) => members.find((member) => member.user_id === id)?.name || members.find((member) => member.user_id === id)?.email || id;
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale) : value;
  const statusOptions = [{ value: "__all__", label: t(($) => $.task_flow.all_statuses) }, { value: "active", label: t(($) => $.minutes_history.active_exports) },
    { value: "needs_attention", label: t(($) => $.nas.needs_attention) }, { value: "succeeded", label: t(($) => $.nas.succeeded) }];
  return <section className="space-y-3" aria-label={t(($) => $.minutes_history.title)}>
    <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => { update(key, { section: "versions" }); onOpenChange(!open); }}>
      {t(($) => $.minutes_history.open, { count: workflow.history_counts.versions })}</Button>
    {open && <div className="space-y-3 rounded-lg border border-border p-4">
      <Tabs value={view.section} onValueChange={(value) => { if (value === "versions" || value === "handoffs" || value === "exports") update(key, { section: value }); }}>
        <TabsList variant="line" className="h-auto flex-wrap" aria-label={t(($) => $.minutes_history.sections)}>
          <TabsTrigger value="versions">{t(($) => $.minutes_history.versions)}</TabsTrigger>
          <TabsTrigger value="handoffs">{t(($) => $.minutes_history.handoffs)}</TabsTrigger>
          <TabsTrigger value="exports">{t(($) => $.nas.title)}</TabsTrigger>
        </TabsList>
      <TabsContent value={view.section} className="space-y-3">
      {view.section === "exports" && <Select value={view.exportStatus || "__all__"} items={statusOptions} onValueChange={(value) => { if (value !== null) update(key, { exportStatus: value === "__all__" ? "" : value }); }}>
        <SelectTrigger aria-label={t(($) => $.minutes_history.export_status)} className="w-full sm:w-56"><SelectValue /></SelectTrigger>
        <SelectContent>{statusOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>}
      {page && <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={active.isFetching}
        onPrevious={() => useCockpitHistoryViewStore.getState().setPage(key, view.section, cursors.slice(0, -1))}
        onNext={() => { if (page.next_cursor) useCockpitHistoryViewStore.getState().setPage(key, view.section, [...cursors, page.next_cursor]); }} />}
      {active.isPending ? <div role="status" className="flex items-center gap-2 py-3 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : active.isError || !page ? <div className="space-y-2"><CockpitFlowError onRetry={() => void active.refetch()} />
          {cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => useCockpitHistoryViewStore.getState().setPage(key, view.section, [""])}>{t(($) => $.task_flow.first_page)}</Button>}</div>
          : page.items.length === 0 ? <p className="py-4 text-caption text-muted-foreground">{t(($) => $.minutes_history.empty)}</p>
            : <div className="max-h-[45vh] space-y-3 overflow-y-auto overscroll-contain">
              {view.section === "versions" && versions.data?.items.map((version) => <article key={version.id} className="flex items-start justify-between gap-3 rounded-md bg-muted/40 p-3">
                <div className="min-w-0 space-y-1 text-caption"><p className="font-medium">{t(($) => $.workflow.version, { number: version.version_number })} · {label(version.decision)}</p>
                  <p className="flex flex-wrap gap-2 text-micro text-muted-foreground">{version.id === workflow.current_version_id && <span>{t(($) => $.minutes_history.current)}</span>}
                    {version.id === workflow.published_version_id && <span>{t(($) => $.minutes_history.official)}</span>}
                    {version.published_at && version.id !== workflow.published_version_id && <span>{t(($) => $.minutes_history.previously_published)}</span>}
                    {version.has_feedback && <span>{t(($) => $.minutes_history.has_feedback)}</span>}<time dateTime={version.created_at}>{date(version.created_at)}</time></p>
                  <p className="line-clamp-1 break-words text-muted-foreground" title={memberName(version.reviewer_id)}>{memberName(version.reviewer_id)}</p></div>
                <DialogTrigger render={<Button type="button" size="sm" variant="outline" onClick={() => onRead(version)} />}>{t(($) => $.minutes_history.read_version, { number: version.version_number })}</DialogTrigger>
              </article>)}
              {view.section === "handoffs" && handoffs.data?.items.map((handoff) => <article key={handoff.id} className="space-y-2 rounded-md bg-muted/40 p-3">
                <p className="break-words text-caption font-medium">{t(($) => $.workflow.handoff_people, { from: handoff.from_reviewer_name?.trim() || memberName(handoff.from_reviewer_id), to: handoff.to_reviewer_name?.trim() || memberName(handoff.to_reviewer_id) })}</p>
                <p className="break-words text-micro text-muted-foreground">{t(($) => $.workflow.handoff_by, { name: handoff.created_by_name?.trim() || memberName(handoff.created_by) })} · <time dateTime={handoff.created_at}>{date(handoff.created_at)}</time></p>
                <p className="text-caption text-muted-foreground">{handoff.version_id === null ? t(($) => $.workflow.handoff_history_future) : handoff.version_number
                  ? t(($) => $.workflow.handoff_history_version, { number: handoff.version_number }) : handoff.version_id}</p>
                <p className="line-clamp-2 whitespace-pre-wrap break-words text-caption" title={handoff.reason}>{handoff.reason}</p>
                <details><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.minutes_history.handoff_details)}</summary>
                  <div className="mt-3 space-y-3"><p className="whitespace-pre-wrap break-words text-caption">{handoff.reason}</p>
                    {handoff.from_review_issue && <div className="space-y-1"><p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_previous_issue)}</p><WorkflowIssueLink issue={handoff.from_review_issue} /></div>}
                    {handoff.to_review_issue && <div className="space-y-1"><p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_replacement_issue)}</p><WorkflowIssueLink issue={handoff.to_review_issue} /></div>}
                  </div></details>
              </article>)}
              {view.section === "exports" && <CockpitNasExportList wsId={wsId} workflow={workflow} jobs={exports.data?.items ?? []} userId={userId} readOnly={readOnly} disabled={disabled || exports.isFetching} />}
            </div>}
      </TabsContent></Tabs>
    </div>}
  </section>;
}
