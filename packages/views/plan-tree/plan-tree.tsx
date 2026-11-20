import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ellipsis, Plus } from "@multica/ui/icons";
import {
  cockpitNodeTasksOptions,
  cockpitPlanOptions,
  cockpitScopeViewKey,
  useCockpitScopeViewStore,
  useCreateCockpitWorkItem,
  useDeleteCockpitWorkItem,
  useMoveCockpitWorkItem,
  useRenameCockpitWorkItem,
  useRenumberCockpitChildren,
  CockpitPlanWriteRefusedError,
  CockpitStatusNotInWorkflowError,
  type CockpitScope,
} from "@multica/core/cockpit";
import { useCreateModule, useDeleteModule, useUpdateModule } from "@multica/core/modules";
import { useUpdateProject } from "@multica/core/projects";
import { useModalStore } from "@multica/core/modals";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { useT } from "../i18n";
import type { CockpitNode, CockpitNodePatch } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";
import { buildPlanRows, planIssueProgress, planModules, type PlanRow } from "./plan-rows";
import { PlanRowName } from "./plan-row-name";
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
}

const PAGE_SIZE = 20;
const EMPTY_COLLAPSED: string[] = [];
const EMPTY_IDS: string[] = [];

/** The plan as a treegrid. Rows come from cockpitPlanOptions; levels come from
 *  kind; every structure write waits for the server and shows its own refusal. */
