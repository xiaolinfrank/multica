"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  issueDetailOptions,
  childIssuesOptions,
} from "@multica/core/issues/queries";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { issueOperationAllowed, issueOperationBasisOptions, useIssueOperationBasis } from "@multica/core/issues";
import { IssueOperationRestriction } from "../issues/components/issue-operation-restriction";
import { IssuePickerModal } from "./issue-picker-modal";
import { useT } from "../i18n";

export function AddChildIssueModal({
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
  const client = useQueryClient(); const [selectedId, setSelectedId] = useState(""); const [scopeBlocked, setScopeBlocked] = useState(false);
  const policy = useIssueOperationBasis(wsId, selectedId ? [selectedId] : []);
  const observation = { basis: policy.byIssue.get(selectedId), pending: policy.isPending, error: policy.isError, retry: () => { void policy.refetch(); } };

  const host = useQuery({
    ...issueDetailOptions(wsId, issueId),
    enabled: !!issueId,
  });
  const issue = host.data;
  const { data: children = [] } = useQuery({
    ...childIssuesOptions(wsId, issueId),
    enabled: !!issueId,
  });

  const excludeIds = [
    issueId,
    ...(issue?.parent_issue_id ? [issue.parent_issue_id] : []),
    ...children.map((c) => c.id),
  ];

  return (
    <IssuePickerModal
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={t(($) => $.add_child.title)}
      description={t(($) => $.add_child.description)}
      excludeIds={excludeIds}
      contextKey={`${wsId}:${issueId}`}
      disabled={!issue || host.isFetching || host.isError}
      notice={selectedId ? <IssueOperationRestriction observation={observation} operation={scopeBlocked ? "scope" : "parent"} />
        : host.isError || !issue ? <IssueOperationRestriction observation={{ pending: host.isPending, error: host.isError, retry: () => { void host.refetch(); } }} operation="parent" /> : undefined}
      onSelect={async (selected, signal) => {
        if (!issue || host.isError || host.isFetching) throw new Error(issueT(($) => $.operation_basis.failed));
        setSelectedId(selected.id); setScopeBlocked(false);
        let basis;
        const child = await client.fetchQuery({ ...issueDetailOptions(wsId, selected.id), staleTime: 0 });
        if (signal.aborted) return;
        if (!child || child.workspace_id !== wsId || child.module_id === undefined || issue.workspace_id !== wsId || issue.module_id === undefined) throw new Error(issueT(($) => $.operation_basis.failed));
        try {
          const page = await client.fetchQuery({ ...issueOperationBasisOptions(wsId, [selected.id]), staleTime: 0 });
          basis = page.items.find((item) => item.issue_id === selected.id);
        } catch { throw new Error(issueT(($) => $.operation_basis.failed)); }
        if (signal.aborted) return;
        const changesScope = child.project_id !== issue.project_id || child.module_id !== issue.module_id;
        if (!issueOperationAllowed(basis, "parent")) throw new Error(issueT(($) => $.operation_basis.blocked));
        if (changesScope && !issueOperationAllowed(basis, "scope")) { setScopeBlocked(true); throw new Error(issueT(($) => $.operation_basis.blocked)); }
        await updateIssue.mutateAsync({ id: selected.id, parent_issue_id: issueId });
        if (signal.aborted) return;
        toast.success(t(($) => $.add_child.toast_success, { identifier: selected.identifier }));
      }}
    />
  );
}
