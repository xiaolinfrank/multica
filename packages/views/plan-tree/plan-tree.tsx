import { Fragment, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Ellipsis, Plus } from "@multica/ui/icons";
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
import type { CockpitNode } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../navigation";
import { buildPlanRows, planIssueProgress, planModules, type PlanRow } from "./plan-rows";

export interface PlanTreeProps {
  wsId: string;
  scope: CockpitScope;
  query: string;
  readOnly: boolean;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

const PAGE_SIZE = 20;
const EMPTY_COLLAPSED: string[] = [];

/** The plan as a treegrid. Rows come from cockpitPlanOptions; levels come from
 *  kind; every structure write waits for the server and shows its own refusal. */
export function PlanTree({ wsId, scope, query, readOnly, selectedId, onSelect }: PlanTreeProps) {
  const { t } = useT("cockpit");
  const viewKey = cockpitScopeViewKey(wsId, scope);
  const includeClosed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.includeClosedProjects ?? false);
  // Selected as the stored array, not a `?? []` default: a fresh array each
  // render makes the store subscription re-render forever.
  const storedCollapsed = useCockpitScopeViewStore((s) => s.plans[viewKey]?.collapsedIds);
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
  // toggle a single add/remove on collapsedIds.
  const seeded = useRef(false);
  if (!seeded.current && nodes.length > 0 && storedCollapsed === undefined) {
    seeded.current = true;
    const workItemIds = nodes.filter((n) => n.kind === "work_item").map((n) => n.id);
    queueMicrotask(() => updatePlan(viewKey, { collapsedIds: workItemIds }));
  }

  const rows = useMemo(
    () => buildPlanRows({ nodes, counts, expanded, query }),
    [nodes, counts, expanded, query],
  );

  const modules = useMemo(() => planModules(nodes), [nodes]);
  const confirmCounts = confirmDelete
    ? rows.find((r) => r.node.id === confirmDelete)?.counts?.primary_total ?? 0
    : 0;

  const setExpanded = (id: string, open: boolean) => {
    const next = new Set(collapsedIds);
    if (open) next.delete(id);
    else next.add(id);
    updatePlan(viewKey, { collapsedIds: [...next] });
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

  const openCreateIssue = (row: PlanRow) => {
    useModalStore.getState().open("create-issue", {
      project_id: row.node.project_id ?? undefined,
      module_id: row.node.module_id ?? undefined,
      ...(row.kind === "work_item"
        ? { cockpit_node: { node_id: row.node.id, code: row.node.code, name: row.node.name } }
        : {}),
    });
  };

  if (isPending) return <p className="p-3 text-caption text-muted-foreground">{t(($) => $.plan_tree.loading)}</p>;
  if (isError) return <p role="alert" className="p-3 text-caption text-destructive">{t(($) => $.plan_tree.load_failed)}</p>;

  return (
    <div className="flex flex-col">
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
      <div role="treegrid" aria-label={t(($) => $.plan_tree.label)} className="flex flex-col outline-none">
        {rows.map((row) => {
          const open = expanded.has(row.node.id);
          const progress = row.kind === "work_item" ? planIssueProgress(row.counts) : null;
          const editable = !structureLocked && !(data?.context_node_ids ?? []).includes(row.node.id);
          return (
            <Fragment key={row.node.id}>
            <div role="row" aria-level={row.depth + 1} aria-selected={selectedId === row.node.id}
              data-node-id={row.node.id} data-kind={row.kind}
              className="group flex items-center gap-1 border-b border-border/60 px-2 py-1 text-caption hover:bg-accent aria-selected:bg-accent">
              <span style={{ paddingLeft: row.depth * 14 }} className="flex shrink-0 items-center">
                {/* Every level expands: a work item's children are its issues,
                    which load on demand rather than with the tree. */}
                <button type="button" aria-label={open ? t(($) => $.plan_tree.collapse) : t(($) => $.plan_tree.expand)}
                  aria-expanded={open} onClick={() => setExpanded(row.node.id, !open)}
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
                  {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
                </button>
              </span>
              <button type="button" onClick={() => onSelect(row.node.id)}
                className="shrink-0 rounded-sm px-1 font-mono text-micro text-muted-foreground hover:text-foreground">
                {row.code}
              </button>
              {renaming === row.node.id ? (
                <InlineName defaultValue={row.name} disabled={!editable}
                  onSubmit={async (name) => {
                    try {
                      if (row.kind === "project") await updateProject.mutateAsync({ id: row.node.project_id ?? row.node.id, title: name });
                      else if (row.kind === "module") await updateModule.mutateAsync({ id: row.node.module_id ?? row.node.id, title: name });
                      else await renameWorkItem.mutateAsync({ id: row.node.id, name });
                      setRenaming(null);
                    } catch (e) { report(e); }
                  }}
                  onCancel={() => setRenaming(null)} />
              ) : (
                <button type="button" disabled={!editable}
                  onDoubleClick={() => setRenaming(row.node.id)}
                  onKeyDown={(e) => { if (e.key === "F2") setRenaming(row.node.id); }}
                  className="min-w-0 flex-1 truncate text-left" title={row.name}>
                  {row.name}
                </button>
              )}
              {progress !== null && (
                <span className="shrink-0 text-micro text-muted-foreground">{t(($) => $.plan_tree.progress, { n: progress })}</span>
              )}
              {row.counts && row.counts.primary_total > 0 && (
                <span className="shrink-0 text-micro text-muted-foreground">{t(($) => $.plan_tree.issue_count, { n: row.counts.primary_total })}</span>
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

/** A name field that commits on Enter and cancels on Escape. */
function InlineName({ defaultValue, disabled, onSubmit, onCancel }: {
  defaultValue: string; disabled: boolean;
  onSubmit: (name: string) => void | Promise<void>; onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <input autoFocus value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)}
      onBlur={() => { const next = value.trim(); if (next && next !== defaultValue) void onSubmit(next); else onCancel(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); const next = value.trim(); if (next) void onSubmit(next); else onCancel(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-caption" />
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
          <span style={{ paddingLeft: (depth + 1) * 14 }} className="inline-block size-3" aria-hidden />
          <button type="button" className="truncate text-left text-muted-foreground hover:text-foreground"
            onClick={() => navigation.push(paths.issueDetail(task.id))}>
            {task.identifier} {task.title}
          </button>
          <TaskBar due={task.due_date ?? null} />
        </div>
      ))}
      {total > items.length && (
        <div role="row" aria-level={depth + 2} className="px-2 py-0.5 text-micro">
          <span style={{ paddingLeft: (depth + 1) * 14 }} className="inline-block" />
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
