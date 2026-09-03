"use client";

// The detail tables: every field of every row, in a grid, editable in place.
//
// The gantt answers "when", the overview answers "how are we doing". Neither
// answers "show me all the deliverables" or "show me the spend lines", which is
// what a programme review actually asks for. The board this replaces answered
// those on a separate maintenance screen that could not be read alongside the
// chart and drifted from it. Here they are the same rows, one source, edited
// where they are read.

import { useMemo, useState } from "react";
import type {
  CockpitBoard,
  CockpitIssueLink,
  CockpitNode,
  CockpitNodePatch,
} from "@multica/core/types";
import {
  buildCockpitTree,
  computeCockpitFinanceRows,
  flattenCockpitTree,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { EditableDate, EditableNumber, EditableSuggest, EditableText } from "./cockpit-fields";
import { ExecStatusChip, StatusChip } from "./cockpit-status";

/** Which grid is showing. Both read the same rows; they differ in the columns. */
export type CockpitTableMode = "tasks" | "finance";

export interface CockpitTableProps {
  board: CockpitBoard;
  mode: CockpitTableMode;
  query: string;
  /** Restrict to one root branch; null shows the whole board. */
  rootId: string | null;
  onSelect: (nodeId: string) => void;
  selectedId: string | null;
  onPatchNode: (nodeId: string, patch: CockpitNodePatch) => void;
  statusSuggestions: string[];
  execStatusSuggestions: string[];
  budgetCategorySuggestions: string[];
  ownerSuggestions: string[];
  readOnly?: boolean;
}

function matches(node: CockpitNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(needle) ||
    node.code.toLowerCase().includes(needle) ||
    node.owner.toLowerCase().includes(needle) ||
    node.vendor.toLowerCase().includes(needle) ||
    node.deliverable.toLowerCase().includes(needle)
  );
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 border-b border-border bg-background px-2 py-1.5 text-left text-caption font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-border/50 px-2 py-1 align-top", className)}>{children}</td>;
}

/** Read-only cell for a value the board derives rather than stores. */
function Derived({ value }: { value: string }) {
  return (
    <span className={cn("text-caption tabular-nums", !value && "text-faint-foreground")}>
      {value || "—"}
    </span>
  );
}

function IssueCell({ links }: { links: CockpitIssueLink[] }) {
  if (links.length === 0) return <span className="text-caption text-faint-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {links.map((link) => (
        <span
          key={link.id}
          title={link.issue_title}
          className="rounded-sm border border-border bg-muted px-1 font-mono text-micro text-muted-foreground"
        >
          {link.issue_identifier}
        </span>
      ))}
    </span>
  );
}

