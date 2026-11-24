import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitNodeTasksOptions,
  cockpitPlanOptions,
  cockpitScopeViewKey,
  cockpitIssueProgress,
  useCockpitScopeViewStore,
  useCreateCockpitWorkItem,
  useDeleteCockpitWorkItem,
  useMoveCockpitWorkItem,
  useRenumberCockpitChildren,
  CockpitPlanWriteRefusedError,
  CockpitStatusNotInWorkflowError,
  type CockpitScope,
} from "@multica/core/cockpit";
import { useCreateModule } from "@multica/core/modules";
import { projectListOptions } from "@multica/core/projects/queries";
import { isCockpitRunningTasksError } from "@multica/core/cockpit";
import { useModalStore } from "@multica/core/modals";
import { useSyncNodeDirectory } from "@multica/core/directory";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { useLocale, useT } from "../i18n";
import { formatDateOnly } from "@multica/core/issues/date";
import type { CockpitNodePatch } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";
import { buildPlanRows, planModules, planNodeKind, type PlanRow } from "./plan-rows";
import { planRowRenameTarget, usePlanRowRename } from "./use-plan-row-rename";
import { PlanRowName } from "./plan-row-name";
import { CreateRow, PlanRowActions } from "./plan-row-actions";
import { ModuleDeleteDialog } from "./module-delete-dialog";
import { planDirectoryPaths } from "./plan-directory-paths";
import { RunningTasksDialog, type RunningTasksConflict } from "./running-tasks-dialog";
import { useLocalPathActions } from "../common/local-path-link";
import { EditableDate, EditableSuggest } from "../cockpit/components/cockpit-fields";
import { StatusChip } from "../cockpit/components/cockpit-status";
import { cn } from "@multica/ui/lib/utils";

export interface PlanTreeProps {
  wsId: string;
  scope: CockpitScope;
  query: string;
  readOnly: boolean;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  /** "tree" is the name column alone; "table" adds the plan's own columns
   *  (owner, status, planned dates, issue count) after it. */
  variant?: "tree" | "table";
  /** Makes the table's columns editable. Without it the table reads only. */
  onPatchNode?: (nodeId: string, patch: CockpitNodePatch) => void;
  ownerSuggestions?: string[];
  statusSuggestions?: string[];
  /** Restrict to these root branches; empty shows the whole plan. */
  rootIds?: ReadonlySet<string>;
  /** Whether a work item expands into its issues. The project page's tree
   *  stops at the work item — the issue list is the surface beside it — so it
   *  passes false instead of growing a second tree component. */
  showIssueRows?: boolean;
}

const PAGE_SIZE = 20;
const EMPTY_COLLAPSED: string[] = [];
const EMPTY_IDS: string[] = [];

/** The plan as a treegrid. Rows come from cockpitPlanOptions; levels come from
 *  kind; every structure write waits for the server and shows its own refusal. */
