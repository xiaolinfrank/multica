"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Blocks, ChevronRight, FolderKanban, ListTree } from "@multica/ui/icons";
import { projectListOptions } from "@multica/core/projects/queries";
import { formatModuleTitle, formatProjectTitle, sortByCode } from "@multica/core/projects/coded-title";
import { moduleListOptions } from "@multica/core/modules/queries";
import {
  cockpitPlanOptions,
  cockpitScopeNodesInfiniteOptions,
  cockpitNodeDetailOptions,
  EMPTY_COCKPIT_SCOPE,
} from "@multica/core/cockpit";
import type { CockpitNodeChoice } from "@multica/core/types";
import { planModuleGroups } from "../../../plan-tree/plan-rows";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { ProjectIcon } from "../../../projects/components/project-icon";
import { useT } from "../../../i18n";
import { PICKER_TRIGGER_CLASS } from "./property-picker";

/** Where an issue is filed: a project, a module inside it, or a work item
 *  inside that module. Every create entry and the detail row share this one
 *  shape, so "the same ownership" means the same three fields everywhere. */
export interface IssueScopeValue {
  project_id: string | null;
  module_id: string | null;
  work_item_id: string | null;
}

export const EMPTY_ISSUE_SCOPE: IssueScopeValue = {
  project_id: null,
  module_id: null,
  work_item_id: null,
};

const PAGE_SIZE = 20;

/** The path's separator. Its own element with `whitespace-pre`: wrapping the
 *  text in a span alone does not keep the spaces — a flex item still trims
 *  its leading and trailing whitespace, and the path reads "Alpha/Module". */
function Separator() {
  return <span className="shrink-0 whitespace-pre">{" / "}</span>;
}

/** One persisted selection resolved independently of any list page — the
 *  trigger must name a work item the tree has not paged to. */
function useSelectedWorkItem(workItemId: string | null, wsId: string) {
  const query = useQuery({
    ...cockpitNodeDetailOptions(wsId, workItemId ?? "", EMPTY_COCKPIT_SCOPE),
    enabled: Boolean(workItemId),
  });
  return useMemo(() => {
    const node = query.data?.node;
    if (!node) return null;
    return { code: node.code, name: node.name };
  }, [query.data]);
}

/**
 * The ownership picker: projects → modules → work items, each level paged or
 * read only when its parent is open. Work items come from the server-side
 * selector (search + cursor paging, 20 a page) — never a whole-workspace plan
 * read. Modules and projects are the small, already-cached lists the rest of
 * the surface uses.
 */
