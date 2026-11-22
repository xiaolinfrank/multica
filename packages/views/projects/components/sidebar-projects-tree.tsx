"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Blocks, ChevronRight, Plus } from "@multica/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useModalStore } from "@multica/core/modals";
import {
  cockpitNodeDetailOptions,
  cockpitScopeNodesOptions,
  EMPTY_COCKPIT_SCOPE,
} from "@multica/core/cockpit";
import type { Module, Project } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@multica/ui/components/ui/sidebar";
import { CappedNumberFlow } from "@multica/ui/components/ui/number-flow";
import { AppLink, useNavigation } from "../../navigation";
import { ProjectIcon } from "./project-icon";
import { useT } from "../../i18n";

// Mirrors NAV_ITEM_CLASS_NAME in app-sidebar.tsx (kept local: exporting one
// class string across the sidebar would couple the two files for a visual
// detail).
const ROW_CLASS_NAME =
  "text-muted-foreground hover:not-data-active:bg-sidebar-accent/70 data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground";

/** True while the route is the project's own page or anything under it. */
function isOnProject(pathname: string, projectHref: string) {
  return pathname === projectHref || pathname.startsWith(projectHref + "/");
}

/** One module's work items, read when (and only when) that module is open.
 *  Twenty a page from the server selector — the sidebar never reads a whole
 *  workspace plan to draw a navigation list. */
