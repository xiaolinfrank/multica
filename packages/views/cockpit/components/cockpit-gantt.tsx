"use client";

import { ChartNoAxesGantt } from "lucide-react";
import { CockpitViewHeading } from "./cockpit-view-heading";

// The execution gantt: the work-breakdown tree on the left, the timeline on
// the right, and every field on both sides editable where it is shown.
//
// The board this replaces made this view read-only and sent corrections to a
// separate maintenance screen. Here the row you are reading is the row you fix.
//
// The tree is the shipped summary tree: four merged directions collapse into
// single group rows with their tasks flattened underneath, and row codes are
// numbered positionally over that shape. Bars paint by status, not by module —
// the module is already carried by the coloured code on the L1 row, so the bar
// itself is free to answer "what is on fire". Payments and core dates sit on
// the direction rows: the money and the milestones are questions someone asks
// about a branch, not about one task.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { useQueries } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useNavigation, AppLink } from "../../navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CockpitBoard,
  CockpitPlanTaskCount,
  CockpitPlanMeetingMarkerGroup,
  CockpitNode,
  CockpitNodePatch,
  CockpitPayment,
} from "@multica/core/types";
import {
  COCKPIT_STATUS_LEGEND,
  COCKPIT_SUMMARY_GROUPS,
  axisMonths,
  buildCockpitSummaryTree,
  buildCockpitTree,
  cockpitAggStatusColor,
  cockpitCoreNodes,
  cockpitEffectiveProgress,
  cockpitGoalProgress,
  cockpitStatusColor,
  cockpitSubtreeAverage,
  computeCockpitAxis,
  computeCockpitRollups,
  daysBetween,
  groupPaymentsByNode,
  groupSubtreePayments,
  cockpitPlanMeetingWindowOptions, cockpitScope, cockpitSurfacePath, cockpitScopeViewKey,
  isCockpitExecNode,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
  isCockpitSummaryGroup,
  parseDay,
  type CockpitCoreNodeKind,
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
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Diamond,
  Target,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useT } from "../../i18n";
import { EditableSuggest, EditableText, ProgressField } from "./cockpit-fields";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { StatusChip } from "./cockpit-status";
import { cockpitGanttLayout } from "./cockpit-layout";

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
 * Clearance between two payment markers, amount labels included: below it the
 * later marker slides right so its figure does not land on the previous one.
 */
const MARKER_CLEARANCE = 78;
/** The board quotes its amounts in 万元 (10k CNY); labels carry the unit. */
const AMOUNT_UNIT = "万";
/** The module whose rows carry the annual-objective marker, as the source sheet pins it. */
const GOAL_ROOT_CODE = "L1-02";
/** The annual-objective marker's colour: the one purple the design system has no token for. */
const CORE_GOAL_COLOR = "#7c3aed";

export interface CockpitGanttProps {
  board: Pick<CockpitBoard, "cockpit" | "nodes" | "payments">;
  displayCodes: ReadonlyMap<string, string>;
  contextNodeIds: ReadonlySet<string>;
  taskCounts: ReadonlyMap<string, CockpitPlanTaskCount>;
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
  /** The owners the board already uses, offered as one-click picks. */
  ownerSuggestions: string[];
  /** Show budget and instalment badges on every row. */
  showFinance: boolean;
  includeArchivedMeetings?: boolean;
  /** Whether the toolbar is open; a collapsed toolbar takes the legend with it. */
  toolbarOpen: boolean;
  /** Bumped by the toolbar to scroll the timeline back to the today line. */
  scrollToTodayNonce: number;
  /** Locate-and-flash one row; the nonce re-triggers repeat clicks. */
  focusTarget: { nodeId: string; nonce: number } | null;
  /** Opens one meeting in the register. Absent hides the meeting markers —
   *  a marker that cannot be followed is decoration. */
  onOpenMeeting?: (meetingId: string) => void;
  readOnly?: boolean;
  /** Full materialization is reserved for an explicitly bounded chart export. */
  renderAllRows?: boolean;
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
    node.collaborators.toLowerCase().includes(needle)
  );
}

/**
 * The rows to render: depth-first, minus collapsed subtrees. A search keeps a
 * row when it matches OR when a descendant does — hiding the parent of a hit
 * would leave the hit with no context to read it in — but it does not open a
 * branch the reader collapsed: the search answers "is it here", the chevron
 * answers "show me".
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
      if (!collapsed.has(entry.node.id)) walk(entry.children);
    }
  };
  walk(tree);
  return rows;
}

/**
 * Which rows carry the payment markers: the direction rows. One row per
 * direction, always the same one — drawing an instalment on whichever row
 * happens to be collapsed right now moves it around as the reader expands the
 * tree, and drawing it on every ancestor draws it three times. A merged
 * summary group is its members' one direction row.
 */