export function PlanTree({
  wsId, scope, query, readOnly, selectedId, onSelect,
  variant = "tree", onPatchNode, ownerSuggestions = [], statusSuggestions = [], rootIds,
}: PlanTreeProps) {
  const { t } = useT("cockpit");
  const viewKey = cockpitScopeViewKey(wsId, scope);
  const includeClosed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.includeClosedProjects ?? false);
  // Selected as the stored array, not a `?? []` default: a fresh array each
  // render makes the store subscription re-render forever.
  const storedCollapsed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.treeCollapsedIds);
  const collapsedIds = storedCollapsed ?? EMPTY_COLLAPSED;
  const updatePlan = useCockpitScopeViewStore((s) => s.updatePlan);
  const { data, isPending, isError } = useQuery(cockpitPlanOptions(wsId, scope, includeClosed));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string; kind: "module" | "work_item" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmRenumber, setConfirmRenumber] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const createModule = useCreateModule();
  const updateModule = useUpdateModule();
  const deleteModule = useDeleteModule();
  const updateProject = useUpdateProject();
  const createWorkItem = useCreateCockpitWorkItem(wsId);
  const renameWorkItem = useRenameCockpitWorkItem(wsId);
  const moveWorkItem = useMoveCockpitWorkItem(wsId);
  const deleteWorkItem = useDeleteCockpitWorkItem(wsId);
  const renumber = useRenumberCockpitChildren(wsId);
  const creationKey = useRef<string | null>(null);

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const counts: readonly CockpitPlanTaskCount[] = useMemo(() => data?.task_counts ?? [], [data]);
  const contextNodeIds = useMemo(() => new Set(data?.context_node_ids ?? EMPTY_IDS), [data]);
  const unreconciled = data != null && !data.cockpit?.plan_reconciled_at && nodes.length > 0;
  const structureLocked = readOnly || unreconciled;

  // collapsedIds is the single source of truth: every row is open unless it is
  // in that list, and the seed puts the work items in it. Deriving from
  // planDefaultExpanded instead would make a work item un-expandable, because
  // that set never contains one.
  const expanded = useMemo(() => {
    const open = new Set(nodes.map((n) => n.id));
    for (const id of collapsedIds) open.delete(id);
    return open;
  }, [nodes, collapsedIds]);

  // Seed once per scope: expand down to the work items, leave their issues for
  // a click. Storing the seed (rather than a second "opened" set) keeps the
  // toggle a single add/remove on treeCollapsedIds. An effect, not a render
  // side effect: the write lands with the mount, not after it.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || nodes.length === 0 || storedCollapsed !== undefined) return;
    seeded.current = true;
    const workItemIds = nodes.filter((n) => n.kind === "work_item").map((n) => n.id);
    updatePlan(viewKey, { treeCollapsedIds: workItemIds });
  }, [nodes, storedCollapsed, updatePlan, viewKey]);

  const rows = useMemo(
    () => buildPlanRows({ nodes, counts, expanded, query, rootIds }),
    [nodes, counts, expanded, query, rootIds],
  );

  const modules = useMemo(() => planModules(nodes), [nodes]);
  const confirmCounts = confirmDelete
    ? rows.find((r) => r.node.id === confirmDelete)?.counts?.primary_total ?? 0
    : 0;

  const setExpanded = useCallback((id: string, open: boolean) => {
    const next = new Set(useCockpitScopeViewStore.getState().plans[viewKey]?.treeCollapsedIds ?? EMPTY_COLLAPSED);
    if (open) next.delete(id);
    else next.add(id);
    updatePlan(viewKey, { treeCollapsedIds: [...next] });
  }, [updatePlan, viewKey]);

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

  const openCreateIssue = (row: PlanRow) => {
    useModalStore.getState().open("create-issue", {
      project_id: row.node.project_id ?? undefined,
      module_id: row.node.module_id ?? undefined,
      ...(row.kind === "work_item"
        ? { cockpit_node: { node_id: row.node.id, code: row.node.code, name: row.node.name } }
        : {}),
    });
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
    // expands like a branch for every keyboard and pointer purpose.
    const expandable = row.hasChildren || row.kind === "work_item";
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); focusRow(rows[Math.min(rows.length - 1, index + 1)]!.node.id); break;
      case "ArrowUp": event.preventDefault(); focusRow(rows[Math.max(0, index - 1)]!.node.id); break;
      case "Home": event.preventDefault(); focusRow(rows[0]!.node.id); break;
      case "End": event.preventDefault(); focusRow(rows[rows.length - 1]!.node.id); break;
      case "ArrowRight":
        event.preventDefault();
        if (expandable && !expanded.has(row.node.id)) setExpanded(row.node.id, true);
        else if (expandable) focusRow(rows[Math.min(rows.length - 1, index + 1)]!.node.id);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (expandable && expanded.has(row.node.id)) setExpanded(row.node.id, false);
        else {
          const parent = rows.find((candidate) => candidate.node.id === row.node.parent_id);
          if (parent) focusRow(parent.node.id);
        }
        break;
      case "Enter": event.preventDefault(); onSelect(row.node.id); break;
      case " ":
        if (expandable) { event.preventDefault(); setExpanded(row.node.id, !expanded.has(row.node.id)); }
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
      {confirmRenumber && (
        <div role="dialog" aria-label={t(($) => $.plan_tree.renumber_confirm)} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-caption">
          <span className="flex-1">{t(($) => $.plan_tree.renumber_confirm)}</span>
          <button type="button" className="text-primary" onClick={() => {
            const id = confirmRenumber;
            setConfirmRenumber(null);
            renumber.mutate(id, {
              onSuccess: (result) => setNotice(t(($) => $.plan_tree.renumber_done, { n: result?.changed ?? 0 })),
              onError: report,
            });
          }}>{t(($) => $.plan_tree.confirm)}</button>
          <button type="button" className="text-muted-foreground" onClick={() => setConfirmRenumber(null)}>{t(($) => $.plan_tree.cancel)}</button>
        </div>
      )}
      {confirmDelete && (
        <div role="dialog" aria-label={t(($) => $.plan_tree.delete)} className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-caption">
          <span className="flex-1">{t(($) => $.plan_tree.delete_confirm, { n: confirmCounts })}</span>
          <button type="button" className="text-destructive" onClick={() => {
            const id = confirmDelete;
            const row = rows.find((r) => r.node.id === id);
            setConfirmDelete(null);
            if (!row) return;
            const done = { onSuccess: () => setNotice(t(($) => $.plan_tree.deleted)), onError: report };
            // The server answers first; the row leaves the tree on the refetch it triggers.
            if (row.kind === "work_item") deleteWorkItem.mutate(id, done);
            else deleteModule.mutate(row.node.module_id ?? id, done);
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
          const progress = row.kind === "work_item" ? planIssueProgress(row.counts) : null;
          const editable = !structureLocked && !contextNodeIds.has(row.node.id);
          const patchable = !readOnly && onPatchNode != null && !contextNodeIds.has(row.node.id);
          const isActive = activeId != null ? activeId === row.node.id : selectedId === row.node.id;
          const expandable = row.hasChildren || row.kind === "work_item";
          return (
            <Fragment key={row.node.id}>
            <div role="row" aria-level={row.depth + 1} aria-selected={selectedId === row.node.id}
              aria-expanded={expandable ? open : undefined}
              tabIndex={isActive ? 0 : -1}
              data-node-id={row.node.id} data-kind={row.kind} data-active={isActive || undefined}
              onFocus={() => setActiveId(row.node.id)}
              onClick={(event) => {
                // A click anywhere on a branch row folds it, unless it landed
                // on a control — the gantt's rule, kept identical here.
                if (!expandable) return;
                if ((event.target as HTMLElement).closest("button, a, input, textarea, select, [contenteditable=true]")) return;
                setExpanded(row.node.id, !open);
              }}
              className={cn("group flex items-center gap-1 border-b border-border/60 px-2 py-1 text-caption hover:bg-accent aria-selected:bg-accent",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                row.kind === "project" && "bg-muted/30 font-semibold")}>
              <PlanRowName
                row={row}
                open={open}
                locked={!editable}
                renaming={renaming === row.node.id}
                onToggle={() => setExpanded(row.node.id, !open)}
                onSelect={() => onSelect(row.node.id)}
                onStartRename={() => setRenaming(row.node.id)}
                onSubmitRename={async (name) => {
                  try {
                    if (row.kind === "project") await updateProject.mutateAsync({ id: row.node.project_id ?? row.node.id, title: name });
                    else if (row.kind === "module") await updateModule.mutateAsync({ id: row.node.module_id ?? row.node.id, title: name });
                    else await renameWorkItem.mutateAsync({ id: row.node.id, name });
                    setRenaming(null);
                  } catch (e) { report(e); }
                }}
                onCancelRename={() => setRenaming(null)}
                trailing={table ? undefined : (
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
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  {row.kind !== "work_item" && (
                    <button type="button" aria-label={t(($) => $.plan_tree.add_child)}
                      onClick={() => { creationKey.current = null; setCreating({ parentId: row.node.id, kind: row.kind === "project" ? "module" : "work_item" }); }}
                      className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                      <Plus className="size-3" aria-hidden />
                    </button>
                  )}
                  {row.kind !== "project" && (
                    <button type="button" aria-label={t(($) => $.plan_tree.add_issue)} onClick={() => openCreateIssue(row)}
                      className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                      <Plus className="size-3" aria-hidden />
                    </button>
                  )}
                  <button type="button" aria-label={t(($) => $.plan_tree.more)} aria-expanded={menuId === row.node.id}
                    onClick={() => setMenuId(menuId === row.node.id ? null : row.node.id)}
                    className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                    <Ellipsis className="size-3" aria-hidden />
                  </button>
                </span>
              )}
              {menuId === row.node.id && (
                <RowMenu
                  row={row}
                  modules={modules}
                  onMove={(parentId) => {
                    setMenuId(null);
                    if (row.kind !== "work_item") return;
                    moveWorkItem.mutate({ id: row.node.id, parent_id: parentId }, {
                      onSuccess: () => setNotice(t(($) => $.plan_tree.moved)),
                      onError: report,
                    });
                  }}
                  onRenumber={() => { setMenuId(null); setConfirmRenumber(row.node.id); }}
                  onDelete={() => { setMenuId(null); setConfirmDelete(row.node.id); }}
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
                      await createModule.mutateAsync({ project_id: row.node.project_id ?? "", title: name });
                    } else {
                      // A retry reuses the key so the server replays the row
                      // it already made instead of creating a second one.
                      creationKey.current ??= crypto.randomUUID();
                      await createWorkItem.mutateAsync({ module_id: row.node.module_id ?? "", name, creation_key: creationKey.current });
                    }
                    setCreating(null);
                    creationKey.current = null;
                  } catch (e) { report(e); }
                }}
              />
            )}
            {row.kind === "work_item" && open && (
              <IssueRows wsId={wsId} nodeId={row.node.id} depth={row.depth} label={t(($) => $.plan_tree.issues_overflow)} />
            )}
          </Fragment>
          );
        })}
      </div>
    </div>
  );
}

