"use client";

// The detail tables: every field of every row, in a grid, editable in place.
//
// The gantt answers "when", the overview answers "how are we doing". Neither
// answers "show me all the deliverables" or "show me the spend lines", which is
// what a programme review actually asks for. The board this replaces answered
// those on a separate maintenance screen that could not be read alongside the
// chart and drifted from it. Here they are the same rows, one source, edited
// where they are read.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CockpitBoard,
  CockpitIssueLink,
  CockpitNode,
  CockpitNodePatch,
} from "@multica/core/types";
import {
  buildCockpitTree,
  buildCockpitDisplayCodes,
  cockpitMissingFields,
  computeCockpitFinanceRows,
  flattenCockpitTree,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  type CockpitCheckField,
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
  /** Restrict to these root branches; empty shows the whole board. */
  rootIds: Set<string>;
  onSelect: (nodeId: string) => void;
  selectedId: string | null;
  onPatchNode: (nodeId: string, patch: CockpitNodePatch) => void;
  statusSuggestions: string[];
  execStatusSuggestions: string[];
  budgetCategorySuggestions: string[];
  ownerSuggestions: string[];
  readOnly?: boolean;
}

function matches(node: CockpitNode, query: string, displayCode: string, links: CockpitIssueLink[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [displayCode, node.code, node.name, node.owner, node.collaborators,
    node.vendor, node.deliverable, node.dependencies, node.note, node.current_progress,
    node.start_date, node.end_date, node.status, node.progress, node.budget_amount,
    node.budget_category, node.exec_status, node.contract, node.source, ...links.flatMap((link) => [link.issue_identifier, link.issue_title])]
    .some((value) => value != null && String(value).toLowerCase().includes(needle));
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

/**
 * The prototype's field-integrity verdict: green "OK" when every core field
 * carries a value, amber "remind N" naming what is missing on hover.
 */
function CheckBadge({ missing, node, onSelect, linkCount }: { missing: CockpitCheckField[]; node: CockpitNode; onSelect: () => void; linkCount: number }) {
  const { t } = useT("cockpit");
  const suggested = (["collaborators", "vendor", "budget_category", "exec_status", "dependencies", "deliverable", "note", "current_progress"] as const)
    .filter((field) => !node[field].trim());
  const suggestedLabels = [
    ...suggested.map((field) => t(($) => $.node[field])),
    ...(node.budget_amount == null ? [t(($) => $.node.budget)] : []),
    ...(linkCount === 0 ? [t(($) => $.node.linked_issues)] : []),
  ];
  const title = [
    ...(missing.length ? [`${t(($) => $.table.core_missing, { count: missing.length })}: ${missing.map((field) => t(($) => $.node[field])).join(" / ")}`] : []),
    ...(suggestedLabels.length ? [`${t(($) => $.table.suggested_fields, { count: suggestedLabels.length })}: ${suggestedLabels.join(" / ")}`] : []),
  ].join("; ");
  if (missing.length === 0) {
    return (
      <button type="button" onClick={onSelect} title={title || undefined} className="whitespace-nowrap rounded-sm text-micro font-medium text-success">
        {t(($) => $.table.check_ok)}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title}
      className="inline-flex items-center whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-micro font-medium text-warning"
    >
      {t(($) => $.table.check_warn, { n: missing.length })}
    </button>
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
  rootIds,
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

  const tableRef = useRef<HTMLDivElement>(null);
  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const displayCodes = useMemo(() => buildCockpitDisplayCodes(tree), [tree]);
  const ancestors = useMemo(() => {
    const result = new Map<string, { root: CockpitTreeNode; parent: CockpitTreeNode | null }>();
    const walk = (entry: CockpitTreeNode, root: CockpitTreeNode, parent: CockpitTreeNode | null) => {
      result.set(entry.node.id, { root, parent });
      entry.children.forEach((child) => walk(child, root, entry));
    };
    tree.forEach((root) => walk(root, root, null));
    return result;
  }, [tree]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    return tree.filter((entry) => rootIds.has(entry.node.id));
  }, [tree, rootIds]);

  const linksByNode = useMemo(() => groupIssueLinksByNode(board.issue_links), [board.issue_links]);
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);

  const taskRows = useMemo(
    () => flattenCockpitTree(scopedTree).filter((e) => e.children.length === 0 && matches(e.node, query, displayCodes.get(e.node.id) ?? e.node.code, linksByNode.get(e.node.id) ?? [])),
    [scopedTree, query, displayCodes, linksByNode],
  );
  const financeRows = useMemo(
    () =>
      computeCockpitFinanceRows(scopedTree, board.payments).filter((row) =>
        matches(row.node, query, displayCodes.get(row.node.id) ?? row.node.code, linksByNode.get(row.node.id) ?? []),
      ),
    [scopedTree, board.payments, query, displayCodes, linksByNode],
  );

  const searchLabel = t(($) => $.toolbar.search);
  useEffect(() => {
    const locate = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing || !query.trim()) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.getAttribute("aria-label") !== searchLabel) return;
      const first = tableRef.current?.querySelector<HTMLTableRowElement>("tbody tr[data-node-id]");
      if (!first) return;
      event.preventDefault();
      first.scrollIntoView?.({ block: "center", behavior: "smooth" });
      onSelect(first.dataset.nodeId!);
    };
    document.addEventListener("keydown", locate);
    return () => document.removeEventListener("keydown", locate);
  }, [query, searchLabel, onSelect, mode]);

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
      <div ref={tableRef} className="flex min-h-0 flex-1 flex-col">
        <p role="status" className="shrink-0 border-b border-border px-4 py-1.5 text-micro text-muted-foreground">
          {t(($) => $.table.finance_hint, {
            rows: financeRows.length,
            budget: formatAmount(totalBudget),
            actual: formatAmount(totalActual),
          })}
          {query.trim() && <> · {t(($) => $.table.search_matches, { count: financeRows.length })}</>}
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
                        {displayCodes.get(ancestors.get(node.id)?.root.node.id ?? "") ?? row.rootCode}
                      </span>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => onSelect(node.id)}
                        aria-label={t(($) => $.gantt.open_node, { code: displayCodes.get(node.id) ?? node.code })}
                        className="rounded-sm px-1 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {displayCodes.get(node.id) ?? node.code}
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
    <div ref={tableRef} className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="shrink-0 border-b border-border px-4 py-1.5 text-micro text-muted-foreground">
        {query.trim() ? t(($) => $.table.search_matches, { count: taskRows.length }) : t(($) => $.table.tasks_hint, { rows: taskRows.length })}
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse">
          <thead>
            <tr>
              <Th className="left-0 z-30 w-[100px] min-w-[100px]">{t(($) => $.node.code)}</Th>
              <Th className="left-[100px] z-30 min-w-[260px]">{t(($) => $.node.name)}</Th>
              <Th>{"L1"}</Th>
              <Th>{"L2"}</Th>
              <Th>{t(($) => $.node.owner)}</Th>
              <Th>{t(($) => $.node.start_date)}</Th>
              <Th>{t(($) => $.node.end_date)}</Th>
              <Th>{t(($) => $.node.status)}</Th>
              <Th>{t(($) => $.node.progress)}</Th>
              <Th>{t(($) => $.table.check)}</Th>
              <Th>{t(($) => $.node.collaborators)}</Th>
              <Th>{t(($) => $.node.deliverable)}</Th>
              <Th>{t(($) => $.node.current_progress)}</Th>
              <Th>{t(($) => $.node.dependencies)}</Th>
              <Th>{t(($) => $.node.linked_issues)}</Th>
              <Th>{t(($) => $.node.vendor)}</Th>
              <Th>{t(($) => $.node.budget)}</Th>
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
                    data-node-id={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  className={rowClass(node.id)}
                >
                  <Td className={cn("sticky left-0 z-10 w-[100px] min-w-[100px] max-w-[100px]", selectedId === node.id ? "bg-accent" : hoveredId === node.id ? "bg-accent/50" : "bg-background")}>
                    <span
                      className="flex items-center gap-1 whitespace-nowrap"
                      title={node.code}
                    >
                      <span className="font-mono text-micro text-faint-foreground">
                        L{entry.depth + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => onSelect(node.id)}
                        aria-label={t(($) => $.gantt.open_node, { code: displayCodes.get(node.id) ?? node.code })}
                        className="rounded-sm px-1 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                        style={entry.color ? { color: entry.color } : undefined}
                      >
                        {displayCodes.get(node.id) ?? node.code}
                      </button>
                    </span>
                  </Td>
                  <Td className={cn("sticky left-[100px] z-10 w-[260px] min-w-[260px] max-w-[260px]", selectedId === node.id ? "bg-accent" : hoveredId === node.id ? "bg-accent/50" : "bg-background")}>
                    <EditableText
                      value={node.name}
                      onCommit={(name) => onPatchNode(node.id, { name })}
                      label={t(($) => $.node.name)}
                      placeholder={t(($) => $.node.name_placeholder)}
                      disabled={readOnly}
                      displayClassName={cn("text-caption", isBranch && "font-medium")}
                    />
                  </Td>
                  <Td><span className="text-caption" title={ancestors.get(node.id)?.root.node.name}>{displayCodes.get(ancestors.get(node.id)?.root.node.id ?? "") ?? "—"}</span></Td>
                  <Td className="max-w-48"><span className="text-caption" title={ancestors.get(node.id)?.parent?.node.name}>{ancestors.get(node.id)?.parent?.node.name ?? "—"}</span></Td>
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
                    <div role="progressbar" aria-label={t(($) => $.node.progress)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, node.progress))} className="mb-1 h-1 w-20 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, node.progress))}%` }} />
                    </div>
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
                  <Td><CheckBadge missing={cockpitMissingFields(node)} node={node} onSelect={() => onSelect(node.id)} linkCount={linksByNode.get(node.id)?.length ?? 0} /></Td>
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
