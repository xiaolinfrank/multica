"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { Blocks, Folder, ListTree, Plus } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { IconButton } from "@multica/ui/components/common/icon-button";
import { issueKeys } from "@multica/core/issues/queries";
import { projectSidebarSource } from "@multica/core/issues/sidebar-list";
import { cockpitNodeDetailOptions, cockpitPlanOptions, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useSidebarProjectPrefs, useUpdateSidebarProjectPrefs } from "@multica/core/issues/sidebar-project-prefs";
import { openCreateIssueWithPreference } from "@multica/core/issues/stores/create-mode-store";
import { useSidebarKeptStore } from "@multica/core/issues/stores/sidebar-kept-store";
import { useSidebarTreeStore } from "@multica/core/issues/stores/sidebar-tree-store";
import { useModalStore } from "@multica/core/modals";
import { useWorkspacePaths } from "@multica/core/paths";
import type { Issue, ListIssuesResponse, Project } from "@multica/core/types";
import { planModuleGroups, type PlanModuleGroup } from "../../plan-tree/plan-rows";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import {
  PANEL_ROW_CLASS,
  PanelCount,
  PanelLink,
  PanelList,
  PanelSection,
  isPathWithin,
  panelRowStateClass,
} from "../panel-nav";
import { ProjectsSectionSettings } from "./sidebar-settings";
import { TreeRow } from "./sidebar-tree";

const DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

function useExpanded(key: string) {
  const expanded = useSidebarTreeStore((s) => s.expanded.includes(key));
  const setExpanded = useSidebarTreeStore((s) => s.setExpanded);
  return [expanded, (next: boolean) => setExpanded(key, next)] as const;
}

/** Hovering a project warms the read its expansion will make: the same plan
 *  query the project page's left column uses, so the two share one cache. */
function usePrefetchPlan(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.prefetchQuery(cockpitPlanOptions(wsId, { projectId, moduleId: null }));
  };
}

/**
 * The id of the issue an expanded row lists or keeps under `ref` — its UUID,
 * or an identifier like `MUL-123` matched case-insensitively as the server
 * does — or `null` when no expanded row lists it.
 */
export function useIssueIdInTree(wsId: string, ref: string | null): string | null {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribeCache = cache.subscribe(onChange);
      const unsubscribeKept = useSidebarKeptStore.subscribe(onChange);
      return () => {
        unsubscribeCache();
        unsubscribeKept();
      };
    },
    [cache],
  );
  return useSyncExternalStore(subscribe, () => {
    if (!ref) return null;
    const identifier = ref.toUpperCase();
    const matches = (issue: Issue) => issue.id === ref || issue.identifier.toUpperCase() === identifier;
    const shown = (queryKey: readonly unknown[]) =>
      cache.findAll({ queryKey }).filter((query) => query.getObserversCount() > 0);
    for (const query of shown(issueKeys.sidebarAll(wsId))) {
      const issue = (query.state.data as ListIssuesResponse | undefined)?.issues?.find(matches);
      if (issue) return issue.id;
    }
    // A shown list keeps the open issue its query dropped (`useKeptActiveItem`).
    for (const [list, held] of Object.entries(useSidebarKeptStore.getState().held)) {
      const issue = qc.getQueryData<Issue>(issueKeys.detail(wsId, held.id));
      if (issue && matches(issue) && shown([...issueKeys.sidebarAll(wsId), list]).length > 0) return issue.id;
    }
    return null;
  });
}

interface ProjectsSectionProps {
  wsId: string;
  pathname: string;
  /** Already filtered and ordered by the section's settings. */
  projects: Project[];
  totalProjects: number;
  plainRowsLit: boolean;
}

