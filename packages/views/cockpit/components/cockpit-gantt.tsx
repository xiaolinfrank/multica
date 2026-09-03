"use client";

// The execution gantt: the work-breakdown tree on the left, the timeline on the
// right, and every field on both sides editable where it is shown.
//
// The board this replaces made this view read-only and sent corrections to a
// separate maintenance screen. Here the row you are reading is the row you fix.
//
// Bars paint by status, not by module. The question a gantt is scanned for is
// "what is on fire", and the module is already carried by the coloured code in
// the tree pane, so the bar itself is free to answer the other one.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CockpitBoard,
  CockpitIssueLink,
  CockpitNode,
  CockpitNodePatch,
  CockpitPayment,
} from "@multica/core/types";
import {
  COCKPIT_STATUS_LEGEND,
  axisMonths,
  buildCockpitTree,
  cockpitStatusColor,
  computeCockpitAxis,
  computeCockpitRollups,
  daysBetween,
  flattenCockpitTree,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  groupSubtreePayments,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
  parseDay,
  type CockpitPaymentGroup,
  type CockpitRollup,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useT } from "../../i18n";
import { EditableSuggest, EditableText, ProgressField } from "./cockpit-fields";
import { StatusChip } from "./cockpit-status";

/** Timeline density. Month is the year-at-a-glance read; week zooms in. */
export type CockpitZoom = "month" | "week";

const DAY_WIDTH: Record<CockpitZoom, number> = { month: 2.6, week: 9 };
const ROW_HEIGHT = 34;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Colours a branch's summary bar. Neutral on purpose: a roll-up has no status. */
const BRANCH_BAR_COLOR = "var(--muted-foreground)";

export interface CockpitGanttProps {
  board: CockpitBoard;
  today: string;
  zoom: CockpitZoom;
  query: string;
  /** Restrict to one root branch; null shows the whole board. */
  rootId: string | null;
  collapsed: Set<string>;
  onToggleCollapse: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
  selectedId: string | null;
  onPatchNode: (nodeId: string, patch: CockpitNodePatch) => void;
  statusSuggestions: string[];
  /** Show budget and instalment badges on every row. */
  showFinance: boolean;
  /** Bumped by the toolbar to scroll the timeline back to the today line. */
  scrollToTodayNonce: number;
  readOnly?: boolean;
}

function matches(node: CockpitNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(needle) ||
    node.code.toLowerCase().includes(needle) ||
    node.owner.toLowerCase().includes(needle) ||
    node.vendor.toLowerCase().includes(needle)
  );
}

/**
 * The rows to render: depth-first, minus collapsed subtrees. A search keeps a
 * row when it matches OR when a descendant does — hiding the parent of a hit
 * would leave the hit with no context to read it in.
 */
function visibleRows(
  tree: CockpitTreeNode[],
  collapsed: Set<string>,
  query: string,
): CockpitTreeNode[] {
  const keep = new Set<string>();
  if (query) {
    const walk = (entry: CockpitTreeNode, ancestors: string[]): boolean => {
      const path = [...ancestors, entry.node.id];
      const selfHit = matches(entry.node, query);
      let childHit = false;
      for (const child of entry.children) {
        if (walk(child, path)) childHit = true;
      }
      if (selfHit || childHit) {
        path.forEach((id) => keep.add(id));
        return true;
      }
      return false;
    };
    tree.forEach((entry) => walk(entry, []));
  }

  const rows: CockpitTreeNode[] = [];
  const walk = (entries: CockpitTreeNode[]) => {
    for (const entry of entries) {
      if (query && !keep.has(entry.node.id)) continue;
      rows.push(entry);
      // A search result is worth seeing even inside a branch someone collapsed.
      if (!collapsed.has(entry.node.id) || query) walk(entry.children);
    }
  };
  walk(tree);
  return rows;
}

/** Trims "李林（POOL 超饱和）" down to the name the row has space for. */
function shortOwner(owner: string): string {
  const name = owner.split("(")[0]!.split("（")[0]!.trim();
  return name || owner;
}

