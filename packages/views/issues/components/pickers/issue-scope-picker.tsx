"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, ChevronRight, FolderKanban, ListTree } from "@multica/ui/icons";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import {
  cockpitContextOptions,
  cockpitScopeNodesOptions,
  cockpitNodeDetailOptions,
  EMPTY_COCKPIT_SCOPE,
} from "@multica/core/cockpit";
import type { CockpitNodeChoice } from "@multica/core/types";
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

/** One persisted selection resolved independently of any list page — the
 *  trigger must name a work item the tree has not paged to. */
function useSelectedWorkItem(workItemId: string | null) {
  const wsId = useWorkspaceId();
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
  restriction,
  triggerRender,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  display = "path",
  workItemLabel,
}: {
  value: IssueScopeValue;
  onUpdate: (next: IssueScopeValue) => void;
  disabled?: boolean;
  /** Read-only: the trigger shows the current value and the menu never
   *  opens — used while a sub-issue's parent fixes the filing. */
  readOnly?: boolean;
  restriction?: React.ReactNode;
  triggerRender?: React.ReactElement;
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
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("issues");
  const [internalOpen, setInternalOpen] = useState(false);
  const locked = disabled || readOnly;
  const open = locked ? false : controlledOpen ?? internalOpen;
  const setOpen = locked ? () => {} : onOpenChange ?? setInternalOpen;

  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const [expandedProject, setExpandedProject] = useState<string | null>(value.project_id);
  const [expandedModule, setExpandedModule] = useState<string | null>(value.module_id);
  const [text, setText] = useState("");
  const [cursors, setCursors] = useState<string[]>([""]);
  const query = text.trim();

  // Reopen on the selection: the tree should show where the issue is now.
  useEffect(() => {
    if (!open) return;
    setExpandedProject(value.project_id);
    setExpandedModule(value.module_id);
  }, [open, value.project_id, value.module_id]);

  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId, expandedProject ?? undefined),
    enabled: open && expandedProject !== null && query === "",
  });

  // The plan is the only source of work items. A board that has not been
  // reconciled has no skeleton rows to file under yet, and a failed read must
  // say so rather than present an empty list as "there are none".
  const context = useQuery({
    ...cockpitContextOptions(wsId, EMPTY_COCKPIT_SCOPE),
    enabled: open,
  });
  const planUnavailableReason = context.isError
    ? t(($) => $.pickers.scope.unavailable_error)
    : context.isSuccess && (!context.data.cockpit || !context.data.cockpit.plan_reconciled_at)
      ? t(($) => $.pickers.scope.unavailable_unreconciled)
      : null;

  // Work items of the open module (tree) or of the whole workspace (search).
  const searchMode = query !== "";
  const workItemParams = searchMode
    ? { q: query, cursor: cursors.at(-1) || undefined, page_size: PAGE_SIZE }
    : { module_id: expandedModule ?? undefined, cursor: cursors.at(-1) || undefined, page_size: PAGE_SIZE };
  const workItems = useQuery({
    ...cockpitScopeNodesOptions(wsId, workItemParams),
    enabled:
      open &&
      planUnavailableReason === null &&
      context.isSuccess &&
      (searchMode ? true : expandedModule !== null),
  });
  const items = workItems.data?.items ?? [];

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const resolvedWorkItem = useSelectedWorkItem(workItemLabel != null ? null : value.work_item_id);
  const selectedWorkItem = workItemLabel != null
    ? { code: "", name: workItemLabel }
    : resolvedWorkItem;
  // The trigger names the module even when its project is not the expanded
  // one — read the whole workspace list for the label only.
  const { data: allModules = [] } = useQuery(moduleListOptions(wsId));
  const selectedModule = value.module_id
    ? allModules.find((module) => module.id === value.module_id)
    : undefined;
  const selectedProject = value.project_id ? projectById.get(value.project_id) : undefined;

  const commit = (next: IssueScopeValue) => {
    onUpdate(next);
    setText("");
    setCursors([""]);
    setOpen(false);
  };
  const chooseWorkItem = (node: CockpitNodeChoice) => {
    if (!node.eligible || !node.project_id || !node.module_id) return;
    commit({ project_id: node.project_id, module_id: node.module_id, work_item_id: node.id });
  };

  const hasValue = Boolean(value.project_id || value.module_id || value.work_item_id);
  const label = (
    <span className="flex min-w-0 items-center gap-1">
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
              value.work_item_id
                ? selectedWorkItem ? `${selectedWorkItem.code} ${selectedWorkItem.name}`.trim() : "…"
                : value.module_id
                  ? selectedModule?.title ?? "…"
                  : selectedProject?.title ?? "…"
            ) : (
              <>
                {selectedProject?.title ?? (value.project_id ? "…" : "")}
                {value.module_id && ` / ${selectedModule?.title ?? "…"}`}
                {value.work_item_id && ` / ${selectedWorkItem ? `${selectedWorkItem.code} ${selectedWorkItem.name}`.trim() : "…"}`}
              </>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{t(($) => $.pickers.scope.none)}</span>
        )}
      </span>
    </span>
  );

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) { setText(""); setCursors([""]); } setOpen(next); }}>
      <PopoverTrigger
        disabled={locked}
        render={triggerRender ?? (
          // Named by its value when it has one: a cell reading "Programme /
          // 01.02.01 Draft" is more useful to a screen reader than the field's
          // own name repeated on every row.
          <button type="button" disabled={locked} className={`${PICKER_TRIGGER_CLASS} max-w-full`}
            aria-label={hasValue ? undefined : t(($) => $.pickers.scope.label)} />
        )}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(22rem,calc(100vw-2rem))] space-y-2">
        <Input
          value={text}
          name="issue-scope-search"
          autoComplete="off"
          spellCheck={false}
          aria-label={t(($) => $.pickers.scope.search)}
          placeholder={t(($) => $.pickers.scope.search)}
          onChange={(event) => { setText(event.target.value); setCursors([""]); }}
        />
        {restriction ? (
          <div className="text-caption">{restriction}</div>
        ) : null}
        {!readOnly ? (
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
              items={items}
              query={searchItemsState(workItems, planUnavailableReason)}
              onSelect={chooseWorkItem}
              showBreadcrumb
              projectLabel={(id) => projectById.get(id)?.title}
            />
          ) : (
            <>
              {projects.map((project) => {
                const expanded = expandedProject === project.id;
                return (
                  <div key={project.id}>
                    <div className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${t(($) => $.pickers.scope.toggle_project)} ${project.title}`}
                        className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setExpandedProject(expanded ? null : project.id);
                          setExpandedModule(null);
                          setCursors([""]);
                        }}
                      >
                        <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent"
                        aria-pressed={value.project_id === project.id && value.module_id === null}
                        onClick={() => commit({ project_id: project.id, module_id: null, work_item_id: null })}
                      >
                        <ProjectIcon project={project} size="sm" />
                        <span className="truncate">{project.title}</span>
                      </button>
                    </div>
                    {expanded ? (
                      <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                        {modules.map((module) => {
                          const moduleOpen = expandedModule === module.id;
                          return (
                            <div key={module.id}>
                              <div className="flex min-w-0 items-center gap-1">
                                <button
                                  type="button"
                                  aria-expanded={moduleOpen}
                                  aria-label={`${t(($) => $.pickers.scope.toggle_module)} ${module.title}`}
                                  className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    setExpandedModule(moduleOpen ? null : module.id);
                                    setCursors([""]);
                                  }}
                                >
                                  <ChevronRight className={`size-3 transition-transform ${moduleOpen ? "rotate-90" : ""}`} />
                                </button>
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent"
                                  aria-pressed={value.module_id === module.id && value.work_item_id === null}
                                  onClick={() => commit({ project_id: module.project_id, module_id: module.id, work_item_id: null })}
                                >
                                  <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
                                  <span className="truncate">{module.title}</span>
                                </button>
                              </div>
                              {moduleOpen ? (
                                <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                                  <WorkItemRows
                                    items={items}
                                    query={searchItemsState(workItems, planUnavailableReason)}
                                    onSelect={chooseWorkItem}
                                  />
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                        {modules.length === 0 ? (
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
        {workItems.data?.next_cursor ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={workItems.isFetching}
            onClick={() => {
              const next = workItems.data?.next_cursor;
              if (next) setCursors((old) => [...old, next]);
            }}
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

function searchItemsState(
  query: { isPending: boolean; isError: boolean; isSuccess: boolean; data?: { items: CockpitNodeChoice[] } },
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
  onSelect,
  showBreadcrumb = false,
  projectLabel,
}: {
  items: readonly CockpitNodeChoice[];
  query: WorkItemRowsState;
  onSelect: (node: CockpitNodeChoice) => void;
  showBreadcrumb?: boolean;
  projectLabel?: (projectId: string) => string | undefined;
}) {
  const { t } = useT("issues");
  if (query === "pending") {
    return <p role="status" className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.loading)}</p>;
  }
  if (query === "unavailable") {
    return <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.pickers.scope.unavailable)}</p>;
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
