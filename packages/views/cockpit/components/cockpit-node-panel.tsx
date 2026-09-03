"use client";

// The node detail panel. Everything a work item carries, in one place, editable
// in place — including the fields the gantt row has no width for: deliverable,
// dependencies, vendor, budget category, instalments and the note.

import type {
  CockpitIssueLink,
  CockpitNode,
  CockpitNodePatch,
  CockpitPayment,
  CockpitPaymentPatch,
} from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Separator } from "@multica/ui/components/ui/separator";
import { Plus, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import {
  CockpitField,
  EditableDate,
  EditableNumber,
  EditableSuggest,
  EditableText,
  EditableTextArea,
  ProgressField,
} from "./cockpit-fields";
import { CockpitIssueLinks } from "./cockpit-issue-links";
import { ExecStatusChip, StatusChip } from "./cockpit-status";

export interface CockpitNodePanelProps {
  node: CockpitNode;
  parent: CockpitNode | undefined;
  payments: CockpitPayment[];
  links: CockpitIssueLink[];
  isBranch: boolean;
  statusSuggestions: string[];
  execStatusSuggestions: string[];
  budgetCategorySuggestions: string[];
  ownerSuggestions: string[];
  onPatch: (patch: CockpitNodePatch) => void;
  onDelete: () => void;
  onClose: () => void;
  onLinkIssue: (issueId: string) => void;
  onUnlinkIssue: (issueId: string) => void;
  onCreatePayment: () => void;
  onPatchPayment: (paymentId: string, patch: CockpitPaymentPatch) => void;
  onDeletePayment: (paymentId: string) => void;
  readOnly?: boolean;
}

export function CockpitNodePanel({
  node,
  parent,
  payments,
  links,
  isBranch,
  statusSuggestions,
  execStatusSuggestions,
  budgetCategorySuggestions,
  ownerSuggestions,
  onPatch,
  onDelete,
  onClose,
  onLinkIssue,
  onUnlinkIssue,
  onCreatePayment,
  onPatchPayment,
  onDeletePayment,
  readOnly,
}: CockpitNodePanelProps) {
  const { t } = useT("cockpit");
  const unset = t(($) => $.common.unset);
  const paymentTotal = payments.reduce((sum, p) => sum + p.amount, 0);

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-card">
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {parent && (
              <span className="truncate font-mono text-micro text-muted-foreground">
                {parent.code}
              </span>
            )}
            <EditableText
              value={node.code}
              onCommit={(code) => onPatch({ code })}
              label={t(($) => $.node.code)}
              placeholder={t(($) => $.node.code)}
              disabled={readOnly}
              displayClassName="font-mono text-micro"
            />
          </div>
          <div className="mt-1">
            <EditableText
              value={node.name}
              onCommit={(name) => onPatch({ name })}
              label={t(($) => $.node.name)}
              placeholder={t(($) => $.node.name_placeholder)}
              disabled={readOnly}
              displayClassName="text-title-sm font-semibold"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t(($) => $.panel.close)}
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-2 gap-3">
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
          <CockpitField label={t(($) => $.node.progress)} className="col-span-2">
            {/* A branch's progress is the weighted roll-up of its leaves, so
                editing it here would be overwritten by the next read. */}
            <ProgressField
              value={node.progress}
              onCommit={(progress) => onPatch({ progress })}
              label={t(($) => $.node.progress)}
              disabled={readOnly || isBranch}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.collaborators)} className="col-span-2">
            <EditableText
              value={node.collaborators}
              onCommit={(collaborators) => onPatch({ collaborators })}
              label={t(($) => $.node.collaborators)}
              placeholder={t(($) => $.node.collaborators_placeholder)}
              disabled={readOnly}
            />
          </CockpitField>
        </div>

        <Separator className="my-4" />

        <CockpitField label={t(($) => $.node.linked_issues)}>
          <CockpitIssueLinks
            links={links}
            onLink={onLinkIssue}
            onUnlink={onUnlinkIssue}
            disabled={readOnly}
          />
        </CockpitField>

        <Separator className="my-4" />

        <div className="grid grid-cols-2 gap-3">
          <CockpitField label={t(($) => $.node.vendor)}>
            <EditableText
              value={node.vendor}
              onCommit={(vendor) => onPatch({ vendor })}
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
          <CockpitField label={t(($) => $.node.contract)} className="col-span-2">
            <EditableText
              value={node.contract}
              onCommit={(contract) => onPatch({ contract })}
              label={t(($) => $.node.contract)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
        </div>

        <div className="mt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
              {t(($) => $.node.payments)}
            </span>
            {payments.length > 0 && (
              <span className="text-micro text-muted-foreground tabular-nums">
                {t(($) => $.finance.payment_total, { total: paymentTotal })}
              </span>
            )}
            <span className="flex-1" />
            {!readOnly && (
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
                <li key={payment.id} className="group/pay flex items-center gap-2">
                  <EditableText
                    value={payment.label}
                    onCommit={(label) => onPatchPayment(payment.id, { label })}
                    label={t(($) => $.payment.label)}
                    placeholder={t(($) => $.payment.label)}
                    disabled={readOnly}
                    displayClassName="w-16 text-caption"
                  />
                  <EditableDate
                    value={payment.pay_date}
                    onCommit={(pay_date) => onPatchPayment(payment.id, { pay_date })}
                    label={t(($) => $.payment.date)}
                    placeholder={unset}
                    disabled={readOnly}
                  />
                  <EditableNumber
                    value={payment.amount}
                    onCommit={(amount) => onPatchPayment(payment.id, { amount: amount ?? 0 })}
                    label={t(($) => $.payment.amount)}
                    placeholder="0"
                    disabled={readOnly}
                  />
                  <span className="flex-1" />
                  {!readOnly && (
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

        {node.source && (
          <p className="mt-4 text-micro text-muted-foreground">
            {t(($) => $.node.source, { source: node.source })}
          </p>
        )}
      </div>

      {!readOnly && (
        <footer className="border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-7 gap-1 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            {isBranch ? t(($) => $.panel.delete_branch) : t(($) => $.panel.delete_node)}
          </Button>
        </footer>
      )}
    </aside>
  );
}
