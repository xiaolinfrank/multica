"use client";

// Structural levels expose basic fields; task-level details remain stored when hidden.

import type {
  CockpitMeeting,
  CockpitNode,
  CockpitNodePatch,
  CockpitPayment,
  CockpitPaymentPatch,
} from "@multica/core/types";
import { useEffect, useRef, useState } from "react";
import { cockpitMeetingSpan, splitCockpitVendors, type CockpitNodeView } from "@multica/core/cockpit";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Separator } from "@multica/ui/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import {
  CockpitField,
  EditableDate,
  EditableNumber,
  EditableSuggest,
  EditableText,
  EditableTextArea,
  EditableTokens,
  ProgressField,
} from "./cockpit-fields";
import { ExecStatusChip, StatusChip } from "./cockpit-status";
import { formatAmount } from "./cockpit-table";

export interface CockpitNodePanelProps {
  node: CockpitNode;
  /** The row's shipped (summary-tree) code, shown when it differs from the
   * stored code the panel edits. */
  displayCode?: string;
  parent: CockpitNode | undefined;
  payments: CockpitPayment[];
  /** The meetings that discussed this work item, newest first. */
  meetings: Pick<CockpitMeeting, "id" | "title" | "meet_date" | "time_range" | "start_time" | "end_time">[];
  isBranch: boolean;
  statusSuggestions: string[];
  execStatusSuggestions: string[];
  budgetCategorySuggestions: string[];
  ownerSuggestions: string[];
  vendorSuggestions: string[];
  onPatch: (patch: CockpitNodePatch) => void;
  binding?: React.ReactNode;
  notice?: React.ReactNode;
  taskWorkspace?: React.ReactNode;
  artifactWorkspace?: React.ReactNode;
  acceptanceWorkspace?: React.ReactNode;
  referenceWorkspace?: React.ReactNode;
  paymentPaging?: React.ReactNode;
  meetingPaging?: React.ReactNode;
  paymentTotal?: number;
  section: CockpitNodeView;
  onSectionChange: (section: CockpitNodeView) => void;
  /** Resolve only after the server has deleted the node; reject on failure. */
  onDelete: () => Promise<unknown>;
  deleteAllowed: boolean;
  deleteRestriction?: React.ReactNode;
  /** Localized destructive consequences, including descendants for a branch. */
  deleteConfirmationDescription: string;
  /** Zero-based tree depth, matching CockpitTreeNode.depth. */
  depth: number;
  onClose: () => void;
  /** Opens one of this item's meetings in the register. */
  onOpenMeeting: (meetingId: string) => void;
  onCreatePayment: () => void;
  onPatchPayment: (paymentId: string, patch: CockpitPaymentPatch) => void;
  onDeletePayment: (paymentId: string) => void;
  readOnly?: boolean;
}

