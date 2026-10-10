"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  childIssuesOptions,
  issueDetailOptions,
} from "@multica/core/issues/queries";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { IssuePickerModal } from "./issue-picker-modal";
import { useT } from "../i18n";
import { IssueOperationRestriction } from "../issues/components/issue-operation-restriction";

export function SetParentIssueModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const { t: issueT } = useT("issues");
  const issueId = (data?.issueId as string) || "";
  const wsId = useWorkspaceId();
  const updateIssue = useUpdateIssue();
  const client = useQueryClient();
  const source = useQuery(issueDetailOptions(wsId, issueId));
  const policy = useIssueOperationBasis(wsId, issueId ? [issueId] : []);
  const basis = policy.byIssue.get(issueId);
  const observation = { basis, pending: source.isPending || policy.isPending, error: source.isError || policy.isError, retry: () => { void source.refetch(); void policy.refetch(); } };
  const canChangeParent = Boolean(source.data && !source.isError && !source.isFetching && issueOperationAllowed(basis, "parent"));

  const { data: children = [] } = useQuery({
    ...childIssuesOptions(wsId, issueId),
    enabled: !!issueId,
  });

  const excludeIds = [issueId, ...children.map((c) => c.id)];

  return (
    <IssuePickerModal
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={t(($) => $.set_parent.title)}
      description={t(($) => $.set_parent.description)}
      excludeIds={excludeIds}
      contextKey={`${wsId}:${issueId}`}
      disabled={!canChangeParent}
      notice={<div className="space-y-2"><IssueOperationRestriction observation={observation} operation="parent" />{basis?.scope.state !== "allowed" && <IssueOperationRestriction observation={observation} operation="scope" />}</div>}
      onSelect={async (selected, signal) => {
        const target = await client.fetchQuery({ ...issueDetailOptions(wsId, selected.id), staleTime: 0 });
        if (signal.aborted) return;
        if (!target || target.workspace_id !== wsId || target.module_id === undefined || !source.data || source.data.workspace_id !== wsId || source.data.module_id === undefined) throw new Error(issueT(($) => $.operation_basis.failed));
        const sameScope = target.project_id === source.data.project_id && target.module_id === source.data.module_id;
        if (!canChangeParent || (!sameScope && !issueOperationAllowed(basis, "scope"))) throw new Error(issueT(($) => $.operation_basis.blocked));
        await updateIssue.mutateAsync({ id: issueId, parent_issue_id: target.id });
        if (signal.aborted) return;
        toast.success(t(($) => $.set_parent.toast_success, { identifier: selected.identifier }));
      }}
    />
  );
}