export { planIssueProgress };

/** Issue rows under one work item: paged (20 a page) as the reader scrolls,
 *  never the whole list up front. */
function IssueRows({ wsId, nodeId, depth, label }: { wsId: string; nodeId: string; depth: number; label: string }) {
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
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
          <TaskBar due={task.due_date ?? null} />
        </div>
      ))}
      {total > items.length && (
        <div role="row" aria-level={depth + 2} className="px-2 py-0.5 text-micro">
          <span style={{ paddingLeft: (depth + 1) * 14 + 8 }} className="inline-block" />
          <button type="button" className="text-primary hover:underline" onClick={() => navigation.push(paths.issueDetail(nodeId))}>
            {label.replace("{{n}}", String(total - items.length))}
          </button>
        </div>
      )}
    </>
  );
}

/** The issue's due marker. The cockpit task projection carries `due_date` but
 *  no start date, so the row shows a marker rather than a span — drawing one
 *  would invent the start the server never sent. */
function TaskBar({ due }: { due: string | null }) {
  if (!due) return null;
  return <span className="ml-auto h-1 w-16 shrink-0 rounded-full bg-muted" aria-hidden title={due} />;
}

/** Inline create field for a module or a work item. */
function CreateRow({ label, onSubmit, onCancel }: {
  label: string; onSubmit: (name: string) => void | Promise<void>; onCancel: () => void;
}) {
  const { t: t2 } = useT("cockpit");
  const [value, setValue] = useState("");
  return (
    <div role="row" className="flex items-center gap-1 border-b border-border/60 bg-muted/40 px-2 py-1 text-caption">
      <input autoFocus value={value} placeholder={label} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); const next = value.trim(); if (next) void onSubmit(next); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-caption" />
      <button type="button" className="text-primary" disabled={!value.trim()}
        onClick={() => { const next = value.trim(); if (next) void onSubmit(next); }}>↵</button>
      <button type="button" className="text-muted-foreground" onClick={onCancel}>{t2(($) => $.plan_tree.cancel)}</button>
    </div>
  );
}

