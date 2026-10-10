"use client";

import { useState } from "react";
import { useIssueOperationBasis } from "@multica/core/issues";
import type { Issue, IssueBatchReceipt, IssueOperationName } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useWorkspaceId } from "@multica/core/hooks";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { IssueOperationRestriction } from "./issue-operation-restriction";

export function IssueBatchOutcomeSummary({ wsId, submittedIds, receipt, issues = [], operation, onRefresh, refreshing = false }: {
  wsId: string; submittedIds: readonly string[]; receipt: IssueBatchReceipt | null;
  issues?: readonly Pick<Issue, "id" | "identifier" | "title">[]; operation: IssueOperationName;
  onRefresh?: () => void; refreshing?: boolean;
}) {
  const { t } = useT("issues"); const paths = useWorkspacePaths(); const [page, setPage] = useState(0);
  const currentWorkspaceId = useWorkspaceId();
  const rows = submittedIds.slice(page * 25, (page + 1) * 25);
  const policy = useIssueOperationBasis(wsId, currentWorkspaceId === wsId ? rows.filter((id) => !receipt?.results.some((item) => item.issue_id === id && item.outcome === "applied")) : []);
  const applied = receipt?.results.filter((item) => item.outcome === "applied").length ?? 0;
  const unconfirmed = receipt?.unconfirmed_ids.length ?? submittedIds.length;
  const outcomeLabel = (id: string) => {
    const outcome = receipt?.results.find((item) => item.issue_id === id)?.outcome;
    return outcome === "applied" ? t(($) => $.operation_basis.applied) : outcome === "rejected" ? t(($) => $.operation_basis.rejected)
      : outcome === "not_attempted" ? t(($) => $.operation_basis.not_attempted) : outcome === "not_applied" ? t(($) => $.operation_basis.not_applied) : t(($) => $.operation_basis.unconfirmed);
  };
  const receiptReason = (code: string) => {
    switch (code) {
      case "revision_conflict": return t(($) => $.revision.conflict);
      case "not_found": case "issue_not_found": case "issue_unavailable": return t(($) => $.operation_basis.unavailable);
      case "formal_review_required": return t(($) => $.operation_basis.formal_required);
      case "retained_artifact_scope": return t(($) => $.operation_basis.retained_scope);
      case "retained_formal_history": return t(($) => $.operation_basis.retained_formal);
      case "retained_history": return t(($) => $.operation_basis.retained_history);
      case "retained_meeting_history": return t(($) => $.operation_basis.retained_meeting);
      case "primary_scope": return t(($) => $.operation_basis.primary_scope);
      default: return t(($) => $.operation_basis.rejected_hint);
    }
  };
  if (currentWorkspaceId !== wsId) return null;
  return <section aria-label={t(($) => $.operation_basis.batch_result)} className="space-y-3">
    <p role="status" className="text-caption">{t(($) => $.operation_basis.result_counts, { applied, remaining: submittedIds.length - applied - unconfirmed, unconfirmed })}</p>
    <p className="text-caption text-muted-foreground">{unconfirmed > 0 ? t(($) => $.operation_basis.unconfirmed_hint) : t(($) => $.operation_basis.result_hint)}</p>
    {receipt?.code && !receipt.results.some((row) => row.code === receipt.code) && <p className="text-caption">{receiptReason(receipt.code)}</p>}
    <p className="text-micro text-muted-foreground">{t(($) => $.operation_basis.observed_labels)}</p>
    <div className="flex items-center justify-between gap-2 text-caption"><span>{t(($) => $.operation_basis.page, { page: page + 1 })}</span><div className="flex gap-2">
      <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t(($) => $.operation_basis.previous)}</Button>
      <Button type="button" variant="outline" size="sm" disabled={(page + 1) * 25 >= submittedIds.length} onClick={() => setPage(page + 1)}>{t(($) => $.operation_basis.next)}</Button>
    </div></div>
    <ul className="max-h-[45vh] space-y-3 overflow-y-auto rounded-lg border p-3">{rows.map((id) => {
      const issue = issues.find((item) => item.id === id), row = receipt?.results.find((item) => item.issue_id === id), applied = row?.outcome === "applied";
      const observation = { basis: policy.byIssue.get(id), pending: policy.pendingIds.has(id), error: policy.errorIds.has(id), retry: () => { void policy.refetch(); onRefresh?.(); } };
      return <li key={id} className="space-y-2 border-b pb-3 last:border-0 last:pb-0">
        {operation === "delete" && applied ? <p className="line-clamp-2 break-words text-caption">{issue ? `${issue.identifier} · ${issue.title}` : id}</p>
          : <AppLink href={paths.issueDetail(id)} target="_blank" rel="noopener noreferrer" className="block line-clamp-2 break-words text-caption text-primary underline underline-offset-4">{issue ? `${issue.identifier} · ${issue.title}` : id} {t(($) => $.operation_basis.new_tab)}</AppLink>}
        <p className="text-caption font-medium">{outcomeLabel(id)}</p>
        {row?.outcome === "rejected" && row.code && <p className="text-caption">{receiptReason(row.code)}</p>}
        {!applied && <IssueOperationRestriction observation={observation} operation={operation} />}
      </li>;
    })}</ul>
    {(receipt?.error || receipt?.code || receipt?.results.some((row) => row.code)) && <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.operation_basis.diagnostics)}</summary>
      {receipt.error && <p className="mt-2 break-words">{receipt.error}</p>}{receipt.code && <p className="break-words font-mono text-micro">{receipt.code}</p>}
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto break-words font-mono text-micro">{rows.map((id) => { const row = receipt.results.find((item) => item.issue_id === id); return row?.code ? <li key={id}>{id}: {row.code}</li> : null; })}</ul>
    </details>}
    <Button type="button" variant="outline" size="sm" disabled={refreshing || policy.isPending} onClick={() => { void policy.refetch(); onRefresh?.(); }}>{t(($) => $.operation_basis.retry)}</Button>
  </section>;
}