export function CockpitTable({
  board,
  mode,
  query,
  rootId,
  onSelect,
  selectedId,
  onPatchNode,
  statusSuggestions,
  execStatusSuggestions,
  budgetCategorySuggestions,
  ownerSuggestions,
  readOnly,
}: CockpitTableProps) {
  const { t } = useT("cockpit");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (!rootId) return tree;
    const found = flattenCockpitTree(tree).find((e) => e.node.id === rootId);
    return found ? [found] : tree;
  }, [tree, rootId]);

  const linksByNode = useMemo(() => groupIssueLinksByNode(board.issue_links), [board.issue_links]);
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);

  const taskRows = useMemo(
    () => flattenCockpitTree(scopedTree).filter((e) => matches(e.node, query)),
    [scopedTree, query],
  );
  const financeRows = useMemo(
    () =>
      computeCockpitFinanceRows(scopedTree, board.payments).filter((row) =>
        matches(row.node, query),
      ),
    [scopedTree, board.payments, query],
  );

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

  if (mode === "finance") {
    const totalBudget = financeRows.reduce((sum, row) => sum + row.budget, 0);
    const totalActual = financeRows.reduce((sum, row) => sum + (row.actualAmount ?? 0), 0);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="shrink-0 border-b border-border px-4 py-1.5 text-micro text-muted-foreground">
          {t(($) => $.table.finance_hint, {
            rows: financeRows.length,
            budget: formatAmount(totalBudget),
            actual: formatAmount(totalActual),
          })}
        </p>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-collapse">
            <thead>
              <tr>
                <Th>{t(($) => $.table.module)}</Th>
                <Th>{t(($) => $.node.code)}</Th>
                <Th>{t(($) => $.node.linked_issues)}</Th>
                <Th>{t(($) => $.table.item)}</Th>
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
              {financeRows.map((row) => {
                const node = row.node;
                return (
                  <tr
                    key={node.id}
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
                      <IssueCell links={linksByNode.get(node.id) ?? []} />
                    </Td>
                    <Td className="max-w-72">
                      <EditableText
                        value={node.name}
                        onCommit={(name) => onPatchNode(node.id, { name })}
                        label={t(($) => $.node.name)}
                        placeholder={t(($) => $.node.name_placeholder)}
                        disabled={readOnly}
                        displayClassName="text-caption"
                      />
                    </Td>
                    <Td className="max-w-64">
                      <EditableText
                        value={node.contract}
                        onCommit={(contract) => onPatchNode(node.id, { contract })}
                        label={t(($) => $.node.contract)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                        displayClassName="text-caption"
                      />
                    </Td>
                    {/* Both dates come from the instalment plan, so they are
                        shown, not typed: edit the instalments and these follow. */}
                    <Td>
                      <Derived value={row.plannedDate ?? ""} />
                    </Td>
                    <Td>
                      <Derived value={row.actualDate ?? ""} />
                    </Td>
                    <Td className="text-right">
                      <EditableNumber
                        value={node.budget_amount}
                        onCommit={(budget_amount) => onPatchNode(node.id, { budget_amount })}
                        label={t(($) => $.node.budget)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                        className="text-right"
                      />
                    </Td>
                    <Td className="text-right">
                      <Derived
                        value={row.actualAmount == null ? "" : formatAmount(row.actualAmount)}
                      />
                    </Td>
                    <Td>
                      <EditableSuggest
                        value={node.vendor}
                        onCommit={(vendor) => onPatchNode(node.id, { vendor })}
                        suggestions={ownerSuggestions}
                        label={t(($) => $.node.vendor)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                      />
                    </Td>
                    <Td>
                      <EditableSuggest
                        value={node.budget_category}
                        onCommit={(budget_category) => onPatchNode(node.id, { budget_category })}
                        suggestions={budgetCategorySuggestions}
                        label={t(($) => $.node.budget_category)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                      />
                    </Td>
                    <Td>
                      <EditableSuggest
                        value={node.exec_status}
                        onCommit={(exec_status) => onPatchNode(node.id, { exec_status })}
                        suggestions={execStatusSuggestions}
                        label={t(($) => $.node.exec_status)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                        renderDisplay={(value) =>
                          value ? (
                            <ExecStatusChip status={value} />
                          ) : (
                            <span className="text-caption text-muted-foreground">{emptyLabel}</span>
                          )
                        }
                      />
                    </Td>
                    <Td className="max-w-80">
                      <span className="text-caption text-muted-foreground">
                        {row.payments.length === 0
                          ? emptyLabel
                          : row.payments
                              .map(
                                (p) => `${p.label} ${p.pay_date ?? "—"}：${formatAmount(p.amount)}`,
                              )
                              .join("；")}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-border px-4 py-1.5 text-micro text-muted-foreground">
        {t(($) => $.table.tasks_hint, { rows: taskRows.length })}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse">
          <thead>
            <tr>
              <Th>{t(($) => $.node.code)}</Th>
              <Th>{t(($) => $.node.name)}</Th>
              <Th>{t(($) => $.node.owner)}</Th>
              <Th>{t(($) => $.node.collaborators)}</Th>
              <Th>{t(($) => $.node.deliverable)}</Th>
              <Th>{t(($) => $.node.current_progress)}</Th>
              <Th>{t(($) => $.node.start_date)}</Th>
              <Th>{t(($) => $.node.end_date)}</Th>
              <Th>{t(($) => $.node.status)}</Th>
              <Th className="text-right">{t(($) => $.node.progress)}</Th>
              <Th>{t(($) => $.node.dependencies)}</Th>
              <Th>{t(($) => $.node.linked_issues)}</Th>
              <Th>{t(($) => $.node.vendor)}</Th>
              <Th className="text-right">{t(($) => $.node.budget)}</Th>
              <Th>{t(($) => $.node.budget_category)}</Th>
              <Th>{t(($) => $.node.exec_status)}</Th>
              <Th>{t(($) => $.node.payments)}</Th>
              <Th>{t(($) => $.node.note)}</Th>
            </tr>
          </thead>
          <tbody>
            {taskRows.map((entry: CockpitTreeNode) => {
              const node = entry.node;
              const isBranch = entry.children.length > 0;
              const payments = paymentsByNode.get(node.id) ?? [];
              return (
                <tr
                  key={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  className={rowClass(node.id)}
                >
                  <Td>
                    <span
                      className="flex items-center gap-1 whitespace-nowrap"
                      style={{ paddingLeft: entry.depth * 10 }}
                    >
                      <span className="font-mono text-micro text-faint-foreground">
                        L{entry.depth + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelect(node.id)}
                        aria-label={t(($) => $.gantt.open_node, { code: node.code })}
                        className="rounded-sm px-1 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                        style={entry.color ? { color: entry.color } : undefined}
                      >
                        {node.code}
                      </button>
                    </span>
                  </Td>
                  <Td className="max-w-80">
                    <EditableText
                      value={node.name}
                      onCommit={(name) => onPatchNode(node.id, { name })}
                      label={t(($) => $.node.name)}
                      placeholder={t(($) => $.node.name_placeholder)}
                      disabled={readOnly}
                      displayClassName={cn("text-caption", isBranch && "font-medium")}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.owner}
                      onCommit={(owner) => onPatchNode(node.id, { owner })}
                      suggestions={ownerSuggestions}
                      label={t(($) => $.node.owner)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                    />
                  </Td>
                  <Td className="max-w-64">
                    <EditableText
                      value={node.collaborators}
                      onCommit={(collaborators) => onPatchNode(node.id, { collaborators })}
                      label={t(($) => $.node.collaborators)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                    />
                  </Td>
                  {/* The column the old board had no room for anywhere. */}
                  <Td className="max-w-96">
                    <EditableText
                      value={node.deliverable}
                      onCommit={(deliverable) => onPatchNode(node.id, { deliverable })}
                      label={t(($) => $.node.deliverable)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                    />
                  </Td>
                  <Td className="max-w-80">
                    <EditableText
                      value={node.current_progress}
                      onCommit={(current_progress) => onPatchNode(node.id, { current_progress })}
                      label={t(($) => $.node.current_progress)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                    />
                  </Td>
                  <Td>
                    <EditableDate
                      value={node.start_date}
                      onCommit={(start_date) => onPatchNode(node.id, { start_date })}
                      label={t(($) => $.node.start_date)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                    />
                  </Td>
                  <Td>
                    <EditableDate
                      value={node.end_date}
                      onCommit={(end_date) => onPatchNode(node.id, { end_date })}
                      label={t(($) => $.node.end_date)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.status}
                      onCommit={(status) => onPatchNode(node.id, { status })}
                      suggestions={statusSuggestions}
                      label={t(($) => $.node.status)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      renderDisplay={(value) => <StatusChip status={value} />}
                    />
                  </Td>
                  <Td className="text-right">
                    <EditableNumber
                      value={node.progress}
                      onCommit={(progress) => onPatchNode(node.id, { progress: progress ?? 0 })}
                      label={t(($) => $.node.progress)}
                      placeholder="0"
                      suffix="%"
                      min={0}
                      max={100}
                      disabled={readOnly || isBranch}
                      className="text-right"
                    />
                  </Td>
                  <Td className="max-w-64">
                    <EditableText
                      value={node.dependencies}
                      onCommit={(dependencies) => onPatchNode(node.id, { dependencies })}
                      label={t(($) => $.node.dependencies)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                    />
                  </Td>
                  <Td>
                    <IssueCell links={linksByNode.get(node.id) ?? []} />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.vendor}
                      onCommit={(vendor) => onPatchNode(node.id, { vendor })}
                      suggestions={ownerSuggestions}
                      label={t(($) => $.node.vendor)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                    />
                  </Td>
                  <Td className="text-right">
                    <EditableNumber
                      value={node.budget_amount}
                      onCommit={(budget_amount) => onPatchNode(node.id, { budget_amount })}
                      label={t(($) => $.node.budget)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      className="text-right"
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.budget_category}
                      onCommit={(budget_category) => onPatchNode(node.id, { budget_category })}
                      suggestions={budgetCategorySuggestions}
                      label={t(($) => $.node.budget_category)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                    />
                  </Td>
                  <Td>
                    <EditableSuggest
                      value={node.exec_status}
                      onCommit={(exec_status) => onPatchNode(node.id, { exec_status })}
                      suggestions={execStatusSuggestions}
                      label={t(($) => $.node.exec_status)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      renderDisplay={(value) =>
                        value ? (
                          <ExecStatusChip status={value} />
                        ) : (
                          <span className="text-caption text-muted-foreground">{emptyLabel}</span>
                        )
                      }
                    />
                  </Td>
                  <Td className="max-w-80">
                    <span
                      className={cn(
                        "text-caption",
                        payments.length === 0 ? "text-faint-foreground" : "text-muted-foreground",
                      )}
                    >
                      {payments.length === 0
                        ? emptyLabel
                        : payments
                            .map((p) => `${p.label} ${p.pay_date ?? "—"}：${formatAmount(p.amount)}`)
                            .join("；")}
                    </span>
                  </Td>
                  <Td className="max-w-96">
                    <EditableText
                      value={node.note}
                      onCommit={(note) => onPatchNode(node.id, { note })}
                      label={t(($) => $.node.note)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                    />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
