"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitIssueActionSourcesOptions, cockpitTaskViewKey, EMPTY_COCKPIT_TASK_VIEW, useCockpitTaskViewStore } from "@multica/core/cockpit";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "../../cockpit/components/cockpit-task-flow";

export function CockpitActionSources({ issueId }: { issueId: string }) {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const viewKey = cockpitTaskViewKey(wsId, "issue", issueId);
  const view = useCockpitTaskViewStore((state) => state.views[viewKey] ?? EMPTY_COCKPIT_TASK_VIEW);
  const cursors = view.cursors;
  const setCursors = (cursors: string[]) => useCockpitTaskViewStore.getState().update(viewKey, { cursors });
  const query = useQuery(cockpitIssueActionSourcesOptions(wsId, issueId, cursors.at(-1) || undefined));
  if (query.isPending) return null;
  if (query.isError || !query.data || query.data.issue_id !== issueId) return <CockpitFlowError onRetry={() => void query.refetch()} />;
  if (query.data.total === 0) return null;
  return <section className="space-y-2 px-2 py-2" aria-label={t(($) => $.meeting_actions.issue_sources)}>
    <h3 className="text-caption font-medium">{t(($) => $.meeting_actions.issue_sources)} ({query.data.total})</h3>
    <ul className="max-h-[40vh] space-y-2 overflow-y-auto overscroll-contain">{query.data.items.map((source) => <li key={source.id} className="min-w-0">
      <AppLink href={`${paths.cockpit()}?meeting=${encodeURIComponent(source.meeting_id)}&action=${encodeURIComponent(source.id)}`}
        newTabTitle={source.meeting_title || source.title} title={`${source.meeting_code} ${source.meeting_title}`} className="line-clamp-2 break-words text-caption hover:underline">
        {source.meeting_code} {source.meeting_title || t(($) => $.issue_meetings.untitled)}
      </AppLink><p className="line-clamp-2 break-words text-micro text-muted-foreground" title={source.title}>{t(($) => $.meeting_actions.source_version, { number: source.version_number })} · {source.title}</p>
    </li>)}</ul>
    {(cursors.length > 1 || query.data.next_cursor) && <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total}
      hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))}
      onNext={() => { if (query.data?.next_cursor) setCursors([...cursors, query.data.next_cursor]); }} />}
  </section>;
}