function carriesMarkers(entry: CockpitTreeNode): boolean {
  // The group's synthetic id deliberately fails the definition regex, so
  // recognise it before the exec check classifies it as a task.
  return (
    entry.depth === 1 &&
    (isCockpitSummaryGroup(entry.node.code) || !isCockpitExecNode(entry.node.code))
  );
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

/** Board amounts carry the programme's own unit, so the unit rides along. */
function wan(value: number): string {
  // 万元 with up to 分 (6 decimals); trailing zeros would fake a precision
  // the number does not have.
  return `${Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))}${AMOUNT_UNIT}`;
}

/** Marks a row that has a deadline but no start date. */
const DEADLINE_GLYPH = "◇";

/** One instalment as a line of text: amount, what it buys, who from, where it stands. */
function paymentLine(payment: CockpitPayment, node: CockpitNode): string {
  return [
    `${payment.label} ${wan(payment.amount)}`,
    node.name,
    node.vendor,
    node.exec_status,
  ]
    .filter(Boolean)
    .join("｜");
}

/** One instalment as a schedule line: which instalment, when, how much. */
function instalmentLine(payment: CockpitPayment): string {
  return `${payment.label} ${payment.pay_date ?? "—"}：${wan(payment.amount)}`;
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
  taskCount,
}: {
  node: CockpitNode;
  code: string;
  rollup: CockpitRollup | undefined;
  payments: CockpitPayment[];
  taskCount: CockpitPlanTaskCount | undefined;
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
        value={taskCount ? t(($) => $.plan_views.task_counts, { primary: taskCount.primary_total, reference: taskCount.reference_total }) : ""}
      />
      <TooltipRow label={t(($) => $.node.vendor)} value={node.vendor} />
      <TooltipRow
        label={t(($) => $.node.budget)}
        value={node.budget_amount == null ? "" : wan(node.budget_amount)}
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

/**
 * One settled or scheduled payment group on a direction row. The disc and the
 * amount ride the top strip of the row; colour alone says whether the money
 * left (green) or is still to find (gold).
 */
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
  const color = group.paid ? "var(--success)" : "var(--warning)";
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
              className="absolute z-10 flex size-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] bg-card text-micro leading-none font-bold shadow-sm"
              style={{ left, top: "26%", borderColor: color, color }}
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
                    total: wan(group.total),
                  })
                : `${state} · ${group.date} · ${t(($) => $.finance.payment_total, {
                    total: wan(group.total),
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
      <span
        className="pointer-events-none absolute -translate-y-1/2 rounded-sm bg-card/85 px-1 py-px text-micro leading-none font-bold whitespace-nowrap tabular-nums shadow-sm"
        style={{ left: left + 9, top: "26%", color }}
        aria-hidden
      >
        {wan(group.total)}
      </span>
    </>
  );
}

const CORE_KIND_META: Record<CockpitCoreNodeKind | "goal", { Icon: LucideIcon; color: string }> = {
  done: { Icon: Check, color: "var(--success)" },
  blocked: { Icon: TriangleAlert, color: "var(--destructive)" },
  upcoming: { Icon: Diamond, color: "var(--brand)" },
  goal: { Icon: Target, color: CORE_GOAL_COLOR },
};

/**
 * Where the row code can stay legible. White inside the bar only works while
 * the label sits wholly on a solid status fill; a light "unstarted" bar takes
 * the foreground ink, and a bar whose recorded progress does not reach past
 * the label pushes the code out past the bar end instead — the veil over the
 * unfinished tail never gets to swallow white text again.
 */
function barCodePlacement(
  barColor: string,
  progress: number,
  width: number,
  codeLen: number,
  roomAfter: number,
): "white" | "dark" | "outside" {
  const light = barColor === "var(--faint-foreground)" || barColor === "var(--muted-foreground)";
  if (light) return "dark";
  const labelPx = 10 + codeLen * 5.6;
  const solidPx = (Math.max(progress, 0) / 100) * width;
  if (solidPx >= labelPx) return "white";
  return roomAfter >= labelPx ? "outside" : "dark";
}

/**
 * One core date on a direction row: what landed, what is stuck, what is about
 * to need attention — the shape of a collapsed branch, back on the timeline.
 * The pill rides the bottom strip of the row; a click opens the tasks behind
 * the glyph.
 */
/**
 * The meetings that discussed a direction, on the day they happened. Rides the
 * same direction rows as the payment and core markers and for the same reason:
 * a marker that moves as the reader expands the tree is a marker nobody can
 * point at twice.
 */
function MeetingMarker({ group, left, onOpenMeeting, registerHref }: {
  group: CockpitPlanMeetingMarkerGroup; left: number; onOpenMeeting: (id: string) => void; registerHref: string;
}) {
  const { t } = useT("cockpit");
  const summary = t(($) => $.gantt.meetings_on, { date: group.date, count: group.total });
  return <Dialog><Tooltip><TooltipTrigger render={<DialogTrigger render={<button type="button" aria-label={summary}
    className="absolute z-10 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] border-info bg-card px-1 text-micro leading-none font-bold text-info shadow-sm" style={{ left, top: "12%" }} />} />}>
    <CalendarDays className="size-2.5" strokeWidth={2.5} aria-hidden />{group.total > 1 && <span>{group.total}</span>}
  </TooltipTrigger><TooltipContent>{summary}</TooltipContent></Tooltip>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{summary}</DialogTitle></DialogHeader>
      <ul className="max-h-72 divide-y overflow-y-auto">{group.items.map((meeting) => <li key={meeting.id}>
        <DialogClose render={<Button variant="link" className="h-auto w-full justify-start py-2 text-left" onClick={() => onOpenMeeting(meeting.id)} />}>
          <span className="min-w-0"><span className="line-clamp-2 break-words" title={meeting.title}>{meeting.title}</span><span className="text-caption text-muted-foreground">{meeting.start_time}</span></span>
        </DialogClose></li>)}</ul>
      <DialogClose nativeButton={false} render={<AppLink href={registerHref} className="text-caption text-primary underline" />}>{t(($) => $.meeting_center.open_register)}</DialogClose>
    </DialogContent>
  </Dialog>;
}

function CoreMarker({
  kind,
  date,
  count,
  nodes,
  goalTitle,
  left,
  onSelect,
}: {
  kind: CockpitCoreNodeKind | "goal";
  date: string;
  count: number;
  nodes: CockpitNode[];
  goalTitle: string | null;
  left: number;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  const meta = CORE_KIND_META[kind];
  const summary =
    kind === "goal"
      ? t(($) => $.gantt.core_goal, { title: goalTitle ?? "", date })
      : kind === "done"
        ? t(($) => $.gantt.core_done, { date, count })
        : kind === "blocked"
          ? t(($) => $.gantt.core_blocked, { date, count })
          : t(($) => $.gantt.core_upcoming, { date, count });
  const marker = (
    <button
      type="button"
      aria-label={summary}
      className="absolute z-10 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-px rounded-full border-[1.5px] bg-card px-1 text-micro leading-none font-bold shadow-sm"
      style={{ left, top: "76%", borderColor: meta.color, color: meta.color }}
    >
      <meta.Icon className="size-2.5" strokeWidth={2.5} aria-hidden />
      {kind !== "goal" && count > 1 && <span>{count}</span>}
    </button>
  );
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger render={<DialogTrigger render={marker} />} />
        <TooltipContent>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="font-medium">{summary}</span>
            {nodes.slice(0, 5).map((node) => (
              <span key={node.id} className="text-caption">
                {node.name} · {node.status || t(($) => $.gantt.status_unscheduled)}
              </span>
            ))}
            {nodes.length > 5 && (
              <span className="text-caption text-muted-foreground">
                {t(($) => $.gantt.core_more, { count: nodes.length - 5 })}
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{summary}</DialogTitle>
        </DialogHeader>
        {nodes.length === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.gantt.core_goal_body, { title: goalTitle ?? "", date })}</p>
        ) : (
          <ul className="flex flex-col">
            {nodes.map((node) => (
              <li key={node.id} className="border-b border-border py-2 last:border-b-0">
                <DialogClose
                  render={
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto whitespace-normal text-left"
                      onClick={() => onSelect(node.id)}
                    />
                  }
                >
                  {node.name}
                </DialogClose>
                <div className="text-caption text-muted-foreground">
                  {node.end_date} · <StatusChip status={node.status} />
                </div>
                <div className="text-caption text-muted-foreground">
                  {t(($) => $.node.owner)}: {node.owner || "—"} ·{" "}
                  {t(($) => $.node.progress)}: {node.progress}%
                </div>
                {node.deliverable && (
                  <div className="text-caption text-muted-foreground">
                    {t(($) => $.node.deliverable)}: {node.deliverable}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Percent plus a 22px rail — the branch read that a number alone doesn't give. */
function MiniProgress({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-micro font-bold tabular-nums", className)}>
      {value}%
      <span className="h-1 w-[22px] overflow-hidden rounded-full bg-current/20">
        <span className="cockpit-grow block h-full rounded-full bg-current" style={{ width: `${value}%` }} />
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
            <Target className="size-3" aria-hidden />
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
  displayCodes,
  contextNodeIds,
  taskCounts,
  today,
  zoom,
  query,
  rootIds,
  collapsed,
  onToggleCollapse,
  onSelect: onSelectNode,
  selectedId,
  onPatchNode,
  statusSuggestions,
  ownerSuggestions,
  showFinance,
  includeArchivedMeetings = false,
  toolbarOpen,
  scrollToTodayNonce,
  focusTarget,
  onOpenMeeting,
  readOnly,
  renderAllRows = false,
}: CockpitGanttProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();
  const wsId = useWorkspaceId(); const navigation = useNavigation();
  const scope = cockpitScope(navigation.searchParams);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });
  const reduceMotion = useReducedMotion() === true;
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const selectedGroup = COCKPIT_SUMMARY_GROUPS.find((group) => group.id === selectedGroupId);
  const onSelect = (id: string) => { if (isCockpitSummaryGroup(id)) setSelectedGroupId(id); else onSelectNode(id); };
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTodayScroll = useRef({ nonce: 0, dayWidth: 0, axisStart: 0 });
  useCockpitScrollMemory(scrollRef, JSON.stringify([cockpitScopeViewKey(wsId, scope), "gantt"]), board.nodes.length > 0, JSON.stringify([query, [...rootIds].sort()]));

  const baseTree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  // The shipped shape: merged directions, their tasks flattened underneath.
  const tree = useMemo(() => {
    const presentCodes = new Set(board.nodes.map((node) => node.code));
    return buildCockpitSummaryTree(baseTree).map((root) => ({ ...root, children: root.children.filter((child) => {
      const group = COCKPIT_SUMMARY_GROUPS.find((item) => item.id === child.node.id);
      return !group || group.members.some((code) => presentCodes.has(code));
    }) }));
  }, [baseTree, board.nodes]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    const picked = tree.filter((entry) => rootIds.has(entry.node.id));
    return picked.length > 0 ? picked : tree;
  }, [tree, rootIds]);

  // Row codes are addresses, so they are built once over the whole tree: a
  // filtered or searched view must not renumber the rows under the reader.
  const rollups = useMemo(() => computeCockpitRollups(tree, today), [tree, today]);
  const rows = useMemo(
    () => visibleRows(scopedTree, collapsed, query),
    [scopedTree, collapsed, query],
  );
  const monthBandHeight = zoom === "week" ? 22 : 36;
  const headerHeight = zoom === "week" ? 52 : 36;
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT, overscan: 8, scrollMargin: headerHeight,
    getItemKey: (index) => rows[index]!.node.id, initialRect: { width: 1100, height: 600 } });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRows = renderAllRows ? rows : virtualRows.map((row) => rows[row.index]!);
  const topPadding = renderAllRows ? 0 : Math.max(0, (virtualRows[0]?.start ?? headerHeight) - headerHeight);
  const bottomPadding = renderAllRows ? 0 : Math.max(0, rows.length * ROW_HEIGHT - topPadding - renderedRows.length * ROW_HEIGHT);
  const nodeById = useMemo(() => new Map(board.nodes.map((n) => [n.id, n])), [board.nodes]);
  // Whose module a row belongs to, and who answers for that module — the
  // owner a direction row inherits and the mainline the goal marker pins to.
  const rootOf = useMemo(() => {
    const byId = new Map<string, string>();
    const byCode = new Map<string, string>();
    const walk = (entry: CockpitTreeNode, rootId: string, rootCode: string) => {
      byId.set(entry.node.id, rootId);
      byCode.set(entry.node.id, rootCode);
      entry.children.forEach((child) => walk(child, rootId, rootCode));
    };
    tree.forEach((root) => walk(root, root.node.id, root.node.code));
    return { byId, byCode };
  }, [tree]);
  const paymentsByNode = useMemo(() => groupPaymentsByNode(board.payments), [board.payments]);
  // A direction row with no owner of its own answers through its mainline.
  const rootOwner = useMemo(() => {
    const map = new Map<string, string>();
    for (const root of tree) map.set(root.node.id, root.node.owner);
    return map;
  }, [tree]);
  // The axis spans the whole board, never just the filtered modules: rescaling
  // the timeline when someone narrows the scope makes every bar jump, and the
  // question a filter asks is "which rows", not "which dates". The objective's
  // month closes it, and its June opens it — the shipped board starts there.
  const axis = useMemo(
    () => computeCockpitAxis(board.nodes, today, { zoom, goalDate: board.cockpit.goal_date }),
    [board.nodes, today, zoom, board.cockpit.goal_date],
  );
  const dayWidth = DAY_WIDTH[zoom];
  const timelineWidth = Math.max(axis.days * dayWidth, 320);
  const months = useMemo(() => axisMonths(axis), [axis]);
  const axisStartKey = axis.start.toISOString().slice(0, 10);
  const todayOffset = useMemo(() => {
    const date = parseDay(today);
    return date ? daysBetween(axis.start, date) * dayWidth : null;
  }, [today, axis.start, dayWidth]);
  // The line rides the middle of today's cell, and only when the cell is on
  // the canvas at all.
  const todayX =
    todayOffset == null || todayOffset < 0 || todayOffset + dayWidth > timelineWidth
      ? null
      : todayOffset + dayWidth / 2;

  const goalDate = board.cockpit.goal_date;
  const goalProgress = useMemo(() => {
    const map = new Map<string, CockpitGoalProgress>();
    if (!goalDate) return map;
    for (const entry of tree) map.set(entry.node.id, cockpitGoalProgress(entry, today, goalDate));
    return map;
  }, [tree, today, goalDate]);

  // The objective stands at the end of its month, flag and line both.
  const goalOffset = useMemo(() => {
    const goal = parseDay(goalDate);
    if (!goal) return null;
    const monthEnd = new Date(Date.UTC(goal.getUTCFullYear(), goal.getUTCMonth() + 1, 0));
    const x = daysBetween(axis.start, monthEnd) * dayWidth + dayWidth;
    return x >= 0 && x <= timelineWidth ? x : null;
  }, [goalDate, axis.start, dayWidth, timelineWidth]);

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

  /** Instalments a direction row is answerable for. */
  const paymentGroups = useMemo(() => {
    const map = new Map<string, CockpitPaymentGroup[]>();
    for (const entry of rows) {
      if (!carriesMarkers(entry)) continue;
      const groups = groupSubtreePayments(entry, paymentsByNode, nodeById);
      if (groups.length > 0) map.set(entry.node.id, groups);
    }
    return map;
  }, [rows, paymentsByNode, nodeById]);

  /**
   * Core dates per direction row: pre-June dates clamped onto the axis start,
   * same-day groups merged after the clamp, and the annual objective pinned on
   * the mainline's rows.
   */
  const coreMarks = useMemo(() => {
    const map = new Map<
      string,
      { kind: CockpitCoreNodeKind | "goal"; date: string; nodes: CockpitNode[] }[]
    >();
    for (const entry of rows) {
      if (!carriesMarkers(entry)) continue;
      const merged = new Map<string, { kind: CockpitCoreNodeKind | "goal"; date: string; nodes: CockpitNode[] }>();
      for (const group of cockpitCoreNodes(entry, today)) {
        const date = group.date < axisStartKey ? axisStartKey : group.date;
        const key = `${group.kind}:${date}`;
        const bucket = merged.get(key);
        if (bucket) bucket.nodes.push(...group.nodes);
        else merged.set(key, { kind: group.kind, date, nodes: [...group.nodes] });
      }
      const marks = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      if (goalDate && rootOf.byCode.get(entry.node.id) === GOAL_ROOT_CODE) {
        marks.push({ kind: "goal", date: goalDate, nodes: [] });
      }
      if (marks.length > 0) map.set(entry.node.id, marks);
    }
    return map;
  }, [rows, today, axisStartKey, goalDate, rootOf]);

  const { treeWidth, compact } = cockpitGanttLayout(viewport.width, showFinance, renderAllRows);
  const hasNodes = board.nodes.length > 0;
  useLayoutEffect(() => {
    const element = scrollRef.current; if (!element) return;
    let frame = 0;
    const measure = () => setViewport({ left: element.scrollLeft, width: element.clientWidth });
    const read = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    element.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read); observer.observe(element); measure();
    return () => { cancelAnimationFrame(frame); element.removeEventListener("scroll", read); observer.disconnect(); };
  }, [hasNodes]);
  const markerRows = renderedRows.filter(carriesMarkers).slice(0, 100).map((entry) => {
    const group = COCKPIT_SUMMARY_GROUPS.find((item) => item.id === entry.node.id);
    return { row_key: entry.node.id, node_ids: group ? board.nodes.filter((node) => group.members.includes(node.code)).map((node) => node.id) : [entry.node.id] };
  }).filter((row) => row.node_ids.length > 0);
  const markerWindows = [];
  const firstDay = Math.max(0, Math.floor(viewport.left / dayWidth));
  const lastDay = Math.min(axis.days - 1, firstDay + Math.ceil(Math.max(1, viewport.width - treeWidth) / dayWidth));
  for (let day = firstDay; day <= lastDay; day += 93) markerWindows.push({
    date_from: new Date(axis.start.getTime() + day * MS_PER_DAY).toISOString().slice(0, 10),
    date_to: new Date(axis.start.getTime() + Math.min(day + 92, lastDay) * MS_PER_DAY).toISOString().slice(0, 10),
  });
  const markerQueries = useQueries({ queries: markerWindows.map((window) => ({ ...cockpitPlanMeetingWindowOptions(wsId, scope, { rows: markerRows, archive: includeArchivedMeetings ? "all" : "active", ...window }), enabled: Boolean(viewport.width > 0 && onOpenMeeting && !renderAllRows && markerRows.length) })) });
  const meetingMarks = new Map<string, CockpitPlanMeetingMarkerGroup[]>();
  for (const query of markerQueries) for (const group of query.data ?? []) meetingMarks.set(group.row_key, [...(meetingMarks.get(group.row_key) ?? []), group]);
  const markerError = markerQueries.some((query) => query.isError);
  const markerRegisterHref = (rowKey: string, date: string) => {
    const row = markerRows.find((item) => item.row_key === rowKey);
    const path = cockpitSurfacePath(navigation.pathname, "meetings", scope);
    const params = new URLSearchParams(path.split("?")[1] ?? "");
    if (row?.node_ids.length === 1) params.set("meeting_node", row.node_ids[0]!);
    else if (row?.node_ids.length) params.set("meeting_nodes", row.node_ids.join(","));
    params.set("from", date); params.set("to", date); params.set("meeting_archive", includeArchivedMeetings ? "all" : "active");
    return `${navigation.pathname}?${params.toString()}`;
  };

  // Scrolling is a viewport action, not board state, so it is driven by a
  // nonce from the toolbar rather than by a value the render depends on.
  useEffect(() => {
    if (scrollToTodayNonce === 0 || todayOffset === null || viewport.width === 0 || renderAllRows) return;
    const axisStart = axis.start.getTime();
    const previous = lastTodayScroll.current;
    if (previous.nonce === scrollToTodayNonce && previous.dayWidth === dayWidth && previous.axisStart === axisStart) return;
    const el = scrollRef.current;
    if (!el) return;
    lastTodayScroll.current = { nonce: scrollToTodayNonce, dayWidth, axisStart };
    // The tree pane is sticky and covers the left of the viewport, so the
    // today line is centred in what is left of it, not in the whole element.
    const centre = Math.max(todayOffset - (el.clientWidth - treeWidth) / 2, 0);
    el.scrollTo({ left: centre, behavior: reduceMotion ? "auto" : "smooth" });
  }, [scrollToTodayNonce, todayOffset, treeWidth, reduceMotion, viewport.width, renderAllRows, axis.start, dayWidth]);

  // Locate first by logical row index: the target may not be mounted yet.
  useEffect(() => {
    if (!focusTarget) return;
    const index = rows.findIndex((entry) => entry.node.id === focusTarget.nodeId);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current?.querySelector(`[data-cockpit-node="${focusTarget.nodeId}"]`);
      element?.classList.add("cockpit-flash");
    });
    const timer = window.setTimeout(() => {
      scrollRef.current?.querySelector(`[data-cockpit-node="${focusTarget.nodeId}"]`)?.classList.remove("cockpit-flash");
    }, 2600);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [focusTarget, rows, rowVirtualizer]);

  if (board.nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12 text-body text-muted-foreground">
        {t(($) => $.empty.no_nodes)}
      </div>
    );
  }

  const emptyLabel = t(($) => $.common.unset);
  const legendLabel = (key: CockpitStatusLegendKey) => t(($) => $.gantt.legend_status[key]);

  // A click anywhere on a branch row folds it, unless it landed on a control.
  const toggleRow = (entry: CockpitTreeNode) => (event: React.MouseEvent) => {
    if (entry.children.length === 0) return;
    if (
      (event.target as HTMLElement).closest(
        "button, a, input, textarea, select, [contenteditable=true]",
      )
    ) {
      return;
    }
    onToggleCollapse(entry.node.id);
  };

  return (
    <div data-cockpit-row-count={rows.length} data-cockpit-gantt data-summary-width={zoom === "month" && rows.every((entry) => entry.children.length > 0) ? treeWidth + Math.max(0, daysBetween(axis.start, new Date(Date.UTC(Number(today.slice(0, 4)) + 1, 0, 1)))) * dayWidth : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CockpitViewHeading title={t(($) => $.tabs.gantt)} icon={ChartNoAxesGantt} />
      {/* Legend and provenance: what the chart is showing and what its colours
          mean, collapsible for anyone who already knows — and folded away with
          the toolbar, which is where the shipped board keeps it. */}
      {toolbarOpen && (
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
                  <span className="font-black text-info" aria-hidden>
                    {DEADLINE_GLYPH}
                  </span>
                  {t(($) => $.gantt.legend_end_only)}
                </span>
                <span className="flex items-center gap-1">
                  <span
                    className="h-2.5 w-0 border-l-2 border-dashed"
                    style={{ borderColor: "var(--budget)" }}
                    aria-hidden
                  />
                  {t(($) => $.gantt.legend_goal)}
                </span>
                <span className="text-faint-foreground">{t(($) => $.gantt.legend_l1_note)}</span>
              </>
            )}
            <span className="flex-1" />
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
      )}

      {markerError && <div role="alert" className="flex items-center gap-2 border-b px-3 py-2 text-caption text-destructive"><span>{t(($) => $.meeting_center.marker_failed)}</span><Button type="button" variant="outline" size="sm" onClick={() => markerQueries.forEach((query) => { void query.refetch(); })}>{t(($) => $.binding.retry)}</Button></div>}
      {renderAllRows && <p className="px-3 py-2 text-caption text-muted-foreground">{t(($) => $.meeting_center.export_markers)}</p>}
      <div ref={scrollRef} data-cockpit-scroll className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div className="flex min-w-max">
          {/* Tree pane. Sticky so the timeline scrolls under the names. */}
          <div
            className="sticky left-0 z-20 shrink-0 border-r border-border bg-background"
            style={{ width: treeWidth }}
          >
            <div
              className="cockpit-time-axis sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background px-3 text-caption font-medium text-muted-foreground"
              style={{ height: headerHeight }}
            >
              <span className="min-w-0 flex-1">{t(($) => $.gantt.column_task)}</span>
              {!compact && showFinance && (
                <span className="w-32 shrink-0 text-right">{t(($) => $.gantt.column_finance)}</span>
              )}
              {!compact && <>
                <span className="w-16 shrink-0 text-right">{t(($) => $.gantt.column_owner)}</span>
                <span className="w-24 shrink-0 text-right">{t(($) => $.gantt.column_status)}</span>
                <span className="w-28 shrink-0 text-right">{t(($) => $.gantt.column_progress)}</span>
              </>}
            </div>
            <div aria-hidden style={{ height: topPadding }} />
            {renderedRows.map((entry) => {
              const { node, depth, children } = entry;
              const rollup = rollups.get(node.id);
              const isBranch = children.length > 0;
              const isMainline = depth === 0;
              const isSelected = selectedId === node.id;
              const collaborators = countPeople(node.collaborators);
              const late = isCockpitNodeLate(node, today);
              const drifting = !late && isCockpitNodeDrifting(node, today);
              const budget = isBranch ? (rollup?.budget ?? 0) : (node.budget_amount ?? 0);
              const ownPayments = paymentsByNode.get(node.id) ?? [];
              const code = displayCodes.get(node.id) ?? node.code;
              const goal = isMainline ? goalProgress.get(node.id) : undefined;
              // The branch read is the subtask average, the figure the source
              // sheet scores merged groups by.
              const subtreeAvg = isBranch ? cockpitSubtreeAverage(entry) : null;
              const inheritedOwner =
                depth === 1 && !node.owner
                  ? (rootOwner.get(rootOf.byId.get(node.id) ?? "") ?? "")
                  : "";
              return (
                <div
                  key={node.id}
                  data-cockpit-node={node.id}
                  data-context-only={contextNodeIds.has(node.id) || undefined}
                  title={contextNodeIds.has(node.id) ? t(($) => $.plan_views.context_only) : isCockpitSummaryGroup(node.id) ? t(($) => $.plan_views.presentation_group) : undefined}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  onClick={toggleRow(entry)}
                  className={cn(
                    "flex items-center gap-2 border-b border-border/50",
                    compact ? "px-1" : "px-3",
                    isBranch && "cursor-pointer",
                    // The selected row must stay identifiable while hovered, so
                    // selection speaks through weight and a left rule, not only
                    // through the background hover also paints.
                    isSelected
                      ? "bg-accent font-medium shadow-[inset_2px_0_0_0_var(--color-brand)]"
                      : isMainline
                        ? "bg-muted/40 font-semibold"
                        : hoveredId === node.id && "bg-accent/50",
                  )}
                  style={{
                    height: ROW_HEIGHT,
                    ...(isMainline && !isSelected
                      ? { boxShadow: `inset 4px 0 0 0 ${entry.color || "var(--color-brand)"}` }
                      : {}),
                  }}
                >
                  <div
                    className="flex min-w-0 flex-1 items-center gap-1"
                    style={{ paddingLeft: compact ? Math.min(depth * 8, 16) : depth * INDENT }}
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
                    <div className={cn("flex min-w-0 flex-1", compact ? "flex-col items-start [&:has(input)>button]:hidden" : "items-center gap-1")}>
                    {/* The row code is the address people quote in meetings.
                        It already says which level the row is on, so no
                        separate depth chip sits beside it. Only the mainline
                        carries the module colour — below it the codes stay
                        grey so colour keeps meaning "which module". */}
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => onSelect(node.id)}
                            aria-label={t(($) => $.gantt.open_node, { code })}
                            className={cn("max-w-full shrink-0 truncate rounded-sm px-1 font-mono text-micro text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground", compact && "leading-tight")}
                            style={isMainline && entry.color ? { color: entry.color } : undefined}
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
                      disabled={readOnly || contextNodeIds.has(node.id) || isCockpitSummaryGroup(node.id)}
                      displayClassName={cn("min-w-0 truncate", compact ? "w-full text-caption leading-tight" : "flex-1", isBranch && "font-medium")}
                    />
                    </div>
                    {!compact && <>
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
                    </>}
                  </div>

                  {!compact && <>
                  {showFinance && (
                    <div className="flex w-32 shrink-0 items-center justify-end gap-1">
                      {budget > 0 && (
                        <span className="rounded-sm border border-budget/30 bg-budget/10 px-1 text-micro font-medium text-budget tabular-nums">
                          {wan(budget)}
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
                      saturation notes included, is what editing opens on. A
                      direction with no owner of its own answers through its
                      mainline, and says so. The span wrapper keeps the tooltip
                      anchored around the combobox rather than inside it. */}
                  <div className="flex w-16 shrink-0 justify-end overflow-hidden">
                    {inheritedOwner ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                          <EditableSuggest
                            value={node.owner}
                            onCommit={(owner) => onPatchNode(node.id, { owner })}
                            suggestions={ownerSuggestions}
                            label={t(($) => $.node.owner)}
                            placeholder={emptyLabel}
                            disabled={readOnly || contextNodeIds.has(node.id) || isCockpitSummaryGroup(node.id)}
                            displayClassName="text-caption"
                            displayValue={shortOwner(inheritedOwner)}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          {t(($) => $.gantt.owner_inherited, { owner: inheritedOwner })}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <EditableSuggest
                        value={node.owner}
                        onCommit={(owner) => onPatchNode(node.id, { owner })}
                        suggestions={ownerSuggestions}
                        label={t(($) => $.node.owner)}
                        placeholder={emptyLabel}
                        disabled={readOnly || contextNodeIds.has(node.id) || isCockpitSummaryGroup(node.id)}
                        displayClassName="text-caption"
                        displayValue={shortOwner(node.owner)}
                      />
                    )}
                  </div>

                  <div className="flex w-24 shrink-0 justify-end overflow-hidden">
                    {isBranch ? (
                      // A roll-up has no status of its own; what it has is a
                      // tally, and that is the more useful thing to show here.
                      // An undecomposed one says so with a dash, not 0/0.
                      rollup && rollup.leafCount > 0 ? (
                        <span className="text-caption text-muted-foreground tabular-nums">
                          {t(($) => $.gantt.done_of, {
                            done: rollup.doneCount,
                            total: rollup.leafCount,
                          })}
                        </span>
                      ) : (
                        <span className="text-caption text-faint-foreground">—</span>
                      )
                    ) : (
                      <EditableSuggest
                        value={node.status}
                        onCommit={(status) => onPatchNode(node.id, { status })}
                        suggestions={statusSuggestions}
                        clearLabel={t(($) => $.node.status_unscheduled)}
                        label={t(($) => $.node.status)}
                        placeholder={emptyLabel}
                        disabled={readOnly || contextNodeIds.has(node.id) || isCockpitSummaryGroup(node.id)}
                        renderDisplay={(value) =>
                          value ? (
                            <StatusChip status={value} />
                          ) : (
                            <span className="text-caption text-muted-foreground">
                              {t(($) => $.gantt.status_unscheduled)}
                            </span>
                          )
                        }
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
                      subtreeAvg != null ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <MiniProgress
                                value={subtreeAvg}
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
                        <span className="text-caption text-faint-foreground">—</span>
                      )
                    ) : (
                      <ProgressField
                        value={node.progress}
                        onCommit={(progress) => onPatchNode(node.id, { progress })}
                        label={t(($) => $.node.progress)}
                        disabled={readOnly || contextNodeIds.has(node.id) || isCockpitSummaryGroup(node.id)}
                      />
                    )}
                  </div>
                  </>}
                </div>
              );
            })}
            <div aria-hidden style={{ height: bottomPadding }} />
          </div>

          {/* Timeline pane. */}
          <div className="relative shrink-0" style={{ width: timelineWidth }}>
            <div
              className="cockpit-time-axis sticky top-0 z-10 border-b border-border bg-background"
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
                                    <div>{t(($) => $.node.linked_issues)}: {taskCounts.has(node.id) ? t(($) => $.plan_views.task_counts, { primary: taskCounts.get(node.id)!.primary_total, reference: taskCounts.get(node.id)!.reference_total }) : emptyLabel}</div>
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
                              <div>{payment.pay_date} · {wan(payment.amount)}</div>
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
              {goalOffset !== null && (
                <div
                  className="pointer-events-none absolute top-0 bottom-0 z-10 border-l-2 border-dashed border-budget/80"
                  style={{ left: goalOffset }}
                  aria-hidden
                />
              )}
              {todayX !== null && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="cockpit-today-line absolute top-0 bottom-0 z-10 w-0.5 bg-brand/80"
                        style={{ left: todayX }}
                        aria-label={t(($) => $.gantt.today_line, { date: today })}
                      />
                    }
                  />
                  <TooltipContent>{t(($) => $.gantt.today_line, { date: today })}</TooltipContent>
                </Tooltip>
              )}
              {todayX !== null && (
                <span
                  className="pointer-events-none absolute top-0 z-20 -translate-x-1/2 rounded-b-md bg-brand px-1.5 py-px text-micro leading-4 font-semibold text-brand-foreground"
                  style={{ left: todayX }}
                  aria-hidden
                >
                  {t(($) => $.meetings.today)}
                </span>
              )}
            </div>

            <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
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

              {todayX !== null && (
                <div
                  className="cockpit-today-line pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-brand/80"
                  style={{ left: todayX }}
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
                          className="absolute top-0.5 z-20 inline-flex items-center gap-1 rounded-r-lg bg-budget px-1.5 py-px text-micro font-semibold whitespace-nowrap text-background"
                          style={{ left: goalOffset + 4 }}
                        >
                          <Target className="size-3" strokeWidth={2.5} aria-hidden />
                          {t(($) => $.gantt.goal_flag, { month: goalDate!.slice(0, 7) })}
                        </span>
                      }
                    />
                    <TooltipContent>
                      <div className="flex max-w-72 flex-col gap-0.5">
                        <span className="font-medium">
                          {board.cockpit.goal_title || t(($) => $.overview.annual_goal)}
                        </span>
                        <span className="text-caption text-muted-foreground">
                          {t(($) => $.gantt.goal_line_note, { date: goalDate! })}
                        </span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </>
              )}

              <div aria-hidden style={{ height: topPadding }} />
              {renderedRows.map((entry) => {
                const { node, children, depth } = entry;
                const rollup = rollups.get(node.id);
                const isBranch = children.length > 0;
                const isMainline = depth === 0;
                const code = displayCodes.get(node.id) ?? node.code;
                const start = node.start_date ?? (isBranch ? (rollup?.start ?? null) : null);
                const end = node.end_date ?? (isBranch ? (rollup?.end ?? null) : null);
                const startDate = parseDay(start);
                const endDate = parseDay(end);
                const groups = paymentGroups.get(node.id) ?? [];
                const marks = coreMarks.get(node.id) ?? [];
                const meetingDays = meetingMarks.get(node.id) ?? [];
                const isSelected = selectedId === node.id;
                const barColor = isBranch
                  ? cockpitAggStatusColor(entry)
                  : cockpitStatusColor(node.status);
                const progress = isBranch
                  ? (cockpitSubtreeAverage(entry) ?? 0)
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

                // Payment markers: pre-axis dates clamp onto the opening day,
                // then each marker claims clearance for itself and its label.
                let prevMarkerX = Number.NEGATIVE_INFINITY;
                const markerX = (date: string): number => {
                  const clamped = date < axisStartKey ? axisStartKey : date;
                  let x = daysBetween(axis.start, parseDay(clamped)!) * dayWidth + dayWidth / 2;
                  if (x - prevMarkerX < MARKER_CLEARANCE) x = prevMarkerX + MARKER_CLEARANCE;
                  prevMarkerX = x;
                  return x;
                };

                return (
                  <div
                    key={node.id}
                    data-cockpit-node={node.id}
                  data-context-only={contextNodeIds.has(node.id) || undefined}
                  title={contextNodeIds.has(node.id) ? t(($) => $.plan_views.context_only) : isCockpitSummaryGroup(node.id) ? t(($) => $.plan_views.presentation_group) : undefined}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                    onClick={toggleRow(entry)}
                    className={cn(
                      "relative border-b border-border/50",
                      isBranch && "cursor-pointer",
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
                                "absolute -translate-y-1/2 overflow-hidden rounded-md ring-offset-background transition-[filter] motion-reduce:transition-none hover:brightness-[1.07] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                !isBranch && "shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_-1px_0_rgb(0_0_0/0.08)]",
                                // A roll-up is hatched as well as coloured: it
                                // reports the state of everything under it, not
                                // a status anyone set on the row itself. The
                                // mainline bar is the one allowed extra height.
                                isBranch && "cockpit-rollup-bar opacity-[0.78]",
                                isMainline ? "top-[5px] h-[22px] rounded-[7px]" : "top-[7px] h-[18px]",
                              )}
                              style={{ left, width, backgroundColor: barColor }}
                            >
                              {/* The unfinished tail is veiled rather than the
                                  done head being filled, so the bar keeps one
                                  colour and progress reads as a waterline. The
                                  row code rides inside the bar — on the shipped
                                  board the timeline is quoted by these, so a
                                  screenshot carries its own addresses. */}
                              {progress < 100 && (
                                <span
                                  className="absolute inset-y-0 right-0 bg-background/70"
                                  style={{ width: `${100 - Math.max(progress, 0)}%` }}
                                  aria-hidden
                                />
                              )}
                              {!isMainline &&
                                barCodePlacement(
                                  barColor,
                                  progress,
                                  width,
                                  code.length,
                                  timelineWidth - left - width - 4,
                                ) !== "outside" && (
                                  <span
                                    className={cn(
                                      "absolute top-0 left-[7px] text-micro leading-[18px] font-semibold whitespace-nowrap",
                                      barCodePlacement(
                                        barColor,
                                        progress,
                                        width,
                                        code.length,
                                        timelineWidth - left - width - 4,
                                      ) === "white"
                                        ? "text-white [text-shadow:0_1px_1px_rgba(0,0,0,0.35)]"
                                        : "text-foreground",
                                    )}
                                    aria-hidden
                                  >
                                    {code}
                                  </span>
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
                            taskCount={taskCounts.get(node.id)}
                          />
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {/* No room on a solid fill — the code steps out past the
                        bar end instead of drowning in the veil. */}
                    {!isMainline &&
                      startDate &&
                      endDate &&
                      barCodePlacement(
                        barColor,
                        progress,
                        width,
                        code.length,
                        timelineWidth - left - width - 4,
                      ) === "outside" && (
                        <span
                          className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-micro font-semibold whitespace-nowrap text-muted-foreground"
                          style={{ left: left + width + 4 }}
                          aria-hidden
                        >
                          {code}
                        </span>
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
                                    daysBetween(axis.start, endDate) * dayWidth + dayWidth / 2 - 7,
                                    timelineWidth - MIN_BAR_WIDTH,
                                  ),
                                ),
                              }}
                            >
                              <span className="text-body leading-none font-black">{DEADLINE_GLYPH}</span>
                              <span className="text-micro whitespace-nowrap">
                                {t(($) => $.gantt.deadline_label, { date: end!.slice(5) })}
                              </span>
                            </button>
                          }
                        />
                        <TooltipContent>
                          <BarTooltipBody
                            node={node}
                            code={code}
                            rollup={rollup}
                            payments={paymentsByNode.get(node.id) ?? []}
                            taskCount={taskCounts.get(node.id)}
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

                    {onOpenMeeting &&
                      meetingDays.map((day) => (
                        <MeetingMarker
                          key={`${node.id}-meet-${day.date}`}
                          group={day}
                          registerHref={markerRegisterHref(node.id, day.date)}
                          left={markerX(day.date)}
                          onOpenMeeting={onOpenMeeting}
                        />
                      ))}

                    {groups.map((group) => (
                      <PaymentMarker
                        key={`${node.id}-${group.paid ? "paid" : "plan"}-${group.date}`}
                        group={group}
                        left={markerX(group.date)}
                        onSelect={onSelect}
                      />
                    ))}

                    {marks.map((mark) => (
                      <CoreMarker
                        key={`${node.id}-${mark.kind}-${mark.date}`}
                        kind={mark.kind}
                        date={mark.date}
                        count={mark.nodes.length}
                        nodes={mark.nodes}
                        goalTitle={board.cockpit.goal_title}
                        left={markerX(mark.date)}
                        onSelect={onSelect}
                      />
                    ))}

                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <Dialog open={Boolean(selectedGroup)} onOpenChange={(open) => { if (!open) setSelectedGroupId(null); }}>
        <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{selectedGroup?.name}</DialogTitle></DialogHeader>
          <p className="text-caption text-muted-foreground">{t(($) => $.plan_views.presentation_group)}</p>
          <ul className="max-h-80 space-y-2 overflow-y-auto">{selectedGroup && board.nodes.filter((node) => selectedGroup.members.includes(node.code)).map((node) => <li key={node.id}>
            <DialogClose render={<Button type="button" variant="outline" className="h-auto min-h-10 w-full justify-start whitespace-normal text-left" onClick={() => onSelectNode(node.id)} />}>
              <span className="mr-2 shrink-0 font-mono text-caption text-muted-foreground">{displayCodes.get(node.id) ?? node.code}</span><span className="line-clamp-2 min-w-0 break-words">{node.name}</span>
            </DialogClose></li>)}</ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}

