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
  buildCockpitDisplayCodes,
  buildCockpitTree,
  cockpitAggStatusColor,
  cockpitEffectiveProgress,
  cockpitGoalProgress,
  cockpitPaymentToneColor,
  cockpitStatusColor,
  computeCockpitAxis,
  computeCockpitRollups,
  daysBetween,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  groupSubtreePayments,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
  parseDay,
  type CockpitGoalProgress,
  type CockpitPaymentGroup,
  type CockpitRollup,
  type CockpitStatusLegendKey,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLocale, useT } from "../../i18n";
import { EditableSuggest, EditableText, ProgressField } from "./cockpit-fields";
import { StatusChip } from "./cockpit-status";

/** Timeline density. Month is the year-at-a-glance read; week zooms in. */
export type CockpitZoom = "month" | "week";

const DAY_WIDTH: Record<CockpitZoom, number> = { month: 3.5, week: 9 };
const ROW_HEIGHT = 32;
/** One indent step in the tree pane. */
const INDENT = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Shortest bar that still reads as a bar. */
const MIN_BAR_WIDTH = 3;
/**
 * Clearance an instalment's amount label needs before it collides with the
 * next marker. Below it the dot still draws — on its true date — and the
 * figure stays in the tooltip.
 */
const AMOUNT_LABEL_CLEARANCE = 78;

export interface CockpitGanttProps {
  board: CockpitBoard;
  today: string;
  zoom: CockpitZoom;
  query: string;
  /** Restrict to these root branches; empty shows the whole board. */
  rootIds: Set<string>;
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
  /** Locate-and-flash one row; the nonce re-triggers repeat clicks. */
  focusTarget: { nodeId: string; nonce: number } | null;
  readOnly?: boolean;
}

