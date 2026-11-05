"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "@multica/ui/icons";
import { toast } from "sonner";
import { Button } from "@multica/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useIssueDeletion } from "@multica/core/issues/use-issue-deletion";
import type { Issue, IssueBatchReceipt, UpdateIssueRequest } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useIssueOperationBasis, issueUpdateOperationAllowed, issueBatchAppliedIds, issueBatchComplete, issueBatchErrorReceipt } from "@multica/core/issues";
import { IssueBatchOperationDialog, type IssueBatchIntent } from "./issue-batch-operation-dialog";
import { commonIssueFields } from "@multica/core/issues/batch";
import { sharedWorkflowStatusKeys, useIssueWorkflows } from "@multica/core/issue-workflows";
import { projectListOptions } from "@multica/core/projects/queries";
import { useBatchUpdateIssues, useBatchDeleteIssues } from "@multica/core/issues/mutations";
import { useModalStore } from "@multica/core/modals";
import { StatusPicker, PriorityPicker, AssigneePicker } from "./pickers";
import { useT } from "../../i18n";
import { CollectionBatchBar } from "../../layout/collection-list";
import { useIssueSurfaceActionsOptional } from "../surface/actions-context";
import { useIssueSurfaceSelection } from "../surface/selection-context";
import { useRegisterCommandBarContext } from "../../search/register-context";
import { createSafeId } from "@multica/core/utils";

export function BatchActionToolbar({
  issues,
  placement = "fixed-bottom",
  clearSelectionOnApply = false,
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
  /**
   * Drop the selection once a status / priority / assignee change fully
   * applies. Off for full-screen lists, where the selection stays so several
   * edits can be chained; on for sub-issues, where a batch edit is a one-shot
   * dispatch and a lingering inline toolbar reads as unfinished. A partial or
   * failed write keeps the selection so the user can retry.
   */
  clearSelectionOnApply?: boolean;
}) {
  const { t } = useT("issues");
  const selection = useIssueSurfaceSelection();
  const selectedIds = selection.selectedIds;
  const clear = selection.clear;

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

  useRegisterCommandBarContext(
    useMemo(
      () => (count > 0 ? { kind: "issues", issues: selectedIssues, clearSelection: clear } : null),
      [count, selectedIssues, clear],
    ),
  );

  // Reflect the real shared value of the selected issues in each picker; fall
  // back to an empty (no-checkmark) state when the selection is mixed, instead
  // of asserting a hardcoded default.
  const common = useMemo(
    () => commonIssueFields(selectedIssues),
    [selectedIssues],
  );

  // A selection inside one project offers that project's workflow statuses;
  // one spanning projects offers the statuses every selected issue's
  // workflow allows. (MUL-7420)
  const sharedProjectId = useMemo(() => {
    const first = selectedIssues[0]?.project_id ?? null;
    return first && selectedIssues.every((i) => i.project_id === first) ? first : null;
  }, [selectedIssues]);
  const wsId = useWorkspaceId();
  const { canDelete } = useIssueDeletion(wsId);
  const canDeleteSelection = selectedIssues.every(canDelete);
  const { workflows } = useIssueWorkflows(wsId);
  const { data: projects } = useQuery({ ...projectListOptions(wsId), enabled: count > 0 && !sharedProjectId });
  const allowedStatuses = useMemo(
    () => (sharedProjectId ? null : sharedWorkflowStatusKeys(workflows, projects, selectedIssues)),
    [sharedProjectId, workflows, projects, selectedIssues],
  );

  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [review, setReview] = useState<{ intent: IssueBatchIntent; result?: { receipt: IssueBatchReceipt | null; submittedIds: string[] } } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const command = useRef<string | null>(null); const inFlight = useRef(false);
  const { categoryOf } = useIssueStatuses(wsId);
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
          if (clearSelectionOnApply && issueBatchComplete(receipt)) clear();
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
        if (clearSelectionOnApply) clear();
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
    const intent: IssueBatchIntent = { key: createSafeId(), workspaceId: wsId, ids: [...ids], issueLabels: selectedIssues.map(({ id, identifier, title }) => ({ id, identifier, title })), kind: "update", updates: { ...updates } };
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
      <CollectionBatchBar
        count={count}
        onClear={clear}
        placement={placement === "fixed-bottom" ? "fixed" : "inline"}
        label={t(($) => $.batch.selected, { count })}
      >
        {/* Status */}
        <StatusPicker
          status={common.status}
          // No shared project spans projects (or none): not the Default-only
          // list of a single issue outside a project. (MUL-8121)
          projectId={sharedProjectId ?? undefined}
          allowedStatuses={allowedStatuses}
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

        {/* Delete — upstream's per-issue delete permission gate, then the
            fork's revision-aware review dialog (it previews the affected
            issues and surfaces revision conflicts), so there is only one
            confirmation step. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || !canDeleteSelection}
          title={!canDeleteSelection ? t(($) => $.batch.delete_restricted) : undefined}
          onClick={() => setReview({ intent: { key: createSafeId(), workspaceId: wsId, ids: [...ids], issueLabels: selectedIssues.map(({ id, identifier, title }) => ({ id, identifier, title })), kind: "delete" } })}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5 mr-1" />
          {t(($) => $.batch.delete)}
        </Button>
      </CollectionBatchBar>

      {review && <IssueBatchOperationDialog key={review.intent.key} wsId={wsId} intent={review.intent} issues={issues} pending={submitting} result={review.result}
        selectionChanged={review.intent.ids.length !== ids.length || review.intent.ids.some((id) => !ids.includes(id))}
        onClose={() => { if (!inFlight.current) { command.current = null; setReview(null); } }}
        onSubmit={(submittedIds, revisions) => { void submitIntent(review.intent, submittedIds, revisions); }} />}
    </>
  );
}
