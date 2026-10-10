"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { issueOperationAllowed, issueUpdateOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import type { Issue, IssueBatchReceipt, IssueOperationName, UpdateIssueRequest } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { cockpitActorLabelOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@multica/ui/components/ui/dialog";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { IssueOperationRestriction } from "./issue-operation-restriction";
import { IssueBatchOutcomeSummary } from "./issue-batch-outcome-summary";
import { useStatusLabel } from "../utils/status-label";
import { priorityLabel } from "../utils/priority-label";

export interface IssueBatchIntent {
  key: string;
  workspaceId: string;
  ids: string[];
  issueLabels: Array<Pick<Issue, "id" | "identifier" | "title">>;
  kind: "update" | "delete";
  updates?: Partial<UpdateIssueRequest>;
}
export function issueBatchOperation(intent: IssueBatchIntent): IssueOperationName {
  if (intent.kind === "delete") return "delete";
  if (intent.updates?.status !== undefined) return "status";
  if (intent.updates?.assignee_type !== undefined || intent.updates?.assignee_id !== undefined) return "assignee";
  if (intent.updates?.project_id !== undefined || intent.updates?.module_id !== undefined) return "scope";
  if (intent.updates?.parent_issue_id !== undefined) return "parent";
  return "status";
}

export function IssueBatchOperationDialog({ wsId, intent, issues, pending, result, selectionChanged = false, onSubmit, onClose }: {
  wsId: string; intent: IssueBatchIntent; issues: Issue[]; pending: boolean;
  result?: { receipt: IssueBatchReceipt | null; submittedIds: string[] };
  selectionChanged?: boolean;
  onSubmit: (ids: string[], revisions: Record<string, number>) => void; onClose: () => void;
}) {
  const { t } = useT("issues"); const paths = useWorkspacePaths(); const { categoryOf } = useIssueStatuses(wsId);
  const statusLabel = useStatusLabel(wsId);
  const assignee = useQuery(cockpitActorLabelOptions(wsId, intent.updates?.assignee_type ?? null, wsId === intent.workspaceId ? intent.updates?.assignee_id ?? null : null));
  const target = intent.kind === "delete" ? t(($) => $.batch.delete) : intent.updates?.status ? `${t(($) => $.batch.status)} · ${statusLabel(intent.updates.status)}`
    : intent.updates?.priority ? `${t(($) => $.batch.priority)} · ${priorityLabel(intent.updates.priority, t)}`
      : `${t(($) => $.batch.assignee)} · ${intent.updates?.assignee_id ? assignee.data || intent.updates.assignee_id : t(($) => $.pickers.assignee.trigger_unassigned)}`;
  const policy = useIssueOperationBasis(wsId, wsId === intent.workspaceId && !result ? intent.ids : []);
  const [confirmedSubset, setConfirmedSubset] = useState<string | null>(null); const [page, setPage] = useState(0);
  const operation = issueBatchOperation(intent);
  const allowed = intent.ids.filter((id) => {
    const basis = policy.byIssue.get(id);
    return typeof basis?.issue_revision === "number" && (intent.kind === "delete" ? issueOperationAllowed(basis, "delete") : issueUpdateOperationAllowed(basis, intent.updates ?? {}, categoryOf));
  });
  const unavailable = intent.ids.length - allowed.length;
  const subsetSignature = JSON.stringify(allowed);
  const eligibleOnly = confirmedSubset === subsetSignature;
  const ready = !selectionChanged && !pending && !policy.isPending && !policy.isError && allowed.length > 0 && (!unavailable || eligibleOnly);
  const rows = intent.ids.slice(page * 25, (page + 1) * 25);
  if (wsId !== intent.workspaceId) return null;
  return <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}><DialogContent className="sm:max-w-xl">
    <DialogHeader><DialogTitle>{result ? t(($) => $.operation_basis.batch_result) : t(($) => $.operation_basis.batch_review)}</DialogTitle><DialogDescription className="break-words font-medium text-foreground">{target}</DialogDescription></DialogHeader>
    <div className="space-y-3">
      {selectionChanged && !result && <p role="alert" className="text-caption text-destructive">{t(($) => $.operation_basis.selection_changed)}</p>}
      {result ? <IssueBatchOutcomeSummary wsId={wsId} receipt={result.receipt} submittedIds={result.submittedIds} issues={intent.issueLabels} operation={operation} /> : <>
        <p className="text-caption">{t(($) => $.operation_basis.batch_counts, { total: intent.ids.length, allowed: allowed.length, blocked: unavailable })}</p>
        {unavailable > 0 && <label className="flex items-start gap-2 text-caption"><Checkbox checked={eligibleOnly} disabled={pending || policy.isPending || policy.isError} onCheckedChange={(value) => setConfirmedSubset(value === true ? subsetSignature : null)} />{t(($) => $.operation_basis.only_available, { count: allowed.length })}</label>}
        {intent.kind === "delete" && <p className="text-caption text-destructive">{t(($) => $.batch.delete_dialog_warning)}</p>}
        <div className="flex items-center justify-between gap-2 text-caption"><span>{t(($) => $.operation_basis.page, { page: page + 1 })}</span><div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page === 0 || pending} onClick={() => setPage(page - 1)}>{t(($) => $.operation_basis.previous)}</Button>
          <Button type="button" variant="outline" size="sm" disabled={(page + 1) * 25 >= intent.ids.length || pending} onClick={() => setPage(page + 1)}>{t(($) => $.operation_basis.next)}</Button>
        </div></div>
        <ul className="max-h-[45vh] space-y-3 overflow-y-auto rounded-lg border p-3">{rows.map((id) => {
          const issue = issues.find((item) => item.id === id);
          const observation = { basis: policy.byIssue.get(id), pending: policy.pendingIds.has(id), error: policy.errorIds.has(id), retry: () => { void policy.refetch(); } };
          return <li key={id} className="space-y-2 border-b pb-3 last:border-0 last:pb-0"><AppLink href={paths.issueDetail(id)} target="_blank" rel="noopener noreferrer" className="block line-clamp-2 break-words text-caption text-primary underline underline-offset-4">{issue ? `${issue.identifier} · ${issue.title}` : id} {t(($) => $.operation_basis.new_tab)}</AppLink>
            {allowed.includes(id) ? <p className="text-caption text-muted-foreground">{t(($) => $.operation_basis.available)}</p> : <IssueOperationRestriction observation={observation} operation={operation} />}
          </li>;
        })}</ul>
        {policy.isError && <Button type="button" variant="outline" size="sm" disabled={pending || policy.isPending} onClick={() => void policy.refetch()}>{t(($) => $.operation_basis.retry)}</Button>}
      </>}
    </div>
    <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={onClose}>{result ? t(($) => $.operation_basis.dismiss) : t(($) => $.batch.cancel)}</Button>
      {!result && <Button type="button" variant={intent.kind === "delete" ? "destructive" : "default"} disabled={!ready} onClick={() => {
        if (!ready) return;
        const revisions: Record<string, number> = {};
        for (const id of allowed) { const revision = policy.byIssue.get(id)?.issue_revision; if (typeof revision === "number") revisions[id] = revision; }
        onSubmit(allowed, revisions);
      }}>{pending ? t(($) => $.operation_basis.applying) : t(($) => $.operation_basis.apply_count, { count: allowed.length })}</Button>}
    </DialogFooter>
  </DialogContent></Dialog>;
}