export function IssueScopePicker({
  value,
  onUpdate,
  disabled = false,
  readOnly = false,
  mixed = false,
  restriction,
  triggerRender,
  trigger,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  display = "path",
  workItemLabel,
  scopeConstraint,
  allowClear = true,
  wsId,
}: {
  value: IssueScopeValue;
  onUpdate: (next: IssueScopeValue) => void;
  disabled?: boolean;
  /** Read-only: the trigger shows the current value and the menu never
   *  opens — used while a sub-issue's parent fixes the filing. */
  readOnly?: boolean;
  /** Mixed batch selection: show no pressed state and start collapsed. */
  mixed?: boolean;
  restriction?: React.ReactNode;
  triggerRender?: React.ReactElement;
  /** Custom trigger label (e.g. a compact "Ownership" label in batch toolbars). */
  trigger?: React.ReactNode;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** "path" names the whole filing ("Project / Module / 01.02.01 Name"), for
   *  the detail row and the dialogs. "leaf" names only the deepest choice —
   *  a table cell sits beside the project and module columns, so repeating
   *  them there would be noise. */
  display?: "path" | "leaf";
  /** The caller's already-resolved "code name" for `value.work_item_id`.
   *  A table row has one from its plan read; passing it keeps the trigger
   *  from re-reading the same node once per row. */
  workItemLabel?: string | null;
  /** Locks the picker to one project (or module) of the tree: a meeting
   *  opened under a scope may move inside it, never out of it. */
  scopeConstraint?: { projectId?: string | null; moduleId?: string | null };
  /** When false the "no project" choice is hidden — a caller that requires a
   *  filing does not offer a way to clear it. Defaults to true. */
  allowClear?: boolean;
  /** The workspace to read. Required rather than read from a route hook: the
   *  picker must render in a dialog or a test without one, and a silently
   *  empty workspace would query nothing. */
  wsId: string;
}) {
  const { t } = useT("issues");
  const [internalOpen, setInternalOpen] = useState(false);
  const locked = disabled || readOnly;
  const open = locked ? false : controlledOpen ?? internalOpen;
  const setOpen = locked ? () => {} : onOpenChange ?? setInternalOpen;
  const constrainedProjectId = scopeConstraint?.projectId ?? null;
  const constrainedModuleId = scopeConstraint?.moduleId ?? null;

  const { data: allProjects = [] } = useQuery(projectListOptions(wsId));
  const projects = useMemo(
    () => sortByCode(constrainedProjectId ? allProjects.filter((project) => project.id === constrainedProjectId) : allProjects),
    [allProjects, constrainedProjectId],
  );
  const [expandedProject, setExpandedProject] = useState<string | null>(
    mixed ? constrainedProjectId : (value.project_id ?? constrainedProjectId),
  );
  const [expandedModule, setExpandedModule] = useState<string | null>(
    mixed ? constrainedModuleId : (value.module_id ?? constrainedModuleId),
  );
  const [text, setText] = useState("");
  const query = text.trim();

  // Reopen on the selection: the tree should show where the issue is now.
  useEffect(() => {
    if (!open) return;
    setExpandedProject(mixed ? constrainedProjectId : (constrainedProjectId ?? value.project_id));
    setExpandedModule(mixed ? constrainedModuleId : (constrainedModuleId ?? value.module_id));
  }, [open, mixed, value.project_id, value.module_id, constrainedProjectId, constrainedModuleId]);

  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId, expandedProject ?? undefined),
    enabled: open && expandedProject !== null && query === "",
  });
  const visibleModules = useMemo(
    () => sortByCode(constrainedModuleId ? modules.filter((module) => module.id === constrainedModuleId) : modules),
    [modules, constrainedModuleId],
  );

  const searchMode = query !== "";

  // The plan is the only source of a module's work items, and its rows come
  // in plan order — the same order the tree, the field and the directory read
  // in. The id-ordered selector would list 01.02.15 before 01.02.01, which is
  // exactly what a reader filing work does not expect.
  const plan = useQuery({
    ...cockpitPlanOptions(wsId, {
      projectId: expandedProject,
      moduleId: expandedModule,
    }),
    enabled: open && !searchMode && expandedModule !== null,
  });
  const planUnavailableReason = plan.isError
    ? t(($) => $.pickers.scope.unavailable_error)
    : plan.isSuccess && !plan.data?.cockpit?.plan_reconciled_at
      ? t(($) => $.pickers.scope.unavailable_unreconciled)
      : null;

  const planItems = useMemo<CockpitNodeChoice[]>(() => {
    const data = plan.data;
    if (!data || !expandedModule) return [];
    // The module record's id and the plan row's id are not the same id: the
    // parent chain names the row, so the row is what children are matched on.
    // A read can carry more than one module row, so pick the one this level
    // opened on — by its module binding, never by position. A read that does
    // not contain that row lists nothing: falling back to the first module row
    // would show another module's work items under this one's name.
    const group = planModuleGroups({ nodes: data.nodes, counts: data.task_counts }).find(
      ({ moduleRow }) => moduleRow.node.module_id === expandedModule,
    );
    return (group?.workItems ?? [])
      .map((row) => ({
        id: row.node.id,
        code: row.code,
        title: row.name,
        project_id: expandedProject,
        module_id: expandedModule,
        // A row the plan lists under an open module is a leaf and fileable;
        // the plan is the authority on the tree's shape here.
        eligible: true,
        reason: "work_item",
      }));
  }, [plan.data, expandedProject, expandedModule]);

  // Search is the one list without a plan to order it: the server selector
  // matches across the whole workspace. It grows a page at a time — "more"
  // appends rather than replacing what is on screen.
  const search = useInfiniteQuery({
    // A locked picker searches only inside its range: paging the whole
    // workspace and filtering here would let another project's rows fill the
    // first page and read as "no work items".
    ...cockpitScopeNodesInfiniteOptions(wsId, {
      project_id: constrainedProjectId ?? undefined,
      module_id: constrainedModuleId ?? undefined,
      q: query,
      page_size: PAGE_SIZE,
    }),
    enabled: open && searchMode,
  });
  const searchItems = useMemo(
    () => (search.data?.pages.flatMap((page) => page.items) ?? []).filter(
      (item) =>
        (!constrainedProjectId || item.project_id === constrainedProjectId) &&
        (!constrainedModuleId || item.module_id === constrainedModuleId),
    ),
    [search.data, constrainedProjectId, constrainedModuleId],
  );

  // Built from every project, not the filtered list: a value that sits outside
  // the constraint — a default meeting folder in another project — still has
  // to read as its own name instead of "…".
  const projectById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project])),
    [allProjects],
  );
  const resolvedWorkItem = useSelectedWorkItem(workItemLabel != null ? null : value.work_item_id, wsId);
  const selectedWorkItem = workItemLabel != null
    ? { code: "", name: workItemLabel }
    : resolvedWorkItem;
  // The trigger names the module even when its project is not the expanded
  // one — read the whole workspace list for the label only.
  const { data: allModules = [] } = useQuery(moduleListOptions(wsId));
  const selectedModule = value.module_id
    ? allModules.find((module) => module.id === value.module_id)
    : undefined;
  // A module names its project, and a seeded value may carry only the module
  // (the project page's "+" does). The path still reads in full.
  const effectiveProjectId = value.project_id ?? selectedModule?.project_id ?? constrainedProjectId ?? null;
  const selectedProject = effectiveProjectId ? projectById.get(effectiveProjectId) : undefined;

  const commit = (next: IssueScopeValue) => {
    onUpdate(next);
    setText("");
    setOpen(false);
  };
  const chooseWorkItem = (node: CockpitNodeChoice) => {
    if (!node.eligible || !node.project_id || !node.module_id) return;
    commit({ project_id: node.project_id, module_id: node.module_id, work_item_id: node.id });
  };

  const hasValue = Boolean(value.project_id || value.module_id || value.work_item_id);
  const selectedProjectText = selectedProject
    ? formatProjectTitle(selectedProject)
    : effectiveProjectId
      ? "…"
      : "";
  const selectedModuleText = value.module_id
    ? selectedModule
      ? formatModuleTitle(selectedModule)
      : "…"
    : "";
  const workItemText = selectedWorkItem
    ? `${selectedWorkItem.code} ${selectedWorkItem.name}`.trim()
    : "…";
  // The full address survives as the tooltip: the segments below are allowed
  // to shorten, but nothing about the filing is lost to a reader.
  const fullPath = [
    selectedProjectText,
    selectedModuleText,
    value.work_item_id ? workItemText : "",
  ]
    .filter(Boolean)
    .join(" / ");
  // The visual path is three segments; its name is the path as one sentence.
  // Read from the segments instead, and the separator's spaces are trimmed at
  // each element boundary, leaving "Programme/01.02 Docking/01.02.01 Draft".
  const accessibleName =
    display === "leaf"
      ? value.work_item_id
        ? workItemText
        : t(($) => $.table.no_work_item)
      : hasValue
        ? fullPath
        : t(($) => $.pickers.scope.label);
  const label = (
    <span className="flex min-w-0 items-center gap-1" title={hasValue ? fullPath : undefined}>
      {value.work_item_id ? (
        <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
      ) : value.module_id ? (
        <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
      ) : value.project_id ? (
        <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="truncate">
        {value.project_id || value.module_id || value.work_item_id ? (
          <>
            {display === "leaf" ? (
              // A leaf cell stands for one level: the work-item column says
              // which work item, and an issue without one says exactly that
              // rather than borrowing the module or project it also has.
              value.work_item_id
                ? selectedWorkItem ? `${selectedWorkItem.code} ${selectedWorkItem.name}`.trim() : "…"
                : <span className="text-muted-foreground">{t(($) => $.table.no_work_item)}</span>
            ) : (
              // Three segments, not one string. A single truncate cuts the
              // tail off, and the tail is the work item — the level this row
              // exists to name. Measured in a browser: the work item must be
              // the segment that shrinks last and ellipsizes; if it holds its
              // width (`shrink-0`), the row overflows and the outer
              // `overflow-hidden` clips the end with no ellipsis at all.
              <span className="flex min-w-0 items-center">
                {/* Project and module give way first, down to `min-w-8` (a
                    character and an ellipsis), then the work item shrinks. */}
                <span className="min-w-8 shrink-[10000] truncate">
                  {selectedProjectText}
                </span>
                {value.module_id && (
                  <>
                    <Separator />
                    <span className="min-w-8 shrink-[100] truncate">{selectedModuleText}</span>
                  </>
                )}
                {value.work_item_id && (
                  <>
                    <Separator />
                    <span className="min-w-0 truncate">{workItemText}</span>
                  </>
                )}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{t(($) => $.pickers.scope.none)}</span>
        )}
      </span>
    </span>
  );

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) setText(""); setOpen(next); }}>
      <PopoverTrigger
        disabled={locked}
        render={triggerRender ?? (
          // Named by its value when it has one: a cell reading "Programme /
          // 01.02.01 Draft" is more useful to a screen reader than the field's
          // own name repeated on every row.
          <button type="button" disabled={locked} className={`${PICKER_TRIGGER_CLASS} max-w-full`}
            aria-label={accessibleName} />
        )}
      >
        {trigger ?? label}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(22rem,calc(100vw-2rem))] space-y-2">
        <Input
          value={text}
          name="issue-scope-search"
          autoComplete="off"
          spellCheck={false}
          aria-label={t(($) => $.pickers.scope.search)}
          placeholder={t(($) => $.pickers.scope.search)}
          onChange={(event) => setText(event.target.value)}
        />
        {restriction ? (
          <div className="text-caption">{restriction}</div>
        ) : null}
        {!readOnly && allowClear ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
            onClick={() => commit(EMPTY_ISSUE_SCOPE)}
          >
            {t(($) => $.pickers.scope.none)}
          </Button>
        ) : null}
        <div className="max-h-80 space-y-0.5 overflow-y-auto overscroll-contain">
          {searchMode ? (
            <WorkItemRows
              items={searchItems}
              query={queryState(search, null)}
              onSelect={chooseWorkItem}
              showBreadcrumb
              projectLabel={(id) => {
                const project = projectById.get(id);
                return project ? formatProjectTitle(project) : undefined;
              }}
            />
          ) : (
            <>
              {projects.map((project) => {
                const expanded = expandedProject === project.id;
                const projectText = formatProjectTitle(project);
                return (
                  <div key={project.id}>
                    <div className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${t(($) => $.pickers.scope.toggle_project)} ${projectText}`}
                        className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setExpandedProject(expanded ? null : project.id);
                          setExpandedModule(null);
                        }}
                      >
                        <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent"
                        aria-pressed={!mixed && value.project_id === project.id && value.module_id === constrainedModuleId && value.work_item_id === null}
                        title={projectText}
                        onClick={() => commit({ project_id: project.id, module_id: constrainedModuleId, work_item_id: null })}
                      >
                        <ProjectIcon project={project} size="sm" />
                        <span className="truncate">{projectText}</span>
                      </button>
                    </div>
                    {expanded ? (
                      <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                        {visibleModules.map((module) => {
                          const moduleOpen = expandedModule === module.id;
                          const moduleText = formatModuleTitle(module);
                          return (
                            <div key={module.id}>
                              <div className="flex min-w-0 items-center gap-1">
                                <button
                                  type="button"
                                  aria-expanded={moduleOpen}
                                  aria-label={`${t(($) => $.pickers.scope.toggle_module)} ${moduleText}`}
                                  className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => setExpandedModule(moduleOpen ? null : module.id)}
                                >
                                  <ChevronRight className={`size-3 transition-transform ${moduleOpen ? "rotate-90" : ""}`} />
                                </button>
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent"
                                  aria-pressed={!mixed && value.module_id === module.id && value.work_item_id === null}
                                  title={moduleText}
                                  onClick={() => commit({ project_id: module.project_id, module_id: module.id, work_item_id: null })}
                                >
                                  <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{moduleText}</span>
                                </button>
                              </div>
                              {moduleOpen ? (
                                <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                                  <WorkItemRows
                                    items={planItems}
                                    query={queryState(plan, planUnavailableReason)}
                                    unavailableReason={planUnavailableReason}
                                    onSelect={chooseWorkItem}
                                  />
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {visibleModules.length === 0 ? (
                          <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.no_modules)}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {projects.length === 0 ? (
                <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.no_projects)}</p>
              ) : null}
            </>
          )}
        </div>
        {searchMode && search.hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {t(($) => $.pickers.scope.more)}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** What the work-item list is showing: rows, a reason it cannot, a pending
 *  read, or nothing yet. Kept apart from the text so the tree's module level
 *  and the search level read the same answer. */
type WorkItemRowsState = "rows" | "pending" | "error" | "unavailable" | "idle";

function queryState(
  query: { isPending: boolean; isError: boolean; isSuccess: boolean },
  unavailableReason: string | null,
): WorkItemRowsState {
  if (unavailableReason) return "unavailable";
  if (query.isError) return "error";
  if (query.isPending) return "pending";
  return query.isSuccess ? "rows" : "idle";
}

function WorkItemRows({
  items,
  query,
  unavailableReason,
  onSelect,
  showBreadcrumb = false,
  projectLabel,
}: {
  items: readonly CockpitNodeChoice[];
  query: WorkItemRowsState;
  /** Why the list cannot answer — "the plan could not be read" and "the board
   *  has not been reconciled" are different problems with different fixes,
   *  so the list repeats the reason it was given instead of one generic line. */
  unavailableReason?: string | null;
  onSelect: (node: CockpitNodeChoice) => void;
  showBreadcrumb?: boolean;
  projectLabel?: (projectId: string) => string | undefined;
}) {
  const { t } = useT("issues");
  if (query === "pending") {
    return <p role="status" className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.loading)}</p>;
  }
  if (query === "unavailable") {
    return <p className="px-2 py-1 text-caption text-muted-foreground">{unavailableReason}</p>;
  }
  if (query === "error") {
    return <p role="alert" className="px-2 py-1 text-caption text-destructive">{t(($) => $.pickers.scope.work_items_failed)}</p>;
  }
  if (items.length === 0) {
    return <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.no_work_items)}</p>;
  }
  return (
    <>
      {items.map((node) => (
        <button
          key={node.id}
          type="button"
          disabled={!node.eligible}
          onClick={() => onSelect(node)}
          className="flex w-full min-w-0 flex-col rounded-xs px-1 py-1 text-left text-caption hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          title={`${node.code} ${node.title}`.trim()}
        >
          <span className="truncate">{`${node.code} ${node.title}`.trim()}</span>
          {showBreadcrumb && node.project_id ? (
            <span className="truncate text-micro text-muted-foreground">
              {projectLabel ? projectLabel(node.project_id) ?? "" : ""}
            </span>
          ) : null}
        </button>
      ))}
    </>
  );
}
