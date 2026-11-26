"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { useCurrentWorkspace, useWorkspacePaths } from "@multica/core/paths";
import { isIssueUuid } from "@multica/core/issues/canonical-id";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { projectSidebarSource, sidebarProjects } from "@multica/core/issues/sidebar-list";
import { useSidebarProjectPrefs } from "@multica/core/issues/sidebar-project-prefs";
import { useSidebarKeptStore } from "@multica/core/issues/stores/sidebar-kept-store";
import { useSidebarTreeStore } from "@multica/core/issues/stores/sidebar-tree-store";
import { projectListOptions } from "@multica/core/projects/queries";
import type { Project } from "@multica/core/types";
import { Gauge, Image as Images, Network } from "@multica/ui/icons";
import { useNavigation } from "../../navigation";
import { IssueContextMenuProvider } from "../../issues/actions";
import { useT } from "../../i18n";
import { PanelBody, PanelHeader, PanelLink, PanelList, PanelSection, isPathWithin } from "../panel-nav";
import { PinnedSection, usePanelPins } from "./pinned-section";
import { useKeptActiveItem } from "./sidebar-tree";
import { ProjectsSection, useIssueInTree } from "./work-tree";
import { ViewsSection, sidebarViewItemSource } from "./views-section";
import { useIssueViewActions } from "../../issue-views/use-view-actions";

const EMPTY_PROJECTS: Project[] = [];
/** The Projects section's key in the kept-rows store, apart from every sidebar source. */
const PROJECTS_LIST = "projects";
/** Pinned rows' place in the clicked-issue record, apart from every sidebar source. */
const PINS_LIST = "pins";

/**
 * The `{id}` of a `{base}/{id}` route — for `/issues/{id}`, a UUID or an
 * identifier like `MUL-123`.
 */
function routeSegment(pathname: string, base: string): string | null {
  if (!pathname.startsWith(base + "/")) return null;
  const segment = pathname.slice(base.length + 1).split("/")[0];
  return segment ? decodeURIComponent(segment) : null;
}

/**
 * Ends the rows the sidebar lists keep (`useKeptActiveItem`) once their issue
 * or project is no longer the page. Mounted with the shell rather than the
 * Work panel, which unmounts on leaving Work and with every compact sheet
 * close.
 */
export function KeptRowsRelease() {
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const wsId = useCurrentWorkspace()?.id ?? "";
  const issueSegment = routeSegment(pathname, p.issues());
  const { data: issue } = useQuery({
    ...issueDetailOptions(wsId, issueSegment ?? ""),
    enabled: false,
  });
  // `undefined` while an identifier route waits for the page to load its issue.
  const issueId = issueSegment ? (issue?.id ?? (isIssueUuid(issueSegment) ? issueSegment : undefined)) : null;
  const projectId = routeSegment(pathname, p.projects());
  useLayoutEffect(() => {
    if (issueId === undefined) return;
    useSidebarKeptStore.getState().release([issueId, projectId].filter((id) => id !== null));
  }, [issueId, projectId]);
  return null;
}