export function CockpitNodePanel({
  node,
  displayCode,
  parent,
  payments,
  meetings,
  isBranch,
  statusSuggestions,
  execStatusSuggestions,
  budgetCategorySuggestions,
  ownerSuggestions,
  vendorSuggestions,
  onPatch,
  binding,
  notice,
  taskWorkspace,
  artifactWorkspace,
  acceptanceWorkspace,
  referenceWorkspace,
  paymentPaging,
  meetingPaging,
  paymentTotal: confirmedPaymentTotal,
  section,
  onSectionChange,
  onDelete,
  deleteAllowed,
  deleteRestriction,
  deleteConfirmationDescription,
  depth,
  onClose,
  onOpenMeeting,
  onCreatePayment,
  onPatchPayment,
  onDeletePayment,
  readOnly,
}: CockpitNodePanelProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const deletingRef = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const taskDetails = Boolean(taskWorkspace) || depth >= 2;
  const navigation = useNavigation();
  const deleteContext = JSON.stringify([node.id, section, navigation.pathname, navigation.searchParams.toString()]);
  const captureDelete = useCockpitCommandContext(deleteContext);
  useEffect(() => { deletingRef.current = false; setConfirmOpen(false); setDeleting(false); setDeleteFailed(false); }, [deleteContext]);

  useEffect(() => { closeButton.current?.focus(); }, [node.id]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || confirmOpen) return;
      // Editors and other popups consume Escape before it reaches the panel.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [confirmOpen, onClose]);

  const confirmDelete = async () => {
    if (deletingRef.current || !deleteAllowed) return;
    const isCurrent = captureDelete();
    deletingRef.current = true;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await onDelete();
      if (isCurrent()) { setConfirmOpen(false); onClose(); }
    } catch {
      if (isCurrent()) setDeleteFailed(true);
    } finally {
      if (isCurrent()) { deletingRef.current = false; setDeleting(false); }
    }
  };

  const unset = t(($) => $.common.unset);
  const paymentTotal = confirmedPaymentTotal ?? payments.reduce((sum, p) => sum + p.amount, 0);
  // Finance editing belongs to execution tasks; a structural row keeps only a
  // read-only view of payments filed there by older data.
  const paymentsEditable = taskDetails && !readOnly;

  return (
    <aside className={cn("cockpit-workbench cockpit-panel-enter @container/node-panel flex min-w-0 max-w-full shrink-0 flex-col border-l border-border bg-card @max-[80rem]/cockpit:w-full @max-[80rem]/cockpit:border-l-0",
      (taskWorkspace || referenceWorkspace) ? "w-[54rem]" : "w-96")}>
      <header tabIndex={0} className="cockpit-workbench-header flex max-h-[30%] shrink-0 items-start gap-2 overflow-y-auto border-b border-border p-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {parent && (
              <span className="truncate font-mono text-micro text-muted-foreground">
                {parent.code}
              </span>
            )}
            {displayCode && displayCode !== node.code && (
              <span
                className="font-mono text-micro font-medium"
                aria-label={t(($) => $.node.row_code, { code: displayCode })}
                title={t(($) => $.node.row_code, { code: displayCode })}
              >
                {displayCode}
              </span>
            )}
            <EditableText
              value={node.code}
              onCommit={(code) => onPatch({ code })}
              label={t(($) => $.node.stored_code)}
              placeholder={t(($) => $.node.code)}
              disabled={readOnly}
              displayClassName={cn(
                "font-mono text-micro",
                displayCode && displayCode !== node.code && "text-muted-foreground",
              )}
            />
          </div>
          <div className="mt-1">
            <EditableText
              value={node.name}
              onCommit={(name) => onPatch({ name })}
              label={t(($) => $.node.name)}
              placeholder={t(($) => $.node.name_placeholder)}
              disabled={readOnly}
              displayClassName="max-w-full whitespace-normal break-words text-title-sm font-semibold [overflow-wrap:anywhere]"
            />
          </div>
        </div>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          disabled={deleting}
          aria-label={t(($) => $.panel.close)}
          className="sticky top-0 z-10 flex size-8 shrink-0 items-center justify-center rounded-md bg-card text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </header>

      {notice && <div className="shrink-0 border-b border-border p-3">{notice}</div>}
      {((section === "artifacts" && !artifactWorkspace) || (section === "acceptance" && !acceptanceWorkspace)) && <p role="status" className="px-4 py-3 text-caption text-muted-foreground">{t(($) => $.feature_availability.unavailable)}</p>}
      <Tabs value={!taskWorkspace || (section === "artifacts" && !artifactWorkspace) || (section === "acceptance" && !acceptanceWorkspace) ? "details" : section} onValueChange={(value) => { if (value === "tasks" || value === "artifacts" || value === "acceptance" || value === "details") onSectionChange(value); }} className="min-h-0 flex-1 gap-0">
        {taskWorkspace && <TabsList variant="line" className="min-h-11 w-full shrink-0 flex-wrap border-b border-border px-4 py-1 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="tasks" className="h-9">{t(($) => $.task_flow.tasks_tab)}</TabsTrigger>
          {artifactWorkspace && <TabsTrigger value="artifacts" className="h-9">{t(($) => $.shell.artifacts)}</TabsTrigger>}
          {acceptanceWorkspace && <TabsTrigger value="acceptance" className="h-9">{t(($) => $.acceptance.title)}</TabsTrigger>}
          <TabsTrigger value="details" className="h-9">{t(($) => $.task_flow.details_tab)}</TabsTrigger>
        </TabsList>}
        {taskWorkspace && <TabsContent value="tasks" keepMounted className="min-h-0 overflow-y-auto p-4">{taskWorkspace}</TabsContent>}
        {artifactWorkspace && <TabsContent value="artifacts" className="flex min-h-0 flex-1 flex-col overflow-hidden [&[hidden]]:hidden">{artifactWorkspace}</TabsContent>}
        {acceptanceWorkspace && <TabsContent value="acceptance" className="min-h-0 overflow-y-auto p-4">{acceptanceWorkspace}</TabsContent>}
        <TabsContent value="details" className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-4">
        {binding && <div className="mb-4">{binding}</div>}
        <div className="grid min-w-0 grid-cols-1 gap-4 @min-[28rem]/node-panel:grid-cols-2">
          <CockpitField label={t(($) => $.node.owner)}>
            <EditableSuggest
              value={node.owner}
              onCommit={(owner) => onPatch({ owner })}
              suggestions={ownerSuggestions}
              label={t(($) => $.node.owner)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.status)}>
            <EditableSuggest
              value={node.status}
              onCommit={(status) => onPatch({ status })}
              suggestions={statusSuggestions}
              clearLabel={t(($) => $.node.status_unscheduled)}
              label={t(($) => $.node.status)}
              placeholder={unset}
              disabled={readOnly}
              renderDisplay={(value) => <StatusChip status={value} />}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.start_date)}>
            <EditableDate
              value={node.start_date}
              onCommit={(start_date) => onPatch({ start_date })}
              label={t(($) => $.node.start_date)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.end_date)}>
            <EditableDate
              value={node.end_date}
              onCommit={(end_date) => onPatch({ end_date })}
              label={t(($) => $.node.end_date)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.progress)} className="min-w-0 @min-[28rem]/node-panel:col-span-2">
            {/* A branch's progress is the weighted roll-up of its leaves, so
                editing it here would be overwritten by the next read. */}
            <ProgressField
              value={node.progress}
              onCommit={(progress) => onPatch({ progress })}
              label={t(($) => $.node.progress)}
              disabled={readOnly || isBranch}
            />
            {isBranch && <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.node.progress_branch_hint)}</p>}
          </CockpitField>
          {taskDetails && (
            <CockpitField label={t(($) => $.node.collaborators)} className="min-w-0 @min-[28rem]/node-panel:col-span-2">
            <EditableText
              value={node.collaborators}
              onCommit={(collaborators) => onPatch({ collaborators })}
              label={t(($) => $.node.collaborators)}
              placeholder={t(($) => $.node.collaborators_placeholder)}
              disabled={readOnly}
            />
            </CockpitField>
          )}
        </div>

        <Separator className="my-4" />
        <CockpitField label={t(($) => $.node.linked_issues)}>
          {taskWorkspace ? <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.reference_location)}</p> : referenceWorkspace}
        </CockpitField>

        {/* The other direction of the meeting register: what was discussed
            here, and when. Read-only — a meeting is attached from the meeting,
            which is where the rest of its record lives. */}
        {(meetings.length > 0 || meetingPaging) && (
          <CockpitField label={t(($) => $.meetings.node_meetings)} className="mt-3">
            {meetingPaging}
            <ul className="flex flex-col gap-0.5">
              {meetings.map((meeting) => (
                <li key={meeting.id}>
                  <button
                    type="button"
                    onClick={() => onOpenMeeting(meeting.id)}
                    className="flex w-full min-w-0 items-baseline gap-2 rounded-sm px-1 text-left hover:bg-accent"
                  >
                    <span className="shrink-0 text-micro tabular-nums text-muted-foreground">
                      {meeting.meet_date ?? "—"}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-caption">{meeting.title}</span>
                    <span className="shrink-0 text-micro text-muted-foreground">
                      {cockpitMeetingSpan(meeting)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </CockpitField>
        )}

        {taskDetails && (
          <>
            <Separator className="my-4" />

            <div className="grid min-w-0 grid-cols-1 gap-4 @min-[28rem]/node-panel:grid-cols-2">
              <CockpitField label={t(($) => $.node.vendor)}>
                <EditableTokens
                  value={node.vendor}
                  onCommit={(vendor) => onPatch({ vendor })}
                  split={splitCockpitVendors}
                  suggestions={vendorSuggestions}
                  label={t(($) => $.node.vendor)}
                  placeholder={unset}
                  disabled={readOnly}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.budget_category)}>
                <EditableSuggest
                  value={node.budget_category}
                  onCommit={(budget_category) => onPatch({ budget_category })}
                  suggestions={budgetCategorySuggestions}
                  label={t(($) => $.node.budget_category)}
                  placeholder={unset}
                  disabled={readOnly}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.budget)}>
                <EditableNumber
                  value={node.budget_amount}
                  onCommit={(budget_amount) => onPatch({ budget_amount })}
                  label={t(($) => $.node.budget)}
                  placeholder={unset}
                  disabled={readOnly}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.exec_status)}>
                <EditableSuggest
                  value={node.exec_status}
                  onCommit={(exec_status) => onPatch({ exec_status })}
                  suggestions={execStatusSuggestions}
                  label={t(($) => $.node.exec_status)}
                  placeholder={unset}
                  disabled={readOnly}
                  renderDisplay={(value) =>
                    value ? (
                      <ExecStatusChip status={value} />
                    ) : (
                      <span className="text-caption text-muted-foreground italic">{unset}</span>
                    )
                  }
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.contract)} className="min-w-0 @min-[28rem]/node-panel:col-span-2">
                <EditableText
                  value={node.contract}
                  onCommit={(contract) => onPatch({ contract })}
                  label={t(($) => $.node.contract)}
                  placeholder={unset}
                  disabled={readOnly}
                />
              </CockpitField>
            </div>

          </>
        )}

        {(taskDetails || payments.length > 0 || paymentPaging) && (
            <div className="mt-3">
              {paymentPaging}
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
                  {t(($) => $.node.payments)}
                </span>
                {payments.length > 0 && (
                  <span className="text-micro text-muted-foreground tabular-nums">
                    {t(($) => $.finance.payment_total, { total: formatAmount(paymentTotal) })}
                  </span>
                )}
                <span className="flex-1" />
                {paymentsEditable && (
                  <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5" onClick={onCreatePayment}>
                    <Plus className="size-3" />
                    {t(($) => $.node.add_payment)}
                  </Button>
                )}
              </div>
              {payments.length === 0 ? (
                <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.empty.no_payments)}</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {payments.map((payment) => (
                    <li key={payment.id} className="group/pay flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border p-2">
                      <EditableText
                        value={payment.label}
                        onCommit={(label) => onPatchPayment(payment.id, { label })}
                        label={t(($) => $.payment.label)}
                        placeholder={t(($) => $.payment.label)}
                        disabled={!paymentsEditable}
                        displayClassName="w-16 text-caption"
                      />
                      <EditableDate
                        value={payment.pay_date}
                        onCommit={(pay_date) => onPatchPayment(payment.id, { pay_date })}
                        label={t(($) => $.payment.date)}
                        placeholder={unset}
                        disabled={!paymentsEditable}
                      />
                      <EditableNumber
                        value={payment.amount}
                        onCommit={(amount) => onPatchPayment(payment.id, { amount: amount ?? 0 })}
                        label={t(($) => $.payment.amount)}
                        placeholder="0"
                        disabled={!paymentsEditable}
                      />
                      <span className="flex-1" />
                      {paymentsEditable && (
                        <button
                          type="button"
                          onClick={() => onDeletePayment(payment.id)}
                          aria-label={t(($) => $.payment.delete)}
                          className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity group-hover/pay:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

        )}

        {taskDetails && (
          <>
            <Separator className="my-4" />

            <div className="flex flex-col gap-3">
              <CockpitField label={t(($) => $.node.current_progress)}>
                <EditableTextArea
                  value={node.current_progress}
                  onCommit={(current_progress) => onPatch({ current_progress })}
                  label={t(($) => $.node.current_progress)}
                  placeholder={t(($) => $.node.current_progress_placeholder)}
                  disabled={readOnly}
                  rows={2}
                />
                <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.node.current_progress_hint)}</p>
              </CockpitField>
              <CockpitField label={t(($) => $.node.deliverable)}>
                <EditableTextArea
                  value={node.deliverable}
                  onCommit={(deliverable) => onPatch({ deliverable })}
                  label={t(($) => $.node.deliverable)}
                  placeholder={t(($) => $.node.deliverable_placeholder)}
                  disabled={readOnly}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.dependencies)}>
                <EditableTextArea
                  value={node.dependencies}
                  onCommit={(dependencies) => onPatch({ dependencies })}
                  label={t(($) => $.node.dependencies)}
                  placeholder={t(($) => $.node.dependencies_placeholder)}
                  disabled={readOnly}
                  rows={2}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.note)}>
                <EditableTextArea
                  value={node.note}
                  onCommit={(note) => onPatch({ note })}
                  label={t(($) => $.node.note)}
                  placeholder={t(($) => $.node.note_placeholder)}
                  disabled={readOnly}
                />
              </CockpitField>
            </div>

          </>
        )}

        {node.source && (
          <p className="mt-4 text-micro text-muted-foreground">
            {t(($) => $.node.source, { source: node.source })}
          </p>
        )}
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <footer className="shrink-0 border-t border-border px-4 py-3">
          <AlertDialog open={confirmOpen} onOpenChange={(open) => {
            if (deletingRef.current) return;
            setConfirmOpen(open);
            if (open) setDeleteFailed(false);
          }}>
            <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" />}>
              <Trash2 className="size-3.5" />
              {isBranch ? t(($) => $.panel.delete_branch) : t(($) => $.panel.delete_node)}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isBranch ? t(($) => $.panel.delete_branch) : t(($) => $.panel.delete_node)} · {node.name}
                </AlertDialogTitle>
                <AlertDialogDescription>{deleteConfirmationDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              {deleteRestriction}
              {deleteFailed && <p role="alert" className="text-caption text-destructive">{t(($) => $.errors.save_failed)}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>{common(($) => $.cancel)}</AlertDialogCancel>
                <Button variant="destructive" disabled={deleting || !deleteAllowed} aria-busy={deleting} onClick={confirmDelete}>
                  {deleting && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
                  {deleting ? common(($) => $.loading) : common(($) => $.delete)}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </footer>
      )}
    </aside>
  );
}
