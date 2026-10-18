"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitArtifactPath, cockpitArtifactsOptions, cockpitScopeViewKey, cockpitSurfacePath, EMPTY_COCKPIT_ARTIFACT_CONTEXT, useCockpitScopeViewStore, type CockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { cn } from "@multica/ui/lib/utils";
import { ArrowUpRight, FileCheck2, FileText, Search } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { SegmentedToggle } from "../../common/segmented-toggle";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { ArtifactStatus, useArtifactStatusLabel } from "./cockpit-artifact-status";

export function CockpitArtifacts({ wsId, scope, nodeId, sourceIssueId, registration }: {
  wsId: string; scope: CockpitScope; nodeId?: string; sourceIssueId?: string; registration?: React.ReactNode;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const label = useArtifactStatusLabel();
  const listId = useId();
  const key = JSON.stringify([cockpitScopeViewKey(wsId, scope), nodeId ?? null, sourceIssueId ?? null]);
  const state = useCockpitScopeViewStore((store) => store.artifacts[key] ?? EMPTY_COCKPIT_ARTIFACT_CONTEXT);
  const update = (patch: Parameters<ReturnType<typeof useCockpitScopeViewStore.getState>["updateArtifact"]>[1]) => useCockpitScopeViewStore.getState().updateArtifact(key, patch);
  const q = useCockpitSearch(state.query);
  const changing = q !== state.query.trim();
  const signature = JSON.stringify([scope, nodeId, sourceIssueId, q, state.status, state.relation]);
  const cursors = state.cursorKey === signature ? state.cursors : [""];
  const query = useQuery({ ...cockpitArtifactsOptions(wsId, { project_id: nodeId ? undefined : scope.projectId ?? undefined, module_id: nodeId ? undefined : scope.moduleId ?? undefined,
    node_id: nodeId, relation: nodeId ? state.relation : undefined, source_issue_id: sourceIssueId, q, status: state.status || undefined, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: Boolean(wsId && !changing) });
  const data = query.data;
  const statuses = ["draft", "pending", "approved", "changes_requested", "rejected", "capturing", "needs_attention", "archived", "unknown"];
  const options = [{ value: "__all__", label: t(($) => $.artifacts.all_statuses) }, ...statuses.map((value) => ({ value, label: label(value) }))];
  return <section aria-label={t(($) => $.shell.artifacts)} className="cockpit-artifact-workspace @container/artifacts flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="cockpit-page-heading flex flex-wrap items-center gap-4 px-4 py-5 lg:px-6">
      <span className="cockpit-page-symbol" aria-hidden><FileCheck2 className="size-6" /></span><div className="min-w-0 flex-1"><h2 className="text-display-sm font-semibold tracking-tight">{t(($) => $.artifacts.title)}</h2>
        <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.artifacts.basis)}</p></div>
      {data?.can_create && (registration ?? <AppLink href={cockpitSurfacePath(paths.cockpit(), "plan", scope)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.artifacts.choose_work_item)}<ArrowUpRight className="size-3.5" aria-hidden /></AppLink>)}
    </div>
    <div className="cockpit-filter-strip flex min-w-0 flex-wrap gap-3 px-4 py-3 lg:px-6">
      {nodeId && <div role="group" aria-label={t(($) => $.artifact_runtime.artifact_relation)} className="min-w-0 max-w-full overflow-x-auto"><SegmentedToggle value={state.relation} options={(["owned", "referenced", "all"] as const).map((value) => [value, t(($) => $.artifact_runtime.relations[value])] as const)} onChange={(relation) => update({ relation })}
        buttonClassName="min-h-8 whitespace-nowrap rounded-md px-3 py-1.5 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>}
      <label className="relative min-w-0 max-w-full flex-1 sm:max-w-80"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input name="cockpit-artifact-search" autoComplete="off" spellCheck={false} value={state.query} aria-label={t(($) => $.artifacts.search)} placeholder={t(($) => $.artifacts.search)} className="pl-8" onChange={(event) => update({ query: event.target.value })} /></label>
      <Select value={state.status || "__all__"} items={options} onValueChange={(value) => { if (value) update({ status: value === "__all__" ? "" : value }); }}>
        <SelectTrigger aria-label={t(($) => $.artifacts.status_filter)} className="w-44 max-w-full"><SelectValue /></SelectTrigger><SelectContent>{options.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 @min-[48rem]/artifacts:p-6">
      {data ? <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.filtered_total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching || changing}
        onPrevious={() => { if (cursors.length > 1) update({ cursorKey: signature, cursors: cursors.slice(0, -1) }); }} onNext={() => { if (data.next_cursor) update({ cursorKey: signature, cursors: [...cursors, data.next_cursor] }); }} />
        : cursors.length > 1 && <div><Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => update({ cursorKey: signature, cursors: cursors.slice(0, -1) })}>{t(($) => $.task_flow.previous)}</Button></div>}
      {query.isPending || changing ? <div role="status" className="flex items-center gap-2 py-6 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : query.isError && !data ? <CockpitFlowError onRetry={() => void query.refetch()} /> : data && <>
          {query.isError && <p role="alert" className="text-caption text-destructive">{t(($) => $.work_overview.refresh_failed)}</p>}
          {data.items.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card p-8 text-caption text-muted-foreground">
            <p>{state.query || state.status ? t(($) => $.task_flow.no_matches) : t(($) => $.artifacts.empty)}</p>
            {(state.query || state.status) && <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => update({ query: "", status: "" })}>{t(($) => $.meetings.filter_clear)}</Button>}
          </div> : <ul className="cockpit-artifact-gallery min-h-0 flex-1 overflow-y-auto overscroll-contain">{data.items.map((artifact) => <li key={artifact.id} className="cockpit-artifact-card" data-status={artifact.status}>
            <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, scope, undefined, nodeId ? { nodeId, view: "artifacts" } : undefined)} newTabTitle={artifact.title} aria-labelledby={`${listId}-${artifact.id}-title`} aria-describedby={`${listId}-${artifact.id}-context ${listId}-${artifact.id}-state`} className="cockpit-artifact-link group flex h-full min-w-0 flex-col gap-4 rounded-2xl p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <div className="cockpit-document-cover"><span className="cockpit-dossier-tab" aria-hidden><FileText className="size-4" /></span><span className="cockpit-document-sheet" aria-hidden />
                <div className="cockpit-dossier-title"><FileText className="size-5" aria-hidden /><h3 id={`${listId}-${artifact.id}-title`} className="line-clamp-3 break-words text-title-sm font-semibold" title={artifact.title}>{artifact.title}</h3></div>
                <ArrowUpRight className="cockpit-cover-arrow size-5" aria-hidden /></div>
              <div className="flex min-w-0 gap-3">
                <div className="min-w-0 space-y-2">
                  <div id={`${listId}-${artifact.id}-context`} className="min-w-0 space-y-1">
                    <p className="min-w-0 break-words text-caption font-medium text-foreground [overflow-wrap:anywhere]" title={artifact.node_label}>{artifact.node_label}</p>
                    <p className="line-clamp-2 break-words text-caption text-muted-foreground [overflow-wrap:anywhere]" title={artifact.source_issue.title}><span className="mr-2 font-mono">{artifact.source_issue.identifier}</span>{artifact.source_issue.title}</p>
                  </div>
                </div>
              </div>
              <div id={`${listId}-${artifact.id}-state`} className="cockpit-artifact-state mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-3"><ArtifactStatus status={artifact.status} />
                {artifact.approved_version && <span className={cn("text-caption tabular-nums", artifact.current_version?.id !== artifact.approved_version.id ? "text-success" : "text-muted-foreground")}>{t(($) => $.artifacts.approved_version, { number: artifact.approved_version.version_number })}</span>}
                <span className="text-caption tabular-nums text-muted-foreground">{t(($) => $.artifacts.version_count, { count: artifact.version_count })}</span>
              </div>
            </AppLink>
          </li>)}</ul>}
        </>}
    </div>
  </section>;
}