/** Tasks active in a calendar week, including end-only deadlines. */
export function cockpitWeekTasks(nodes: CockpitNode[], start: string, end: string): CockpitNode[] {
  return nodes.filter((node) => {
    const first = node.start_date ?? node.end_date;
    const last = node.end_date ?? node.start_date;
    return !!first && !!last && !!parseDay(first) && !!parseDay(last)
      && first <= last && first <= end && last >= start;
  });
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

/**
 * Which rows carry the payment markers.
 *
 * One row per module, always the same one: drawing an instalment on whichever
 * row happens to be collapsed right now moves it around as the reader expands
 * the tree, and drawing it on every ancestor draws it three times. The module
 * row is the level someone asks "when does this pay out" about.
 */
function carriesMarkers(entry: CockpitTreeNode): boolean {
  return entry.depth === 1 || (entry.depth === 0 && entry.children.length === 0);
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
  code,
  rollup,
  payments,
  links,
}: {
  node: CockpitNode;
  code: string;
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
        {code} · {node.name}
      </span>
      {code !== node.code && (
        <span className="text-caption text-muted-foreground">
          {t(($) => $.gantt.original_code, { code: node.code })}
        </span>
      )}
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
  showAmount,
  onSelect,
}: {
  group: CockpitPaymentGroup;
  left: number;
  showAmount: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  const color = cockpitPaymentToneColor(group.tone);
  const state = group.paid ? t(($) => $.finance.payment_paid) : t(($) => $.finance.payment_planned);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onSelect(group.entries[0]!.node.id)}
              aria-label={`${state} · ${t(($) => $.finance.payment_on, { date: group.date })}`}
              // A marker lands either on the bar or on the bare track, so it
              // carries its own disc of card background — a gold ring on brand
              // blue alone is too close in lightness to find at a glance.
              className="absolute top-1/2 z-10 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] bg-card text-micro leading-none font-bold"
              style={{ left, borderColor: color, color }}
            >
              ¥
            </button>
          }
        />
        <TooltipContent>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="font-medium tabular-nums">
              {group.month
                ? t(($) => $.finance.payment_month, {
                    month: group.month,
                    count: group.entries.length,
                    total: formatAmount(group.total),
                  })
                : `${state} · ${group.date} · ${t(($) => $.finance.payment_total, {
                    total: formatAmount(group.total),
                  })}`}
            </span>
            {group.entries.map(({ payment, node }) => (
              <span key={payment.id} className="text-caption">
                {paymentLine(payment, node)}
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
      {showAmount && (
        <span
          className="pointer-events-none absolute top-0 z-10 text-micro leading-[11px] font-bold whitespace-nowrap tabular-nums"
          style={{ left: left + 9, color }}
          aria-hidden
        >
          {formatAmount(group.total)}
        </span>
      )}
    </>
  );
}

/** Percent plus a 22px rail — the branch read that a number alone doesn't give. */
function MiniProgress({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-micro font-bold tabular-nums", className)}>
      {value}%
      <span className="h-1 w-[22px] overflow-hidden rounded-full bg-current/20">
        <span className="block h-full rounded-full bg-current" style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

/** How a module is tracking against the annual objective, as a clickable chip. */
function GoalChip({
  goal,
  goalDate,
  onOpen,
}: {
  goal: CockpitGoalProgress;
  goalDate: string;
  onOpen: () => void;
}) {
  const { t } = useT("cockpit");
  if (goal.actual == null) return null;
  const gap = goal.gapPts;
  const drift =
    gap == null
      ? t(($) => $.gantt.goal_on_track)
      : gap > 0
        ? t(($) => $.gantt.goal_behind, { pts: gap })
        : gap < 0
          ? t(($) => $.gantt.goal_ahead, { pts: -gap })
          : t(($) => $.gantt.goal_on_track);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1 py-px",
              goal.behind
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-success/30 bg-success/10 text-success",
            )}
          >
            <span aria-hidden>🎯</span>
            <MiniProgress value={goal.actual} />
          </button>
        }
      />
      <TooltipContent>
        <div className="flex max-w-80 flex-col gap-0.5">
          <span className="font-medium">{t(($) => $.gantt.goal_chip)}</span>
          <span className="text-caption">
            {t(($) => $.gantt.goal_actual, { pct: goal.actual })}
            {goal.scheduled != null && ` · ${t(($) => $.gantt.goal_scheduled, { pct: goal.scheduled })}`}
            {` · ${drift}`}
          </span>
          {goal.latestEnd && goal.planVsGoalDays != null && (
            <span className="text-caption">
              {goal.planVsGoalDays > 0
                ? t(($) => $.gantt.goal_late_days, {
                    date: goal.latestEnd,
                    days: goal.planVsGoalDays,
                  })
                : t(($) => $.gantt.goal_early_days, {
                    date: goal.latestEnd,
                    days: -goal.planVsGoalDays,
                  })}
            </span>
          )}
          {goal.crossYearCount > 0 && (
            <span className="text-caption">
              {t(($) => $.gantt.goal_cross_year, { count: goal.crossYearCount })}
            </span>
          )}
          <span className="text-caption text-muted-foreground">
            {t(($) => $.gantt.goal_basis, { date: goalDate, n: goal.taskCount })}
          </span>
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
  rootIds,
  collapsed,
  onToggleCollapse,
  onSelect,
  selectedId,
  onPatchNode,
  statusSuggestions,
  showFinance,
  scrollToTodayNonce,
  focusTarget,
  readOnly,
}: CockpitGanttProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    const picked = tree.filter((entry) => rootIds.has(entry.node.id));
    return picked.length > 0 ? picked : tree;
  }, [tree, rootIds]);

  // Row codes are addresses, so they are built once over the whole tree: a
  // filtered or searched view must not renumber the rows under the reader.
  const displayCodes = useMemo(() => buildCockpitDisplayCodes(tree), [tree]);
  const rollups = useMemo(() => computeCockpitRollups(tree, today), [tree, today]);
  const rows = useMemo(
    () => visibleRows(scopedTree, collapsed, query),
    [scopedTree, collapsed, query],
  );
  const nodeById = useMemo(() => new Map(board.nodes.map((n) => [n.id, n])), [board.nodes]);
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);
  const linksByNode = useMemo(() => groupIssueLinksByNode(board.issue_links), [board.issue_links]);

  // The axis spans the whole board, never just the filtered modules: rescaling
  // the timeline when someone narrows the scope makes every bar jump, and the
  // question a filter asks is "which rows", not "which dates".
  const axis = useMemo(
    () => computeCockpitAxis(board.nodes, today, { zoom }),
    [board.nodes, today, zoom],
  );
  const dayWidth = DAY_WIDTH[zoom];
  const timelineWidth = Math.max(axis.days * dayWidth, 320);
  const months = useMemo(() => axisMonths(axis), [axis]);
  const todayOffset = useMemo(() => {
    const date = parseDay(today);
    return date ? daysBetween(axis.start, date) * dayWidth : null;
  }, [today, axis.start, dayWidth]);

  const monthLabel = useMemo(() => {
    const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
    const yearFormat = new Intl.DateTimeFormat(locale, { year: "numeric", timeZone: "UTC" });
    return (key: string) => {
      const [year, month] = key.split("-").map(Number);
      const date = new Date(Date.UTC(year ?? 2000, (month ?? 1) - 1, 1));
      // January carries the year instead of the month: on a three-year axis
      // "Jan" twice over is the one label that needs saying which Jan.
      return month === 1 ? yearFormat.format(date) : monthFormat.format(date);
    };
  }, [locale]);

  /** Monday offsets, for the week ruler and its gridlines. */
  const weeks = useMemo(() => {
    if (zoom !== "week") return [];
    const out: { offset: number; label: string }[] = [];
    // getUTCDay() is 0 on Sunday; shift so Monday is the week start.
    const lead = (axis.start.getUTCDay() + 6) % 7;
    for (let offset = lead === 0 ? 0 : 7 - lead; offset < axis.days; offset += 7) {
      const date = new Date(axis.start.getTime() + offset * MS_PER_DAY);
      out.push({ offset, label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}` });
    }
    return out;
  }, [zoom, axis.start, axis.days]);

  const weekTasks = useMemo(
    () => visibleRows(scopedTree, new Set(), query)
      .filter((entry) => entry.children.length === 0)
      .map((entry) => entry.node),
    [scopedTree, query],
  );

  /** Instalments a module row is answerable for. */
  const paymentGroups = useMemo(() => {
    const map = new Map<string, CockpitPaymentGroup[]>();
    for (const entry of rows) {
      if (!carriesMarkers(entry)) continue;
      const groups = groupSubtreePayments(entry, paymentsByNode, nodeById);
      if (groups.length > 0) map.set(entry.node.id, groups);
    }
    return map;
  }, [rows, paymentsByNode, nodeById]);

  const goalDate = board.cockpit.goal_date;
  const goalProgress = useMemo(() => {
    const map = new Map<string, CockpitGoalProgress>();
    if (!goalDate) return map;
    for (const entry of tree) map.set(entry.node.id, cockpitGoalProgress(entry, today, goalDate));
    return map;
  }, [tree, today, goalDate]);

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

  const treeWidth = showFinance ? 800 : 680;

  // Scrolling is a viewport action, not board state, so it is driven by a
  // nonce from the toolbar rather than by a value the render depends on.
  useEffect(() => {
    if (scrollToTodayNonce === 0 || todayOffset === null) return;
    const el = scrollRef.current;
    if (!el) return;
    // The tree pane is sticky and covers the left of the viewport, so the
    // today line is centred in what is left of it, not in the whole element.
    const centre = Math.max(todayOffset - (el.clientWidth - treeWidth) / 2, 0);
    el.scrollTo({ left: centre, behavior: "smooth" });
  }, [scrollToTodayNonce, todayOffset, treeWidth]);

  // A digest-card task click lands here: locate the row, scroll it into the
  // middle and flash it, the way the prototype's grid did.
  useEffect(() => {
    if (!focusTarget) return;
    const el = scrollRef.current?.querySelector(
      `[data-cockpit-node="${focusTarget.nodeId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("cockpit-flash");
    const timer = window.setTimeout(() => el.classList.remove("cockpit-flash"), 2600);
    return () => window.clearTimeout(timer);
  }, [focusTarget]);

  if (board.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12 text-body text-muted-foreground">
        {t(($) => $.empty.no_nodes)}
      </div>
    );
  }

  const emptyLabel = t(($) => $.common.unset);
  const monthBandHeight = zoom === "week" ? 22 : 36;
  const headerHeight = zoom === "week" ? 52 : 36;
  const legendLabel = (key: CockpitStatusLegendKey) => t(($) => $.gantt.legend_status[key]);

  return (
    <div data-cockpit-gantt data-summary-width={zoom === "month" && rows.every((entry) => entry.children.length > 0) ? treeWidth + Math.max(0, daysBetween(axis.start, new Date(Date.UTC(Number(today.slice(0, 4)) + 1, 0, 1)))) * dayWidth : undefined} className="flex min-h-0 flex-1 flex-col">
      {/* Legend, provenance and row counts: what the chart is showing and what
          its colours mean, collapsible for anyone who already knows. */}
      <div className="shrink-0 border-b border-border px-4 py-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted-foreground">
          {navOpen &&
            COCKPIT_STATUS_LEGEND.map((item) => (
              <span key={item.key} className="flex items-center gap-1">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden
                />
                {legendLabel(item.key)}
              </span>
            ))}
          {navOpen && (
            <>
              <span className="flex items-center gap-1">
                <span
                  className="cockpit-rollup-bar h-1.5 w-3 rounded-full opacity-[0.78]"
                  style={{ backgroundColor: "var(--color-brand)" }}
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
                <span className="font-bold text-success" aria-hidden>
                  ¥
                </span>
                {t(($) => $.finance.payment_paid)}
              </span>
              <span className="flex items-center gap-1">
                <span className="font-bold text-brand" aria-hidden>
                  ¥
                </span>
                {t(($) => $.finance.payment_planned)}
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

      <div ref={scrollRef} data-cockpit-scroll className="min-h-0 flex-1 overflow-auto">
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
              const code = displayCodes.get(node.id) ?? node.code;
              const goal = depth === 0 ? goalProgress.get(node.id) : undefined;
              return (
                <div
                  key={node.id}
                  data-cockpit-node={node.id}
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
                    style={{ paddingLeft: depth * INDENT }}
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
                    {/* The row code is the address people quote in meetings.
                        It already says which level the row is on, so no
                        separate depth chip sits beside it. */}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => onSelect(node.id)}
                            aria-label={t(($) => $.gantt.open_node, { code })}
                            className="shrink-0 rounded-sm px-1 font-mono text-micro text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
                            style={entry.color ? { color: entry.color } : undefined}
                          >
                            {code}
                          </button>
                        }
                      />
                      <TooltipContent>
                        {t(($) => $.gantt.original_code, { code: node.code })}
                      </TooltipContent>
                    </Tooltip>
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
                    {/* Amber for a deadline already missed, red for one about
                        to be: the row that has not started yet is the one
                        still worth acting on. */}
                    {late && (
                      <span className="shrink-0 rounded-sm border border-warning/30 bg-warning/10 px-1 text-micro text-warning">
                        {t(($) => $.gantt.overdue)}
                      </span>
                    )}
                    {drifting && (
                      <span className="shrink-0 rounded-sm border border-destructive/30 bg-destructive/10 px-1 text-micro text-destructive">
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
                    {goal && goalDate ? (
                      <GoalChip goal={goal} goalDate={goalDate} onOpen={() => onSelect(node.id)} />
                    ) : isBranch ? (
                      // A branch's percentage is derived, so it is a read-out
                      // rather than a field: editing it would write a number
                      // the next roll-up overwrites.
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <MiniProgress
                              value={Math.round(rollup?.progress ?? node.progress)}
                              className="text-muted-foreground"
                            />
                          }
                        />
                        <TooltipContent>
                          {t(($) => $.gantt.subtree_progress_hint, {
                            n: rollup?.leafCount ?? 0,
                            done: rollup?.doneCount ?? 0,
                            total: rollup?.leafCount ?? 0,
                          })}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <ProgressField
                        value={node.progress}
                        onCommit={(progress) => onPatchNode(node.id, { progress })}
                        label={t(($) => $.node.progress)}
                        disabled={readOnly}
                      />
                    )}
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
              <div className="relative flex" style={{ height: monthBandHeight }}>
                {months.map((month) => {
                  const isJanuary = month.key.endsWith("-01");
                  return (
                    <div
                      key={month.key}
                      className={cn(
                        "flex items-center text-micro tabular-nums",
                        zoom === "week"
                          ? "justify-start border-b border-border/50 pl-1 font-semibold text-foreground"
                          : "justify-center text-muted-foreground",
                        // A year boundary is a stronger line than a month one.
                        isJanuary && month.offset > 0
                          ? "border-l border-border"
                          : "border-l border-border/50",
                        isJanuary && "font-semibold text-foreground",
                      )}
                      style={{ width: month.days * dayWidth }}
                    >
                      {month.days * dayWidth > 28 ? monthLabel(month.key) : ""}
                    </div>
                  );
                })}
              </div>
              {zoom === "week" && (
                <div className="relative flex h-[30px]">
                  {weeks.map((week) => {
                    const start = new Date(axis.start.getTime() + week.offset * MS_PER_DAY)
                      .toISOString().slice(0, 10);
                    const end = new Date(axis.start.getTime() + (week.offset + 6) * MS_PER_DAY)
                      .toISOString().slice(0, 10);
                    const tasks = cockpitWeekTasks(weekTasks, start, end);
                    const weeklyPayments = board.payments.filter((payment) => payment.pay_date && payment.pay_date >= start && payment.pay_date <= end && visibleRows(scopedTree, new Set(), query).some((entry) => entry.node.id === payment.node_id));
                    const title = `${t(($) => $.toolbar.zoom_week)} · ${start} – ${end}`;
                    return (
                      <Dialog key={week.offset}>
                        <Tooltip>
                          <TooltipTrigger render={
                            <DialogTrigger render={
                              <Button variant="ghost" size="sm"
                                className="absolute top-0 h-full rounded-none border-l border-border/50 p-0 text-micro text-muted-foreground tabular-nums"
                                aria-label={title}
                                style={{ left: week.offset * dayWidth,
                                  width: Math.min(7, axis.days - week.offset) * dayWidth }}>
                                {week.label}
                              </Button>
                            } />
                          } />
                          <TooltipContent>
                            <div>{title}</div>
                            <div>{t(($) => $.overview.tasks)}: {tasks.length}</div>
                            {tasks.slice(0, 5).map((node) => <div key={node.id}>{node.name}</div>)}
                          </TooltipContent>
                        </Tooltip>
                        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
                          <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
                          {tasks.length === 0 ? <p className="text-body text-muted-foreground">{t(($) => $.empty.no_nodes)}</p> : (
                            <table className="w-full text-caption">
                              <thead><tr className="text-left text-muted-foreground">
                                <th>{t(($) => $.gantt.column_task)}</th>
                                <th>{t(($) => $.node.end_date)}</th>
                                <th>{t(($) => $.node.status)}</th>
                              </tr></thead>
                              <tbody>{tasks.map((node) => (
                                <tr key={node.id} className="border-t border-border">
                                  <td className="py-2 pr-2"><DialogClose render={<Button variant="link" size="sm" className="h-auto whitespace-normal text-left" onClick={() => onSelect(node.id)} />}>
                                    {displayCodes.get(node.id) ?? node.code} {node.name}
                                  </DialogClose>
                                    <div>{t(($) => $.node.progress)}: {cockpitEffectiveProgress(node)}%</div>
                                    <div>{t(($) => $.node.current_progress)}: {node.current_progress || emptyLabel}</div>
                                    <div>{t(($) => $.node.deliverable)}: {node.deliverable || emptyLabel}</div>
                                    <div>{t(($) => $.node.linked_issues)}: {(linksByNode.get(node.id) ?? []).map((link) => `${link.issue_identifier} ${link.issue_title} (${link.issue_status})`).join(" · ") || emptyLabel}</div>
                                  </td>
                                  <td className="whitespace-nowrap pr-2">{node.end_date ?? emptyLabel}</td>
                                  <td><StatusChip status={node.status} /></td>
                                </tr>
                              ))}</tbody>
                            </table>
                          )}
                          <section aria-label={t(($) => $.node.payments)}>
                            <h3 className="mt-4 font-medium">{t(($) => $.node.payments)}</h3>
                            {weeklyPayments.map((payment) => <div key={payment.id} className="py-2 text-caption">
                              <DialogClose render={<Button variant="link" size="sm" onClick={() => onSelect(payment.node_id)} />}>
                                {nodeById.get(payment.node_id)?.name} · {payment.label}
                              </DialogClose>
                              <div>{payment.pay_date} · {formatAmount(payment.amount)}</div>
                              {nodeById.get(payment.node_id)?.contract && <div>{t(($) => $.node.contract)}: {nodeById.get(payment.node_id)?.contract}</div>}
                              {nodeById.get(payment.node_id)?.exec_status && <div>{nodeById.get(payment.node_id)?.exec_status}</div>}
                            </div>)}
                            {weeklyPayments.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.empty.no_payments)}</p>}
                          </section>
                        </DialogContent>
                      </Dialog>
                    );
                  })}
                </div>
              )}
              {todayOffset !== null && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="absolute top-0 bottom-0 z-10 w-0.5 bg-destructive opacity-70"
                        style={{ left: todayOffset }}
                        aria-label={t(($) => $.gantt.today_line, { date: today })}
                      />
                    }
                  />
                  <TooltipContent>{t(($) => $.gantt.today_line, { date: today })}</TooltipContent>
                </Tooltip>
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
                  className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-destructive opacity-70"
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
                const code = displayCodes.get(node.id) ?? node.code;
                const start = node.start_date ?? (isBranch ? (rollup?.start ?? null) : null);
                const end = node.end_date ?? (isBranch ? (rollup?.end ?? null) : null);
                const startDate = parseDay(start);
                const endDate = parseDay(end);
                const groups = paymentGroups.get(node.id) ?? [];
                const isSelected = selectedId === node.id;
                const barColor = isBranch
                  ? cockpitAggStatusColor(entry)
                  : cockpitStatusColor(node.status);
                const progress = isBranch
                  ? Math.round(rollup?.progress ?? node.progress)
                  : cockpitEffectiveProgress(node);

                // Clamped to the axis on both edges: a bar that starts before
                // the canvas would otherwise draw at a negative offset and a
                // bar that ends after it would stretch the scroll width.
                let left = 0;
                let width = 0;
                if (startDate && endDate) {
                  const rawLeft = daysBetween(axis.start, startDate) * dayWidth;
                  const rawRight = rawLeft + (daysBetween(startDate, endDate) + 1) * dayWidth;
                  left = Math.max(0, Math.min(rawLeft, timelineWidth - MIN_BAR_WIDTH));
                  width = Math.max(MIN_BAR_WIDTH, Math.min(rawRight, timelineWidth) - left);
                }

                return (
                  <div
                    key={node.id}
                    data-cockpit-node={node.id}
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
                              aria-label={t(($) => $.gantt.bar_label, { code })}
                              className={cn(
                                "absolute top-1/2 -translate-y-1/2 overflow-hidden rounded-sm ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                // A roll-up is hatched as well as coloured: it
                                // reports the state of everything under it, not
                                // a status anyone set on the row itself.
                                isBranch ? "cockpit-rollup-bar h-[22px] opacity-[0.78]" : "h-[18px]",
                              )}
                              style={{ left, width, backgroundColor: barColor }}
                            >
                              {/* The unfinished tail is veiled rather than the
                                  done head being filled, so the bar keeps one
                                  colour and progress reads as a waterline. The
                                  code is not repeated inside the bar: the tree
                                  pane is sticky, so it never scrolls away. */}
                              {progress < 100 && (
                                <span
                                  className="absolute inset-y-0 right-0 bg-background/70"
                                  style={{ width: `${100 - Math.max(progress, 0)}%` }}
                                  aria-hidden
                                />
                              )}
                            </button>
                          }
                        />
                        <TooltipContent>
                          <BarTooltipBody
                            node={node}
                            code={code}
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
                              aria-label={t(($) => $.gantt.bar_label, { code })}
                              className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1 text-info"
                              style={{
                                left: Math.max(
                                  0,
                                  Math.min(
                                    daysBetween(axis.start, endDate) * dayWidth - 6,
                                    timelineWidth - MIN_BAR_WIDTH,
                                  ),
                                ),
                              }}
                            >
                              <span className="text-body leading-none font-black">{DEADLINE_GLYPH}</span>
                              <span className="text-micro whitespace-nowrap">{end!.slice(5)}</span>
                            </button>
                          }
                        />
                        <TooltipContent>
                          <BarTooltipBody
                            node={node}
                            code={code}
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

                    {groups.map((group, index) => {
                      const x = daysBetween(axis.start, parseDay(group.date)!) * dayWidth;
                      const next = groups[index + 1];
                      const nextX = next
                        ? daysBetween(axis.start, parseDay(next.date)!) * dayWidth
                        : Number.POSITIVE_INFINITY;
                      return (
                        <PaymentMarker
                          key={`${node.id}-${group.paid ? "paid" : "plan"}-${group.date}`}
                          group={group}
                          left={x}
                          showAmount={nextX - x >= AMOUNT_LABEL_CLEARANCE}
                          onSelect={onSelect}
                        />
                      );
                    })}

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
