"use client";

import { useState } from "react";
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

  const submit = async () => {
    if (!issueId || submitting) return;
    setSubmitting(true);
    try {
      await updateIssue.mutateAsync({
        id: issueId,
        ...updates,
        parent_issue_id: null,
      });
      onClose();
    } catch (err) {
      toast.error(
        errorCode(err) === "revision_conflict"
          ? tIssues(($) => $.revision.conflict)
          : err instanceof Error && err.message
            ? err.message
            : t(($) => $.module_detach.toast_failed),
      );
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
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>
            {t(($) => $.module_detach.cancel)}
          </AlertDialogCancel>
          <AlertDialogAction onClick={submit} disabled={submitting}>
            {submitting
              ? t(($) => $.module_detach.submitting)
              : t(($) => $.module_detach.confirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
