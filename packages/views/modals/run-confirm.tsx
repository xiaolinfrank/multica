"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import type { Issue, IssueAssigneeType, IssueStatus, UpdateIssueRequest, IssueBatchReceipt } from "@multica/core/types";
import { useUpdateIssue, useBatchUpdateIssues } from "@multica/core/issues/mutations";
import { useIssueOperationBasis, issueUpdateOperationAllowed, issueOperationAllowed, issueBatchAppliedIds, issueBatchComplete, issueBatchErrorReceipt } from "@multica/core/issues";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { errorCode } from "@multica/core/api";
import { useActorName } from "@multica/core/workspace/hooks";
import { useWorkspaceId } from "@multica/core/hooks";
import { useShortcut, shortcutMatchesEvent, isPlainShortcut } from "@multica/core/shortcuts";
import { isImeComposing } from "@multica/core/utils";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";
import { useStatusLabel } from "../issues/utils/status-label";
import { useT } from "../i18n";
import { AppLink } from "../navigation";
import { IssueOperationRestriction } from "../issues/components/issue-operation-restriction";
import { IssueBatchOutcomeSummary } from "../issues/components/issue-batch-outcome-summary";

// i18next inlines {{name}} / {{status}} into the sentence, but their position
// varies by language ("{{name}} 会…" vs "Once assigned, {{name}} will…" vs
// "{{name}}'s leader…"). Fence each one with a sentinel so we can bold just
// those spans at render time without splitting copy into per-language
// prefix/suffix keys. Bolding is also what marks a custom status name as a
// status rather than an ordinary word ("Move this issue to Later.").
const FENCE = "\u0000";

const fenced = (value: string) => `${FENCE}${value}${FENCE}`;

function boldFenced(text: string): ReactNode {
  const parts = text.split(FENCE);
  // Every fenced span contributes one odd-indexed part; an unfenced string is
  // a single part and renders as-is.
  if (parts.length < 3) return text;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-semibold text-foreground">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface RunConfirmData {
  issueIds?: string[];
  // The two issue writes that hand work to an agent, and the only two that
  // confirm. `assign` gives the issue an agent/squad owner; `promote` moves an
  // already-owned issue out of the backlog category, which starts the run on
  // its own (RunSourceStatus). Batch status changes still apply directly
  // (MUL-4155) — `promote` is the single-issue picker path only (MUL-6463).
  mode?: "assign" | "promote";
  /** promote only: the status KEY the issue is moving to. */
  status?: IssueStatus;
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  assigneeName?: string;
  issueRevision?: number;
  expectedRevisions?: Record<string, number>;
  issueLabels?: Array<Pick<Issue, "id" | "identifier" | "title">>;
  onBatchResult?: (receipt: IssueBatchReceipt | null, submittedIds: string[]) => void;
}

/**
 * Handoff confirmation for the issue writes that start agent runs.
 *
 * The dialog confirms the requested assignment/status, not a predicted run
 * count. A bounded operation-basis read explains structural and formal-review
 * restrictions; actual dispatch remains the server's decision at write time.
 *
 * Completion is silent: the assignee/status change and any run it starts
 * surface through the issue's normal updates, so the confirm adds no result
 * toast. Whether a run starts stays the server's existing decision at write
 * time. Dismissing the dialog (X / Esc / click-outside) cancels without any
 * write. Shared by single assign (1 id), batch assign (N ids), and the
 * single-issue promotion out of backlog.
 */