function ModuleWorkItems({
  wsId,
  projectId,
  moduleId,
  projectHref,
  activeNodeId,
}: {
  wsId: string;
  /** The module's project: the selector refuses a module on its own. */
  projectId: string;
  moduleId: string;
  projectHref: string;
  activeNodeId: string | null;
}) {
  const { t } = useT("projects");
  const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery(
    cockpitScopeNodesOptions(wsId, {
      project_id: projectId,
      module_id: moduleId,
      eligible: false,
      page_size: 20,
      cursor: cursors.at(-1) || undefined,
    }),
  );
  // An unreconciled board has no rows to name, and a refused read is not the
  // reader's problem to fix from a navigation list: both stay silent.
  if (query.isError || (query.isSuccess && !query.data)) return null;
  const items = query.data?.items ?? [];
  if (query.isPending) return null;
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => (
        <SidebarMenuItem key={item.id}>
          <SidebarMenuButton
            size="sm"
            isActive={activeNodeId === item.id}
            render={<AppLink href={`${projectHref}?node=${encodeURIComponent(item.id)}`} />}
            className={cn("pl-12", ROW_CLASS_NAME)}
          >
            <span className="truncate text-caption">{`${item.code} ${item.title}`.trim()}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
      {query.data?.next_cursor ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            className="pl-12"
            disabled={query.isFetching}
            onClick={() => {
              const next = query.data?.next_cursor;
              if (next) setCursors((old) => [...old, next]);
            }}
          >
            <span className="truncate text-caption text-muted-foreground">{t(($) => $.module.more_work_items)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
    </>
  );
}

function ProjectTreeRow({
  project,
  modules,
  pathname,
  activeModuleId,
  activeNodeId,
  activeNodeModuleId,
  projectHref,
  wsId,
}: {
  project: Project;
  modules: Module[];
  pathname: string;
  activeModuleId: string | null;
  activeNodeId: string | null;
  /** The module holding the selected work item, so its list opens on arrival. */
  activeNodeModuleId: string | null;
  projectHref: string;
  wsId: string | null;
}) {
  const { t } = useT("projects");
  // null = untouched, so the auto-open (the active module lives here) can
  // still be overridden by an explicit collapse.
  const route = pathname + "?module=" + (activeModuleId ?? "") + "&node=" + (activeNodeId ?? "");
  const [override, setOverride] = useState<{ route: string; open: boolean } | null>(null);
  const inProject = isOnProject(pathname, projectHref);
  const autoOpen =
    inProject &&
    (modules.some((m) => m.id === activeModuleId) ||
      (activeNodeModuleId !== null && modules.some((m) => m.id === activeNodeModuleId)));
  const open = override?.route === route ? override.open : autoOpen;
  const activeProject =
    inProject && !modules.some((m) => m.id === activeModuleId) && !activeNodeId;
  // A module's own work items open on demand; the selected work item's module
  // opens itself so the highlight is visible on arrival.
  const [openModules, setOpenModules] = useState<string[]>([]);
  useEffect(() => {
    if (!activeNodeModuleId) return;
    setOpenModules((old) => (old.includes(activeNodeModuleId) ? old : [...old, activeNodeModuleId]));
  }, [activeNodeModuleId]);

  return (
    <SidebarMenuItem className="group/project-row">
      <div className="flex items-center">
        {modules.length > 0 ? (
          <button
            type="button"
            onClick={() => setOverride({ route, open: !open })}
            aria-expanded={open}
            aria-label={`${t(($) => $.module.toggle_modules_aria)} ${project.title}`}
            className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ChevronRight
              className={cn(
                "size-3 stroke-[2.5] transition-transform duration-200",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        <SidebarMenuButton
          isActive={activeProject}
          render={<AppLink href={projectHref} />}
          className={cn("min-w-0 flex-1", ROW_CLASS_NAME)}
        >
          <ProjectIcon project={project} size="sm" />
          <span className="truncate">{project.title}</span>
        </SidebarMenuButton>
        <button
          type="button"
          aria-label={`${t(($) => $.module.add_aria)} ${project.title}`}
          onClick={() =>
            useModalStore.getState().open("create-module", {
              projectId: project.id,
            })
          }
          className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring hover:bg-sidebar-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {modules.length > 0 && open && (
        <SidebarMenu className="gap-0.5">
          {modules.map((m) => (
            <SidebarMenuItem key={m.id}>
              <div className="flex items-center">
                <button
                  type="button"
                  aria-expanded={openModules.includes(m.id)}
                  aria-label={`${t(($) => $.module.toggle_work_items_aria)} ${m.title}`}
                  onClick={() =>
                    setOpenModules((old) =>
                      old.includes(m.id) ? old.filter((id) => id !== m.id) : [...old, m.id],
                    )
                  }
                  className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 stroke-[2.5] transition-transform duration-200",
                      openModules.includes(m.id) && "rotate-90",
                    )}
                  />
                </button>
                <SidebarMenuButton
                  size="sm"
                  isActive={inProject && activeModuleId === m.id}
                  render={
                    <AppLink
                      href={`${projectHref}?module=${encodeURIComponent(m.id)}`}
                    />
                  }
                  className={cn("min-w-0 flex-1", ROW_CLASS_NAME)}
                >
                  <Blocks className="!size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{m.title}</span>
                  <CappedNumberFlow
                    value={m.issue_count}
                    animated={false}
                    className="ml-auto shrink-0 text-caption"
                  />
                </SidebarMenuButton>
              </div>
              {openModules.includes(m.id) && wsId ? (
                <ModuleWorkItems
                  wsId={wsId}
                  projectId={project.id}
                  moduleId={m.id}
                  projectHref={projectHref}
                  activeNodeId={activeNodeId}
                />
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </SidebarMenuItem>
  );
}

/** The Work group's single projects navigation entry and its expandable subtree. */
export function SidebarProjectsTree({ children, href }: { children: ReactNode; href: string }) {
  const { t } = useT("projects");
  // The sidebar can render before the workspace resolves (slug-first
  // routing); useCurrentWorkspace is nullable here, unlike useWorkspaceId.
  const wsId = useCurrentWorkspace()?.id ?? null;
  const wsPaths = useWorkspacePaths();
  const { pathname, searchParams } = useNavigation();
  const { data: projects = [] } = useQuery({
    ...projectListOptions(wsId ?? ""),
    enabled: wsId !== null,
  });
  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId ?? ""),
    enabled: wsId !== null,
  });
  const activeModuleId = searchParams?.get("module") ?? null;
  const activeNodeId = searchParams?.get("node") ?? null;

  // Which module holds the selected work item. One single-node read, and only
  // while a row is selected — the sidebar draws no tree of its own.
  const activeNode = useQuery({
    ...cockpitNodeDetailOptions(wsId ?? "", activeNodeId ?? "", EMPTY_COCKPIT_SCOPE),
    enabled: Boolean(wsId && activeNodeId && activeNodeId !== "none"),
  });
  const activeNodeModuleId = activeNode.data?.binding?.module_id ?? null;

  const modulesByProject = useMemo(() => {
    const map = new Map<string, Module[]>();
    for (const m of modules) {
      const list = map.get(m.project_id);
      if (list) list.push(m);
      else map.set(m.project_id, [m]);
    }
    return map;
  }, [modules]);

  // This subtree is a quick-navigation list, so a paused project stays out of
  // it; the projects page still lists every status. Excluding the one status
  // (rather than allow-listing the rest) keeps a status introduced by a newer
  // backend visible here. The project currently open is the exception — the
  // row you are looking at should never be the one missing from the tree.
  const visibleProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.status !== "paused" ||
          isOnProject(pathname, wsPaths.projectDetail(project.id)),
      ),
    [pathname, projects, wsPaths],
  );

  const route = pathname + "?module=" + (activeModuleId ?? "") + "&node=" + (activeNodeId ?? "");
  const [override, setOverride] = useState<{ route: string; open: boolean } | null>(null);
  const inProjects = pathname === href || pathname.startsWith(href + "/");
  const open = override?.route === route ? override.open : inProjects;

  return (
    <SidebarMenuItem>
      <div className="flex items-center">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          aria-label={t(($) => $.module.toggle_projects_aria)}
          aria-expanded={open}
          onClick={() => setOverride({ route, open: !open })}
          className="grid size-6 shrink-0 place-items-center rounded-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring hover:bg-sidebar-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      <div hidden={!open}>
        <SidebarMenu className="gap-0.5 pl-2">
          {visibleProjects.map((project) => (
            <ProjectTreeRow
              key={project.id}
              project={project}
              modules={modulesByProject.get(project.id) ?? []}
              pathname={pathname}
              activeModuleId={activeModuleId}
              activeNodeId={activeNodeId}
              activeNodeModuleId={activeNodeModuleId}
              projectHref={wsPaths.projectDetail(project.id)}
              wsId={wsId}
            />
          ))}
        </SidebarMenu>
      </div>
    </SidebarMenuItem>
  );
}
