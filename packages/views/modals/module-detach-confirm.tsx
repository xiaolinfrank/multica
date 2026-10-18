"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import type { UpdateIssueRequest } from "@multica/core/types";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { errorCode } from "@multica/core/api";
import { useT } from "../i18n";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueOperationAllowed, issueUpdateOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { IssueOperationRestriction } from "../issues/components/issue-operation-restriction";
import { useCockpitCommandContext } from "../cockpit/components/use-cockpit-command-context";

/**
 * Confirms the one write that can take a sub-issue out of its parent's module.
 *
 * A sub-issue is filed where its parent is, so re-filing it is really two
 * changes: the move the user asked for, and the loss of the parent link that
 * the module was standing in for. The server refuses the pair outright
 * (`child_module_mismatch`), so this dialog is where the second change is
 * agreed to — and it sends both in one request, leaving no window where the
 * issue is detached but not yet moved.
 */
export function ModuleDetachConfirmModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const { t: tIssues } = useT("issues");
  const issueId = (data?.issueId as string) || "";
  const issueTitle = (data?.issueTitle as string) || "";
  const updates = (data?.updates as Partial<UpdateIssueRequest> | undefined) ?? {};
  const [submitting, setSubmitting] = useState(false);
  const updateIssue = useUpdateIssue();
  const wsId = useWorkspaceId(); const policy = useIssueOperationBasis(wsId, issueId ? [issueId] : []);
  const basis = policy.byIssue.get(issueId);
  const allowed = issueUpdateOperationAllowed(basis, { ...updates, parent_issue_id: null });
  const observation = { basis, pending: policy.isPending, error: policy.isError, retry: () => { void policy.refetch(); } };
  const invocation = useRef({ data, generation: 0 });
  if (invocation.current.data !== data) invocation.current = { data, generation: invocation.current.generation + 1 };
  const identity = JSON.stringify([wsId, issueId, updates, invocation.current.generation]);
  const captureContext = useCockpitCommandContext(identity);
  const [error, setError] = useState("");
  useEffect(() => { setSubmitting(false); setError(""); }, [identity]);

  const submit = async () => {
    if (!issueId || submitting || !allowed) return;
    const stillCurrent = captureContext();
    setSubmitting(true);
    setError("");
    try {
      await updateIssue.mutateAsync({
        id: issueId,
        ...updates,
        parent_issue_id: null,
      });
      if (stillCurrent()) onClose();
    } catch (err) {
      if (!stillCurrent()) return;
      const message =
        errorCode(err) === "revision_conflict"
          ? tIssues(($) => $.revision.conflict)
          : err instanceof Error && err.message
            ? err.message
            : t(($) => $.module_detach.toast_failed);
      setError(message); toast.error(message);
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.module_detach.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.module_detach.description, { title: issueTitle })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <IssueOperationRestriction observation={observation} operation={issueOperationAllowed(basis, "parent") ? "scope" : "parent"} />
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>
            {t(($) => $.module_detach.cancel)}
          </AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={submitting || !allowed}>
            {submitting
              ? t(($) => $.module_detach.submitting)
              : t(($) => $.module_detach.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
