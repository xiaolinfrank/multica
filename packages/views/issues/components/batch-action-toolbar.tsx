"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import type { Issue, IssueBatchReceipt, UpdateIssueRequest } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useIssueOperationBasis, issueUpdateOperationAllowed, issueBatchAppliedIds, issueBatchComplete, issueBatchErrorReceipt } from "@multica/core/issues";
import { IssueBatchOperationDialog, type IssueBatchIntent } from "./issue-batch-operation-dialog";
import { commonIssueFields } from "@multica/core/issues/batch";
import { useBatchUpdateIssues, useBatchDeleteIssues } from "@multica/core/issues/mutations";
import { useModalStore } from "@multica/core/modals";
import { StatusPicker, PriorityPicker, AssigneePicker } from "./pickers";
import { useT } from "../../i18n";
import { cn } from "@multica/ui/lib/utils";
import {
  UI_EASE_OUT,
  UI_MOTION_DURATION,
} from "@multica/ui/lib/motion";
import { useIssueSurfaceActionsOptional } from "../surface/actions-context";
import { useIssueSurfaceSelection } from "../surface/selection-context";

export function BatchActionToolbar({
  issues,
  placement = "fixed-bottom",
}: {
  /**
   * The universe of selectable issues at this call site (the same list the
   * rows are rendered from). The toolbar filters it by the active surface
   * selection to reflect the real common status / priority / assignee of the
   * selected issues, mirroring how the skill list filters rows by `selectedIds`.
   */
  issues: Issue[];
  /**
   * "fixed-bottom" — floats at the bottom of the viewport (default; used by
   * full-screen issue lists).
   * "inline" — renders in normal flow so callers can place it adjacent to
   * the selected rows (used inside scrollable sections like sub-issues).
   */
  placement?: "fixed-bottom" | "inline";
}) {
  const { t } = useT("issues");
  const selection = useIssueSurfaceSelection();
  const selectedIds = selection.selectedIds;
  const clear = selection.clear;
  const shouldReduceMotion = useReducedMotion() ?? false;

  // The authoritative selection is selectedIds ∩ the visible universe. Acting
  // on raw selectedIds while other consumers (Export selected, common fields)
  // intersect lets one "N selected" mean different sets — e.g. a realtime
  // update drops a selected row from the window, batch still mutates it but
  // export omits it. Count, pickers, and every action below share this set.
  const selectedIssues = useMemo(
    () => issues.filter((i) => selectedIds.has(i.id)),
    [issues, selectedIds],
  );
  const count = selectedIssues.length;

  // Reflect the real shared value of the selected issues in each picker; fall
  // back to an empty (no-checkmark) state when the selection is mixed, instead
  // of asserting a hardcoded default.
  const common = useMemo(
    () => commonIssueFields(selectedIssues),
    [selectedIssues],
  );

  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [review, setReview] = useState<{ intent: IssueBatchIntent; result?: { receipt: IssueBatchReceipt | null; submittedIds: string[] } } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const command = useRef<string | null>(null); const inFlight = useRef(false);
  const wsId = useWorkspaceId(); const { categoryOf } = useIssueStatuses(wsId);
  const selectedNow = useRef(selectedIds); selectedNow.current = selectedIds;
  const workspaceNow = useRef(wsId); workspaceNow.current = wsId;
  useEffect(() => () => { command.current = null; }, []);
  useEffect(() => { command.current = null; inFlight.current = false; setSubmitting(false); setReview(null); }, [wsId]);
  const surfaceActions = useIssueSurfaceActionsOptional();
  const batchUpdate = useBatchUpdateIssues();
  const batchDelete = useBatchDeleteIssues();
  const openModal = useModalStore((s) => s.open);
  const loading =
    submitting || (surfaceActions?.isPending ?? (batchUpdate.isPending || batchDelete.isPending));
  const ids = selectedIssues.map((issue) => issue.id);
  const policy = useIssueOperationBasis(wsId, ids);

  useEffect(() => {
    if (count > 0) return;
    setStatusOpen(false);
    setPriorityOpen(false);
    setAssigneeOpen(false);
  }, [count]);

  const submitIntent = async (intent: IssueBatchIntent, submittedIds: string[], revisions: Record<string, number>) => {
    if (inFlight.current || submittedIds.length === 0 || intent.workspaceId !== wsId || submittedIds.some((id) => !ids.includes(id))) return;
    const capturedWorkspace = wsId, capturedSelection = selectedNow.current;
    command.current = intent.key;
    const updates = intent.updates ?? {};
    if (intent.kind === "update" && (updates.assignee_type === "agent" || updates.assignee_type === "squad") && updates.assignee_id
      && submittedIds.some((id) => selectedIssues.find((issue) => issue.id === id)?.status !== "backlog")) {
      setReview(null);
      openModal("issue-run-confirm", { issueIds: submittedIds, mode: "assign", assigneeType: updates.assignee_type, assigneeId: updates.assignee_id,
        expectedRevisions: revisions,
        issueLabels: intent.issueLabels.filter((issue) => submittedIds.includes(issue.id)),
        onBatchResult: (receipt: IssueBatchReceipt | null) => {
          if (command.current !== intent.key || workspaceNow.current !== capturedWorkspace || selectedNow.current !== capturedSelection) return;
          const applied = issueBatchAppliedIds(receipt); if (applied.length) selection.deselect(applied);
        },
      });
      return;
    }
    inFlight.current = true; setSubmitting(true);
    const stillCurrent = () => command.current === intent.key && workspaceNow.current === capturedWorkspace;
    const acknowledge = (receipt: IssueBatchReceipt | null) => {
      if (!stillCurrent()) return;
      const applied = issueBatchAppliedIds(receipt), complete = issueBatchComplete(receipt);
      if (selectedNow.current === capturedSelection && applied.length) selection.deselect(applied);
      if (complete) {
        setReview(null);
        toast.success(intent.kind === "delete" ? t(($) => $.batch.delete_success, { count: applied.length }) : t(($) => $.batch.update_success, { count: applied.length }));
      } else setReview({ intent, result: { receipt, submittedIds } });
    };
    try {
      const receipt = intent.kind === "delete"
        ? surfaceActions ? await surfaceActions.batchDelete(submittedIds, { expected_revisions: revisions }) : await batchDelete.mutateAsync({ ids: submittedIds, expected_revisions: revisions })
        : surfaceActions ? await surfaceActions.batchUpdate(submittedIds, updates, { expected_revisions: revisions }) : await batchUpdate.mutateAsync({ ids: submittedIds, updates, expected_revisions: revisions });
      acknowledge(receipt);
    } catch (cause) {
      acknowledge(issueBatchErrorReceipt(cause, capturedWorkspace, submittedIds, intent.kind));
    } finally {
      if (stillCurrent()) { inFlight.current = false; setSubmitting(false); }
    }
  };

  const handleBatchUpdate = (updates: Partial<UpdateIssueRequest>) => {
    if (loading || ids.length === 0) return;
    const intent: IssueBatchIntent = { key: crypto.randomUUID(), workspaceId: wsId, ids: [...ids], issueLabels: selectedIssues.map(({ id, identifier, title }) => ({ id, identifier, title })), kind: "update", updates: { ...updates } };
    const revisions: Record<string, number> = {};
    const available = ids.every((id) => {
      const basis = policy.byIssue.get(id);
      if (!issueUpdateOperationAllowed(basis, updates, categoryOf) || typeof basis?.issue_revision !== "number") return false;
      revisions[id] = basis.issue_revision; return true;
    });
    if (!available || policy.isError || policy.isPending) { setReview({ intent }); return; }
    void submitIntent(intent, ids, revisions);
  };
  const handleBatchStatus = (updates: Partial<UpdateIssueRequest>) => { if (updates.status) handleBatchUpdate(updates); };
  const handleBatchAssignee = handleBatchUpdate;

  return (
    <>
      <AnimatePresence initial={false}>
        {count > 0 && (
          <div
            key="issue-batch-toolbar"
            className={cn(
              "z-50 max-w-[calc(100vw-2rem)]",
              placement === "fixed-bottom"
                ? "fixed bottom-6 left-1/2 -translate-x-1/2 max-md:above-chat-launcher"
                : "mb-2 w-fit",
            )}
          >
            <motion.div
              role="region"
              aria-label={t(($) => $.operation_basis.batch_toolbar)}
              className="flex flex-wrap items-center gap-1 rounded-lg border bg-background px-2 py-1.5 shadow-lg"
              initial={{
                opacity: 0,
                transform: shouldReduceMotion
                  ? "translateY(0)"
                  : "translateY(8px)",
              }}
              animate={{
                opacity: 1,
                transform: "translateY(0)",
                transition: {
                  duration: UI_MOTION_DURATION.fast,
                  ease: UI_EASE_OUT,
                },
              }}
              exit={{
                opacity: 0,
                transform: shouldReduceMotion
                  ? "translateY(0)"
                  : "translateY(8px)",
                transition: {
                  duration: shouldReduceMotion
                    ? UI_MOTION_DURATION.fast
                    : UI_MOTION_DURATION.micro,
                  ease: UI_EASE_OUT,
                },
              }}
            >
        <div className="flex items-center gap-1.5 pl-1 pr-2 border-r mr-1">
          <span className="text-body font-medium">{t(($) => $.batch.selected, { count })}</span>
          <button
            type="button"
            aria-label={t(($) => $.operation_basis.clear_selection)}
            onClick={clear}
            className="rounded-xs p-0.5 hover:bg-accent transition-colors"
          >
            <X className="size-3.5 text-muted-foreground" />
          </button>
        </div>

        {/* Status */}
        <StatusPicker
          status={common.status}
          onUpdate={handleBatchStatus}
          open={statusOpen}
          onOpenChange={setStatusOpen}
          triggerRender={<Button variant="ghost" size="sm" disabled={loading} />}
          trigger={t(($) => $.batch.status)}
          align="center"
        />

        {/* Priority */}
        <PriorityPicker
          priority={common.priority}
          onUpdate={handleBatchUpdate}
          open={priorityOpen}
          onOpenChange={setPriorityOpen}
          triggerRender={<Button variant="ghost" size="sm" disabled={loading} />}
          trigger={t(($) => $.batch.priority)}
          align="center"
        />

        {/* Assignee */}
        <AssigneePicker
          assigneeType={common.assignee?.type ?? null}
          assigneeId={common.assignee?.id ?? null}
          mixed={common.assignee === null}
          onUpdate={handleBatchAssignee}
          open={assigneeOpen}
          onOpenChange={setAssigneeOpen}
          triggerRender={<Button variant="ghost" size="sm" disabled={loading} />}
          trigger={t(($) => $.batch.assignee)}
          align="center"
        />

        {/* Delete */}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={() => setReview({ intent: { key: crypto.randomUUID(), workspaceId: wsId, ids: [...ids], issueLabels: selectedIssues.map(({ id, identifier, title }) => ({ id, identifier, title })), kind: "delete" } })}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5 mr-1" />
          {t(($) => $.batch.delete)}
        </Button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {review && <IssueBatchOperationDialog key={review.intent.key} wsId={wsId} intent={review.intent} issues={issues} pending={submitting} result={review.result}
        selectionChanged={review.intent.ids.length !== ids.length || review.intent.ids.some((id) => !ids.includes(id))}
        onClose={() => { if (!inFlight.current) { command.current = null; setReview(null); } }}
        onSubmit={(submittedIds, revisions) => { void submitIntent(review.intent, submittedIds, revisions); }} />}

    </>
  );
}