export function RunConfirmModal({
  onClose,
  data,
}: {
  onClose: () => void;
  data: Record<string, unknown> | null;
}) {
  const { t } = useT("modals");
  const { t: tIssues } = useT("issues");
  const { getActorName } = useActorName();
  const sendShortcut = useShortcut("send");
  const d = (data ?? {}) as RunConfirmData;
  const issueIds = d.issueIds ?? [];
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { categoryOf } = useIssueStatuses(wsId);
  const intent = JSON.stringify([wsId, issueIds, d.mode, d.status, d.assigneeType, d.assigneeId, d.issueRevision, d.expectedRevisions]);
  const generation = useRef({ intent, sequence: 0 });
  if (generation.current.intent !== intent) generation.current = { intent, sequence: generation.current.sequence + 1 };
  // Returning to identical inputs is a new interaction, not permission for an
  // older in-flight response to close this instance or clear its selection.
  const identity = generation.current.sequence + ":" + intent;
  const latest = useRef(identity); latest.current = identity;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lock = useRef<string | null>(null);
  const [outcome, setOutcome] = useState<{ identity: string; ids: string[]; receipt: IssueBatchReceipt | null } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const visibleOutcome = outcome?.identity === identity ? outcome : null;
  const completed = new Set(issueBatchAppliedIds(visibleOutcome?.receipt));
  const activeIds = issueIds.filter((id) => !completed.has(id));
  const policy = useIssueOperationBasis(wsId, activeIds);
  const unconfirmed = Boolean(visibleOutcome && (!visibleOutcome.receipt || visibleOutcome.receipt.unconfirmed_ids.length > 0));

  // Which footer action is in flight, so only the clicked button shows a
  // spinner (the write is not instant — the disabled-only state read as frozen).
  const [pending, setPending] = useState<{ identity: string; action: "go" | "suppress" } | null>(null);
  const pendingAction = pending?.identity === identity ? pending.action : null;
  const submitting = pendingAction !== null;

  const updateIssue = useUpdateIssue();
  const batchUpdate = useBatchUpdateIssues();

  // Built-ins resolve through i18n, custom statuses through the catalog, so the
  // promotion headline reads the same way the picker the user just used does.
  const statusLabel = useStatusLabel(wsId);

  // A promotion carries the status and nothing else: the owner is already on
  // the issue, and re-sending the same assignee would turn a status write into
  // an assignee write on the server's side of the trigger predicate.
  const isPromote = d.mode === "promote" && !!d.status;

  const applyTo = (extra: Partial<UpdateIssueRequest>) => {
    const base: UpdateIssueRequest = isPromote
      ? { status: d.status }
      : {
          assignee_type: d.assigneeType ?? null,
          assignee_id: d.assigneeId ?? null,
        };
    return { ...base, ...extra };
  };
  const blockedIds = activeIds.filter((id) => !issueUpdateOperationAllowed(policy.byIssue.get(id), applyTo({}), categoryOf));
  const executionBlockedIds = activeIds.filter((id) => !issueOperationAllowed(policy.byIssue.get(id), "execution"));
  const revisionDrift = issueIds.length === 1 && d.issueRevision !== undefined
    && policy.byIssue.get(issueIds[0]!)?.issue_revision !== undefined
    && policy.byIssue.get(issueIds[0]!)?.issue_revision !== d.issueRevision;
  // A partial or unknown attempt is a result to inspect, never an automatic
  // retry surface. The caller keeps unapplied selections for a new action.
  const canSubmit = activeIds.length > 0 && blockedIds.length === 0 && !visibleOutcome && !unconfirmed && !revisionDrift;

  // The copy names whoever the issue is handed to; for a squad that is the
  // squad itself, since its leader deciding who works is an internal detail.
  const assigneeName =
    d.assigneeName ??
    getActorName(d.assigneeType === "squad" ? "squad" : "agent", d.assigneeId ?? "");

  const submit = async (suppressRun: boolean) => {
    if (!canSubmit || (!suppressRun && executionBlockedIds.length > 0) || submitting || lock.current === identity) return;
    const submittedIds = [...activeIds], submittedIdentity = identity;
    const current = () => mounted.current && latest.current === submittedIdentity;
    lock.current = identity;
    setPending({ identity, action: suppressRun ? "suppress" : "go" });
    setFailure(null);
    const payload = applyTo(suppressRun ? { suppress_run: true } : {});
    const expected = Object.fromEntries(submittedIds.flatMap((id) => {
      const revision = d.expectedRevisions?.[id] ?? policy.byIssue.get(id)?.issue_revision;
      return revision && revision > 0 ? [[id, revision]] : [];
    }));
    try {
      // Completion is silent, exactly as before: the assignee and any run show
      // up through the issue's normal assignee / run-status updates, so there is
      // no result toast to add here. Whether a run started is the server's
      // existing decision at write time, not something this dialog reports.
      if (issueIds.length === 1) {
        await updateIssue.mutateAsync({
          id: issueIds[0]!,
          ...payload,
          expected_revision: d.issueRevision ?? expected[issueIds[0]!],
        });
      } else {
        const receipt = await batchUpdate.mutateAsync({ ids: submittedIds, updates: payload, expected_revisions: expected });
        if (!current()) return;
        setOutcome({ identity, ids: submittedIds, receipt });
        if (typeof d.onBatchResult === "function") d.onBatchResult(receipt, submittedIds);
        if (!issueBatchComplete(receipt)) return;
      }
      if (current()) onClose();
    } catch (err) {
      if (!current()) return;
      if (issueIds.length > 1) {
        const receipt = issueBatchErrorReceipt(err, wsId, submittedIds, "update");
        setOutcome({ identity, ids: submittedIds, receipt });
        if (typeof d.onBatchResult === "function") d.onBatchResult(receipt, submittedIds);
      }
      const message = errorCode(err) === "revision_conflict"
          ? tIssues(($) => $.revision.conflict)
          : err instanceof Error && err.message
            ? err.message
            : t(($) => $.run_confirm.toast_failed);
      setFailure({ identity, message }); toast.error(message);
      void policy.refetch();
    } finally {
      if (lock.current === submittedIdentity) lock.current = null;
      if (current()) setPending(null);
    }
  };

  /**
   * The configured `send` chord confirms the assignment, the same chord that
   * creates from the issue composer (MUL-5694).
   *
   * Bound on the dialog, not on a single control, because the chord means "run
   * the primary action" no matter which control has focus — and with only the
   * footer left to focus, that is precisely where the keycap on the confirm
   * button would otherwise be advertising a dead key.
   */
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    // A held chord submits once, and the Enter that commits an IME
    // composition is the user picking a candidate, never a confirmation.
    if (e.defaultPrevented || e.repeat || isImeComposing(e)) return;
    if (!shortcutMatchesEvent(sendShortcut, e.nativeEvent)) return;
    // Only a BARE Enter activates a focused button (Chromium fires no click
    // for ⌘/Ctrl+Enter), so a `send` remapped to plain Enter is the one case
    // where confirming here too would double-write — and on "Don't start yet"
    // the two writes would disagree about suppress_run. Every chord form
    // reaches the footer as a dead key without us, so it must not be skipped.
    const activatesFocusedButton =
      isPlainShortcut(sendShortcut, "Enter") &&
      e.target instanceof HTMLElement &&
      e.target.closest("button") !== null;
    if (activatesFocusedButton) return;
    e.preventDefault();
    void submit(false);
  };

  // States the action, not a prediction: the write is certain, the run is
  // conditional, so the copy names no run count. The promotion names the
  // status it is moving to by its workspace label — a custom status is only
  // recognisable by the name its admin gave it.
  const headline: ReactNode = boldFenced(
    isPromote
      ? t(($) => $.run_confirm.promote_single, {
          name: fenced(assigneeName),
          status: fenced(statusLabel(d.status ?? "")),
        })
      : issueIds.length > 1
        ? t(($) => $.run_confirm.assign_batch, {
            name: fenced(assigneeName),
            count: activeIds.length,
          })
        : t(($) => $.run_confirm.assign_single, { name: fenced(assigneeName) }),
  );

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      {/* Wider than the primitive's sm:max-w-sm: the two actions are long
          phrases, not "Cancel"/"Save". In French they measure ~435px with the
          send-shortcut keycaps against the 352px the default leaves, so the
          dialog's overflow-auto showed a horizontal scrollbar. */}
      <DialogContent className="sm:max-w-lg" onKeyDown={onDialogKeyDown}>
        <DialogHeader>
          <DialogTitle>
            {isPromote
              ? t(($) => $.run_confirm.title_promote)
              : t(($) => $.run_confirm.title_assign)}
          </DialogTitle>
          <DialogDescription>{headline}</DialogDescription>
        </DialogHeader>

        {visibleOutcome && <IssueBatchOutcomeSummary wsId={wsId} submittedIds={visibleOutcome.ids} receipt={visibleOutcome.receipt}
          issues={d.issueLabels} operation={isPromote ? "status" : "assignee"} onRefresh={() => void policy.refetch()} />}
        {!visibleOutcome && blockedIds.length > 0 && <div className="max-h-60 space-y-3 overflow-y-auto">
          <p className="text-caption">{tIssues(($) => $.operation_basis.batch_counts, { total: activeIds.length, allowed: activeIds.length - blockedIds.length, blocked: blockedIds.length })}</p>
          {blockedIds.slice(0, 3).map((id) => <IssueOperationRestriction key={id} operation={isPromote ? "status" : "assignee"}
            observation={{ basis: policy.byIssue.get(id), pending: policy.pendingIds.has(id), error: policy.errorIds.has(id), retry: () => void policy.refetch() }} />)}
        </div>}
        {!visibleOutcome && blockedIds.length === 0 && executionBlockedIds.slice(0, 3).map((id) => <IssueOperationRestriction key={id} operation="execution"
          observation={{ basis: policy.byIssue.get(id), pending: policy.pendingIds.has(id), error: policy.errorIds.has(id), retry: () => void policy.refetch() }} />)}
        {(revisionDrift || failure?.identity === identity) && <div role="alert" className="space-y-2 text-caption">
          <p>{revisionDrift ? tIssues(($) => $.revision.conflict) : failure?.message}</p>
          {issueIds.length === 1 && <AppLink href={paths.issueDetail(issueIds[0]!)} target="_blank" rel="noopener noreferrer" className="text-primary underline">
            {tIssues(($) => $.operation_basis.open_record)} {tIssues(($) => $.operation_basis.new_tab)}
          </AppLink>}
        </div>}
        {/* flex-wrap keeps a longer translation, or a larger text size, from
            bringing the scrollbar back: the actions stack instead. */}
        <DialogFooter className="sm:flex-wrap">
          <Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>{tIssues(($) => $.operation_basis.dismiss)}</Button>
          <Button type="button" variant="outline" disabled={submitting || !canSubmit} onClick={() => submit(true)}>
            {pendingAction === "suppress" ? <Spinner className="size-4" /> : t(($) => $.run_confirm.dont_start)}
          </Button>
          <Button type="button" disabled={submitting || !canSubmit || executionBlockedIds.length > 0} onClick={() => submit(false)}>
            {pendingAction === "go" ? (
              <Spinner className="size-4" />
            ) : (
              <>
                {isPromote
                  ? t(($) => $.run_confirm.confirm_promote)
                  : t(($) => $.run_confirm.confirm_assign)}
                {/* Decorative: the accessible name stays the button's own copy,
                    not "Confirm assignment Command Enter". Absent when `send`
                    is unbound. */}
                {sendShortcut ? (
                  <ShortcutKeycaps
                    shortcut={sendShortcut}
                    decorative
                    className="ml-1"
                    keyClassName="border-background/30 bg-background/15 text-primary-foreground shadow-none"
                  />
                ) : null}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
