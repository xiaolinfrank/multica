"use client";

// The detail tables: every field of every row, in a grid, editable in place.
//
// The gantt answers "when", the overview answers "how are we doing". Neither
// answers "show me all the deliverables" or "show me the spend lines", which is
// what a programme review actually asks for. The board this replaces answered
// those on a separate maintenance screen that could not be read alongside the
// chart and drifted from it. Here they are the same rows, one source, edited
// where they are read.

import { useMemo, useRef, useState } from "react";
import { Plus, Trash2, Wallet } from "lucide-react";
import { CockpitViewHeading } from "./cockpit-view-heading";
import { useWorkspaceId } from "@multica/core/hooks";
import { useNavigation } from "../../navigation";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CockpitBoard,
  CockpitPlanTaskCount,
  CockpitNode,
  CockpitNodePatch,
} from "@multica/core/types";
import {
  cockpitScope, cockpitScopeViewKey,
  buildCockpitTree,
  cockpitPaymentTone,
  cockpitPaymentToneColor,
  computeCockpitFinanceLedger,
  splitCockpitVendors,
  useCreateCockpitPayment,
  useDeleteCockpitPayment,
  useUpdateCockpitPayment,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { EditableDate, EditableNumber, EditableSuggest, EditableText, EditableTokens } from "./cockpit-fields";
import { ExecStatusChip } from "./cockpit-status";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";

export interface CockpitTableProps {
  board: Pick<CockpitBoard, "nodes" | "payments">;
  contextNodeIds: ReadonlySet<string>;
  taskCounts: ReadonlyMap<string, CockpitPlanTaskCount>;
  query: string;
  /** Restrict to these root branches; empty shows the whole board. */
  rootIds: Set<string>;
  onSelect: (nodeId: string) => void;
  selectedId: string | null;
  onPatchNode: (nodeId: string, patch: CockpitNodePatch) => void;
  execStatusSuggestions: string[];
  budgetCategorySuggestions: string[];
  vendorSuggestions: string[];
  readOnly?: boolean;
}

function matches(node: CockpitNode, query: string, displayCode: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [displayCode, node.code, node.name, node.owner, node.collaborators,
    node.vendor, node.deliverable, node.dependencies, node.note, node.current_progress,
    node.start_date, node.end_date, node.status, node.progress, node.budget_amount,
    node.budget_category, node.exec_status, node.contract, node.source]
    .some((value) => value != null && String(value).toLowerCase().includes(needle));
}

export function formatAmount(value: number): string {
  // 万元 with up to 分 (6 decimals); trailing zeros would fake a precision
  // the number does not have.
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function Th({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <th
      scope="col"
      style={style}
      className={cn(
        "sticky top-0 z-10 border-b border-border bg-background px-2 py-1.5 text-left text-caption font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <td style={style} className={cn("border-b border-border/50 px-2 py-1 align-top", className)}>{children}</td>;
}

/** Read-only cell for a value the board derives rather than stores. */
function Derived({ value }: { value: string }) {
  return (
    <span className={cn("text-caption tabular-nums", !value && "text-faint-foreground")}>
      {value || "—"}
    </span>
  );
}

function IssueCell({ count, onOpen }: { count: CockpitPlanTaskCount | undefined; onOpen: () => void }) {
  const { t } = useT("cockpit");
  if (!count) return <span className="text-caption text-faint-foreground">—</span>;
  return <button type="button" onClick={onOpen} className="rounded text-caption text-primary hover:underline">
    {t(($) => $.plan_views.task_counts, { primary: count.primary_total, reference: count.reference_total })}
  </button>;
}

export function CockpitTable({
  board,
  contextNodeIds,
  taskCounts,
  query,
  rootIds,
  onSelect,
  selectedId,
  onPatchNode,
  execStatusSuggestions,
  budgetCategorySuggestions,
  vendorSuggestions,
  readOnly,
}: CockpitTableProps) {
  const { t } = useT("cockpit");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // An instalment is removed only after the dialog says which one: the grid
  // is dense and a stray click used to be the whole confirmation.
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [removeError, setRemoveError] = useState("");

  const tableRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsId = useWorkspaceId(); const navigation = useNavigation();
  const createPayment = useCreateCockpitPayment(wsId);
  const patchPayment = useUpdateCockpitPayment(wsId);
  const removePayment = useDeleteCockpitPayment(wsId);
  useCockpitScrollMemory(scrollRef, JSON.stringify([cockpitScopeViewKey(wsId, cockpitScope(navigation.searchParams)), "finance"]), board.nodes.length > 0, JSON.stringify([query, [...rootIds].sort()]));
  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    return tree.filter((entry) => rootIds.has(entry.node.id));
  }, [tree, rootIds]);

  // Every work item appears at least once (its instalment rows, or a single
  // row with no instalment yet) so its money fields are editable here rather
  // than in the node panel.
  const financeRows = useMemo(
    () =>
      computeCockpitFinanceLedger(scopedTree, board.payments, contextNodeIds).filter((row) =>
        matches(row.node, query, row.node.code),
      ),
    [scopedTree, board.payments, query, contextNodeIds],
  );

  const visibleCount = financeRows.length;
  // One row is one instalment (R0): a node with several would repeat its id
  // and the virtualizer would key two rows the same.
  const rowVirtualizer = useVirtualizer({ count: visibleCount, getScrollElement: () => scrollRef.current,
    estimateSize: () => 56, overscan: 6, scrollMargin: 36, initialRect: { width: 1200, height: 700 },
    getItemKey: (index) => {
      const row = financeRows[index]!;
      // One row per instalment; a work item without one still needs a stable
      // key of its own.
      return row.payment?.id ?? `node:${row.node.id}`;
    } });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const topSpace = Math.max(0, (virtualRows[0]?.start ?? 36) - 36);
  const bottomSpace = Math.max(0, rowVirtualizer.getTotalSize() - (virtualRows.at(-1)?.end ?? 36) + 36);

  const emptyLabel = t(($) => $.common.unset);

  const rowClass = (nodeId: string) =>
    cn(
      selectedId === nodeId
        ? "bg-accent font-medium shadow-[inset_2px_0_0_0_var(--color-brand)]"
        : hoveredId === nodeId && "bg-accent/50",
    );

  if (board.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12 text-body text-muted-foreground">
        {t(($) => $.empty.no_nodes)}
      </div>
    );
  }

  const totalBudget = [
    ...new Map(financeRows.map((row) => [row.node.id, row.budget])).values(),
  ].reduce((sum, budget) => sum + budget, 0);
  const totalActual = financeRows.reduce((sum, row) => sum + row.amount, 0);
  return (
    <div ref={tableRef} className="cockpit-ledger flex min-h-0 min-w-0 flex-1 flex-col">
      <CockpitViewHeading title={t(($) => $.plan_views.finance)} icon={Wallet} description={t(($) => $.finance.actual_basis)}>
        <span className="text-caption text-muted-foreground" role="status">{query.trim() ? t(($) => $.table.search_matches, { count: financeRows.length }) : t(($) => $.finance.line_count, { n: financeRows.length })}</span>
      </CockpitViewHeading>
      <dl className="cockpit-ledger-totals">
        <div><dt>{t(($) => $.finance.budget)}</dt><dd><span tabIndex={0} className="cockpit-finance-value">{formatAmount(totalBudget)}</span><span className="cockpit-currency-unit">{t(($) => $.finance.amount_unit)}</span></dd></div>
        <div><dt>{t(($) => $.finance.actual)}</dt><dd><span tabIndex={0} className="cockpit-finance-value">{formatAmount(totalActual)}</span><span className="cockpit-currency-unit">{t(($) => $.finance.amount_unit)}</span></dd></div>
      </dl>
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto">
        <table aria-rowcount={visibleCount + 1} className="w-max min-w-full border-collapse">
          <thead>
            <tr>
              <Th>{t(($) => $.table.module)}</Th>
              <Th>{t(($) => $.node.code)}</Th>
              <Th>{t(($) => $.node.linked_issues)}</Th>
              <Th>{t(($) => $.table.item)}</Th>
              <Th>{t(($) => $.node.payments)}</Th>
              <Th>{t(($) => $.node.contract)}</Th>
              <Th>{t(($) => $.table.planned_date)}</Th>
              <Th>{t(($) => $.table.actual_date)}</Th>
              <Th className="text-right">{t(($) => $.table.planned_amount)}</Th>
              <Th className="text-right">{t(($) => $.table.actual_amount)}</Th>
              <Th>{t(($) => $.node.vendor)}</Th>
              <Th>{t(($) => $.node.budget_category)}</Th>
              <Th>{t(($) => $.node.exec_status)}</Th>
              <Th>{t(($) => $.node.payments)}</Th>
            </tr>
          </thead>
          <tbody>
            {topSpace > 0 && <tr aria-hidden><td colSpan={13} style={{ height: topSpace, padding: 0 }} /></tr>}
            {virtualRows.map((virtual) => {
              const row = financeRows[virtual.index]!;
              const node = row.node;
              const payment = row.payment;
              // Money is a work item's: a structural row's legacy instalments
              // and figures are shown, never edited.
              const moneyEditable = row.editable && !readOnly && !contextNodeIds.has(node.id);
              return (
                <tr
                  key={payment?.id ?? `node:${node.id}`}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtual.index}
                  aria-rowindex={virtual.index + 2}
                  data-node-id={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  className={rowClass(node.id)}
                >
                  <Td>
                    <span className="flex items-center gap-1 text-caption whitespace-nowrap">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.rootColor || "var(--muted-foreground)" }}
                        aria-hidden
                      />
                      {row.rootCode}
                    </span>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => onSelect(node.id)}
                      aria-label={t(($) => $.gantt.open_node, { code: node.code })}
                      className="rounded-sm px-1 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {node.code}
                    </button>
                  </Td>
                  <Td>
                    <IssueCell count={taskCounts.get(node.id)} onOpen={() => onSelect(node.id)} />
                  </Td>
                  <Td className="max-w-72">
                    <EditableText
                      value={node.name}
                      onCommit={(name) => onPatchNode(node.id, { name })}
                      label={t(($) => $.node.name)}
                      placeholder={t(($) => $.node.name_placeholder)}
                      disabled={!moneyEditable}
                      displayClassName="line-clamp-2 text-caption"
                    />
                  </Td>
                  <Td>
                    {payment ? (
                      <EditableText
                        value={payment.label}
                        onCommit={(label) => patchPayment.mutate({ id: payment.id, patch: { label } })}
                        label={t(($) => $.payment.label)}
                        placeholder={t(($) => $.payment.label)}
                        disabled={!moneyEditable}
                        displayClassName="w-24 text-caption"
                      />
                    ) : <span className="text-caption text-faint-foreground">—</span>}
                  </Td>
                  <Td className="max-w-64">
                    <EditableText
                      value={node.contract}
                      onCommit={(contract) => onPatchNode(node.id, { contract })}
                      label={t(($) => $.node.contract)}
                      placeholder={emptyLabel}
                      disabled={!moneyEditable}
                      displayClassName="line-clamp-2 text-caption"
                    />
                  </Td>
                  {/* This instalment's date, not the task's first payment. */}
                  <Td>
                    {payment ? (
                      <EditableDate
                        value={payment.pay_date}
                        onCommit={(pay_date) => patchPayment.mutate({ id: payment.id, patch: { pay_date } })}
                        label={t(($) => $.payment.date)}
                        placeholder={emptyLabel}
                        disabled={!moneyEditable}
                      />
                    ) : <span className="text-caption text-faint-foreground">—</span>}
                  </Td>
                  <Td>
                    <Derived value={row.paid ? (payment?.pay_date ?? "") : ""} />
                  </Td>
                  <Td className="text-right">
                    <EditableNumber
                      value={node.budget_amount}
                      onCommit={(budget_amount) => onPatchNode(node.id, { budget_amount })}
                      label={t(($) => $.node.budget)}
                      placeholder={emptyLabel}
                      disabled={!moneyEditable}
                      className="text-right"
                    />
                  </Td>
                  <Td className="text-right">
                    {payment ? (
                      <EditableNumber
                        value={payment.amount}
                        onCommit={(amount) => patchPayment.mutate({ id: payment.id, patch: { amount: amount ?? 0 } })}
                        label={t(($) => $.payment.amount)}
                        placeholder="0"
                        disabled={!moneyEditable}
                        className="text-right"
                      />
                    ) : <span className="text-caption text-faint-foreground">—</span>}
                  </Td>
                  <Td>
                    <EditableTokens
                      value={node.vendor}
                      onCommit={(vendor) => onPatchNode(node.id, { vendor })}
                      split={splitCockpitVendors}
                      suggestions={vendorSuggestions}
                      label={t(($) => $.node.vendor)}
                      placeholder={emptyLabel}
                      disabled={!moneyEditable}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.budget_category}
                      onCommit={(budget_category) => onPatchNode(node.id, { budget_category })}
                      suggestions={budgetCategorySuggestions}
                      label={t(($) => $.node.budget_category)}
                      placeholder={emptyLabel}
                      disabled={!moneyEditable}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.exec_status}
                      onCommit={(exec_status) => onPatchNode(node.id, { exec_status })}
                      suggestions={execStatusSuggestions}
                      label={t(($) => $.node.exec_status)}
                      placeholder={emptyLabel}
                      disabled={!moneyEditable}
                      renderDisplay={(value) =>
                        value ? (
                          <ExecStatusChip status={value} />
                        ) : (
                          <span className="text-caption text-muted-foreground">{emptyLabel}</span>
                        )
                      }
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1 whitespace-nowrap">
                      <span
                        className="inline-flex whitespace-nowrap rounded-full border px-1.5 py-px text-micro font-medium"
                        style={{
                          color: cockpitPaymentToneColor(cockpitPaymentTone(node.exec_status)),
                          borderColor: "color-mix(in srgb, currentColor 35%, transparent)",
                          backgroundColor: "color-mix(in srgb, currentColor 8%, transparent)",
                        }}
                      >
                        {row.paid ? t(($) => $.finance.payment_paid) : t(($) => $.finance.payment_planned)}
                      </span>
                      {payment && moneyEditable ? (
                        <button type="button" aria-label={t(($) => $.payment.delete)}
                          onClick={() => { setRemoveError(""); setRemoving({ id: payment.id, label: payment.label }); }}
                          className="rounded-sm p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-40">
                          <Trash2 className="size-3" aria-hidden />
                        </button>
                      ) : payment ? null : moneyEditable ? (
                        <button type="button" disabled={createPayment.isPending} aria-label={t(($) => $.node.add_payment)}
                          onClick={() => createPayment.mutate({
                            nodeId: node.id,
                            body: { label: t(($) => $.payment.new_label, { index: (board.payments.filter((item) => item.node_id === node.id).length || 0) + 1 }), amount: 0, position: 0 },
                          })}
                          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                          <Plus className="size-3" aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
            {bottomSpace > 0 && <tr aria-hidden><td colSpan={13} style={{ height: bottomSpace, padding: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => { if (!open && !removePayment.isPending) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.payment.delete)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.confirmation.delete_description, { label: removing?.label ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && <p role="alert" className="text-caption text-destructive">{removeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removePayment.isPending}>{t(($) => $.binding.cancel)}</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={removePayment.isPending || !removing} onClick={() => {
              if (!removing) return;
              removePayment.mutate(removing.id, {
                onSuccess: () => setRemoving(null),
                onError: (error) => setRemoveError(error instanceof Error ? error.message : t(($) => $.errors.save_failed)),
              });
            }}>{t(($) => $.payment.delete)}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}