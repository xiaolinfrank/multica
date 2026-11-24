"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Blocks, ChevronRight, FolderKanban, ListTree } from "@multica/ui/icons";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import {
  cockpitPlanOptions,
  cockpitScopeNodesInfiniteOptions,
  type CockpitScope,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { planModuleGroups, planNodeKind } from "../../plan-tree/plan-rows";
import { useT } from "../../i18n";
import { PICKER_TRIGGER_CLASS } from "../../issues/components/pickers/property-picker";

const PAGE_SIZE = 20;

/** The project → module → work item tree a meeting can be linked to.
 *
 *  Every level is selectable: the value is a `cockpit_node.id`, and a project
 *  row or module row is as real a link target as a work item. The tree reads
 *  one project's plan at a time (never the whole workspace), and search is the
 *  paged server selector — the same shape the ownership picker uses. */
export function CockpitPlanNodePicker({
  wsId: wsIdProp,
  scope,
  label,
  value,
  onSelect,
  disabled = false,
  allowClear,
  onClear,
  triggerRender,
  align = "start",
  open: controlledOpen,
  onOpenChange,
}: {
  wsId?: string;
  scope?: CockpitScope;
  label: string;
  /** The already-resolved code and name of the current link. */
  value?: string;
  onSelect: (nodeId: string) => void | Promise<unknown>;
  disabled?: boolean;
  allowClear?: boolean;
  onClear?: () => void;
  triggerRender?: React.ReactElement;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const workspaceId = useWorkspaceId();
  const wsId = wsIdProp ?? workspaceId;
  const { t } = useT("cockpit");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = disabled ? false : controlledOpen ?? internalOpen;
  const setOpen = disabled ? () => {} : onOpenChange ?? setInternalOpen;
  const [text, setText] = useState("");
  const query = text.trim();
  const searchMode = query !== "";
  const constrainedProjectId = scope?.projectId ?? null;
  const constrainedModuleId = scope?.moduleId ?? null;

  const [expandedProject, setExpandedProject] = useState<string | null>(constrainedProjectId);
  const [expandedModule, setExpandedModule] = useState<string | null>(constrainedModuleId);
  const [pendingProject, setPendingProject] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!open) {
      setText("");
      setSaveError("");
      return;
    }
    setExpandedProject(constrainedProjectId);
    setExpandedModule(constrainedModuleId);
  }, [open, constrainedProjectId, constrainedModuleId]);

  const { data: allProjects = [] } = useQuery(projectListOptions(wsId));
  const projects = useMemo(
    () => (constrainedProjectId ? allProjects.filter((project) => project.id === constrainedProjectId) : allProjects),
    [allProjects, constrainedProjectId],
  );

  // One bounded read per open project. It carries the L1 row, the module rows
  // and their work items, so choosing any level needs no second tree walk.
  const plan = useQuery({
    ...cockpitPlanOptions(wsId, { projectId: expandedProject, moduleId: null }),
    enabled: open && !searchMode && expandedProject !== null,
  });
  const planUnavailableReason = plan.isError
    ? t(($) => $.node_picker.plan_failed)
    : plan.isSuccess && !plan.data?.cockpit?.plan_reconciled_at
      ? t(($) => $.node_picker.plan_unreconciled)
      : null;
  const planNodes = plan.data?.nodes;

  const rowForProject = useMemo(() => {
    if (!planNodes || !expandedProject) return null;
    const byId = new Map(planNodes.map((node) => [node.id, node]));
    return planNodes.find(
      (node) => !node.parent_id && node.project_id === expandedProject && planNodeKind(node, byId) === "project",
    ) ?? null;
  }, [planNodes, expandedProject]);

  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId, expandedProject ?? undefined),
    enabled: open && !searchMode && expandedProject !== null,
  });
  const visibleModules = useMemo(
    () => (constrainedModuleId ? modules.filter((module) => module.id === constrainedModuleId) : modules),
    [modules, constrainedModuleId],
  );

  const moduleRowFor = useMemo(() => {
    if (!planNodes) return () => null;
    return (moduleId: string) =>
      planNodes.find((node) => node.module_id === moduleId && node.parent_id !== null) ?? null;
  }, [planNodes]);

  const workItemsFor = useMemo(() => {
    if (!plan.data) return () => [];
    const groups = planModuleGroups({ nodes: plan.data.nodes, counts: plan.data.task_counts });
    return (moduleId: string) =>
      groups.find(({ moduleRow }) => moduleRow.node.module_id === moduleId)?.workItems ?? [];
  }, [plan.data]);

  const search = useInfiniteQuery({
    ...cockpitScopeNodesInfiniteOptions(wsId, {
      project_id: constrainedProjectId ?? undefined,
      module_id: constrainedModuleId ?? undefined,
      q: query,
      eligible: false,
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

  const choose = async (nodeId: string) => {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSelect(nodeId);
      setOpen(false);
      setText("");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
    } finally {
      setSaving(false);
    }
  };

  // A project row can be clicked before its plan arrives; the click asks for
  // that project's plan and lands on the row once it is there.
  useEffect(() => {
    if (!pendingProject || !rowForProject) return;
    setPendingProject(null);
    void choose(rowForProject.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProject, rowForProject]);

  const projectRowButton = (projectId: string, title: string, rowId: string | null) => (
    <button
      type="button"
      disabled={saving || !rowId}
      onClick={() => {
        if (rowId) void choose(rowId);
        else {
          setExpandedProject(projectId);
          setPendingProject(projectId);
        }
      }}
      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      title={rowId ? title : t(($) => $.node_picker.project_row_missing)}
    >
      <FolderKanban className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
    </button>
  );

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) { setText(""); setSaveError(""); } setOpen(next); }}>
      <PopoverTrigger
        disabled={disabled}
        render={triggerRender ?? (
          <button type="button" disabled={disabled} className={`${PICKER_TRIGGER_CLASS} max-w-full`} aria-label={label} />
        )}
      >
        <span className="flex min-w-0 items-center gap-1">
          <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{value || label}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(22rem,calc(100vw-2rem))] space-y-2">
        <Input
          value={text}
          name="cockpit-plan-node-search"
          autoComplete="off"
          spellCheck={false}
          aria-label={t(($) => $.node_picker.search_placeholder)}
          placeholder={t(($) => $.node_picker.search_placeholder)}
          disabled={saving}
          onChange={(event) => setText(event.target.value)}
        />
        {allowClear && !searchMode ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground"
            disabled={saving}
            onClick={() => { onClear?.(); setOpen(false); }}
          >
            {t(($) => $.node_picker.none)}
          </Button>
        ) : null}
        <div className="max-h-80 space-y-0.5 overflow-y-auto overscroll-contain">
          {searchMode ? (
            search.isError ? (
              <div role="alert" className="space-y-2 text-caption">
                <p>{t(($) => $.node_picker.search_failed)}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void search.refetch()}>
                  {t(($) => $.binding.retry)}
                </Button>
              </div>
            ) : search.isPending ? (
              <p role="status" className="px-2 py-1 text-caption text-muted-foreground">
                {t(($) => $.workflow.loading)}
              </p>
            ) : searchItems.length === 0 ? (
              <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.node_picker.empty)}</p>
            ) : (
              searchItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={saving}
                  onClick={() => void choose(item.id)}
                  className="flex w-full min-w-0 flex-col rounded-xs px-1 py-1 text-left text-caption hover:bg-accent disabled:opacity-60"
                  title={`${item.code} ${item.title}`.trim()}
                >
                  <span className="truncate">{`${item.code} ${item.title}`.trim()}</span>
                </button>
              ))
            )
          ) : (
            <>
              {projects.length === 0 ? (
                <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.node_picker.no_projects)}</p>
              ) : null}
              {projects.map((project) => {
                const expanded = expandedProject === project.id;
                const rowId = expanded ? rowForProject?.id ?? null : null;
                return (
                  <div key={project.id}>
                    <div className="flex min-w-0 items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${t(($) => $.node_picker.toggle_project)} ${project.title}`}
                        className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setExpandedProject(expanded ? null : project.id);
                          setExpandedModule(null);
                        }}
                      >
                        <ChevronRight className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
                      </button>
                      {projectRowButton(project.id, project.title, rowId)}
                    </div>
                    {expanded ? (
                      <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                        {planUnavailableReason ? (
                          <div className="space-y-2 px-2 py-1 text-caption text-muted-foreground">
                            <p>{planUnavailableReason}</p>
                            {plan.isError ? (
                              <Button type="button" size="sm" variant="outline" onClick={() => void plan.refetch()}>
                                {t(($) => $.binding.retry)}
                              </Button>
                            ) : null}
                            <p>{t(($) => $.node_picker.search_fallback)}</p>
                          </div>
                        ) : plan.isPending ? (
                          <p role="status" className="px-2 py-1 text-caption text-muted-foreground">
                            {t(($) => $.workflow.loading)}
                          </p>
                        ) : planNodes ? (
                          visibleModules.map((module) => {
                            const moduleOpen = expandedModule === module.id;
                            const row = moduleRowFor(module.id);
                            const workItems = workItemsFor(module.id);
                            return (
                              <div key={module.id}>
                                <div className="flex min-w-0 items-center gap-1">
                                  <button
                                    type="button"
                                    aria-expanded={moduleOpen}
                                    aria-label={`${t(($) => $.node_picker.toggle_module)} ${module.title}`}
                                    className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => setExpandedModule(moduleOpen ? null : module.id)}
                                  >
                                    <ChevronRight className={`size-3 transition-transform ${moduleOpen ? "rotate-90" : ""}`} />
                                  </button>
                                  <button
                                    type="button"
                                    disabled={saving || !row}
                                    onClick={() => {
                                      if (row) void choose(row.id);
                                      else setExpandedModule(module.id);
                                    }}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs px-1 py-1 text-left text-caption hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                                    title={row ? module.title : t(($) => $.node_picker.module_row_missing)}
                                  >
                                    <Blocks className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{module.title}</span>
                                  </button>
                                </div>
                                {moduleOpen ? (
                                  <div className="ml-4 space-y-0.5 border-l border-border/60 pl-1">
                                    {workItems.length === 0 ? (
                                      <p className="px-2 py-1 text-caption text-muted-foreground">
                                        {t(($) => $.node_picker.no_work_items)}
                                      </p>
                                    ) : (
                                      workItems.map((row) => (
                                        <button
                                          key={row.node.id}
                                          type="button"
                                          disabled={saving}
                                          onClick={() => void choose(row.node.id)}
                                          className="flex w-full min-w-0 items-center rounded-xs px-1 py-1 text-left text-caption hover:bg-accent disabled:opacity-60"
                                          title={`${row.code} ${row.name}`.trim()}
                                        >
                                          <span className="truncate">{`${row.code} ${row.name}`.trim()}</span>
                                        </button>
                                      ))
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })
                        ) : null}
                        {planNodes && visibleModules.length === 0 ? (
                          <p className="px-2 py-1 text-caption text-muted-foreground">{t(($) => $.node_picker.no_modules)}</p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
        </div>
        {searchMode && search.hasNextPage ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={search.isFetchingNextPage || saving}
            onClick={() => void search.fetchNextPage()}
          >
            {t(($) => $.node_picker.more)}
          </Button>
        ) : null}
        {saving ? <p role="status" className="text-caption text-muted-foreground">{t(($) => $.workflow.loading)}</p> : null}
        {saveError ? <p role="alert" className="text-caption text-destructive">{saveError}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
