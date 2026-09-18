"use client";

import { type ReactNode, useMemo, useState } from "react";
import { Boxes, ChevronRight, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useModalStore } from "@multica/core/modals";
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

function ProjectTreeRow({
  project,
  modules,
  pathname,
  activeModuleId,
  projectHref,
}: {
  project: Project;
  modules: Module[];
  pathname: string;
  activeModuleId: string | null;
  projectHref: string;
}) {
  const { t } = useT("projects");
  // null = untouched, so the auto-open (the active module lives here) can
  // still be overridden by an explicit collapse.
  const route = pathname + "?module=" + (activeModuleId ?? "");
  const [override, setOverride] = useState<{ route: string; open: boolean } | null>(null);
  const inProject = pathname === projectHref || pathname.startsWith(projectHref + "/");
  const autoOpen = inProject && modules.some((m) => m.id === activeModuleId);
  const open = override?.route === route ? override.open : autoOpen;
  const activeProject =
    inProject && !modules.some((m) => m.id === activeModuleId);

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
              <SidebarMenuButton
                size="sm"
                isActive={inProject && activeModuleId === m.id}
                render={
                  <AppLink
                    href={`${projectHref}?module=${encodeURIComponent(m.id)}`}
                  />
                }
                className={cn("pl-7", ROW_CLASS_NAME)}
              >
                <Boxes className="!size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
                <CappedNumberFlow
                  value={m.issue_count}
                  animated={false}
                  className="ml-auto shrink-0 text-caption"
                />
              </SidebarMenuButton>
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

  const modulesByProject = useMemo(() => {
    const map = new Map<string, Module[]>();
    for (const m of modules) {
      const list = map.get(m.project_id);
      if (list) list.push(m);
      else map.set(m.project_id, [m]);
    }
    return map;
  }, [modules]);

  const route = pathname + "?module=" + (activeModuleId ?? "");
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
          {projects.map((project) => (
            <ProjectTreeRow
              key={project.id}
              project={project}
              modules={modulesByProject.get(project.id) ?? []}
              pathname={pathname}
              activeModuleId={activeModuleId}
              projectHref={wsPaths.projectDetail(project.id)}
            />
          ))}
        </SidebarMenu>
      </div>
    </SidebarMenuItem>
  );
}
