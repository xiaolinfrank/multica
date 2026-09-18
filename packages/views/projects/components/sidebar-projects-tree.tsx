"use client";

import { useMemo, useState } from "react";
import { Boxes, ChevronRight, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { useModalStore } from "@multica/core/modals";
import type { Module, Project } from "@multica/core/types";
import { cn } from "@multica/ui/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@multica/ui/components/ui/sidebar";
import { CappedNumberFlow } from "@multica/ui/components/ui/number-flow";
import { AppLink, useNavigation } from "../../navigation";
import { routeIconForPath } from "../../layout/route-icon-components";
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
  const [override, setOverride] = useState<boolean | null>(null);
  const autoOpen = modules.some((m) => m.id === activeModuleId);
  const open = override ?? autoOpen;
  const activeProject =
    activeModuleId === null &&
    (pathname === projectHref || pathname.startsWith(projectHref + "/"));

  return (
    <SidebarMenuItem className="group/project-row">
      <div className="flex items-center">
        {modules.length > 0 ? (
          <button
            type="button"
            onClick={() => setOverride(!open)}
            aria-expanded={open}
            aria-label={t(($) => $.module.toggle_modules_aria)}
            className="grid size-5 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
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
          aria-label={t(($) => $.module.add_aria)}
          onClick={() =>
            useModalStore.getState().open("create-module", {
              projectId: project.id,
            })
          }
          className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/project-row:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {modules.length > 0 && (
        <Collapsible open={open} onOpenChange={setOverride}>
          <CollapsibleContent>
            <SidebarMenu className="gap-0.5">
              {modules.map((m) => (
                <SidebarMenuItem key={m.id}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={activeModuleId === m.id}
                    render={
                      <AppLink
                        href={`${projectHref}?module=${encodeURIComponent(m.id)}`}
                      />
                    }
                    className={cn("pl-7", ROW_CLASS_NAME)}
                  >
                    <Boxes className="!size-3.5 shrink-0" />
                    <span className="truncate">{m.title}</span>
                    <CappedNumberFlow
                      value={m.issue_count}
                      animated={false}
                      className="ml-auto text-caption"
                    />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </CollapsibleContent>
        </Collapsible>
      )}
    </SidebarMenuItem>
  );
}

/** The sidebar's 项目 entry: the label row navigates to the projects index
 *  exactly like the nav item it replaces, and expands into the
 *  projects-with-modules tree for one-click deep links. Always renders —
 *  with no projects yet the index link is the only way to create one. */
export function SidebarProjectsTree() {
  const { t } = useT("projects");
  const { t: tLayout } = useT("layout");
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

  const projectsHref = wsPaths.projects();
  const projectsActive =
    pathname === projectsHref || pathname.startsWith(projectsHref + "/");
  const hasProjects = projects.length > 0;
  // The sidebar and desktop tab bar derive this icon from the destination
  // path (route-icon-components), so this row reads like every other nav
  // entry instead of a bare label.
  const ProjectsNavIcon = routeIconForPath(projectsHref);

  return (
    <Collapsible defaultOpen>
      <SidebarGroup className="group/projects-tree">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center">
              <SidebarMenuButton
                isActive={projectsActive && activeModuleId === null}
                render={<AppLink href={projectsHref} />}
                className={cn("min-w-0 flex-1", ROW_CLASS_NAME)}
              >
                <ProjectsNavIcon />
                <span className="truncate">
                  {tLayout(($) => $.nav.projects)}
                </span>
              </SidebarMenuButton>
              {hasProjects && (
                <CollapsibleTrigger
                  aria-label={t(($) => $.tree_toggle_aria)}
                  className="group/trigger grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight className="!size-3 stroke-[2.5] transition-transform duration-200 group-data-[panel-open]/trigger:rotate-90" />
                </CollapsibleTrigger>
              )}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
        {hasProjects && (
          <CollapsibleContent>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
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
            </SidebarGroupContent>
          </CollapsibleContent>
        )}
      </SidebarGroup>
    </Collapsible>
  );
}