function countPeople(value: string): number {
  return value
    .split(/[、,，;；/]/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/** Board amounts carry the programme's own unit, so only the digits are formatted. */
function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Marks a row that has a deadline but no start date. */
const DEADLINE_GLYPH = "◇";

/** One instalment as a line of text: amount, what it buys, who from, where it stands. */
function paymentLine(payment: CockpitPayment, node: CockpitNode): string {
  return [
    `${payment.label} ${formatAmount(payment.amount)}`,
    node.name,
    node.vendor,
    node.exec_status,
  ]
    .filter(Boolean)
    .join("｜");
}

/** One instalment as a schedule line: which instalment, when, how much. */
function instalmentLine(payment: CockpitPayment): string {
  return `${payment.label} ${payment.pay_date ?? "—"}：${formatAmount(payment.amount)}`;
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <span className="text-caption">
      <span className="text-muted-foreground">{label}</span> {value}
    </span>
  );
}

function BarTooltipBody({
  node,
  rollup,
  payments,
  links,
}: {
  node: CockpitNode;
  rollup: CockpitRollup | undefined;
  payments: CockpitPayment[];
  links: CockpitIssueLink[];
}) {
  const { t } = useT("cockpit");
  const start = node.start_date ?? rollup?.start ?? null;
  const end = node.end_date ?? rollup?.end ?? null;
  return (
    <div className="flex max-w-80 flex-col gap-1">
      <span className="font-medium">
        {node.code} · {node.name}
      </span>
      {(start || end) && (
        <span className="text-caption tabular-nums">
          {start ?? "—"} → {end ?? "—"}
        </span>
      )}
      <TooltipRow label={t(($) => $.node.owner)} value={node.owner} />
      <TooltipRow label={t(($) => $.node.collaborators)} value={node.collaborators} />
      {/* The fields the board this replaces buried in a maintenance table.
          They are what a reviewer actually asks about, so they travel with the
          bar rather than waiting behind a click. */}
      <TooltipRow label={t(($) => $.node.deliverable)} value={node.deliverable} />
      <TooltipRow label={t(($) => $.node.current_progress)} value={node.current_progress} />
      <TooltipRow label={t(($) => $.node.dependencies)} value={node.dependencies} />
      <TooltipRow
        label={t(($) => $.node.linked_issues)}
        value={links.map((l) => l.issue_identifier).join(" ")}
      />
      <TooltipRow label={t(($) => $.node.vendor)} value={node.vendor} />
      <TooltipRow
        label={t(($) => $.node.budget)}
        value={node.budget_amount == null ? "" : formatAmount(node.budget_amount)}
      />
      <TooltipRow label={t(($) => $.node.budget_category)} value={node.budget_category} />
      <TooltipRow label={t(($) => $.node.exec_status)} value={node.exec_status} />
      <TooltipRow
        label={t(($) => $.node.payments)}
        value={payments.map(instalmentLine).join("；")}
      />
      <TooltipRow label={t(($) => $.node.contract)} value={node.contract} />
      <TooltipRow label={t(($) => $.node.note)} value={node.note} />
    </div>
  );
}

function PaymentMarker({
  group,
  left,
  onSelect,
}: {
  group: CockpitPaymentGroup;
  left: number;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onSelect(group.entries[0]!.node.id)}
            aria-label={t(($) => $.finance.payment_on, { date: group.date })}
            // A marker lands either on the bar or on the bare track, so it
            // carries its own disc of page background — gold on brand blue
            // alone is too close in lightness to find at a glance.
            className="absolute top-1/2 z-10 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-budget bg-background text-micro font-bold text-budget tabular-nums"
            style={{ left }}
          >
            {group.entries.length > 1 ? group.entries.length : "¥"}
          </button>
        }
      />
      <TooltipContent>
        <div className="flex max-w-80 flex-col gap-0.5">
          <span className="font-medium tabular-nums">
            {group.date} · {t(($) => $.finance.payment_count, { count: group.entries.length })} ·{" "}
            {t(($) => $.finance.payment_total, { total: formatAmount(group.total) })}
          </span>
          {group.entries.map(({ payment, node }) => (
            <span key={payment.id} className="text-caption">
              {paymentLine(payment, node)}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function CockpitGantt({
  board,
  today,
  zoom,
  query,
  rootId,
  collapsed,
  onToggleCollapse,
  onSelect,
  selectedId,
  onPatchNode,
  statusSuggestions,
  showFinance,
  scrollToTodayNonce,
  readOnly,
}: CockpitGanttProps) {
  const { t } = useT("cockpit");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (!rootId) return tree;
    const found = flattenCockpitTree(tree).find((e) => e.node.id === rootId);
    return found ? [found] : tree;
  }, [tree, rootId]);

  const rollups = useMemo(() => computeCockpitRollups(tree, today), [tree, today]);
  const rows = useMemo(
    () => visibleRows(scopedTree, collapsed, query),
    [scopedTree, collapsed, query],
  );
  const nodeById = useMemo(() => new Map(board.nodes.map((n) => [n.id, n])), [board.nodes]);
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);
  const linksByNode = useMemo(() => groupIssueLinksByNode(board.issue_links), [board.issue_links]);

  const scopedNodes = useMemo(
    () => flattenCockpitTree(scopedTree).map((e) => e.node),
    [scopedTree],
  );
  const axis = useMemo(() => computeCockpitAxis(scopedNodes, today), [scopedNodes, today]);
  const dayWidth = DAY_WIDTH[zoom];
  const timelineWidth = Math.max(axis.days * dayWidth, 320);
  const months = useMemo(() => axisMonths(axis), [axis]);
  const todayOffset = useMemo(() => {
    const date = parseDay(today);
    return date ? daysBetween(axis.start, date) * dayWidth : null;
  }, [today, axis.start, dayWidth]);

  /** Monday offsets, for the week ruler and its gridlines. */
  const weeks = useMemo(() => {
    if (zoom !== "week") return [];
    const out: { offset: number; label: string }[] = [];
    // getUTCDay() is 0 on Sunday; shift so Monday is the week start.
    const lead = (axis.start.getUTCDay() + 6) % 7;
    for (let offset = lead === 0 ? 0 : 7 - lead; offset < axis.days; offset += 7) {
      const date = new Date(axis.start.getTime() + offset * MS_PER_DAY);
      out.push({ offset, label: String(date.getUTCDate()) });
    }
    return out;
  }, [zoom, axis.start, axis.days]);

  /** Instalments a row is answerable for, bucketed by day. */
  const paymentGroups = useMemo(() => {
    const map = new Map<string, CockpitPaymentGroup[]>();
    for (const entry of rows) {
      // A collapsed branch speaks for the money underneath it; an expanded one
      // lets its children speak, so an instalment is drawn exactly once.
      const isLeaf = entry.children.length === 0;
      if (!isLeaf && !collapsed.has(entry.node.id)) continue;
      const groups = groupSubtreePayments(entry, paymentsByNode, nodeById);
      if (groups.length > 0) map.set(entry.node.id, groups);
    }
    return map;
  }, [rows, collapsed, paymentsByNode, nodeById]);

  const goalOffset = useMemo(() => {
    const date = parseDay(board.cockpit.goal_date);
    return date ? daysBetween(axis.start, date) * dayWidth : null;
  }, [board.cockpit.goal_date, axis.start, dayWidth]);

  const counts = useMemo(() => {
    let branches = 0;
    let leaves = 0;
    for (const entry of rows) {
      if (entry.children.length > 0) branches += 1;
      else leaves += 1;
    }
    return { branches, leaves };
  }, [rows]);

  // Scrolling is a viewport action, not board state, so it is driven by a
  // nonce from the toolbar rather than by a value the render depends on.
  useEffect(() => {
    if (scrollToTodayNonce === 0 || todayOffset === null) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(todayOffset - el.clientWidth / 3, 0), behavior: "smooth" });
  }, [scrollToTodayNonce, todayOffset]);

  if (board.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12 text-body text-muted-foreground">
        {t(($) => $.empty.no_nodes)}
      </div>
    );
  }

  const emptyLabel = t(($) => $.common.unset);
  const treeWidth = showFinance ? 800 : 680;
  const headerHeight = zoom === "week" ? 44 : 30;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Legend, provenance and row counts: what the chart is showing and what
          its colours mean, collapsible for anyone who already knows. */}
      <div className="shrink-0 border-b border-border px-4 py-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
          {navOpen &&
            COCKPIT_STATUS_LEGEND.map((item) => (
              <span key={item.status} className="flex items-center gap-1">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
                {item.status}
              </span>
            ))}
          {navOpen && (
            <>
              <span className="flex items-center gap-1">
                <span
                  className="h-1 w-3 rounded-full opacity-50"
                  style={{ backgroundColor: BRANCH_BAR_COLOR }}
                  aria-hidden
                />
                {t(($) => $.gantt.legend_rollup)}
              </span>
              <span className="flex items-center gap-1">
                <span className="text-info" aria-hidden>
                  {DEADLINE_GLYPH}
                </span>
                {t(($) => $.gantt.legend_end_only)}
              </span>
              <span className="flex items-center gap-1">
                <span className="font-bold text-budget" aria-hidden>
                  ¥
                </span>
                {t(($) => $.gantt.legend_payment)}
              </span>
              <span className="flex items-center gap-1">
                <span className="text-destructive" aria-hidden>
                  |
                </span>
                {t(($) => $.gantt.legend_today)}
              </span>
            </>
          )}
          <span className="flex-1" />
          <span className="tabular-nums">
            {t(($) => $.gantt.stats, {
              total: board.nodes.length,
              shown: rows.length,
              branches: counts.branches,
              leaves: counts.leaves,
              today,
            })}
          </span>
          <button
            type="button"
            onClick={() => setNavOpen((open) => !open)}
            className="rounded-sm px-1 hover:bg-accent hover:text-foreground"
          >
            {navOpen ? t(($) => $.gantt.hide_legend) : t(($) => $.gantt.show_legend)}
          </button>
        </div>
        {navOpen && board.cockpit.basis && (
          <p className="mt-1 text-micro text-faint-foreground">
            {t(($) => $.gantt.basis, { basis: board.cockpit.basis })}
          </p>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-max">
          {/* Tree pane. Sticky so the timeline scrolls under the names. */}
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-border bg-background"
            style={{ width: treeWidth }}
          >
            <div
              className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 text-caption font-medium text-muted-foreground"
              style={{ height: headerHeight }}
            >
              <span className="flex-1">{t(($) => $.gantt.column_task)}</span>
              {showFinance && (
                <span className="w-32 shrink-0 text-right">{t(($) => $.gantt.column_finance)}</span>
              )}
              <span className="w-16 shrink-0 text-right">{t(($) => $.gantt.column_owner)}</span>
              <span className="w-24 shrink-0 text-right">{t(($) => $.gantt.column_status)}</span>
              <span className="w-28 shrink-0 text-right">{t(($) => $.gantt.column_progress)}</span>
            </div>
            {rows.map((entry) => {
              const { node, depth, children } = entry;
              const rollup = rollups.get(node.id);
              const isBranch = children.length > 0;
              const isSelected = selectedId === node.id;
              const collaborators = countPeople(node.collaborators);
              const late = isCockpitNodeLate(node, today);
              const drifting = !late && isCockpitNodeDrifting(node, today);
              const budget = isBranch ? (rollup?.budget ?? 0) : (node.budget_amount ?? 0);
              const ownPayments = paymentsByNode.get(node.id) ?? [];
              return (
                <div
                  key={node.id}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  className={cn(
                    "flex items-center gap-2 border-b border-border/50 px-3",
                    // The selected row must stay identifiable while hovered, so
                    // selection speaks through weight and a left rule, not only
                    // through the background hover also paints.
                    isSelected
                      ? "bg-accent font-medium shadow-[inset_2px_0_0_0_var(--color-brand)]"
                      : hoveredId === node.id && "bg-accent/50",
                  )}
                  style={{ height: ROW_HEIGHT }}
                >
                  <div
                    className="flex min-w-0 flex-1 items-center gap-1"
                    style={{ paddingLeft: depth * 14 }}
                  >
                    {isBranch ? (
                      <button
                        type="button"
                        onClick={() => onToggleCollapse(node.id)}
                        aria-label={
                          collapsed.has(node.id)
                            ? t(($) => $.gantt.expand_branch, { name: node.name })
                            : t(($) => $.gantt.collapse_branch, { name: node.name })
                        }
                        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        {collapsed.has(node.id) ? (
                          <ChevronRight className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                      </button>
                    ) : (
                      <span className="w-[1.125rem] shrink-0" />
                    )}
                    <span className="shrink-0 font-mono text-micro text-faint-foreground">
                      L{depth + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSelect(node.id)}
                      aria-label={t(($) => $.gantt.open_node, { code: node.code })}
                      className="shrink-0 rounded-sm px-1 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                      style={entry.color ? { color: entry.color } : undefined}
                    >
                      {node.code}
                    </button>
                    <EditableText
                      value={node.name}
                      onCommit={(name) => onPatchNode(node.id, { name })}
                      label={t(($) => $.node.name)}
                      placeholder={t(($) => $.node.name_placeholder)}
                      disabled={readOnly}
                      displayClassName={cn("flex-1", isBranch && "font-medium")}
                    />
                    {/* A branch that never got broken down looks identical to a
                        finished one at a glance. It should not. */}
                    {isBranch && rollup?.leafCount === 0 && (
                      <span className="shrink-0 rounded-sm border border-dashed border-border px-1 text-micro text-faint-foreground">
                        {t(($) => $.gantt.not_decomposed)}
                      </span>
                    )}
                    {collaborators > 0 && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="shrink-0 rounded-sm border border-border bg-muted px-1 text-micro text-muted-foreground">
                              {t(($) => $.gantt.collaborator_count, { n: collaborators })}
                            </span>
                          }
                        />
                        <TooltipContent>{node.collaborators}</TooltipContent>
                      </Tooltip>
                    )}
                    {late && (
                      <span className="shrink-0 rounded-sm border border-destructive/30 bg-destructive/10 px-1 text-micro text-destructive">
                        {t(($) => $.gantt.overdue)}
                      </span>
                    )}
                    {drifting && (
                      <span className="shrink-0 rounded-sm border border-warning/30 bg-warning/10 px-1 text-micro text-warning">
                        {t(($) => $.gantt.should_have_started)}
                      </span>
                    )}
                  </div>

                  {showFinance && (
                    <div className="flex w-32 shrink-0 items-center justify-end gap-1">
                      {budget > 0 && (
                        <span className="rounded-sm border border-budget/30 bg-budget/10 px-1 text-micro font-medium text-budget tabular-nums">
                          {formatAmount(budget)}
                        </span>
                      )}
                      {ownPayments.length > 0 && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                onClick={() => onSelect(node.id)}
                                className="rounded-sm border border-success/30 bg-success/10 px-1 text-micro font-medium text-success hover:bg-success/20"
                              >
                                {t(($) => $.finance.payment_count, {
                                  count: ownPayments.length,
                                })}
                              </button>
                            }
                          />
                          <TooltipContent>
                            <div className="flex flex-col gap-0.5">
                              {ownPayments.map((p) => (
                                <span key={p.id} className="text-caption tabular-nums">
                                  {instalmentLine(p)}
                                </span>
                              ))}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {budget === 0 && ownPayments.length === 0 && (
                        <span className="text-micro text-faint-foreground">{emptyLabel}</span>
                      )}
                    </div>
                  )}

                  {/* The row shows the name; the full string, POOL and
                      saturation notes included, is what editing opens on. */}
                  <div className="flex w-16 shrink-0 justify-end overflow-hidden">
                    <EditableText
                      value={node.owner}
                      onCommit={(owner) => onPatchNode(node.id, { owner })}
                      label={t(($) => $.node.owner)}
                      placeholder={emptyLabel}
                      disabled={readOnly}
                      displayClassName="text-caption"
                      displayValue={shortOwner(node.owner)}
                    />
                  </div>

                  <div className="flex w-24 shrink-0 justify-end overflow-hidden">
                    {isBranch ? (
                      // A roll-up has no status of its own; what it has is a
                      // tally, and that is the more useful thing to show here.
                      <span className="text-caption text-muted-foreground tabular-nums">
                        {t(($) => $.gantt.done_of, {
                          done: rollup?.doneCount ?? 0,
                          total: rollup?.leafCount ?? 0,
                        })}
                      </span>
                    ) : (
                      <EditableSuggest
                        value={node.status}
                        onCommit={(status) => onPatchNode(node.id, { status })}
                        suggestions={statusSuggestions}
                        label={t(($) => $.node.status)}
                        placeholder={emptyLabel}
                        disabled={readOnly}
                        renderDisplay={(value) => <StatusChip status={value} />}
                      />
                    )}
                  </div>
                  <div className="flex w-28 shrink-0 justify-end">
                    <ProgressField
                      value={isBranch ? Math.round(rollup?.progress ?? node.progress) : node.progress}
                      onCommit={(progress) => onPatchNode(node.id, { progress })}
                      label={t(($) => $.node.progress)}
                      disabled={readOnly || isBranch}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Timeline pane. */}
          <div className="relative shrink-0" style={{ width: timelineWidth }}>
            <div
              className="sticky top-0 z-10 border-b border-border bg-background"
              style={{ height: headerHeight }}
            >
              <div className="relative flex h-[30px]">
                {months.map((month) => (
                  <div
                    key={month.key}
                    className="flex items-center justify-center border-l border-border/50 text-micro text-muted-foreground tabular-nums"
                    style={{ width: month.days * dayWidth }}
                  >
                    {month.days * dayWidth > 28 ? month.key.slice(2) : ""}
                  </div>
                ))}
              </div>
              {zoom === "week" && (
                <div className="relative h-3.5">
                  {weeks.map((week) => (
                    <span
                      key={week.offset}
                      className="absolute top-0 text-micro text-faint-foreground tabular-nums"
                      style={{ left: week.offset * dayWidth + 1 }}
                    >
                      {week.label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              {/* One gridline layer for the whole chart rather than one per
                  row: a year at week density is ~50 lines, and drawing them
                  per row would be tens of thousands of nodes. */}
              <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
                {(zoom === "week" ? weeks.map((w) => w.offset) : months.map((m) => m.offset)).map(
                  (offset) => (
                    <div
                      key={offset}
                      className="absolute top-0 bottom-0 border-l border-border/30"
                      style={{ left: offset * dayWidth }}
                    />
                  ),
                )}
              </div>

              {todayOffset !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-destructive"
                  style={{ left: todayOffset }}
                  aria-hidden
                />
              )}

              {/* The annual objective is not a task, so it is a line on the
                  timeline rather than a bar in the tree. */}
              {goalOffset !== null && (
                <>
                  <div
                    className="pointer-events-none absolute top-0 bottom-0 z-10 border-l-2 border-dashed border-budget/70"
                    style={{ left: goalOffset }}
                    aria-hidden
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className="absolute top-0.5 z-10 rounded-r-md bg-budget px-1.5 py-px text-micro font-semibold whitespace-nowrap text-background"
                          style={{ left: goalOffset }}
                        >
                          🎯 {board.cockpit.goal_date}
                        </span>
                      }
                    />
                    <TooltipContent>
                      {board.cockpit.goal_title || t(($) => $.overview.annual_goal)}
                    </TooltipContent>
                  </Tooltip>
                </>
              )}

              {rows.map((entry) => {
                const { node, children } = entry;
                const rollup = rollups.get(node.id);
                const isBranch = children.length > 0;
                const start = node.start_date ?? (isBranch ? (rollup?.start ?? null) : null);
                const end = node.end_date ?? (isBranch ? (rollup?.end ?? null) : null);
                const startDate = parseDay(start);
                const endDate = parseDay(end);
                const groups = paymentGroups.get(node.id) ?? [];
                const late = isCockpitNodeLate(node, today);
                const isSelected = selectedId === node.id;
                const barColor = isBranch ? BRANCH_BAR_COLOR : cockpitStatusColor(node.status);

                let left = 0;
                let width = 0;
                if (startDate && endDate) {
                  left = daysBetween(axis.start, startDate) * dayWidth;
                  width = Math.max((daysBetween(startDate, endDate) + 1) * dayWidth, 4);
                }

                return (
                  <div
                    key={node.id}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                    className={cn(
                      "relative border-b border-border/50",
                      isSelected ? "bg-accent" : hoveredId === node.id && "bg-accent/50",
                    )}
                    style={{ height: ROW_HEIGHT }}
                  >
                    {startDate && endDate && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => onSelect(node.id)}
                              aria-label={t(($) => $.gantt.bar_label, { code: node.code })}
                              className={cn(
                                "absolute top-1/2 overflow-hidden rounded-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                isBranch ? "h-2 -translate-y-1/2" : "h-4 -translate-y-1/2",
                              )}
                              style={{
                                left,
                                width,
                                backgroundColor: barColor,
                                opacity: isBranch ? 0.45 : 1,
                              }}
                            >
                              {/* The unfinished tail is veiled rather than the
                                  done head being filled, so the bar keeps one
                                  colour and progress reads as a waterline. The
                                  code is not repeated inside the bar: the tree
                                  pane is sticky, so it never scrolls away. */}
                              {!isBranch && node.progress < 100 && (
                                <span
                                  className="absolute inset-y-0 right-0 bg-background/70"
                                  style={{
                                    width: `${100 - Math.max(node.progress, 0)}%`,
                                  }}
                                  aria-hidden
                                />
                              )}
                            </button>
                          }
                        />
                        <TooltipContent>
                          <BarTooltipBody
                            node={node}
                            rollup={rollup}
                            payments={paymentsByNode.get(node.id) ?? []}
                            links={linksByNode.get(node.id) ?? []}
                          />
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* A deadline with no start is real information: it says
                        the work is committed but unscheduled. */}
                    {!startDate && endDate && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => onSelect(node.id)}
                              aria-label={t(($) => $.gantt.bar_label, { code: node.code })}
                              className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 text-info"
                              style={{ left: daysBetween(axis.start, endDate) * dayWidth - 6 }}
                            >
                              <span className="text-body leading-none font-black">{DEADLINE_GLYPH}</span>
                              <span className="text-micro whitespace-nowrap">{end!.slice(5)}</span>
                            </button>
                          }
                        />
                        <TooltipContent>
                          <BarTooltipBody
                            node={node}
                            rollup={rollup}
                            payments={paymentsByNode.get(node.id) ?? []}
                            links={linksByNode.get(node.id) ?? []}
                          />
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* An undated row is invisible on a timeline unless it says
                        so. Silence here reads as "nothing here", which is wrong. */}
                    {!startDate && !endDate && (
                      <span className="absolute top-1/2 left-1 -translate-y-1/2 rounded-sm border border-dashed border-border px-1.5 text-micro text-faint-foreground">
                        {t(($) => $.gantt.unscheduled)}
                      </span>
                    )}

                    {groups.map((group) => (
                      <PaymentMarker
                        key={`${node.id}-${group.date}`}
                        group={group}
                        left={daysBetween(axis.start, parseDay(group.date)!) * dayWidth}
                        onSelect={onSelect}
                      />
                    ))}

                    {late && startDate && endDate && (
                      <span
                        className="absolute top-1/2 ml-1 -translate-y-1/2 text-micro font-medium text-destructive"
                        style={{ left: left + width }}
                      >
                        {t(($) => $.gantt.overdue)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
