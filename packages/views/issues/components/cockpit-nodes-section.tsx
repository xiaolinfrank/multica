"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import { buildCockpitDisplayCodesFromIndex, cockpitIssueNodeReferencesOptions, cockpitNodeIndexOptions, cockpitObjectPath,
  cockpitPrimaryNodeOptions, useRemoveCockpitIssueNodeReference, useAppendCockpitNodeIssue } from "@multica/core/cockpit";
import { ChevronRight, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitNodeChoicePicker } from "../../cockpit/components/cockpit-node-choice";
import { CockpitFlowError, CockpitFlowPaging } from "../../cockpit/components/cockpit-task-flow";

export function CockpitNodesSection({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceId();
  return <CockpitNodeReferences key={`${wsId}:${issueId}`} wsId={wsId} issueId={issueId} />;
}
function CockpitNodeReferences({ wsId, issueId }: { wsId: string; issueId: string }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitIssueNodeReferencesOptions(wsId, issueId, { cursor: cursors.at(-1) || undefined }), enabled: open });
  const primary = useQuery(cockpitPrimaryNodeOptions(wsId, issueId));
  const primaryNode = primary.data?.issue_id === issueId ? primary.data : null;
  const index = useQuery({ ...cockpitNodeIndexOptions(wsId), enabled: open && Boolean(query.data?.items.length || primaryNode?.node_id) });
  const codes = useMemo(() => buildCockpitDisplayCodesFromIndex(index.data?.items ?? []), [index.data]);
  const link = useAppendCockpitNodeIssue(wsId); const unlink = useRemoveCockpitIssueNodeReference(wsId);
  const busy = link.isPending || unlink.isPending;
  const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  return <div>
    <button type="button" className="mb-2 flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-caption font-medium hover:bg-accent/70" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className="truncate">{t(($) => $.issue_detail.title)}</span><ChevronRight className={`size-3 shrink-0 ${open ? "rotate-90" : ""}`} />
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{query.data && !primary.isPending && !primary.isError ? query.data.total + (primaryNode?.node_id ? 1 : 0) : "—"}</span>
    </button>
    {open && <div className="space-y-2 pl-2">
      {primaryNode?.node_id && <div><p className="text-micro text-muted-foreground">{t(($) => $.meeting_actions.primary_node)}</p>
        <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: primaryNode.node_id })} newTabTitle={primaryNode.node_name || primaryNode.node_code}
          className="block break-words py-1 text-caption hover:underline">{codes.get(primaryNode.node_id) ?? primaryNode.node_code} {primaryNode.node_name || t(($) => $.issue_detail.untitled)}</AppLink></div>}
      {primary.isError && <CockpitFlowError onRetry={() => void primary.refetch()} />}
      {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : <>
        {query.data.items.length === 0 && !primaryNode?.node_id && <p className="text-caption text-muted-foreground">{t(($) => $.issue_detail.none)}</p>}
        <ul className="max-h-80 space-y-1 overflow-y-auto overscroll-contain">{query.data.items.map((row) => {
          const code = codes.get(row.node_id) ?? row.code;
          const label = row.available ? `${code} ${row.title || t(($) => $.issue_detail.untitled)}`.trim() : t(($) => $.issue_detail.unavailable);
          return <li key={row.node_id} className="flex min-w-0 items-center gap-1 rounded-sm px-1 hover:bg-accent/50">
            {row.available ? <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: row.node_id })} newTabTitle={label} className="min-w-0 flex-1 truncate py-1 text-caption hover:underline" title={label}>{label}</AppLink>
              : <span className="min-w-0 flex-1 py-1 text-caption text-muted-foreground">{label}<span className="block break-all font-mono text-micro">{row.node_id}</span></span>}
            <Button type="button" variant="ghost" size="icon-xs" disabled={busy || !row.can_unlink || row.relation !== "reference"}
              aria-label={row.available ? t(($) => $.issue_detail.unlink, { label }) : t(($) => $.issue_detail.remove_unavailable, { id: row.node_id })} onClick={() => unlink.mutate({ nodeId: row.node_id, issueId }, { onError: fail })}><X className="size-3.5" /></Button>
          </li>;
        })}</ul>
        {(query.data.total > 25 || cursors.length > 1) && <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total} hasNext={Boolean(query.data.next_cursor)} busy={query.isFetching || busy}
          onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (query.data.next_cursor) setCursors((old) => [...old, query.data.next_cursor!]); }} />}
      </>}
      <CockpitNodeChoicePicker wsId={wsId} label={t(($) => $.issue_detail.link)} eligible={false} disabled={unlink.isPending}
        onSelect={(node) => link.mutateAsync({ nodeId: node.id, issueId })} />
    </div>}
  </div>;
}
