"use client";

import { ChartGantt, Target } from "@multica/ui/icons";
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
import { useQueries, useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useNavigation } from "../../navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CockpitBoard,
  CockpitPlanTaskCount,
  CockpitPlanMeetingMarkerGroup,
  CockpitNode,
  CockpitNodePatch,
} from "@multica/core/types";
import {
  COCKPIT_STATUS_LEGEND,
  cockpitIssueProgress,
  axisMonths,
  buildCockpitTree,
  cockpitAggStatusColor,
  cockpitCoreNodes,
  cockpitEffectiveProgress,
  cockpitGoalProgress,
  cockpitStatusColor,
  cockpitSubtreeAverage,
  isCockpitWorkItem,
  computeCockpitAxis,
  computeCockpitRollups,
  daysBetween,
  groupPaymentsByNode,
  groupSubtreePayments,
  cockpitPlanMeetingWindowOptions, cockpitScope, cockpitSurfacePath, cockpitScopeViewKey,
  useCreateCockpitWorkItem, useDeleteCockpitWorkItem, useMoveCockpitWorkItem, useRenumberCockpitChildren,
  isCockpitNodeDrifting,
  isCockpitNodeLate,
  parseDay,
  type CockpitCoreNodeKind,
  type CockpitGoalProgress,
  type CockpitPaymentGroup,
  type CockpitStatusLegendKey,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";

import { useLocale, useT } from "../../i18n";
import { useCreateModule } from "@multica/core/modules";
import { useModalStore } from "@multica/core/modals";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { EditableSuggest, ProgressField } from "./cockpit-fields";
import { PlanRowName } from "../../plan-tree/plan-row-name";
import { CreateRow, PlanRowActions } from "../../plan-tree/plan-row-actions";
import { ModuleDeleteDialog } from "../../plan-tree/module-delete-dialog";
import { planModules, planRowFor, type PlanRow } from "../../plan-tree/plan-rows";
import { planRowRenameTarget, usePlanRowRename } from "../../plan-tree/use-plan-row-rename";
import { planDirectoryPaths } from "../../plan-tree/plan-directory-paths";
import { RunningTasksDialog, type RunningTasksConflict } from "../../plan-tree/running-tasks-dialog";
import { useLocalPathActions } from "../../common/local-path-link";
import { projectListOptions } from "@multica/core/projects/queries";
import { isCockpitRunningTasksError } from "@multica/core/cockpit";
import { useSyncNodeDirectory } from "@multica/core/directory";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { StatusChip } from "./cockpit-status";
import { cockpitGanttLayout } from "./cockpit-layout";

/** Timeline density. Month is the year-at-a-glance read; week zooms in. */

import {
  DAY_WIDTH, DEADLINE_GLYPH, GOAL_ROOT_CODE, INDENT, MARKER_CLEARANCE, MIN_BAR_WIDTH,
  MS_PER_DAY, ROW_HEIGHT,
  barCodePlacement, carriesMarkers, cockpitWeekTasks, countPeople, instalmentLine,
  shortOwner, visibleRows, wan,
  type CockpitZoom,
} from "./cockpit-gantt-helpers";
import { BarTooltipBody, CoreMarker, GoalChip, MeetingMarker, MiniProgress, PaymentMarker } from "./cockpit-gantt-markers";

export { cockpitWeekTasks };
export type { CockpitZoom };
export interface CockpitGanttProps {
  board: Pick<CockpitBoard, "cockpit" | "nodes" | "payments">;
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
export function CockpitGantt({
  board,
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
  const onSelect = onSelectNode;
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [directoryFailure, setDirectoryFailure] = useState<{ nodeId: string; reason: string } | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string; kind: "module" | "work_item" } | null>(null);
  const [confirming, setConfirming] = useState<{ kind: "delete" | "renumber"; row: PlanRow } | null>(null);
  const [conflict, setConflict] = useState<RunningTasksConflict | null>(null);
  const [deletingModule, setDeletingModule] = useState<PlanRow | null>(null);
  const renameRow = usePlanRowRename(wsId);
  const createModule = useCreateModule();
  const createWorkItem = useCreateCockpitWorkItem(wsId);
  const moveWorkItem = useMoveCockpitWorkItem(wsId);
  const deleteWorkItem = useDeleteCockpitWorkItem(wsId);
  const renumber = useRenumberCockpitChildren(wsId);
  const syncDirectory = useSyncNodeDirectory(wsId);
  const createKey = useRef<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTodayScroll = useRef({ nonce: 0, dayWidth: 0, axisStart: 0 });
  useCockpitScrollMemory(scrollRef, JSON.stringify([cockpitScopeViewKey(wsId, scope), "gantt"]), board.nodes.length > 0, JSON.stringify([query, [...rootIds].sort()]));

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const modules = useMemo(() => planModules(board.nodes), [board.nodes]);
  const scopedTree = useMemo(() => {
    if (rootIds.size === 0) return tree;
    const picked = tree.filter((entry) => rootIds.has(entry.node.id));
    return picked.length > 0 ? picked : tree;
  }, [tree, rootIds]);

  // Row codes are addresses, so they are built once over the whole tree: a
  // filtered or searched view must not renumber the rows under the reader.
  const rollups = useMemo(() => computeCockpitRollups(tree, today, taskCounts), [tree, today, taskCounts]);
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
  // Structure writes wait for the reconcile, exactly as the tree's do: a
  // board without rows can still be reconciled, and a missing stamp means
  // the module/work-item rows do not exist yet.
  const structureLocked = Boolean(readOnly) || (board.nodes.length > 0 && !board.cockpit.plan_reconciled_at);
  const failAction = (error: unknown) => setActionError(error instanceof Error ? error.message : String(error));
  // The collaboration root lives on the project; the tree composes paths from
  // data it already has and never stats the share.
  const projects = useQuery(projectListOptions(wsId));
  const collabByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects.data ?? []) {
      if (project.collab_path) map.set(project.id, project.collab_path);
    }
    return map;
  }, [projects.data]);
  const directoryPaths = useMemo(() => planDirectoryPaths(board.nodes, collabByProject), [board.nodes, collabByProject]);
  const pathActions = useLocalPathActions();
  // A structural write refused because an agent works in the folder: offer
  // "now" or "later" and re-run the same write with the choice.
  const reportDirectory = (nodeId: string, result?: { status: string; reason?: string; error?: string } | null) => {
    if (result?.status === "failed") {
      setDirectoryFailure({ nodeId, reason: result.error || result.reason || "" });
      return;
    }
    setDirectoryFailure((current) => (current?.nodeId === nodeId ? null : current));
  };
  const runRenumber = (nodeId: string, directorySync?: "sync" | "defer" | "force") =>
    renumber.mutateAsync({ nodeId, directorySync }).then(
      (result) => { setConflict(null); setActionError(null); setActionNotice(t(($) => $.plan_tree.renumber_done, { n: result?.changed ?? 0 })); const failed = result?.directory_results?.find((item) => item.status === "failed"); if (failed) reportDirectory(failed.node_id, failed); else setDirectoryFailure(null); },
      (error) => {
        if (isCockpitRunningTasksError(error)) {
          setConflict({ tasks: error.runningTasks, retry: (mode) => void runRenumber(nodeId, mode) });
          return;
        }
        failAction(error);
      },
    );
  const runMove = (nodeId: string, parentId: string, directorySync?: "sync" | "defer" | "force") =>
    moveWorkItem.mutateAsync({ id: nodeId, parent_id: parentId, directorySync }).then(
      (moved) => { setConflict(null); setActionNotice(t(($) => $.plan_tree.moved)); reportDirectory(nodeId, moved?.directory_sync); },
      (error) => {
        if (isCockpitRunningTasksError(error)) {
          setConflict({ tasks: error.runningTasks, retry: (mode) => void runMove(nodeId, parentId, mode) });
          return;
        }
        failAction(error);
      },
    );
  const filingOf = (row: PlanRow): { project_id: string; module_id: string } | null => {
    if (row.kind === "module") {
      return row.node.project_id && row.node.module_id
        ? { project_id: row.node.project_id, module_id: row.node.module_id } : null;
    }
    if (row.kind === "work_item") {
      const parent = row.node.parent_id ? nodeById.get(row.node.parent_id) : undefined;
      return parent?.project_id && parent.module_id
        ? { project_id: parent.project_id, module_id: parent.module_id } : null;
    }
    return null;
  };
  const submitCreate = async (row: PlanRow, name: string) => {
    try {
      if (creating?.kind === "module") {
        if (!row.node.project_id) return;
        await createModule.mutateAsync({ project_id: row.node.project_id, title: name });
      } else {
        if (!row.node.module_id) return;
        // A retry replays the same key instead of creating a second row.
        createKey.current ??= crypto.randomUUID();
        await createWorkItem.mutateAsync({ module_id: row.node.module_id, name, creation_key: createKey.current });
      }
      setCreating(null);
      createKey.current = null;
    } catch (error) {
      failAction(error);
    }
  };
  const runConfirmed = () => {
    if (!confirming) return;
    const row = confirming.row;
    const done = () => { setConfirming(null); setActionError(null); };
    const fail = (error: unknown) => { setConfirming(null); failAction(error); };
    if (confirming.kind === "delete") {
      deleteWorkItem.mutate(row.node.id, { onSuccess: done, onError: fail });
      return;
    }
    setConfirming(null);
    void runRenumber(row.node.id);
  };
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
    for (const entry of tree) map.set(entry.node.id, cockpitGoalProgress(entry, today, goalDate, taskCounts));
    return map;
  }, [tree, today, goalDate, taskCounts]);

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
      for (const group of cockpitCoreNodes(entry, today, taskCounts)) {
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
  }, [rows, today, axisStartKey, goalDate, rootOf, taskCounts]);

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
  const markerRows = renderedRows.filter(carriesMarkers).slice(0, 100)
    .map((entry) => ({ row_key: entry.node.id, node_ids: [entry.node.id] }));
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
      <CockpitViewHeading title={t(($) => $.tabs.gantt)} icon={ChartGantt} />
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

      {actionError && <div role="alert" className="flex items-center gap-2 border-b px-3 py-2 text-caption text-destructive"><span className="min-w-0 flex-1">{actionError}</span><button type="button" className="underline" onClick={() => setActionError(null)}>{t(($) => $.plan_tree.dismiss)}</button></div>}
      {actionNotice && <p role="status" className="border-b px-3 py-2 text-caption text-muted-foreground">{actionNotice}</p>}
      {directoryFailure && (
        <div role="alert" className="flex items-center gap-2 border-b px-3 py-2 text-caption text-destructive">
          <span className="min-w-0 flex-1">{t(($) => $.directories.sync_failed, { reason: directoryFailure.reason })}</span>
          <button type="button" className="underline" disabled={syncDirectory.isPending}
            onClick={() => syncDirectory.mutate({ nodeId: directoryFailure.nodeId }, {
              onSuccess: (answer) => reportDirectory(directoryFailure.nodeId, answer.directory_sync),
              onError: (error) => setDirectoryFailure({ nodeId: directoryFailure.nodeId, reason: error instanceof Error ? error.message : "" }),
            })}>{t(($) => $.directories.retry)}</button>
          <button type="button" className="underline" onClick={() => setDirectoryFailure(null)}>{t(($) => $.plan_tree.dismiss)}</button>
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
              const late = isCockpitNodeLate(node, today, taskCounts.get(node.id));
              const drifting = !late && isCockpitNodeDrifting(node, today, taskCounts.get(node.id));
              const budget = isBranch ? (rollup?.budget ?? 0) : (node.budget_amount ?? 0);
              const ownPayments = paymentsByNode.get(node.id) ?? [];
              const goal = isMainline ? goalProgress.get(node.id) : undefined;
              // The branch read is the subtask average, the figure the source
              // sheet scores merged groups by.
              const subtreeAvg = isBranch ? cockpitSubtreeAverage(entry, taskCounts) : null;
              const inheritedOwner =
                depth === 1 && !node.owner
                  ? (rootOwner.get(rootOf.byId.get(node.id) ?? "") ?? "")
                  : "";
              const planRow = planRowFor(node, depth, taskCounts.get(node.id) ?? null, isBranch);
              // A work item with issues reports their ratio and has no typed
              // field here either; the panel and this column must agree.
              const workCounts = taskCounts.get(node.id);
              // A structure row is not a work item even when nobody has broken
              // it down yet: it has no typed progress of its own.
              const isWorkItem = isCockpitWorkItem(node, depth);
              // Same rule as the panel and the summaries: a countable ratio
              // means the issues own the number; none means the typed one.
              const workRatio = isWorkItem ? cockpitIssueProgress(workCounts) : null;
              const hasIssues = workRatio != null;
              return (
                <div
                  key={node.id}
                  data-cockpit-node={node.id}
                  data-context-only={contextNodeIds.has(node.id) || undefined}
                  title={contextNodeIds.has(node.id) ? t(($) => $.plan_views.context_only) : undefined}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId((id) => (id === node.id ? null : id))}
                  onClick={toggleRow(entry)}
                  className={cn(
                    "group flex items-center gap-2 border-b border-border/50",
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
                  {creating?.parentId === node.id ? (
                    <CreateRow inline
                      label={creating.kind === "module" ? t(($) => $.plan_tree.new_module) : t(($) => $.plan_tree.new_work_item)}
                      onCancel={() => { setCreating(null); createKey.current = null; }}
                      onSubmit={(name) => submitCreate(planRow, name)} />
                  ) : (
                    <PlanRowName
                      row={planRow}
                      open={!collapsed.has(node.id)}
                      locked={readOnly || contextNodeIds.has(node.id) || planRowRenameTarget(planRow) == null}
                      renaming={renamingId === node.id}
                      compact={compact}
                      indent={INDENT}
                      expandable={isBranch}
                      onToggle={() => onToggleCollapse(node.id)}
                      onSelect={() => onSelect(node.id)}
                      onStartRename={() => { setActionError(null); setRenamingId(node.id); }}
                      onSubmitRename={async (name) => {
                        // L1/L2 titles live on the project/module record; a work
                        // item is renamed as a node. Same hook as the tree, and
                        // the same draft rule: a refusal keeps the editor open
                        // with what was typed, ready to retry.
                        try {
                          reportDirectory(node.id, await renameRow(planRow, name));
                          setRenamingId(null);
                        } catch (error) {
                          if (isCockpitRunningTasksError(error)) {
                            setConflict({
                              tasks: error.runningTasks,
                              retry: (mode) => {
                                setConflict(null);
                                void renameRow(planRow, name, mode).then((result) => { reportDirectory(node.id, result); setRenamingId(null); }).catch(failAction);
                              },
                            });
                            return;
                          }
                          setActionError(error instanceof Error ? error.message : String(error));
                        }
                      }}
                      onCancelRename={() => setRenamingId(null)}
                    />
                  )}
                  {!structureLocked && !contextNodeIds.has(node.id) && creating?.parentId !== node.id && (
                    <PlanRowActions
                      row={planRow}
                      modules={modules}
                      onAddChild={planRow.kind === "project"
                        ? () => { createKey.current = null; setCreating({ parentId: node.id, kind: "module" }); }
                        : planRow.kind === "module"
                          ? () => { createKey.current = null; setCreating({ parentId: node.id, kind: "work_item" }); }
                          : undefined}
                      onAddIssue={filingOf(planRow) ? () => {
                        const filing = filingOf(planRow)!;
                        useModalStore.getState().open("create-issue", {
                          project_id: filing.project_id, module_id: filing.module_id,
                          ...(planRow.kind === "work_item" ? { work_item_id: node.id } : {}),
                        });
                      } : undefined}
                      onMove={(parentId) => void runMove(node.id, parentId)}
                      directoryPath={planRow.kind === "project" ? null : directoryPaths.get(node.id) ?? null}
                      directoryDisabledReason={t(($) => $.directories.unavailable)}
                      onOpenDirectory={planRow.kind === "project" ? undefined : () => {
                        const path = directoryPaths.get(node.id);
                        if (path) void pathActions.open(path);
                      }}
                      onCopyDirectory={planRow.kind === "project" ? undefined : () => {
                        const path = directoryPaths.get(node.id);
                        if (path) void pathActions.copy(path);
                      }}
                      onRenumber={() => setConfirming({ kind: "renumber", row: planRow })}
                      onDelete={() => {
                        if (planRow.kind === "module") setDeletingModule(planRow);
                        else setConfirming({ kind: "delete", row: planRow });
                      }}
                    />
                  )}
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
                            disabled={readOnly || contextNodeIds.has(node.id)}
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
                        disabled={readOnly || contextNodeIds.has(node.id)}
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
                        disabled={readOnly || contextNodeIds.has(node.id)}
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
                        <span data-progress-empty className="text-caption text-faint-foreground">—</span>
                      )
                    ) : !isWorkItem ? (
                      // Nobody has broken this structure row down yet: the
                      // gantt draws no figure and there is nothing to type.
                      <span data-progress-empty className="text-caption text-faint-foreground">—</span>
                    ) : hasIssues ? (
                      <span className="text-caption tabular-nums text-muted-foreground">{workRatio}%</span>
                    ) : (
                      <ProgressField
                        value={node.progress}
                        onCommit={(progress) => onPatchNode(node.id, { progress })}
                        label={t(($) => $.node.progress)}
                        disabled={readOnly || contextNodeIds.has(node.id)}
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
                                    {node.code} {node.name}
                                  </DialogClose>
                                    <div>{t(($) => $.node.progress)}: {cockpitEffectiveProgress(node, taskCounts.get(node.id))}%</div>
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
                const code = node.code;
                const start = node.start_date ?? (isBranch ? (rollup?.start ?? null) : null);
                const end = node.end_date ?? (isBranch ? (rollup?.end ?? null) : null);
                const startDate = parseDay(start);
                const endDate = parseDay(end);
                const groups = paymentGroups.get(node.id) ?? [];
                const marks = coreMarks.get(node.id) ?? [];
                const meetingDays = meetingMarks.get(node.id) ?? [];
                const isSelected = selectedId === node.id;
                const barColor = isBranch
                  ? cockpitAggStatusColor(entry, taskCounts)
                  : cockpitStatusColor(node.status);
                // A structure row paints its leaves' average; one nobody has
                // broken down yet has no figure at all, not a stored one.
                const progress = isBranch || !isCockpitWorkItem(node, depth)
                  ? (cockpitSubtreeAverage(entry, taskCounts) ?? 0)
                  : cockpitEffectiveProgress(node, taskCounts.get(node.id));

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
                  title={contextNodeIds.has(node.id) ? t(($) => $.plan_views.context_only) : undefined}
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
                                  data-progress={Math.max(progress, 0)}
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
                        taskCounts={taskCounts}
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
      <ModuleDeleteDialog wsId={wsId} row={deletingModule} nodes={board.nodes} payments={board.payments}
        countsById={taskCounts} onOpenChange={(open) => { if (!open) setDeletingModule(null); }}
        onDeleted={() => { setDeletingModule(null); setActionNotice(t(($) => $.plan_tree.deleted)); }} />
      <AlertDialog open={confirming != null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.kind === "renumber" ? t(($) => $.plan_tree.renumber_confirm) : t(($) => $.plan_tree.delete)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.kind === "renumber"
                ? t(($) => $.plan_tree.renumber_confirm)
                : t(($) => $.plan_tree.delete_confirm, { n: confirming?.row.counts?.primary_total ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.plan_tree.cancel)}</AlertDialogCancel>
            <Button type="button" variant={confirming?.kind === "delete" ? "destructive" : "default"} onClick={runConfirmed}>
              {t(($) => $.plan_tree.confirm)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RunningTasksDialog conflict={conflict} onDismiss={() => setConflict(null)} />
    </div>
  );
}
