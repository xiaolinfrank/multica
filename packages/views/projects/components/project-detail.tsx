"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Boxes, Check, ChevronRight, Link2, MoreHorizontal, Network, PanelRight, Pin, PinOff, Plus, Trash2, UserMinus, X as XIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multica/ui/lib/utils";
import { copyText } from "@multica/ui/lib/clipboard";
import { toast } from "sonner";
import type { ProjectStatus, ProjectPriority } from "@multica/core/types";
import { useAuthStore } from "@multica/core/auth";
import { projectDetailOptions } from "@multica/core/projects/queries";
import { useModalStore } from "@multica/core/modals";
import { moduleListOptions } from "@multica/core/modules/queries";
import { moduleTitleNumberPrefix } from "@multica/core/modules/title-number";
import { useUpdateProject, useDeleteProject } from "@multica/core/projects/mutations";
import { pinListOptions } from "@multica/core/pins";
import { useCreatePin, useDeletePin } from "@multica/core/pins";
import { memberListOptions, agentListOptions } from "@multica/core/workspace/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { openCreateIssueWithPreference, useIssuesScope } from "@multica/core/issues/stores";
import { useRecentContextStore } from "@multica/core/chat";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { pinAgentByName } from "@multica/core/agents";
import { useConfigStore } from "@multica/core/config";
import { PROJECT_STATUS_ORDER, PROJECT_STATUS_CONFIG, PROJECT_PRIORITY_ORDER } from "@multica/core/projects/config";
import { getProjectIssueMetrics } from "./project-issue-metrics";
import { ActorAvatar } from "../../common/actor-avatar";
import { currentPath, useNavigation } from "../../navigation";
import { TitleEditor, ContentEditor, type ContentEditorRef } from "../../editor";
import { PriorityIcon } from "../../issues/components/priority-icon";
import { ProjectResourcesSection } from "./project-resources-section";
import { CollabPathProperty } from "./collab-path";
import { ProjectStartDatePicker } from "./project-start-date-picker";
import { ProjectDueDatePicker } from "./project-due-date-picker";
import { IssueSurface } from "../../issues/surface/issue-surface";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@multica/ui/components/ui/resizable";
import { Sheet, SheetContent } from "@multica/ui/components/ui/sheet";
import { useIsMobile } from "@multica/ui/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@multica/ui/components/ui/popover";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multica/ui/components/ui/tooltip";
import { EmojiPicker } from "@multica/ui/components/common/emoji-picker";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import {
  AnimatedRightSidebar,
  getAnimatedRightSidebarInitialOpen,
  rightSidebarPanelMotionProps,
  useAnimatedRightSidebarState,
  useRightSidebarShortcut,
} from "../../layout/animated-right-sidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../i18n";
import { useProjectStatusLabels, useProjectPriorityLabels } from "./labels";
import { ModulesManageDialog } from "./modules-manage-dialog";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";

/** URL sentinel for the ungrouped filter (module ids are UUIDs, so "none"
 *  can never collide with one). */
const NO_MODULE_FILTER = "none";

// ---------------------------------------------------------------------------
// Property row — sidebar property display
// ---------------------------------------------------------------------------