export function PlanTree({
  wsId, scope, query, readOnly, selectedId, onSelect,
  variant = "tree", onPatchNode, ownerSuggestions = [], statusSuggestions = [], rootIds,
  showIssueRows = true,
}: PlanTreeProps) {
  const { t } = useT("cockpit");
  const viewKey = cockpitScopeViewKey(wsId, scope);
  const includeClosed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.includeClosedProjects ?? false);
  // Selected as the stored array, not a `?? []` default: a fresh array each
  // render makes the store subscription re-render forever.
  const storedCollapsed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.treeCollapsedIds);
  const collapsedIds = storedCollapsed ?? EMPTY_COLLAPSED;
  const storedExpandedWorkItems = useCockpitScopeViewStore((s) => s.plans[viewKey]?.treeExpandedWorkItemIds);
  const expandedWorkItemIds = storedExpandedWorkItems ?? EMPTY_IDS;
  const updatePlan = useCockpitScopeViewStore((s) => s.updatePlan);
  const { data, isPending, isError } = useQuery(cockpitPlanOptions(wsId, scope, includeClosed));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string; kind: "module" | "work_item" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmRenumber, setConfirmRenumber] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingModule, setDeletingModule] = useState<PlanRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<RunningTasksConflict | null>(null);
  const [directoryFailure, setDirectoryFailure] = useState<{ nodeId: string; reason: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const createModule = useCreateModule();
  const renameRow = usePlanRowRename(wsId);
  const createWorkItem = useCreateCockpitWorkItem(wsId);
  const moveWorkItem = useMoveCockpitWorkItem(wsId);
  const deleteWorkItem = useDeleteCockpitWorkItem(wsId);
  const renumber = useRenumberCockpitChildren(wsId);
  const syncDirectory = useSyncNodeDirectory(wsId);
  const creationKey = useRef<string | null>(null);

  // A structural write can succeed while its folder operation did not (a
  // collision on the share, for example). Say so and keep one retry beside the
  // message instead of leaving the failure in the response.
  const reportDirectory = (nodeId: string, result?: { status: string; reason?: string; error?: string } | null) => {
    if (result?.status === "failed") {
      setDirectoryFailure({ nodeId, reason: result.error || result.reason || "" });
      return;
    }
    setDirectoryFailure((current) => (current?.nodeId === nodeId ? null : current));
  };
  const reportDirectoryResults = (result?: { directory_results?: { node_id: string; status: string; reason?: string; error?: string }[] | null } | null) => {
    const failed = result?.directory_results?.find((item) => item.status === "failed");
    if (failed) {
      setDirectoryFailure({ nodeId: failed.node_id, reason: failed.error || failed.reason || "" });
      return;
    }
    setDirectoryFailure(null);
  };

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const counts: readonly CockpitPlanTaskCount[] = useMemo(() => data?.task_counts ?? [], [data]);
  const contextNodeIds = useMemo(() => new Set(data?.context_node_ids ?? EMPTY_IDS), [data]);
  const unreconciled = data != null && !data.cockpit?.plan_reconciled_at && nodes.length > 0;
  const structureLocked = readOnly || unreconciled;

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  // The collaboration root lives on the project, the folder name on the row:
  // the path is composed from data already in hand, and the folder's actual
  // state is asked for only by the panel.
  const projects = useQuery(projectListOptions(wsId));
  const collabByProject = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects.data ?? []) {
      if (project.collab_path) map.set(project.id, project.collab_path);
    }
    return map;
  }, [projects.data]);
  const directoryPaths = useMemo(() => planDirectoryPaths(nodes, collabByProject), [nodes, collabByProject]);
  const pathActions = useLocalPathActions();
  const countsById = useMemo(() => new Map(counts.map((c) => [c.node_id, c])), [counts]);

  // Projects and modules are open unless folded; work items are closed unless
  // opened. The asymmetry is the point: a work item's children are its issues,
  // and expanding it is a read. Nothing is seeded, so the first paint of a
  // scope, a scope switch and a row that arrives later all start closed.
  const expanded = useMemo(() => {
    const open = new Set<string>();
    for (const node of nodes) {
      if (planNodeKind(node, byId) === "work_item") {
        if (expandedWorkItemIds.includes(node.id)) open.add(node.id);
      } else if (!collapsedIds.includes(node.id)) {
        open.add(node.id);
      }
    }
    return open;
  }, [nodes, byId, collapsedIds, expandedWorkItemIds]);

  const rows = useMemo(
    () => buildPlanRows({ nodes, counts, expanded, query, rootIds }),
    [nodes, counts, expanded, query, rootIds],
  );

  const modules = useMemo(() => planModules(nodes), [nodes]);
  const confirmCounts = confirmDelete
    ? rows.find((r) => r.node.id === confirmDelete)?.counts?.primary_total ?? 0
    : 0;

  const searching = query.trim().length > 0;
  const setRowOpen = useCallback((row: PlanRow, open: boolean) => {
    const state = useCockpitScopeViewStore.getState().plans[viewKey];
    if (row.kind === "work_item") {
      const next = new Set(state?.treeExpandedWorkItemIds ?? EMPTY_IDS);
      if (open) next.add(row.node.id);
      else next.delete(row.node.id);
      updatePlan(viewKey, { treeExpandedWorkItemIds: [...next] });
      return;
    }
    const next = new Set(state?.treeCollapsedIds ?? EMPTY_COLLAPSED);
    if (open) next.delete(row.node.id);
    else next.add(row.node.id);
    updatePlan(viewKey, { treeCollapsedIds: [...next] });
  }, [updatePlan, viewKey]);

  const parentRowOf = (row: PlanRow) => (row.node.parent_id ? byId.get(row.node.parent_id) : undefined);
  const paths = useWorkspacePaths();
  // "Open in the list" hands the project page the row itself (S6): the page
  // selects `?node=`, so the work item stays selected instead of only its
  // module. A work item's project is the module row above it.
  const projectListHref = (row: PlanRow): string | null => {
    const module = parentRowOf(row);
    if (!module?.project_id) return null;
    return `${paths.projectDetail(module.project_id)}?node=${encodeURIComponent(row.node.id)}`;
  };
  // A work item takes its filing from the module row above it (its own
  // project_id/module_id are null by design); a module carries its own. A
  // missing id disables the action instead of substituting the node's id,
  // which would call a project endpoint with a node id.
  const createScopeOf = (row: PlanRow): { project_id: string; module_id: string } | null => {
    if (row.kind === "module") {
      return row.node.project_id && row.node.module_id
        ? { project_id: row.node.project_id, module_id: row.node.module_id } : null;
    }
    if (row.kind === "work_item") {
      const module = parentRowOf(row);
      return module?.project_id && module.module_id
        ? { project_id: module.project_id, module_id: module.module_id } : null;
    }
    return null;
  };

  const openCreateIssue = (row: PlanRow) => {
    const scope = createScopeOf(row);
    if (!scope) return;
    // One seed shape everywhere: the three flat ids, never a nested blob.
    useModalStore.getState().open("create-issue", {
      project_id: scope.project_id,
      module_id: scope.module_id,
      ...(row.kind === "work_item" ? { work_item_id: row.node.id } : {}),
    });
  };

  const report = (e: unknown) => {
    if (e instanceof CockpitStatusNotInWorkflowError) {
      setError(t(($) => $.plan_tree.status_not_in_workflow, {
        issue: e.detail.issue, workflow: e.detail.workflow_name, statuses: e.detail.allowed_statuses.join(" / "),
      }));
    } else if (e instanceof CockpitPlanWriteRefusedError || e instanceof Error) {
      // The server's own message, never a generic "save failed".
      setError(e.message);
    } else setError(String(e));
  };

  // Arrow keys move a cursor over the rows without navigating: selection is
  // the detail panel's, the cursor is the keyboard's. Enter hands the row over.
  const activeIndex = activeId ? rows.findIndex((row) => row.node.id === activeId) : -1;
  const activeRow = activeIndex >= 0 ? rows[activeIndex]! : null;
  const focusRow = (nodeId: string) => {
    setActiveId(nodeId);
    queueMicrotask(() => gridRef.current?.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`)?.focus());
  };
  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const row = activeRow ?? rows[Math.max(0, Math.min(rows.length - 1, activeIndex))]!;
    const index = rows.indexOf(row);
    // A work item has no node children, but its issues load under it: it
    // expands like a branch for every keyboard and pointer purpose — unless
    // this tree stops at the work item.
    const expandable = row.hasChildren || (showIssueRows && row.kind === "work_item");
    // A search owns the visible set, so it locks the containers' folds. A
    // work item's issues are not part of that set: expanding one is a read
    // the query does not contradict, so it stays available.
    const foldable = !searching || row.kind === "work_item";
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); focusRow(rows[Math.min(rows.length - 1, index + 1)]!.node.id); break;
      case "ArrowUp": event.preventDefault(); focusRow(rows[Math.max(0, index - 1)]!.node.id); break;
      case "Home": event.preventDefault(); focusRow(rows[0]!.node.id); break;
      case "End": event.preventDefault(); focusRow(rows[rows.length - 1]!.node.id); break;
      // While a search filters the tree, a container's fold is not the
      // reader's call: the query decides what shows, so its arrows only move
      // the cursor. A work item folds as usual — its issues are a read.
      case "ArrowRight":
        event.preventDefault();
        if (foldable && expandable && !expanded.has(row.node.id)) setRowOpen(row, true);
        else if (expandable) focusRow(rows[Math.min(rows.length - 1, index + 1)]!.node.id);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (!foldable || !expandable || !expanded.has(row.node.id)) {
          const parent = rows.find((candidate) => candidate.node.id === row.node.parent_id);
          if (parent) focusRow(parent.node.id);
        } else setRowOpen(row, false);
        break;
      case "Enter": event.preventDefault(); onSelect(row.node.id); break;
      case " ":
        if (expandable && foldable) { event.preventDefault(); setRowOpen(row, !expanded.has(row.node.id)); }
        break;
      default: break;
    }
  };

  if (isPending) return <p className="p-3 text-caption text-muted-foreground">{t(($) => $.plan_tree.loading)}</p>;
  if (isError) return <p role="alert" className="p-3 text-caption text-destructive">{t(($) => $.plan_tree.load_failed)}</p>;

  const table = variant === "table";
  return (
    <div className={cn("flex flex-col", table && "min-h-0 flex-1")}>
      {unreconciled && (
        <p role="status" className="border-b border-border px-3 py-1.5 text-caption text-muted-foreground">
          {t(($) => $.plan_tree.unreconciled)}
        </p>
      )}
      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-caption text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>{t(($) => $.plan_tree.dismiss)}</button>
        </div>
      )}
      {notice && (
        <p role="status" className="border-b border-border px-3 py-1.5 text-caption text-muted-foreground">{notice}</p>
      )}
      {directoryFailure && (
        <div role="alert" className="flex items-start gap-2 border-b border-border px-3 py-1.5 text-caption text-destructive">
          <span className="min-w-0 flex-1">{t(($) => $.directories.sync_failed, { reason: directoryFailure.reason })}</span>
          <button type="button" className="underline" disabled={syncDirectory.isPending}
            onClick={() => syncDirectory.mutate({ nodeId: directoryFailure.nodeId }, {
              onSuccess: (answer) => reportDirectory(directoryFailure.nodeId, answer.directory_sync),
              onError: (error) => setDirectoryFailure({ nodeId: directoryFailure.nodeId, reason: error instanceof Error ? error.message : "" }),
            })}>{t(($) => $.directories.retry)}</button>
          <button type="button" className="underline" onClick={() => setDirectoryFailure(null)}>{t(($) => $.plan_tree.dismiss)}</button>
        </div>
      )}
      {confirmRenumber && (
        <div role="dialog" aria-label={t(($) => $.plan_tree.renumber_confirm)} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-caption">
          <span className="flex-1">{t(($) => $.plan_tree.renumber_confirm)}</span>
          <button type="button" className="text-primary" onClick={() => {
            const id = confirmRenumber;
            setConfirmRenumber(null);
            const attempt = (directorySync?: "sync" | "defer" | "force") =>
              renumber.mutateAsync({ nodeId: id, directorySync }).then(
                (result) => { setConflict(null); setNotice(t(($) => $.plan_tree.renumber_done, { n: result?.changed ?? 0 })); reportDirectoryResults(result); },
                (e) => {
                  if (isCockpitRunningTasksError(e)) {
                    setConflict({ tasks: e.runningTasks, retry: (mode) => void attempt(mode) });
                    return;
                  }
                  report(e);
                },
              );
            void attempt();
          }}>{t(($) => $.plan_tree.confirm)}</button>
          <button type="button" className="text-muted-foreground" onClick={() => setConfirmRenumber(null)}>{t(($) => $.plan_tree.cancel)}</button>
        </div>
      )}
      {confirmDelete && (
        <div role="dialog" aria-label={t(($) => $.plan_tree.delete)} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-caption">
          <span className="flex-1">{t(($) => $.plan_tree.delete_confirm, { n: confirmCounts })}
            <span className="ml-2 text-muted-foreground">{t(($) => $.directories.delete_keeps_folder)}</span>
          </span>
          <button type="button" className="text-destructive" onClick={() => {
            const id = confirmDelete;
            setConfirmDelete(null);
            // The server answers first; the row leaves the tree on the refetch it triggers.
            deleteWorkItem.mutate(id, { onSuccess: () => setNotice(t(($) => $.plan_tree.deleted)), onError: report });
          }}>{t(($) => $.plan_tree.confirm)}</button>
          <button type="button" className="text-muted-foreground" onClick={() => setConfirmDelete(null)}>{t(($) => $.plan_tree.cancel)}</button>
        </div>
      )}
      {table && (
        <div role="row" className="flex items-center gap-1 border-b border-border bg-background px-2 py-1 text-micro font-medium text-muted-foreground">
          <span role="columnheader" className="min-w-0 flex-1">{t(($) => $.plan_tree.column_name)}</span>
          <span role="columnheader" className="w-24 shrink-0 text-right">{t(($) => $.plan_tree.column_owner)}</span>
          <span role="columnheader" className="w-24 shrink-0 text-right">{t(($) => $.plan_tree.column_status)}</span>
          <span role="columnheader" className="w-52 shrink-0 text-right">{t(($) => $.plan_tree.column_dates)}</span>
          <span role="columnheader" className="w-28 shrink-0 text-right">{t(($) => $.plan_tree.column_issues)}</span>
          <span className="w-10 shrink-0" />
        </div>
      )}
      <div ref={gridRef} role="treegrid" aria-label={t(($) => $.plan_tree.label)} aria-multiselectable={false}
        onKeyDown={onGridKeyDown} className={cn("flex flex-col outline-none", table && "min-h-0 flex-1 overflow-y-auto")}>
        {rows.map((row) => {
          const open = expanded.has(row.node.id);
          const progress = row.kind === "work_item" ? cockpitIssueProgress(row.counts) : null;
          const editable = !structureLocked && !contextNodeIds.has(row.node.id);
          const patchable = !readOnly && onPatchNode != null && !contextNodeIds.has(row.node.id);
          const isActive = activeId != null ? activeId === row.node.id : selectedId === row.node.id;
          const expandable = row.hasChildren || (showIssueRows && row.kind === "work_item");
          // A search keeps a hit's parents on screen, so those rows read as
          // open while it runs — the query, not the stored fold, decides what
          // is visible. A work item's issues are not part of that filtered
          // set: its row reports the fold it actually has, and only then
          // reads them.
          const shownOpen = searching && row.kind !== "work_item" ? true : open;
          const canRename = planRowRenameTarget(row) != null;
          const canAddChild = row.kind === "project" ? Boolean(row.node.project_id) : row.kind === "module" ? Boolean(row.node.module_id) : false;
          const canAddIssue = createScopeOf(row) != null;
          return (
            <Fragment key={row.node.id}>
            <div role="row" aria-level={row.depth + 1} aria-selected={selectedId === row.node.id}
              aria-expanded={expandable ? shownOpen : undefined}
              tabIndex={isActive ? 0 : -1}
              data-node-id={row.node.id} data-kind={row.kind} data-active={isActive || undefined}
              onFocus={() => setActiveId(row.node.id)}
              onClick={(event) => {
                // A click anywhere on a branch row folds it, unless it landed
                // on a control — the gantt's rule, kept identical here. A
                // search is a filter, not a fold: the query decides what is
                // visible, so the click does nothing until it is cleared.
                if (!expandable) return;
                if (searching && row.kind !== "work_item") return;
                if ((event.target as HTMLElement).closest("button, a, input, textarea, select, [contenteditable=true]")) return;
                setRowOpen(row, !open);
              }}
              className={cn("group flex items-center gap-1 border-b border-border/60 px-2 py-1 text-caption hover:bg-accent aria-selected:bg-accent",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                row.kind === "project" && "bg-muted/30 font-semibold")}>
              <PlanRowName
                row={row}
                open={shownOpen}
                expandable={expandable}
                locked={!editable || !canRename}
                foldDisabled={searching && row.kind !== "work_item"}
                renaming={renaming === row.node.id}
                onToggle={() => setRowOpen(row, !open)}
                onSelect={() => onSelect(row.node.id)}
                onStartRename={() => setRenaming(row.node.id)}
                onSubmitRename={async (name) => {
                  try {
                    reportDirectory(row.node.id, await renameRow(row, name));
                    setRenaming(null);
                  } catch (e) {
                    // An agent working in the folder is a choice, not a
                    // failure: sync now, or write the row and let the panel
                    // move the folder later.
                    if (isCockpitRunningTasksError(e)) {
                      setConflict({
                        tasks: e.runningTasks,
                        retry: (mode) => {
                          setConflict(null);
                          void renameRow(row, name, mode).then((result) => { reportDirectory(row.node.id, result); setRenaming(null); }).catch(report);
                        },
                      });
                      return;
                    }
                    report(e);
                  }
                }}
                onCancelRename={() => setRenaming(null)}
                // Progress and task counts are `shrink-0`, so in the narrow
                // plan column they are what squeezed a work item's name down
                // to a character. A tree that shows no issue rows
                // (`showIssueRows={false}` — the project page's navigator) is
                // a name list, not a scoreboard: the row is a place to click.
                trailing={table || !showIssueRows ? undefined : (
                  <>
                    {progress !== null && (
                      <span className="shrink-0 text-micro text-muted-foreground">{t(($) => $.plan_tree.progress, { n: progress })}</span>
                    )}
                    {row.counts && row.counts.primary_total > 0 && (
                      <span className="shrink-0 text-micro text-muted-foreground">{t(($) => $.plan_tree.issue_count, { n: row.counts.primary_total })}</span>
                    )}
                  </>
                )}
              />
              {table && (
                <>
                  <div className="flex w-24 shrink-0 justify-end overflow-hidden">
                    <EditableSuggest value={row.node.owner} onCommit={(owner) => onPatchNode?.(row.node.id, { owner })}
                      suggestions={ownerSuggestions} label={t(($) => $.node.owner)}
                      placeholder={t(($) => $.common.unset)} disabled={!patchable} displayClassName="text-caption" />
                  </div>
                  <div className="flex w-24 shrink-0 justify-end overflow-hidden">
                    <EditableSuggest value={row.node.status} onCommit={(status) => onPatchNode?.(row.node.id, { status })}
                      suggestions={statusSuggestions} clearLabel={t(($) => $.node.status_unscheduled)}
                      label={t(($) => $.node.status)} placeholder={t(($) => $.common.unset)} disabled={!patchable}
                      renderDisplay={(value) => value ? <StatusChip status={value} /> : <span className="text-caption text-muted-foreground">{t(($) => $.gantt.status_unscheduled)}</span>} />
                  </div>
                  <div className="flex w-52 shrink-0 items-center justify-end gap-1 whitespace-nowrap text-micro text-muted-foreground">
                    <EditableDate value={row.node.start_date} onCommit={(start_date) => onPatchNode?.(row.node.id, { start_date })}
                      label={t(($) => $.node.start_date)} placeholder={t(($) => $.common.unset)} disabled={!patchable} />
                    <span aria-hidden>–</span>
                    <EditableDate value={row.node.end_date} onCommit={(end_date) => onPatchNode?.(row.node.id, { end_date })}
                      label={t(($) => $.node.end_date)} placeholder={t(($) => $.common.unset)} disabled={!patchable} />
                  </div>
                  <div className="flex w-28 shrink-0 justify-end whitespace-nowrap">
                    {row.counts && row.counts.primary_total + row.counts.reference_total > 0 ? (
                      <button type="button" onClick={() => onSelect(row.node.id)} className="rounded text-micro text-primary hover:underline">
                        {t(($) => $.plan_views.task_counts, { primary: row.counts.primary_total, reference: row.counts.reference_total })}
                      </button>
                    ) : <span className="text-micro text-faint-foreground">—</span>}
                  </div>
                </>
              )}
              {editable && (
                <PlanRowActions
                  row={row}
                  modules={modules}
                  onAddChild={row.kind !== "work_item" && canAddChild
                    ? () => { creationKey.current = null; setCreating({ parentId: row.node.id, kind: row.kind === "project" ? "module" : "work_item" }); }
                    : undefined}
                  onAddIssue={row.kind !== "project" && canAddIssue ? () => openCreateIssue(row) : undefined}
                  onMove={(parentId) => {
                    if (row.kind !== "work_item") return;
                    const attempt = (directorySync?: "sync" | "defer" | "force") =>
                      moveWorkItem.mutateAsync({ id: row.node.id, parent_id: parentId, directorySync }).then(
                        (moved) => { setConflict(null); setNotice(t(($) => $.plan_tree.moved)); reportDirectory(row.node.id, moved?.directory_sync); },
                        (e) => {
                          if (isCockpitRunningTasksError(e)) {
                            setConflict({ tasks: e.runningTasks, retry: (mode) => void attempt(mode) });
                            return;
                          }
                          report(e);
                        },
                      );
                    void attempt();
                  }}
                  directoryPath={row.kind === "project" ? null : directoryPaths.get(row.node.id) ?? null}
                  directoryDisabledReason={t(($) => $.directories.unavailable)}
                  onOpenDirectory={row.kind === "project" ? undefined : () => {
                    const path = directoryPaths.get(row.node.id);
                    if (path) void pathActions.open(path);
                  }}
                  onCopyDirectory={row.kind === "project" ? undefined : () => {
                    const path = directoryPaths.get(row.node.id);
                    if (path) void pathActions.copy(path);
                  }}
                  onRenumber={() => setConfirmRenumber(row.node.id)}
                  onDelete={() => {
                    if (row.kind === "module") setDeletingModule(row);
                    else setConfirmDelete(row.node.id);
                  }}
                />
              )}
            </div>
            {creating?.parentId === row.node.id && (
              <CreateRow
                label={creating.kind === "module" ? t(($) => $.plan_tree.new_module) : t(($) => $.plan_tree.new_work_item)}
                onCancel={() => { setCreating(null); creationKey.current = null; }}
                onSubmit={async (name) => {
                  try {
                    if (creating.kind === "module") {
                      if (!row.node.project_id) return;
                      await createModule.mutateAsync({ project_id: row.node.project_id, title: name });
                    } else {
                      if (!row.node.module_id) return;
                      // A retry reuses the key so the server replays the row
                      // it already made instead of creating a second one.
                      creationKey.current ??= crypto.randomUUID();
                      await createWorkItem.mutateAsync({ module_id: row.node.module_id, name, creation_key: creationKey.current });
                    }
                    setCreating(null);
                    creationKey.current = null;
                  } catch (e) { report(e); }
                }}
              />
            )}
            {showIssueRows && row.kind === "work_item" && open && (
              <IssueRows wsId={wsId} nodeId={row.node.id} depth={row.depth} listHref={projectListHref(row)} />
            )}
          </Fragment>
          );
        })}
      </div>

      <ModuleDeleteDialog wsId={wsId} row={deletingModule} nodes={nodes}
        payments={data?.payments ?? []} countsById={countsById}
        onOpenChange={(open) => { if (!open) setDeletingModule(null); }}
        onDeleted={() => { setDeletingModule(null); setNotice(t(($) => $.plan_tree.deleted)); }} />
      <RunningTasksDialog conflict={conflict} onDismiss={() => setConflict(null)} />
    </div>
  );
}

/** Issue rows under one work item: paged (20 a page) as the reader scrolls,
 *  never the whole list up front. */
function IssueRows({ wsId, nodeId, depth, listHref }: {
  wsId: string; nodeId: string; depth: number; listHref: string | null;
}) {
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const { t } = useT("cockpit");
  const locale = useLocale();
  const { data } = useQuery(cockpitNodeTasksOptions(wsId, nodeId, { page_size: PAGE_SIZE }));
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  if (items.length === 0) return null;
  return (
    <>
      {items.map((task) => (
        <div key={task.id} role="row" aria-level={depth + 2} className="flex items-center gap-1 border-b border-border/40 px-2 py-0.5 text-micro">
          <span style={{ paddingLeft: (depth + 1) * 14 + 8 }} className="inline-block size-3" aria-hidden />
          <button type="button" className="truncate text-left text-muted-foreground hover:text-foreground"
            onClick={() => navigation.push(paths.issueDetail(task.id))}>
            {task.identifier} {task.title}
          </button>
          {/* The task projection carries due_date but no start date, so the
              row states the deadline rather than drawing a span the server
              never sent. A bar in the gantt needs start_date added to the
              node-task response (a server change, S6+). */}
          {task.due_date && (
            <span className="ml-auto shrink-0 text-micro text-muted-foreground">
              {formatDateOnly(task.due_date, { month: "short", day: "numeric" }, locale)}
            </span>
          )}
        </div>
      ))}
      {total > items.length && (
        <div role="row" aria-level={depth + 2} className="px-2 py-0.5 text-micro">
          <span style={{ paddingLeft: (depth + 1) * 14 + 8 }} className="inline-block" />
          {listHref ? (
            <button type="button" className="text-primary hover:underline" onClick={() => navigation.push(listHref)}>
              {t(($) => $.plan_tree.issues_overflow, { n: total - items.length })}
            </button>
          ) : (
            <span className="text-muted-foreground">{t(($) => $.plan_tree.issues_overflow, { n: total - items.length })}</span>
          )}
        </div>
      )}
    </>
  );
}
