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
import { useDeleteIssue } from "@multica/core/issues/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { IssueOperationRestriction } from "../issues/components/issue-operation-restriction";
import { useCockpitCommandContext } from "../cockpit/components/use-cockpit-command-context";
import { useBackOrReplace } from "../navigation";
import { useT } from "../i18n";

export function DeleteIssueConfirmModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const issueId = (data?.issueId as string) || "";
  const wsId = useWorkspaceId();
  const policy = useIssueOperationBasis(wsId, issueId ? [issueId] : []);
  const observation = { basis: policy.byIssue.get(issueId), pending: policy.pendingIds.has(issueId), error: policy.errorIds.has(issueId), retry: () => { void policy.refetch(); } };
  const canDelete = issueOperationAllowed(observation.basis, "delete");
  // Set only by callers that are rendering the issue we are about to delete
  // (the detail page). List surfaces leave it undefined and simply stay put.
  const fallbackPath = (data?.onDeletedFallbackPath as string | undefined) || undefined;
  const [deleting, setDeleting] = useState(false);
  const deleteIssue = useDeleteIssue();
  const backOrReplace = useBackOrReplace();
  const invocation = useRef({ data, generation: 0 });
  if (invocation.current.data !== data) invocation.current = { data, generation: invocation.current.generation + 1 };
  const context = JSON.stringify([wsId, issueId, invocation.current.generation]);
  const captureContext = useCockpitCommandContext(context);
  useEffect(() => { setDeleting(false); }, [context]);

  const handleDelete = async () => {
    if (!issueId || deleting || !canDelete) return;
    const stillCurrent = captureContext();
    setDeleting(true);
    try {
      await deleteIssue.mutateAsync(issueId);
      if (!stillCurrent()) return;
      toast.success(t(($) => $.delete_issue.toast_deleted));
      onClose();
      // Back to whichever list the user opened this issue from; `fallbackPath`
      // only kicks in when there is no in-app history to step back into.
      if (fallbackPath) backOrReplace(fallbackPath);
    } catch (err) {
      if (!stillCurrent()) return;
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.delete_issue.toast_delete_failed),
      );
      setDeleting(false);
      void policy.refetch();
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => { if (!v && !deleting) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.delete_issue.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.delete_issue.description)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <IssueOperationRestriction observation={observation} operation="delete" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t(($) => $.delete_issue.cancel)}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting || !canDelete}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {deleting ? t(($) => $.delete_issue.deleting) : t(($) => $.delete_issue.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
