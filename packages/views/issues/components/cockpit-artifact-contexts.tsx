"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import { cockpitArtifactPath, cockpitContextOptions, cockpitIssueArtifactsOptions, cockpitObjectPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "../../cockpit/components/cockpit-task-flow";

export function CockpitArtifactContexts({ issueId }: { issueId: string }) {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const context = useQuery(cockpitContextOptions(wsId, EMPTY_COCKPIT_SCOPE));
  if (context.isError) return <section aria-label={t(($) => $.issue_artifacts.title)}><p className="mb-2 text-caption font-medium">{t(($) => $.issue_artifacts.title)}</p><CockpitFlowError onRetry={() => void context.refetch()} /></section>;
  if (context.data?.capabilities?.artifacts !== true) return null;
  return <IssueArtifactContexts key={`${wsId}:${issueId}`} wsId={wsId} issueId={issueId} />;
}

function IssueArtifactContexts({ wsId, issueId }: { wsId: string; issueId: string }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true);
  const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitIssueArtifactsOptions(wsId, issueId, { cursor: cursors.at(-1) || undefined }), enabled: open });
  const roles: Record<string, string> = {
    origin: t(($) => $.issue_artifacts.roles.origin), current_producer: t(($) => $.issue_artifacts.roles.current_producer),
    former_producer: t(($) => $.issue_artifacts.roles.former_producer), version_producer: t(($) => $.issue_artifacts.roles.version_producer),
    review: t(($) => $.issue_artifacts.roles.review), retired_review: t(($) => $.issue_artifacts.roles.retired_review), acceptance_review: t(($) => $.issue_artifacts.roles.acceptance_review),
  };
  return <section aria-label={t(($) => $.issue_artifacts.title)}>
    <button type="button" className="mb-2 flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium hover:bg-accent/70"
      onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="truncate">{t(($) => $.issue_artifacts.title)}</span><ChevronRight className={`size-3 shrink-0 ${open ? "rotate-90" : ""}`} />
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{query.data?.total ?? "—"}</span>
    </button>
    {open && <div className="space-y-2 pl-2">
      {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : <>
        {query.data.total === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.issue_artifacts.empty)}</p>}
        <ul className="max-h-80 space-y-2 overflow-y-auto overscroll-contain">{query.data.items.map((row) => {
          const acceptance = row.kind === "acceptance_request";
          const label = acceptance ? `${row.node_label} · ${t(($) => $.issue_artifacts.acceptance)}`
            : `${row.artifact_title || t(($) => $.issue_artifacts.artifact)}${row.version_number ? ` · ${t(($) => $.issue_artifacts.version, { number: row.version_number })}` : ""}`;
          const href = acceptance && row.request_id ? cockpitObjectPath(paths.cockpit(), { kind: "node", id: row.node_id, view: "acceptance", requestId: row.request_id })
            : (row.kind === "artifact" || row.kind === "artifact_version") && row.artifact_id ? cockpitArtifactPath(paths.cockpit(), row.artifact_id, EMPTY_COCKPIT_SCOPE, row.version_id ?? undefined) : null;
          return <li key={`${row.kind}:${row.id}`} className="min-w-0 rounded-sm px-1">
            {href ? <AppLink href={href} newTabTitle={label} className="block break-words py-1 text-caption hover:underline">{label}</AppLink>
              : <span className="block break-words py-1 text-caption">{label}</span>}
            <p className="break-words text-micro text-muted-foreground">{row.roles.map((role) => roles[role] || t(($) => $.issue_artifacts.unknown_role, { role })).join(" · ")}</p>
            {row.is_current_review && <p className="text-micro font-medium">{t(($) => $.issue_artifacts.current_review)}</p>}
          </li>;
        })}</ul>
        {(cursors.length > 1 || query.data.next_cursor) && <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total}
          hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))}
          onNext={() => { if (query.data.next_cursor) setCursors((old) => [...old, query.data.next_cursor!]); }} />}
      </>}
    </div>}
  </section>;
}