export function WorkPanel() {
  const { t } = useT("layout");
  const viewActions = useIssueViewActions();
  const p = useWorkspacePaths();
  const { pathname } = useNavigation();
  const wsId = useCurrentWorkspace()?.id;
  const userId = useAuthStore((s) => s.user?.id);

  const { data: projects = EMPTY_PROJECTS } = useQuery({
    ...projectListOptions(wsId ?? ""),
    enabled: !!wsId,
  });
  // Cache read only: the detail page owns resolving the route's issue.
  const issueSegment = routeSegment(pathname, p.issues());
  const { data: currentIssue } = useQuery({
    ...issueDetailOptions(wsId ?? "", issueSegment ?? ""),
    enabled: false,
  });
  // A tree row takes the highlight from "All issues" while it lists the issue.
  const inTree = useIssueInTree(wsId ?? "", issueSegment);
  // The tree and a UUID route name the issue before the page has loaded it;
  // waiting for the load would light "All issues" first.
  const currentIssueId = issueSegment
    ? (currentIssue?.id ?? inTree.issueId ?? (isIssueUuid(issueSegment) ? issueSegment : null))
    : null;
  // An issue can sit in Pinned and in several lists at once, but lights in
  // one place: the list it was clicked in. Arriving any other way (search, a
  // link, a shortcut) lights the pin, else the first list that shows it.
  const [clickedIssue, setClickedIssue] = useState<{ segment: string; list: string | null } | null>(null);
  const clickedList =
    clickedIssue &&
    !!currentIssueId &&
    (clickedIssue.segment === currentIssueId || clickedIssue.segment === currentIssue?.identifier)
      ? clickedIssue.list
      : undefined;
  const treeClaimsIssue = clickedList !== undefined && clickedList !== PINS_LIST;
  const pins = usePanelPins(wsId, userId, pathname, treeClaimsIssue ? null : currentIssueId);
  const rememberClickedIssue = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a[href]");
    if (!link) return;
    const path = new URL(link.getAttribute("href") ?? "", window.location.href).pathname;
    const list = link.closest("[data-pinned-section]")
      ? PINS_LIST
      : (link.closest("[data-sidebar-list]")?.getAttribute("data-sidebar-list") ?? null);
    const segment = link.getAttribute("data-issue-id") || routeSegment(path, p.issues());
    setClickedIssue(segment ? { segment, list } : null);
  };
  // A lit pin already marks the issue; opening its project would only push
  // the rest of the panel down.
  const revealProjectId =
    issueSegment && !pins.isActivePinnedRoute ? (currentIssue?.project_id ?? null) : null;

  const setExpanded = useSidebarTreeStore((s) => s.setExpanded);
  useEffect(() => {
    if (revealProjectId) setExpanded(projectSidebarSource(revealProjectId), true);
  }, [revealProjectId, setExpanded]);

  const { projectSettings, projectOrder } = useSidebarProjectPrefs(wsId ?? "");
  const filteredProjects = useMemo(
    () => sidebarProjects(projects, projectSettings, projectOrder, userId),
    [projects, projectSettings, projectOrder, userId],
  );
  const openProject = projects.find((project) => isPathWithin(pathname, p.projectDetail(project.id)));
  const keptProjects = useKeptActiveItem(PROJECTS_LIST, filteredProjects, openProject?.id ?? null, openProject);
  const shownProjects = useMemo(() => {
    const revealed = projects.find((project) => project.id === revealProjectId);
    return revealed && !keptProjects.includes(revealed) ? [...keptProjects, revealed] : [...keptProjects];
  }, [projects, keptProjects, revealProjectId]);
  const plainRowsLit = !pins.isActivePinnedRoute;
  const listOrder = viewActions.sidebar.items.map(sidebarViewItemSource);
  const litSource =
    !plainRowsLit || !currentIssueId
      ? null
      : clickedList && inTree.sources.includes(clickedList)
        ? clickedList
        : (listOrder.find((source) => inTree.sources.includes(source)) ?? inTree.sources[0] ?? null);
  const issueLitInTree = litSource !== null;
  const issueInAllIssues =
    plainRowsLit &&
    !!currentIssueId &&
    !currentIssue?.project_id &&
    litSource === null;

  return (
    <>
      <PanelHeader title={t(($) => $.spaces.work)} />
      {/* Outside PanelBody: clicks inside the menu's portal still bubble
          through the React tree, and must not reach rememberClickedIssue. */}
      <IssueContextMenuProvider variant="sidebar">
        <PanelBody onClickCapture={rememberClickedIssue}>
          {/* BayClaw work surfaces: cockpit is the work entry point, graph and
              gallery are its satellites (fleet lives in Team · resources, mirroring
              the pre-merge sidebar's group semantics). */}
          <PanelSection label={t(($) => $.panels.work.bayclaw)}>
            <PanelList>
              <PanelLink
                href={p.cockpit()}
                icon={<Gauge />}
                label={t(($) => $.nav.cockpit)}
                active={isPathWithin(pathname, p.cockpit())}
              />
              <PanelLink
                href={p.graph()}
                icon={<Network />}
                label={t(($) => $.nav.graph)}
                active={isPathWithin(pathname, p.graph())}
              />
              <PanelLink
                href={p.gallery()}
                icon={<Images />}
                label={t(($) => $.nav.gallery)}
                active={isPathWithin(pathname, p.gallery())}
              />
            </PanelList>
          </PanelSection>
          {wsId && (
            <ViewsSection
              wsId={wsId}
              pathname={pathname}
              plainRowsLit={plainRowsLit}
              issueLitInTree={issueLitInTree}
              issueInAllIssues={issueInAllIssues}
              activeIssueId={currentIssueId}
              litSource={litSource}
              actions={viewActions}
            />
          )}

          {wsId && (
            <div data-pinned-section className="contents">
              <PinnedSection pins={pins} wsId={wsId} />
            </div>
          )}

          {wsId && (
            <ProjectsSection
              wsId={wsId}
              pathname={pathname}
              projects={shownProjects}
              totalProjects={projects.length}
              plainRowsLit={plainRowsLit}
            />
          )}
        </PanelBody>
      </IssueContextMenuProvider>
    </>
  );
}