export function ProjectsSection({
  wsId,
  pathname,
  projects,
  totalProjects,
  plainRowsLit,
}: ProjectsSectionProps) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const collapsed = useSidebarTreeStore((s) => s.projectsCollapsed);
  const setCollapsed = useSidebarTreeStore((s) => s.setProjectsCollapsed);
  const { projectSettings, projectOrder } = useSidebarProjectPrefs(wsId);
  // Where the page's `?node=` points — read only on a project page. The
  // cockpit's own address uses `?node=` too (`cockpitObjectPath`), and its
  // rows must not open or light up a sidebar whose links all lead to the
  // project page. Same test as the project row's own `active`, so the two
  // can never disagree about which project is open.
  const { searchParams } = useNavigation();
  const nodeParam = searchParams?.get("node") ?? null;
  const onProjectPage = projects.some((project) => isPathWithin(pathname, p.projectDetail(project.id)));
  const activeNodeId = plainRowsLit && onProjectPage ? nodeParam : null;
  const activeNode = useQuery({
    ...cockpitNodeDetailOptions(wsId, activeNodeId ?? "", EMPTY_COCKPIT_SCOPE),
    enabled: Boolean(activeNodeId && activeNodeId !== "none"),
  });
  const activeNodeRow = activeNode.data?.node ?? null;
  // Which project the selection lives in: the node read says, and for `none`
  // — which names no node — the open project page does.
  const activeProjectId =
    activeNodeId === "none"
      ? projects.find((project) => isPathWithin(pathname, p.projectDetail(project.id)))?.id ?? null
      : activeNode.data?.binding?.project_id ?? null;
  // Rows on an older board carry no `kind`; the parent chain does, and that is
  // the same fallback the plan tree reads (`planNodeKind`). Depth 0/1/2 is
  // project/module/work item — never the code.
  const activeDepth = activeNode.data?.ancestors?.length ?? 0;
  const activeKind =
    activeNodeRow?.kind ??
    (activeNodeRow ? (activeDepth >= 2 ? "work_item" : activeDepth === 1 ? "module" : "project") : null);
  const activeModuleRowId = activeKind === "module" ? activeNodeRow?.id ?? null : null;
  const activeModuleId = activeNodeRow
    ? activeKind === "work_item"
      ? activeNode.data?.binding?.module_id ?? null
      : activeNodeRow.module_id ?? null
    : null;
  const activeWorkItemId = activeKind === "work_item" ? activeNodeRow?.id ?? null : null;
  const updatePrefs = useUpdateSidebarProjectPrefs(wsId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id) return;
      const ids = projects.map((project) => project.id);
      const from = ids.indexOf(String(active.id));
      const to = ids.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      const moved = arrayMove(ids, from, to);
      updatePrefs({
        // Projects the filter hides keep their relative place after the shown ones.
        projectOrder: [...moved, ...projectOrder.filter((id) => !moved.includes(id))],
        projectSettings: { ordering: "manual" },
      });
    },
    [projects, projectOrder, updatePrefs],
  );

  return (
    <PanelSection
      label={t(($) => $.nav.projects)}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      action={
        <>
          <ProjectsSectionSettings wsId={wsId} className="opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(pointer:coarse)]:opacity-100" />
          <IconButton
            label={t(($) => $.panels.work.new_project)}
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => useModalStore.getState().open("create-project")}
          >
            <Plus />
          </IconButton>
        </>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={DRAG_MODIFIERS} onDragEnd={onDragEnd}>
        <SortableContext items={projects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
          <PanelList>
            {projects.map((project) => (
              <ProjectTreeItem
                key={project.id}
                wsId={wsId}
                project={project}
                active={plainRowsLit && isPathWithin(pathname, p.projectDetail(project.id))}
                showCount={projectSettings.showCount}
                activeNodeId={activeNodeId}
                activeProjectId={activeProjectId}
                activeModuleRowId={activeModuleRowId}
                activeModuleId={activeModuleId}
                activeWorkItemId={activeWorkItemId}
              />
            ))}
          </PanelList>
        </SortableContext>
      </DndContext>
      <PanelList className="mt-px">
        {totalProjects === 0 ? (
          <li>
            <button
              type="button"
              className={cn(
                PANEL_ROW_CLASS,
                panelRowStateClass(false),
                "w-full text-caption text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0",
              )}
              onClick={() => useModalStore.getState().open("create-project")}
            >
              <Plus aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-left">
                {t(($) => $.panels.work.new_project)}
              </span>
            </button>
          </li>
        ) : (
          <PanelLink
            href={p.projects()}
            icon={<span className="size-4" aria-hidden />}
            label={t(($) => $.panels.work.all_projects, { count: totalProjects })}
            active={pathname === p.projects()}
            className="text-caption"
          />
        )}
      </PanelList>
    </PanelSection>
  );
}