/** The row's "…" menu. Only the actions the level supports appear. */
function RowMenu({ row, modules, onMove, onRenumber, onDelete }: {
  row: PlanRow;
  modules: CockpitNode[];
  onMove: (parentId: string) => void;
  onRenumber: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("cockpit");
  const [moving, setMoving] = useState(false);
  return (
    <div role="menu" className="flex flex-col gap-1 border-b border-border/60 bg-popover px-3 py-1.5 text-caption">
      {row.kind === "work_item" && !moving && (
        <button type="button" role="menuitem" className="text-left" onClick={() => setMoving(true)}>{t(($) => $.plan_tree.move)}</button>
      )}
      {moving && (
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">{t(($) => $.plan_tree.move_to)}</span>
          <select className="rounded-sm border border-input bg-background px-1" defaultValue=""
            onChange={(e) => { if (e.target.value) onMove(e.target.value); }}>
            <option value="" disabled>{t(($) => $.plan_tree.choose_module)}</option>
            {modules.filter((m) => m.id !== row.node.parent_id).map((m) => (
              <option key={m.id} value={m.id}>{m.code} {m.name}</option>
            ))}
          </select>
        </label>
      )}
      {row.kind !== "work_item" && (
        <button type="button" role="menuitem" className="text-left" onClick={onRenumber}>{t(($) => $.plan_tree.renumber)}</button>
      )}
      {row.kind !== "project" && (
        <button type="button" role="menuitem" className="text-left text-destructive" onClick={onDelete}>{t(($) => $.plan_tree.delete)}</button>
      )}
    </div>
  );
}
