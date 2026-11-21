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
import { Wallet } from "lucide-react";
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
  computeCockpitFinanceRows,
  splitCockpitVendors,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { EditableNumber, EditableSuggest, EditableText, EditableTokens } from "./cockpit-fields";
import { ExecStatusChip } from "./cockpit-status";

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

  const tableRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsId = useWorkspaceId(); const navigation = useNavigation();
  useCockpitScrollMemory(scrollRef, JSON.stringify([cockpitScopeViewKey(wsId, cockpitScope(navigation.searchParams)), "finance"]), board.nodes.length > 0, JSON.stringify([query, [...rootIds].sort()]));
  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    return tree.filter((entry) => rootIds.has(entry.node.id));
  }, [tree, rootIds]);

  const financeRows = useMemo(
    () =>
      computeCockpitFinanceRows(scopedTree, board.payments, contextNodeIds).filter((row) =>
        matches(row.node, query, row.node.code),
      ),
    [scopedTree, board.payments, query, contextNodeIds],
  );

  const visibleCount = financeRows.length;
  // One row is one instalment (R0): a node with several would repeat its id
  // and the virtualizer would key two rows the same.
  const rowVirtualizer = useVirtualizer({ count: visibleCount, getScrollElement: () => scrollRef.current,
    estimateSize: () => 56, overscan: 6, scrollMargin: 36, initialRect: { width: 1200, height: 700 },
    getItemKey: (index) => financeRows[index]!.payment.id });
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
              return (
                <tr
                  key={row.payment.id}
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
                      disabled={readOnly || contextNodeIds.has(node.id)}
                      displayClassName="line-clamp-2 text-caption"
                    />
                  </Td>
                  <Td>
                    <Derived value={row.payment.label} />
                  </Td>
                  <Td className="max-w-64">
                    <EditableText
                      value={node.contract}
                      onCommit={(contract) => onPatchNode(node.id, { contract })}
                      label={t(($) => $.node.contract)}
                      placeholder={emptyLabel}
                      disabled={readOnly || contextNodeIds.has(node.id)}
                      displayClassName="line-clamp-2 text-caption"
                    />
                  </Td>
                  {/* This instalment's date, not the task's first payment. */}
                  <Td>
                    <Derived value={row.payment.pay_date ?? ""} />
                  </Td>
                  <Td>
                    <Derived value={row.paid ? (row.payment.pay_date ?? "") : ""} />
                  </Td>
                  <Td className="text-right">
                    <EditableNumber
                      value={node.budget_amount}
                      onCommit={(budget_amount) => onPatchNode(node.id, { budget_amount })}
                      label={t(($) => $.node.budget)}
                      placeholder={emptyLabel}
                      disabled={readOnly || contextNodeIds.has(node.id)}
                      className="text-right"
                    />
                  </Td>
                  <Td className="text-right">
                    <Derived
                      value={formatAmount(row.amount)}
                    />
                  </Td>
                  <Td>
                    <EditableTokens
                      value={node.vendor}
                      onCommit={(vendor) => onPatchNode(node.id, { vendor })}
                      split={splitCockpitVendors}
                      suggestions={vendorSuggestions}
                      label={t(($) => $.node.vendor)}
                      placeholder={emptyLabel}
                      disabled={readOnly || contextNodeIds.has(node.id)}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.budget_category}
                      onCommit={(budget_category) => onPatchNode(node.id, { budget_category })}
                      suggestions={budgetCategorySuggestions}
                      label={t(($) => $.node.budget_category)}
                      placeholder={emptyLabel}
                      disabled={readOnly || contextNodeIds.has(node.id)}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.exec_status}
                      onCommit={(exec_status) => onPatchNode(node.id, { exec_status })}
                      suggestions={execStatusSuggestions}
                      label={t(($) => $.node.exec_status)}
                      placeholder={emptyLabel}
                      disabled={readOnly || contextNodeIds.has(node.id)}
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
                  </Td>
                </tr>
              );
            })}
            {bottomSpace > 0 && <tr aria-hidden><td colSpan={13} style={{ height: bottomSpace, padding: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}