function ProjectTreeItem({
  wsId,
  project,
  active,
  showCount,
  activeNodeId,
  activeProjectId,
  activeModuleRowId,
  activeModuleId,
  activeWorkItemId,
}: {
  wsId: string;
  project: Project;
  active: boolean;
  showCount: boolean;
  /** The `?node=` on a project page for this project, or null. */
  activeNodeId: string | null;
  activeProjectId: string | null;
  activeModuleRowId: string | null;
  /** The module record the selected row sits under, so its list opens. */
  activeModuleId: string | null;
  activeWorkItemId: string | null;
}) {
  const { t } = useT("layout");
  const p = useWorkspacePaths();
  const listId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  const source = projectSidebarSource(project.id);
  const [expanded, setExpanded] = useExpanded(source);
  const prefetch = usePrefetchPlan(wsId, project.id);

  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  const wasDragged = useRef(false);
  useEffect(() => {
    if (isDragging) wasDragged.current = true;
  }, [isDragging]);

  // Arrive from a link that names a row inside this project: open the project
  // so the highlighted row is on screen. Keyed on the selection, so collapsing
  // it by hand afterwards sticks.
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (activeProjectId !== project.id) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === activeProjectId) return;
    openedFor.current = activeProjectId;
    setExpanded(true);
  }, [activeProjectId, project.id, setExpanded]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        isDragging &&
          "relative z-20 rounded-lg bg-surface-raised shadow-[var(--menu-shadow)] ring-1 ring-surface-border",
      )}
    >
      <TreeRow
        ref={linkRef}
        rowRef={setActivatorNodeRef}
        {...listeners}
        href={p.projectDetail(project.id)}
        label={project.title}
        icon={<Folder className="size-4 shrink-0" />}
        active={active}
        expanded={expanded}
        onExpandedChange={setExpanded}
        listId={listId}
        toggleLabel={t(($) => $.panels.work.project_plan, { name: project.title })}
        onPrefetch={prefetch}
        onNavigate={(event) => {
          if (!wasDragged.current) return;
          wasDragged.current = false;
          event.preventDefault();
        }}
        trailing={
          // The button takes the count's place on hover, so the row never reflows.
          <span className="relative flex h-5 min-w-5 items-center justify-end">
            {showCount && (
              <PanelCount
                value={project.issue_count - project.done_count}
                className="transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0 [@media(pointer:coarse)]:opacity-0"
              />
            )}
            <IconButton
              label={t(($) => $.panels.work.new_issue_in_project, { name: project.title })}
              size="icon-xs"
              className="absolute -right-2 z-10 text-muted-foreground opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => openCreateIssueWithPreference({ project_id: project.id })}
            >
              <Plus />
            </IconButton>
          </span>
        }
      />
      {expanded && (
        <ProjectPlanRows
          wsId={wsId}
          projectId={project.id}
          listId={listId}
          activeNodeId={activeProjectId === project.id ? activeNodeId : null}
          activeModuleRowId={activeModuleRowId}
          activeModuleId={activeModuleId}
          activeWorkItemId={activeWorkItemId}
        />
      )}
    </li>
  );
}

/** The plan's modules, each with its work items, under a project row.
 *
 *  This is the plan read, not the issue list: the tree answers "what is this
 *  project made of" (modules and work items, in plan order), and tasks live
 *  on the project page. A board that has not been reconciled, or a read that
 *  failed, falls back to the module records alone — the reason belongs on the
 *  project page, which has room to explain it.
 */
const WORK_ITEM_CAP = 20;
const PLAN_LIST_CLASS = "mb-2 ml-5 border-l border-surface-border pl-1.5";
const PLAN_CHILD_CLASS = "text-caption";

