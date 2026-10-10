"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitMeetingActionsOptions, useCockpitActionCommandStore, cockpitTaskViewKey, EMPTY_COCKPIT_TASK_VIEW, useCockpitTaskViewStore } from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { useStatusLabel } from "../../issues/utils/status-label";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitActionCreate, CockpitActionDetail } from "./cockpit-action-dialogs";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitMeetingActions({ wsId, workflow, userId, readOnly }: { wsId: string; workflow: CockpitMeetingWorkflowSummary; userId: string; readOnly?: boolean }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const linkedAction = navigation.searchParams.get("action");
  const linkedMeeting = navigation.searchParams.get("meeting");
  const issueStatus = useStatusLabel(wsId);
  const viewKey = cockpitTaskViewKey(wsId, "meeting", workflow.meeting_id);
  const view = useCockpitTaskViewStore((state) => state.views[viewKey] ?? EMPTY_COCKPIT_TASK_VIEW);
  const setView = (patch: Partial<typeof view>) => useCockpitTaskViewStore.getState().update(viewKey, patch);
  const { text, status, versionId } = view;
  const setText = (text: string) => setView({ text });
  const setStatus = (status: string) => setView({ status });
  const setVersionId = (versionId: string) => setView({ versionId });
  const q = useCockpitSearch(text);
  const selectedId = linkedMeeting === workflow.meeting_id ? linkedAction : null;
  const latestNavigation = useRef(navigation);
  const mounted = useRef(true);
  useEffect(() => { latestNavigation.current = navigation; }, [navigation]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const actionHref = (actionId: string) => {
    const search = new URLSearchParams(navigation.searchParams.toString());
    search.set("meeting", workflow.meeting_id); search.set("action", actionId);
    return `${paths.cockpit()}?${search.toString()}${navigation.hash}`;
  };
  const closeAction = (actionId: string | null) => {
    const current = latestNavigation.current;
    // An old command may settle after another action or workspace was opened.
    if (!mounted.current || !actionId || current.searchParams.get("meeting") !== workflow.meeting_id || current.searchParams.get("action") !== actionId) return;
    const search = new URLSearchParams(current.searchParams.toString());
    search.delete("action");
    current.replace(`${current.pathname}${search.size ? `?${search.toString()}` : ""}${current.hash}`);
  };
  const busy = useRef(false);
  useEffect(() => { busy.current = false; }, [selectedId]);
  const filterKey = JSON.stringify([workflow.meeting_id, q, status, versionId]);
  const cursors = view.cursorKey === filterKey ? view.cursors : [""];
  const setPagination = (next: { key: string; cursors: string[] }) => setView({ cursorKey: next.key, cursors: next.cursors });
  const query = useQuery(cockpitMeetingActionsOptions(wsId, workflow.meeting_id, { q, status, version_id: versionId, cursor: cursors.at(-1) || undefined }));
  const commands = useCockpitActionCommandStore((state) => state.draft.commands);
  const pending = Object.values(commands).filter((command) => command.kind === "decision" && command.meeting_id === workflow.meeting_id);
  const published = workflow.published_version;
  const human = Boolean(userId && !readOnly);
  const canAdd = human && query.data?.can_add === true && published?.decision === "approved" && Boolean(published.published_at)
    && (workflow.can_manage || published.reviewer_id === userId);
  const filters = [
    { value: "__all__", label: t(($) => $.meeting_actions.all) }, { value: "draft", label: t(($) => $.meeting_actions.pending) },
    { value: "accepted", label: t(($) => $.meeting_actions.accepted) }, { value: "dismissed", label: t(($) => $.meeting_actions.dismissed) },
  ];
  const versions = [{ value: "__all__", label: t(($) => $.meeting_actions.all_versions) },
    ...(published ? [{ value: published.id, label: t(($) => $.meeting_actions.source_version, { number: published.version_number }) }] : []),
    ...(versionId && versionId !== published?.id ? [{ value: versionId, label: t(($) => $.meeting_actions.source_version, { number: query.data?.items.find((entry) => entry.version_id === versionId)?.version_number ?? versionId }) }] : [])];
  return <Dialog open={Boolean(selectedId)} onOpenChange={(next) => { if (!next && !busy.current) closeAction(selectedId); }}>
    <section className="space-y-4 rounded-lg border border-border p-4" aria-label={t(($) => $.meeting_actions.region)}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.meeting_actions.region)}</h3>
        <CockpitActionCreate wsId={wsId} workflow={workflow} disabled={!canAdd || query.isFetching} /></div>
      {pending.map((command) => command.kind === "decision" && <DialogTrigger key={command.action_id} nativeButton={false} role="link"
        render={<AppLink href={actionHref(command.action_id)} className={buttonVariants({ size: "sm", variant: "outline" })} />}>
        {t(($) => $.meeting_actions.retry_decision)}</DialogTrigger>)}
      <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.search)}<Input value={text} onChange={(event) => setText(event.target.value)} /></label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="space-y-1 text-caption">{t(($) => $.meeting_actions.status)}
        <Select value={status || "__all__"} onValueChange={(value) => setStatus(value && value !== "__all__" ? value : "")} items={filters}>
          <SelectTrigger className="w-full" aria-label={t(($) => $.meeting_actions.status)}><SelectValue /></SelectTrigger><SelectContent>{filters.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
        </Select></label><label className="space-y-1 text-caption">{t(($) => $.meeting_actions.source_filter)}
        <Select value={versionId || "__all__"} onValueChange={(value) => setVersionId(value && value !== "__all__" ? value : "")} items={versions}>
          <SelectTrigger className="w-full" aria-label={t(($) => $.meeting_actions.source_filter)}><SelectValue /></SelectTrigger><SelectContent>{versions.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
        </Select></label></div>
      {query.isPending ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : query.isError || !query.data ? <div className="space-y-2"><CockpitFlowError onRetry={() => void query.refetch()} />
          {cursors.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => setPagination({ key: filterKey, cursors: [""] })}>{t(($) => $.task_flow.first_page)}</Button>}</div> : <>
          <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.filtered_total} hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching || q !== text.trim()}
            onPrevious={() => setPagination({ key: filterKey, cursors: cursors.slice(0, -1) })}
            onNext={() => { if (query.data?.next_cursor) setPagination({ key: filterKey, cursors: [...cursors, query.data.next_cursor] }); }} />
          <ul className="max-h-[45vh] overflow-y-auto overscroll-contain divide-y divide-border">{query.data.items.map((action) => <li key={action.id} className="space-y-1.5 py-3">
            <div className="flex items-start justify-between gap-3"><h4 className="line-clamp-2 min-w-0 break-words text-body font-medium" title={action.title}>{action.title}</h4>
              <DialogTrigger nativeButton={false} role="link" render={<AppLink href={actionHref(action.id)} newTabTitle={action.title}
                className={buttonVariants({ variant: "ghost", size: "xs" })} aria-label={t(($) => $.meeting_actions.review_action, { title: action.title })} />}>{t(($) => $.meeting_actions.review)}</DialogTrigger></div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <Button type="button" variant="ghost" size="xs" onClick={() => setVersionId(action.version_id)}>{t(($) => $.meeting_actions.source_version, { number: action.version_number })}</Button>
              <span>{action.status === "draft" ? t(($) => $.meeting_actions.pending) : action.status === "accepted" ? t(($) => $.meeting_actions.accepted) : action.status === "dismissed" ? t(($) => $.meeting_actions.dismissed) : action.status}</span>
              {action.source_superseded && action.status === "draft" && <span>{t(($) => $.meeting_actions.superseded)}</span>}
              {action.node_id && <span>{action.node_code} {action.node_name}</span>}
            </div>
            {action.issue && <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption"><AppLink href={paths.issueDetail(action.issue.identifier || action.issue.id)} newTabTitle={action.issue.title}
              title={`${action.issue.identifier} ${action.issue.title}`} aria-label={`${action.issue.identifier} ${action.issue.title}`} className="line-clamp-2 min-w-0 flex-1 break-words hover:underline">
              <span className="mr-1 font-mono">{action.issue.identifier}</span>{action.issue.title}</AppLink><span className="text-muted-foreground">{issueStatus(action.issue.status)} · {action.issue.assignee_name || t(($) => $.workflow.unassigned)}</span></div>}
          </li>)}</ul>
          {query.data.items.length === 0 && <p className="py-3 text-caption text-muted-foreground">{q || status || versionId ? t(($) => $.task_flow.no_matches) : t(($) => $.meeting_actions.empty)}</p>}
        </>}
    </section>
    {selectedId && <CockpitActionDetail key={selectedId} wsId={wsId} workflow={workflow} actionId={selectedId} userId={userId} readOnly={readOnly}
      onBusyChange={(value) => {
        const current = latestNavigation.current;
        if (current.searchParams.get("meeting") === workflow.meeting_id && current.searchParams.get("action") === selectedId) busy.current = value;
      }} onDone={() => closeAction(selectedId)} />}
  </Dialog>;
}