function PropRow({
  label,
  children,
  stacked,
}: {
  label: string;
  children: React.ReactNode;
  /** Puts the label on its own line above the value. For properties whose
   *  label does not fit the 4rem label column in every supported locale, or
   *  whose value needs the full row width to stay readable — the collaboration
   *  space is both: "Collaboration space" / 人机协作空间路径 overruns the
   *  column, and the value is a deep absolute path. */
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="min-h-8 rounded-md px-2 -mx-2 py-1 hover:bg-accent/50 transition-colors">
        <span className="block text-caption text-muted-foreground">{label}</span>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-8 items-center gap-2 rounded-md px-2 -mx-2 hover:bg-accent/50 transition-colors">
      <span className="w-16 shrink-0 text-caption text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-caption truncate">
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectDetail
// ---------------------------------------------------------------------------

export function ProjectDetail({ projectId }: { projectId: string }) {
  const { t } = useT("projects");
  const statusLabels = useProjectStatusLabels();
  const priorityLabels = useProjectPriorityLabels();
  const wsId = useWorkspaceId();
  const wsPaths = useWorkspacePaths();
  const router = useNavigation();
  const userId = useAuthStore((s) => s.user?.id);
  const { data: project, isLoading } = useQuery(projectDetailOptions(wsId, projectId));
  const recordRecentContext = useRecentContextStore((s) => s.recordVisit);
  useEffect(() => {
    if (project) {
      recordRecentContext(wsId, {
        type: "project",
        id: project.id,
        label: project.title,
        subtitle: project.description ?? undefined,
        icon: project.icon,
        projectStatus: project.status,
      });
    }
  }, [project?.id, project?.title, project?.description, project?.icon, project?.status, recordRecentContext, wsId]);
  const issueTab = useIssuesScope(`project:${projectId}`);
  const issueScope = useMemo(
    () => ({ type: "project" as const, projectId, actorKind: issueTab }),
    [projectId, issueTab],
  );
  // Module narrowing comes from the ?module= URL param so the strip, the
  //  breadcrumb, deep links, and browser/tab back all agree on one source.
  // Both platform adapters surface searchParams (web: useSearchParams,
  // desktop: location.search), so no per-app wiring is needed here.
  const activeModule = router.searchParams.get("module");
  const { data: stripModules = [], isSuccess: modulesLoaded } = useQuery(
    moduleListOptions(wsId, projectId),
  );
  const activeModuleRecord = stripModules.find(
    (module) => module.id === activeModule,
  );
  const moduleFilter = useMemo(() => {
    if (!activeModule) return undefined;
    if (activeModule === NO_MODULE_FILTER) return { include_no_module: true };
    // A stale ?module= id (module since deleted, hand-edited URL) must not
    // filter the surface into silence. Once the list has loaded, an unknown
    // id falls back to the unfiltered view instead of matching zero rows.
    if (modulesLoaded && !activeModuleRecord) return undefined;
    return { module_ids: [activeModule] };
  }, [activeModule, activeModuleRecord, modulesLoaded]);
  const handleSelectModule = useCallback(
    (value: string | null) => {
      const params = new URLSearchParams(router.searchParams.toString());
      if (value) params.set("module", value);
      else params.delete("module");
      const qs = params.toString();
      router.push(
        wsPaths.projectDetail(projectId) + (qs ? "?" + qs : ""),
      );
    },
    [projectId, router, wsPaths],
  );
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const pinnedAgentName = useConfigStore((s) => s.defaultIssueAssigneeAgentName);
  const { getActorName } = useActorName();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const { data: pinnedItems = [] } = useQuery({
    ...pinListOptions(wsId, userId ?? ""),
    enabled: !!userId,
  });
  const isPinned = pinnedItems.some((p) => p.item_type === "project" && p.item_id === projectId);
  const isWorkspaceAdmin = useMemo(() => {
    if (!userId) return false;
    const me = members.find((m) => m.user_id === userId);
    return me?.role === "owner" || me?.role === "admin";
  }, [members, userId]);
  const createPin = useCreatePin();
  const deletePinMut = useDeletePin();
  const descEditorRef = useRef<ContentEditorRef>(null);
  const isMobile = useIsMobile();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [modulesManageOpen, setModulesManageOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [progressOpen, setProgressOpen] = useState(true);
  const [descriptionOpen, setDescriptionOpen] = useState(true);

  // Sidebar panel
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "multica_project_detail_layout",
  });
  const sidebarRef = usePanelRef();
  const rightSidebarShortcutTargetRef = useRef<HTMLDivElement | null>(null);
  const desktopSidebarInitialOpen = getAnimatedRightSidebarInitialOpen(
    true,
    defaultLayout,
  );
  // Desktop and mobile sidebar state must be separate. A single state defaulting
  // to `true` made the mobile <Sheet> mount in the open position on first render
  // (after `useIsMobile()` flipped from false→true), briefly covering the page
  // with its modal backdrop and locking scroll — leaving the page unresponsive.
  const {
    open: desktopSidebarOpen,
    visualOpen: desktopSidebarVisualOpen,
    motionEnabled: desktopSidebarMotionEnabled,
    beginToggle: beginDesktopSidebarToggle,
    handleResize: handleDesktopSidebarResize,
  } = useAnimatedRightSidebarState(desktopSidebarInitialOpen);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarOpen = isMobile ? mobileSidebarOpen : desktopSidebarOpen;

  useEffect(() => {
    if (isMobile) {
      setMobileSidebarOpen(false);
    }
  }, [isMobile]);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((open) => !open);
      return;
    }

    const panel = sidebarRef.current;
    if (!panel) return;
    const nextOpen = panel.isCollapsed();
    beginDesktopSidebarToggle(nextOpen);
    window.requestAnimationFrame(() => {
      if (nextOpen) panel.expand();
      else panel.collapse();
    });
  }, [beginDesktopSidebarToggle, isMobile, sidebarRef]);

  useRightSidebarShortcut(rightSidebarShortcutTargetRef, handleToggleSidebar);

  // Lead popover
  const [leadOpen, setLeadOpen] = useState(false);
  const [leadFilter, setLeadFilter] = useState("");
  const leadQuery = leadFilter.toLowerCase();
  const filteredMembers = members.filter((m) => m.name.toLowerCase().includes(leadQuery) || matchesPinyin(m.name, leadQuery));
  const filteredAgents = pinAgentByName(
    agents.filter((a) => !a.archived_at && (a.name.toLowerCase().includes(leadQuery) || matchesPinyin(a.name, leadQuery))),
    pinnedAgentName,
  );

  const handleUpdateField = useCallback(
    (data: Parameters<typeof updateProject.mutate>[0] extends { id: string } & infer R ? R : never) => {
      if (!project) return;
      updateProject.mutate({ id: project.id, ...data });
    },
    [project, updateProject],
  );

  const handleDelete = useCallback(() => {
    if (!project) return;
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        toast.success(t(($) => $.detail.toast_project_deleted));
        router.push(wsPaths.projects());
      },
    });
  }, [project, deleteProject, router, wsPaths, t]);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-8 py-10 space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-40 w-full mt-8" />
      </div>
    );
  }

  if (!project) {
    return <div className="flex items-center justify-center h-full text-muted-foreground">{t(($) => $.detail.not_found)}</div>;
  }

  const issueMetrics = getProjectIssueMetrics(project);
  const statusCfg = PROJECT_STATUS_CONFIG[project.status];

  const sidebarContent = (
    <div className="space-y-5">
      {/* Icon + Title */}
      <div>
        <Popover open={iconPickerOpen} onOpenChange={setIconPickerOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="text-display-sm cursor-pointer rounded-lg p-1 -ml-1 hover:bg-accent/60 transition-colors"
                title={t(($) => $.detail.icon_tooltip)}
              >
                {project.icon || "📁"}
              </button>
            }
          />
          <PopoverContent align="start" className="w-auto p-0">
            <EmojiPicker
              onSelect={(emoji) => {
                handleUpdateField({ icon: emoji });
                setIconPickerOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <TitleEditor
          key={`title-${projectId}`}
          defaultValue={project.title}
          placeholder={t(($) => $.detail.title_placeholder)}
          className="mt-2 w-full text-title-sm font-semibold leading-snug tracking-tight"
          onBlur={(value) => {
            const trimmed = value.trim();
            if (trimmed && trimmed !== project.title) handleUpdateField({ title: trimmed });
          }}
        />
      </div>

      {/* Properties */}
      <div>
        <button
          type="button"
          className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${propertiesOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setPropertiesOpen(!propertiesOpen)}
        >
          {t(($) => $.detail.section_properties)}
          <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${propertiesOpen ? "rotate-90" : ""}`} />
        </button>
        {propertiesOpen && <div className="space-y-0.5 pl-2">
          <PropRow label={t(($) => $.table.status)}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button type="button" className="inline-flex items-center gap-1.5 text-caption hover:text-foreground transition-colors">
                    <span className={cn("size-2 rounded-full", statusCfg.dotColor)} />
                    <span>{statusLabels[project.status]}</span>
                  </button>
                }
              />
              <DropdownMenuContent align="start" className="w-44">
                {PROJECT_STATUS_ORDER.map((s) => (
                  <DropdownMenuItem key={s} onClick={() => handleUpdateField({ status: s as ProjectStatus })}>
                    <span className={cn("size-2 rounded-full", PROJECT_STATUS_CONFIG[s].dotColor)} />
                    <span>{statusLabels[s]}</span>
                    {s === project.status && <Check className="ml-auto h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </PropRow>
          <PropRow label={t(($) => $.table.priority)}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button type="button" className="inline-flex items-center gap-1.5 text-caption hover:text-foreground transition-colors">
                    <PriorityIcon priority={project.priority} />
                    <span>{priorityLabels[project.priority]}</span>
                  </button>
                }
              />
              <DropdownMenuContent align="start" className="w-44">
                {PROJECT_PRIORITY_ORDER.map((p) => (
                  <DropdownMenuItem key={p} onClick={() => handleUpdateField({ priority: p as ProjectPriority })}>
                    <PriorityIcon priority={p} />
                    <span>{priorityLabels[p]}</span>
                    {p === project.priority && <Check className="ml-auto h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </PropRow>
          <PropRow label={t(($) => $.table.lead)}>
            <Popover open={leadOpen} onOpenChange={(v) => { setLeadOpen(v); if (!v) setLeadFilter(""); }}>
              <PopoverTrigger
                render={
                  <button type="button" className="inline-flex items-center gap-1.5 text-caption hover:text-foreground transition-colors">
                    {project.lead_type && project.lead_id ? (
                      <>
                        <ActorAvatar actorType={project.lead_type} actorId={project.lead_id} size="sm" enableHoverCard showStatusDot />
                        <span className="cursor-pointer">{getActorName(project.lead_type, project.lead_id)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t(($) => $.lead.no_lead)}</span>
                    )}
                  </button>
                }
              />
              <PopoverContent align="start" className="w-52 p-0">
                <div className="px-2 py-1.5 border-b">
                  <input
                    type="text"
                    value={leadFilter}
                    onChange={(e) => setLeadFilter(e.target.value)}
                    placeholder={t(($) => $.lead.assign_placeholder)}
                    className="w-full bg-transparent text-body placeholder:text-muted-foreground outline-none"
                  />
                </div>
                <div className="p-1 max-h-60 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() => { handleUpdateField({ lead_type: null, lead_id: null }); setLeadOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-accent transition-colors"
                  >
                    <UserMinus className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-muted-foreground">{t(($) => $.lead.no_lead)}</span>
                  </button>
                  {filteredMembers.length > 0 && (
                    <>
                      <div className="px-2 pt-2 pb-1 text-caption font-medium text-muted-foreground uppercase tracking-wider">{t(($) => $.lead.members_group)}</div>
                      {filteredMembers.map((m) => (
                        <button
                          type="button"
                          key={m.user_id}
                          onClick={() => { handleUpdateField({ lead_type: "member", lead_id: m.user_id }); setLeadOpen(false); }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-accent transition-colors"
                        >
                          <ActorAvatar actorType="member" actorId={m.user_id} size="sm" />
                          <span>{m.name}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {filteredAgents.length > 0 && (
                    <>
                      <div className="px-2 pt-2 pb-1 text-caption font-medium text-muted-foreground uppercase tracking-wider">{t(($) => $.lead.agents_group)}</div>
                      {filteredAgents.map((a) => (
                        <button
                          type="button"
                          key={a.id}
                          onClick={() => { handleUpdateField({ lead_type: "agent", lead_id: a.id }); setLeadOpen(false); }}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-accent transition-colors"
                        >
                          <ActorAvatar actorType="agent" actorId={a.id} size="sm" showStatusDot />
                          <span>{a.name}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {filteredMembers.length === 0 && filteredAgents.length === 0 && leadFilter && (
                    <div className="px-2 py-3 text-center text-body text-muted-foreground">{t(($) => $.lead.no_results)}</div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </PropRow>
          <PropRow label={t(($) => $.detail.prop_start_date)}>
            <ProjectStartDatePicker startDate={project.start_date} onUpdate={handleUpdateField} />
          </PropRow>
          <PropRow label={t(($) => $.detail.prop_due_date)}>
            <ProjectDueDatePicker dueDate={project.due_date} onUpdate={handleUpdateField} />
          </PropRow>
          {/* One collaboration space per project, even when the page is
              filtered to a module: a module's deliverables live in a folder
              named after it inside this directory, so there is no second path
              to show or keep in sync. */}
          <PropRow label={t(($) => $.collab_path.label)} stacked>
            <CollabPathProperty
              value={project.collab_path}
              onCommit={(next) => handleUpdateField({ collab_path: next })}
            />
          </PropRow>
        </div>}
      </div>

      {/* Progress */}
      {issueMetrics.totalCount > 0 && (() => {
        const pct = Math.round((issueMetrics.completedCount / issueMetrics.totalCount) * 100);
        return (
          <div>
            <button
              type="button"
              className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${progressOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setProgressOpen(!progressOpen)}
            >
              {t(($) => $.detail.section_progress)}
              <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${progressOpen ? "rotate-90" : ""}`} />
            </button>
            {progressOpen && <div className="pl-2 flex items-center gap-3">
              <div className="relative h-2 flex-1 rounded-full bg-muted overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-caption text-muted-foreground tabular-nums shrink-0">
                {issueMetrics.completedCount}/{issueMetrics.totalCount}
              </span>
            </div>}
          </div>
        );
      })()}

      {/* Description */}
      <div>
        <button
          type="button"
          className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${descriptionOpen ? "" : "text-muted-foreground hover:text-foreground"}`}
          onClick={() => setDescriptionOpen(!descriptionOpen)}
        >
          {t(($) => $.detail.section_description)}
          <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${descriptionOpen ? "rotate-90" : ""}`} />
        </button>
        {descriptionOpen && <div className="pl-2">
          <ContentEditor
            ref={descEditorRef}
            key={projectId}
            value={project.description || ""}
            placeholder={t(($) => $.detail.description_placeholder)}
            onUpdate={(md) => handleUpdateField({ description: md || null })}
            debounceMs={1500}
          />
          <p className="mt-1 px-2 text-caption text-muted-foreground">
            {t(($) => $.detail.description_hint)}
          </p>
        </div>}
      </div>

      {/* Resources */}
      <ProjectResourcesSection projectId={projectId} />
    </div>
  );

  return (
    <>
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="content" minSize="50%">
        <div ref={rightSidebarShortcutTargetRef} className="flex h-full flex-col">
          <BreadcrumbHeader
            segments={[{ href: wsPaths.projects(), label: t(($) => $.detail.breadcrumb_fallback) }]}
            leaf={
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-medium text-foreground">{project.title}</span>
                {activeModuleRecord && (
                  <>
                    <ChevronRight className="size-3 shrink-0 text-faint-foreground" />
                    <span className="flex min-w-0 items-center gap-0.5 rounded-full bg-accent px-2 py-0.5 text-caption">
                      <Boxes className="size-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{activeModuleRecord.title}</span>
                      <button
                        type="button"
                        aria-label={t(($) => $.module.clear_aria)}
                        onClick={() => handleSelectModule(null)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      >
                        <XIcon className="size-3" />
                      </button>
                    </span>
                  </>
                )}
              </span>
            }
            actions={
              <>
              {/* Seeds the project the same way the `c` shortcut does on this
                  route (global-shortcuts.tsx), and goes through the create-mode
                  preference so agent/manual stays where the user left it. The
                  active module rides along exactly like the surface create
                  defaults below — activeModuleRecord is only set for a module
                  that still exists in this project, so the "none" sentinel and
                  dead ids seed nothing. */}
              <Button
                size="sm"
                variant="outline"
                className="px-2 sm:px-2.5"
                aria-label={t(($) => $.detail.new_issue_button)}
                onClick={() =>
                  openCreateIssueWithPreference({
                    project_id: projectId,
                    ...(activeModuleRecord && {
                      module_id: activeModuleRecord.id,
                      // Numbered modules number the work inside them, so a
                      // create while the strip is narrowed to one opens on
                      // that module's own number.
                      ...(moduleTitleNumberPrefix(activeModuleRecord.title)
                        ? {
                            title: moduleTitleNumberPrefix(
                              activeModuleRecord.title,
                            ),
                          }
                        : {}),
                    }),
                  })
                }
              >
                <Plus className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">{t(($) => $.detail.new_issue_button)}</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="px-2 sm:px-2.5"
                aria-label={t(($) => $.module.create.title)}
                onClick={() => useModalStore.getState().open("create-module", { projectId })}
              >
                <Boxes className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">{t(($) => $.module.create.title)}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                title={t(($) => $.detail.graph_tooltip)}
                onClick={() => router.push(wsPaths.projectGraph(projectId))}
              >
                <Network />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("text-muted-foreground", isPinned && "text-foreground")}
                title={isPinned ? t(($) => $.detail.unpin_tooltip) : t(($) => $.detail.pin_tooltip)}
                onClick={() => {
                  if (isPinned) {
                    deletePinMut.mutate({ itemType: "project", itemId: projectId });
                  } else {
                    createPin.mutate({ item_type: "project", item_id: projectId });
                  }
                }}
              >
                {isPinned ? <PinOff /> : <Pin />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                      <MoreHorizontal />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-auto">
                  <DropdownMenuItem onClick={() => {
                    void copyText(router.getShareableUrl(currentPath(router))).then((ok) => {
                      if (ok) toast.success(t(($) => $.detail.toast_link_copied));
                    });
                  }}>
                    <Link2 className="h-3.5 w-3.5" />
                    {t(($) => $.detail.copy_link)}
                  </DropdownMenuItem>
                  {isWorkspaceAdmin && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setModulesManageOpen(true)}>
                        <Boxes className="h-3.5 w-3.5" />
                        {t(($) => $.module.manage_title)}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleteDialogOpen(true)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t(($) => $.detail.delete_action)}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={sidebarOpen ? "secondary" : "ghost"}
                      size="icon-sm"
                      className={sidebarOpen ? "" : "text-muted-foreground"}
                      onClick={handleToggleSidebar}
                    >
                      <PanelRight />
                    </Button>
                  }
                />
                <TooltipContent side="bottom">{t(($) => $.detail.sidebar_tooltip)}</TooltipContent>
              </Tooltip>
              </>
            }
          />

          <IssueSurface
            scope={issueScope}
            modes={["table", "board", "list", "swimlane", "gantt"]}
            moduleFilter={moduleFilter}
            // Folder-style management: a project with modules shows them as
            // table groups until the user picks a grouping explicitly. While
            // modules load, no default applies, so the table never flaps.
            defaultTableGrouping={
              modulesLoaded
                ? stripModules.length > 0
                  ? "module"
                  : "none"
                : undefined
            }
            createDefaults={activeModuleRecord ? { module_id: activeModuleRecord.id } : undefined}
          />
          </div>
        </ResizablePanel>
        {!isMobile && <ResizableHandle />}
        {!isMobile && (
        <ResizablePanel
          id="sidebar"
          {...rightSidebarPanelMotionProps}
          data-right-sidebar-motion={desktopSidebarMotionEnabled ? "enabled" : undefined}
          defaultSize={desktopSidebarOpen ? 320 : 0}
          minSize={260}
          maxSize={420}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          panelRef={sidebarRef}
          onResize={handleDesktopSidebarResize}
        >
          <AnimatedRightSidebar open={desktopSidebarVisualOpen} motionEnabled={desktopSidebarMotionEnabled}>
            {sidebarContent}
          </AnimatedRightSidebar>
        </ResizablePanel>
        )}
        {isMobile && (
          <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
            <SheetContent side="right" showCloseButton={false} className="w-[320px] overflow-y-auto p-4">
              {sidebarContent}
            </SheetContent>
          </Sheet>
        )}
      </ResizablePanelGroup>

      {/* Module folder management (rename / reorder / delete / create) */}
      {isWorkspaceAdmin && (
        <ModulesManageDialog
          projectId={projectId}
          open={modulesManageOpen}
          onOpenChange={setModulesManageOpen}
        />
      )}

      {/* Delete confirmation */}
      {isWorkspaceAdmin && (
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.delete_dialog.title)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.delete_dialog.description)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t(($) => $.delete_dialog.cancel)}</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-white hover:bg-destructive/90">
                {t(($) => $.delete_dialog.confirm)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