function ProjectPlanRows({
  wsId,
  projectId,
  listId,
  activeNodeId,
  activeModuleRowId,
  activeModuleId,
  activeWorkItemId,
}: {
  wsId: string;
  projectId: string;
  listId: string;
  activeNodeId: string | null;
  activeModuleRowId: string | null;
  activeModuleId: string | null;
  activeWorkItemId: string | null;
}) {
  const { t } = useT("projects");
  const p = useWorkspacePaths();
  const projectHref = p.projectDetail(projectId);
  const plan = useQuery(cockpitPlanOptions(wsId, { projectId, moduleId: null }));
  const data = plan.data;
  const ready = plan.isSuccess && Boolean(data?.cockpit?.plan_reconciled_at) && data?.complete === true;
  const fallback = useQuery({
    ...moduleListOptions(wsId, projectId),
    // Also on a failed read: `isError` is a settled answer too, and the
    // modules are what the tree can still show.
    enabled: (plan.isSuccess || plan.isError) && !ready,
  });
  const groups = useMemo(
    () => (ready && data ? planModuleGroups({ nodes: data.nodes, counts: data.task_counts }) : []),
    [data, ready],
  );

  if (!ready) {
    const modules = fallback.data ?? [];
    if (modules.length === 0) return null;
    // Unreconciled or unreadable: the module records still name the places
    // work can be filed, and the project page rewrites `?module=` to `?node=`.
    return (
      <ul id={listId} className={PLAN_LIST_CLASS}>
        {modules.map((module) => (
          <li key={module.id}>
            <TreeRow
              href={`${projectHref}?module=${encodeURIComponent(module.id)}`}
              label={module.title}
              icon={<Blocks className="size-4 shrink-0" />}
              active={false}
              className={PLAN_CHILD_CLASS}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul id={listId} className={PLAN_LIST_CLASS}>
      {groups.map((group) => (
        <PlanModuleItem
          key={group.moduleRow.node.id}
          group={group}
          projectHref={projectHref}
          activeModuleRowId={activeModuleRowId}
          activeModuleId={activeModuleId}
          activeWorkItemId={activeWorkItemId}
        />
      ))}
      <li>
        <TreeRow
          href={`${projectHref}?node=none`}
          label={t(($) => $.detail.no_module_row)}
          icon={<span className="size-4 shrink-0" aria-hidden />}
          active={activeNodeId === "none"}
          className={PLAN_CHILD_CLASS}
        />
      </li>
    </ul>
  );
}

function PlanModuleItem({
  group,
  projectHref,
  activeModuleRowId,
  activeModuleId,
  activeWorkItemId,
}: {
  group: PlanModuleGroup;
  projectHref: string;
  activeModuleRowId: string | null;
  activeModuleId: string | null;
  activeWorkItemId: string | null;
}) {
  const { t } = useT("projects");
  const { t: tl } = useT("layout");
  const row = group.moduleRow;
  const childListId = useId();
  // Its own key: a plan module is not the project row and not a view, and its
  // fold state must survive an unrelated expand elsewhere.
  const [open, setOpen] = useExpanded(`plan-module:${row.node.id}`);
  const active = activeModuleRowId === row.node.id;

  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeModuleId || row.node.module_id !== activeModuleId) return;
    if (openedFor.current === activeModuleId) return;
    openedFor.current = activeModuleId;
    setOpen(true);
  }, [activeModuleId, open, row.node.module_id, setOpen]);

  const shown = group.workItems.slice(0, WORK_ITEM_CAP);
  const hasMore = group.workItems.length > WORK_ITEM_CAP;

  return (
    <li>
      <TreeRow
        href={`${projectHref}?node=${encodeURIComponent(row.node.id)}`}
        label={`${row.code} ${row.name}`.trim()}
        icon={<Blocks className="size-4 shrink-0" />}
        active={active}
        expanded={open}
        onExpandedChange={setOpen}
        listId={childListId}
        toggleLabel={tl(($) => $.panels.work.module_plan, { name: row.name })}
        className={PLAN_CHILD_CLASS}
      />
      {open && (
        <ul id={childListId} className="mb-1 ml-4 border-l border-surface-border pl-1.5">
          {shown.map((item) => (
            <li key={item.node.id}>
              <TreeRow
                href={`${projectHref}?node=${encodeURIComponent(item.node.id)}`}
                label={`${item.code} ${item.name}`.trim()}
                icon={<ListTree className="size-3.5 shrink-0" />}
                active={activeWorkItemId === item.node.id}
                className="pl-6 text-caption"
              />
            </li>
          ))}
          {hasMore && (
            <li>
              <TreeRow
                href={`${projectHref}?node=${encodeURIComponent(row.node.id)}`}
                label={t(($) => $.module.view_all_work_items, { n: group.workItems.length })}
                icon={<span className="size-4 shrink-0" aria-hidden />}
                active={false}
                className="pl-6 text-caption text-muted-foreground"
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
