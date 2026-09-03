"use client";

// The execution gantt: the work-breakdown tree on the left, the timeline on the
// right, and every field on both sides editable where it is shown.
//
// The board this replaces made this view read-only and sent corrections to a
// separate maintenance screen. Here the row you are reading is the row you fix.

import { useMemo, useState } from "react";
import type {
  CockpitBoard,
  CockpitNode,
  CockpitNodePatch,
  CockpitPayment,
} from "@multica/core/types";
import {
  axisMonths,
  buildCockpitTree,
  computeCockpitAxis,
  computeCockpitRollups,
  daysBetween,
  flattenCockpitTree,
  groupPaymentsByNode,
  isCockpitNodeLate,
  parseDay,
  type CockpitRollup,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { ChevronDown, ChevronRight, CircleDollarSign } from "lucide-react";
import { useT } from "../../i18n";
import { EditableSuggest, EditableText, ProgressField } from "./cockpit-fields";
import { StatusChip } from "./cockpit-status";

/** Timeline density. Month is the year-at-a-glance read; week zooms in. */
export type CockpitZoom = "month" | "week";

const DAY_WIDTH: Record<CockpitZoom, number> = { month: 2.6, week: 9 };
const TREE_WIDTH = 600;
const ROW_HEIGHT = 34;

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

function BarTooltipBody({
  node,
  rollup,
  payments,
}: {
  node: CockpitNode;
  rollup: CockpitRollup | undefined;
  payments: CockpitPayment[];
}) {
  const { t } = useT("cockpit");
  const start = node.start_date ?? rollup?.start ?? null;
  const end = node.end_date ?? rollup?.end ?? null;
  return (
    <div className="flex max-w-72 flex-col gap-1">
      <span className="font-medium">
        {node.code} · {node.name}
      </span>
      {(start || end) && (
        <span className="text-caption tabular-nums">
          {start ?? "—"} → {end ?? "—"}
        </span>
      )}
      {node.owner && <span className="text-caption">{t(($) => $.node.owner)}: {node.owner}</span>}
      {payments.length > 0 && (
        <span className="text-caption">
          {t(($) => $.finance.payment_count, { count: payments.length })}
        </span>
      )}
    </div>
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
  readOnly,
}: CockpitGanttProps) {
  const { t } = useT("cockpit");
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);

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

  if (board.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12 text-body text-muted-foreground">
        {t(($) => $.empty.no_nodes)}
      </div>
    );
  }

  const emptyLabel = t(($) => $.common.unset);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex min-w-max">
        {/* Tree pane. Sticky so the timeline scrolls under the names. */}
        <div
          className="sticky left-0 z-20 shrink-0 border-r border-border bg-background"
          style={{ width: TREE_WIDTH }}
        >
          <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-border bg-background px-3 text-caption font-medium text-muted-foreground">
            <span className="flex-1">{t(($) => $.gantt.column_task)}</span>
            <span className="w-16 shrink-0 text-right">{t(($) => $.gantt.column_owner)}</span>
            <span className="w-24 shrink-0 text-right">{t(($) => $.gantt.column_status)}</span>
            <span className="w-28 shrink-0 text-right">{t(($) => $.gantt.column_progress)}</span>
          </div>
          {rows.map((entry) => {
            const { node, depth, children } = entry;
            const rollup = rollups.get(node.id);
            const isBranch = children.length > 0;
            const isSelected = selectedId === node.id;
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
                <div className="flex min-w-0 flex-1 items-center gap-1" style={{ paddingLeft: depth * 14 }}>
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
                </div>
                <div className="w-16 shrink-0 truncate text-right">
                  <EditableText
                    value={node.owner}
                    onCommit={(owner) => onPatchNode(node.id, { owner })}
                    label={t(($) => $.node.owner)}
                    placeholder={emptyLabel}
                    disabled={readOnly}
                    displayClassName="text-caption"
                  />
                </div>
                <div className="flex w-24 shrink-0 justify-end overflow-hidden">
                  <EditableSuggest
                    value={node.status}
                    onCommit={(status) => onPatchNode(node.id, { status })}
                    suggestions={statusSuggestions}
                    label={t(($) => $.node.status)}
                    placeholder={emptyLabel}
                    disabled={readOnly}
                    renderDisplay={(value) => <StatusChip status={value} />}
                  />
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
          <div className="sticky top-0 z-10 flex h-9 border-b border-border bg-background">
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

          {todayOffset !== null && (
            <div
              className="pointer-events-none absolute top-9 bottom-0 z-10 w-px bg-destructive"
              style={{ left: todayOffset }}
              aria-hidden
            />
          )}

          {rows.map((entry) => {
            const { node, children } = entry;
            const rollup = rollups.get(node.id);
            const isBranch = children.length > 0;
            const start = node.start_date ?? (isBranch ? rollup?.start ?? null : null);
            const end = node.end_date ?? (isBranch ? rollup?.end ?? null : null);
            const startDate = parseDay(start);
            const endDate = parseDay(end);
            const payments = paymentsByNode.get(node.id) ?? [];
            const late = isCockpitNodeLate(node, today);
            const isSelected = selectedId === node.id;

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
                {months.map((month) => (
                  <div
                    key={month.key}
                    className="absolute top-0 bottom-0 border-l border-border/30"
                    style={{ left: month.offset * dayWidth }}
                    aria-hidden
                  />
                ))}

                {startDate && endDate && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          onClick={() => onSelect(node.id)}
                          aria-label={t(($) => $.gantt.bar_label, { code: node.code })}
                          className={cn(
                            "absolute top-1/2 -translate-y-1/2 rounded-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                            isBranch ? "h-2" : "h-4",
                          )}
                          style={{
                            left,
                            width,
                            // A branch with no colour of its own and no
                            // coloured ancestor still needs a visible bar.
                            backgroundColor: entry.color || "var(--color-brand)",
                            opacity: isBranch ? 0.45 : 1,
                          }}
                        />
                      }
                    />
                    <TooltipContent>
                      <BarTooltipBody node={node} rollup={rollup} payments={payments} />
                    </TooltipContent>
                  </Tooltip>
                )}

                {/* Progress fill sits inside the bar, so "how far along" and
                    "how long" are read in the same shape. */}
                {startDate && endDate && !isBranch && node.progress > 0 && (
                  <div
                    className="pointer-events-none absolute top-1/2 h-4 -translate-y-1/2 rounded-sm bg-foreground/25"
                    style={{ left, width: (width * Math.min(node.progress, 100)) / 100 }}
                    aria-hidden
                  />
                )}

                {payments.map((payment) => {
                  const date = parseDay(payment.pay_date);
                  if (!date) return null;
                  return (
                    <Tooltip key={payment.id}>
                      <TooltipTrigger
                        render={
                          <span
                            // A marker lands either on the bar or on the bare
                            // track, so it carries its own disc of page
                            // background — gold on brand blue alone is too
                            // close in lightness to find at a glance.
                            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background text-budget"
                            style={{ left: daysBetween(axis.start, date) * dayWidth }}
                          >
                            <CircleDollarSign className="size-3" />
                          </span>
                        }
                      />
                      <TooltipContent>
                        {payment.label || t(($) => $.finance.payment)} · {payment.pay_date} ·{" "}
                        {payment.amount}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}

                {late && (
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
  );
}
