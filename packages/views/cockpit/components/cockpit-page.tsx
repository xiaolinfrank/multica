"use client";

// Bounded plan reads and independent node/meeting workbenches share URL scope.
// Query owns read models; the core view store retains filters, layout and return
// position. Contact books and object relationships are loaded on demand.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import type {
  CockpitDirectoryEntry,
  CockpitMeetingImportItem,
  CockpitMeetingImportResult,
  CockpitMeetingProvision,
  CockpitMeetingWorkflowSetup,
  CockpitMilestonePatch,
  CockpitNode,
  CockpitNodePatch,
  CockpitPatch,
} from "@multica/core/types";
import {
  buildCockpitSummaryTree,
  buildCockpitTree,
  cockpitScopeViewKey, useCockpitScopeViewStore, EMPTY_COCKPIT_PLAN_CONTEXT,
  useCockpitMeetingCreateDraftStore, checkpointCockpitMeetingCreation,
  cockpitPlanOptions, cockpitContextOptions, cockpitSelectedMemberOptions, buildCockpitDisplayCodesFromIndex,
  cockpitSurfacePath, cockpitScopedPath,
  cockpitShellDestination,
  cockpitObjectPath, cockpitMeetingContextPath, cockpitMeetingDirectoryPath,
  cockpitDestination,
  cockpitScope,
  cockpitOverallProgress,
  cockpitSummaryCollapseIds,
  flattenCockpitTree,
  useCreateCockpitMeeting,
  useDeleteCockpitMilestone,
  useImportCockpitMeetingFolders,
  useProvisionCockpitMeeting,
  useEnableCockpitMeetingWorkflow,
  useUpdateCockpit,
  useDeleteCockpitDirectoryCompact,
  useUpsertCockpitDirectoryCompact,
  useUpdateCockpitMilestone,
  useUpdateCockpitNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter } from "@multica/ui/components/ui/alert-dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { toast } from "sonner";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDollarSign,
  Crosshair,
  Download,
  Layers,
  Plus,
  Search,
} from "lucide-react";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitChanges } from "./cockpit-changes";
import { captureCockpitGantt, downloadCockpitPng, printCockpitGantt } from "./cockpit-export";
import { CockpitGantt, type CockpitZoom } from "./cockpit-gantt";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitMeetingCreate, type CockpitMeetingDraft, type CockpitMeetingCreationResult } from "./cockpit-meeting-create";
import { CockpitPlanStructureCreate } from "./cockpit-plan-structure-create";
import { CockpitMeetingImport } from "./cockpit-meeting-import";
import { CockpitSelectedMeeting } from "./cockpit-selected-meeting";
import { CockpitBusinessMeetings } from "./cockpit-business-meetings";
import { CockpitReadFailure } from "./cockpit-read-failure";
import { CockpitMeetings } from "./cockpit-meetings";
import { CockpitSelectedNode } from "./cockpit-selected-node";
import { CockpitResponsibilities } from "./cockpit-responsibilities";
import { CockpitMilestoneCreate } from "./cockpit-milestone-create";
import { CockpitMilestones } from "./cockpit-milestones";
import { CockpitOverview } from "./cockpit-overview";
import { CockpitTable } from "./cockpit-table";
import { CockpitCsvExport } from "./cockpit-csv-export";
import { CockpitVersions } from "./cockpit-versions";

type CockpitTab = "overview" | "gantt" | "meetings" | "changes" | "finance";


// Stable empty arrays: an inline `?? []` allocates a fresh array on every
// render while the board query is loading, which invalidates every memo
// downstream of it.
const EMPTY_NODES: CockpitNode[] = [];

/**
 * One derived headline figure for the toolbar: a label, a percentage and a
 * rail. Derived, so it is a read-out and not a field — the number comes from
 * the tasks, and the way to move it is to move them.
 */
function ProgressChip({
  label,
  value,
  behind,
  hint,
}: {
  label: string;
  value: number | null;
  behind?: boolean;
  hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md border px-2 text-caption tabular-nums",
              behind
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border text-muted-foreground",
            )}
          >
            {label}
            <b className="text-foreground">{value == null ? "—" : `${value}%`}</b>
            <span className="h-1 w-6 overflow-hidden rounded-full bg-foreground/10">
              <span
                className={cn("block h-full rounded-full", behind ? "bg-destructive" : "bg-brand")}
                style={{ width: `${value ?? 0}%` }}
              />
            </span>
          </span>
        }
      />
      <TooltipContent>
        <span className="block max-w-72 text-caption">{hint}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Today as a calendar day, in the viewer's own timezone. */
function todayString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The distinct non-empty values a board already uses for one field. */
function suggestionsFor(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort();
}

export function CockpitBoardWorkspace({ initialTab = "overview", today: suppliedToday }: {
  initialTab?: CockpitTab;
  today?: string;
}) {
  const { t } = useT("cockpit");
  const { t: commonT } = useT("common");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const { scope, planView } = cockpitShellDestination(navigation.searchParams);
  const [tab, setTab] = useState<CockpitTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const planKey = cockpitScopeViewKey(wsId, scope);
  const planState = useCockpitScopeViewStore((store) => store.plans[planKey] ?? EMPTY_COCKPIT_PLAN_CONTEXT);
  const zoom = planState.zoom, query = planState.query, showFinance = planState.showFinance, toolsOpen = planState.toolsOpen;
  const setZoom = (zoom: CockpitZoom) => useCockpitScopeViewStore.getState().updatePlan(planKey, { zoom });
  const setQuery = (query: string) => useCockpitScopeViewStore.getState().updatePlan(planKey, { query });
  const setShowFinance = (value: boolean | ((current: boolean) => boolean)) => useCockpitScopeViewStore.getState().updatePlan(planKey, { showFinance: typeof value === "function" ? value(planState.showFinance) : value });
  const setToolsOpen = (value: boolean | ((current: boolean) => boolean)) => useCockpitScopeViewStore.getState().updatePlan(planKey, { toolsOpen: typeof value === "function" ? value(planState.toolsOpen) : value });
  // Empty means "every module"; the menu is multi-select, so comparing two
  // modules side by side does not mean opening the board twice.
  const rootIds = useMemo(() => new Set(planState.rootIds), [planState.rootIds]);
  const collapsed = useMemo(() => new Set(planState.collapsedIds), [planState.collapsedIds]);
  const setRootIds = useCallback((value: Set<string> | ((current: Set<string>) => Set<string>)) => {
    const store = useCockpitScopeViewStore.getState();
    store.updatePlan(planKey, { rootIds: [...(typeof value === "function" ? value(new Set(store.plans[planKey]?.rootIds ?? [])) : value)] });
  }, [planKey]);
  const setCollapsed = useCallback((value: Set<string> | ((current: Set<string>) => Set<string>)) => {
    const store = useCockpitScopeViewStore.getState();
    store.updatePlan(planKey, { collapsedIds: [...(typeof value === "function" ? value(new Set(store.plans[planKey]?.collapsedIds ?? [])) : value)], seeded: true });
  }, [planKey]);
  const destination = cockpitDestination(navigation.searchParams);
  const selectedId = destination.nodeId;
  const selectedMeetingId = destination.meetingId;
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const meetingCreateKey = cockpitScopeViewKey(wsId, scope);
  const creation = useCockpitMeetingCreateDraftStore((state) => state.draft.byScope[meetingCreateKey]);
  const savedMeetingId = creation?.meetingId ?? null;
  const meetingWorkflowCreated = creation?.workflowCreated ?? false;
  const captureMeetingContext = useCockpitCommandContext(JSON.stringify([meetingCreateKey, creatingMeeting]));
  const onMeetingCreateOpenChange = setCreatingMeeting;
  const [scanningMeetings, setScanningMeetings] = useState(false);
  const captureImportContext = useCockpitCommandContext(JSON.stringify([meetingCreateKey, scanningMeetings]));
  const [creatingMilestone, setCreatingMilestone] = useState(false);
  const [deletion, setDeletion] = useState<{ kind: "milestone"; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletionLock = useRef(false);
  const deletionOpener = useRef<HTMLElement | null>(null);
  const [scrollToTodayNonce, setScrollToTodayNonce] = useState(0);
  // The gantt locates-and-flashes one row; the nonce makes repeat clicks on
  // the same digest task re-trigger the effect.
  const [focusTarget, setFocusTarget] = useState<{ nodeId: string; nonce: number } | null>(
    null,
  );
  const [dayAtMount] = useState(todayString);
  const today = suppliedToday ?? dayAtMount;

  const planQuery = useQuery({ ...cockpitPlanOptions(wsId, scope), enabled: tab !== "meetings" && tab !== "changes" });
  const taskCounts = useMemo(() => new Map((planQuery.data?.task_counts ?? []).map((item) => [item.node_id, item])), [planQuery.data?.task_counts]);
  const contextNodeIds = useMemo(() => new Set(planQuery.data?.context_node_ids ?? []), [planQuery.data?.context_node_ids]);
  const context = useQuery(cockpitContextOptions(wsId, scope));
  const board = planQuery.data?.cockpit ? { ...planQuery.data, cockpit: planQuery.data.cockpit } : null;
  const cockpit = context.data?.cockpit;
  const meetingProjectId = scope.projectId ?? cockpit?.meeting_project_id ?? null;
  const meetingModuleId = scope.moduleId ?? (!scope.projectId || scope.projectId === cockpit?.meeting_project_id ? cockpit?.meeting_module_id ?? null : null);
  const meetingNodeId = meetingProjectId === cockpit?.meeting_project_id && meetingModuleId === cockpit?.meeting_module_id ? cockpit?.meeting_node_id ?? null : null;
  const currentUserId = context.data?.actor.user_id ?? "";
  const currentMember = useQuery(cockpitSelectedMemberOptions(wsId, currentUserId));
  const currentUserName = currentMember.data?.items.find((member) => member.id === currentUserId)?.title ?? "";
  const members = useMemo(() => (currentMember.data?.items ?? []).map((member) => ({ user_id: member.id, name: member.title, avatar_url: member.avatar_url })), [currentMember.data]);
  const canRestore = !context.isError && context.data?.actor.is_human === true && ["owner", "admin"].includes(context.data.actor.role);

  const updateBoard = useUpdateCockpit(wsId);
  const updateNode = useUpdateCockpitNode(wsId);
  const updateMilestone = useUpdateCockpitMilestone(wsId);
  const deleteMilestone = useDeleteCockpitMilestone(wsId);
  const createMeeting = useCreateCockpitMeeting(wsId);
  const provisionMeeting = useProvisionCockpitMeeting(wsId);
  const enableMeetingWorkflow = useEnableCockpitMeetingWorkflow(wsId);
  const importMeetings = useImportCockpitMeetingFolders(wsId);
  // The contact editor reads bounded pages; these writes return exact receipts.
  const upsertDirectory = useUpsertCockpitDirectoryCompact(wsId);
  const deleteDirectoryEntry = useDeleteCockpitDirectoryCompact(wsId);

  // `board?.nodes ?? []` inline would mint a new array on every render where
  // the query is still loading, invalidating every memo below it.
  const nodes = useMemo(() => board?.nodes ?? EMPTY_NODES, [board?.nodes]);
  const tree = useMemo(() => buildCockpitTree(nodes), [nodes]);
  // The shipped shape of the board: merged directions, tasks flattened under
  // the group rows. The gantt and the detail tables quote row codes from this
  // tree, so a code means the same row everywhere.
  const summaryTree = useMemo(() => buildCockpitSummaryTree(tree), [tree]);
  const summaryFlat = useMemo(() => flattenCockpitTree(summaryTree), [summaryTree]);
  const displayCodes = useMemo(() => buildCockpitDisplayCodesFromIndex(planQuery.data?.node_index ?? []), [planQuery.data?.node_index]);
  // The summary tree's parent links, for jumps that must open a row whose
  // display parent is a merged group rather than its stored parent.
  const summaryParent = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (entry: (typeof summaryFlat)[number]) => {
      entry.children.forEach((child) => {
        map.set(child.node.id, entry.node.id);
        walk(child);
      });
    };
    summaryTree.forEach(walk);
    return map;
  }, [summaryTree]);
  const statusSuggestions = useMemo(() => suggestionsFor(nodes.map((n) => n.status)), [nodes]);
  const execStatusSuggestions = useMemo(
    () => suggestionsFor(nodes.map((n) => n.exec_status)),
    [nodes],
  );
  const budgetCategorySuggestions = useMemo(
    () => suggestionsFor(nodes.map((n) => n.budget_category)),
    [nodes],
  );
  const ownerSuggestions = useMemo(() => suggestionsFor(nodes.map((n) => n.owner)), [nodes]);
  const vendorSuggestions = useMemo(() => suggestionsFor(nodes.map((n) => n.vendor)), [nodes]);

  const fail = useCallback(
    (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
    },
    [t],
  );

  const patchBoard = useCallback(
    (patch: CockpitPatch) => { if (context.data?.actor.is_human === true) updateBoard.mutate(patch, { onError: fail }); },
    [updateBoard, fail, context.data?.actor.is_human],
  );
  const patchNode = useCallback(
    (id: string, patch: CockpitNodePatch) => { if (context.data?.actor.is_human === true && !contextNodeIds.has(id)) updateNode.mutate({ id, patch }, { onError: fail }); },
    [updateNode, fail, context.data?.actor.is_human, contextNodeIds],
  );
  const patchMilestone = useCallback(
    (id: string, patch: CockpitMilestonePatch) => { if (context.data?.actor.is_human === true) updateMilestone.mutate({ id, patch }, { onError: fail }); },
    [updateMilestone, fail, context.data?.actor.is_human],
  );
  // The directory save is shared by the picker (one contact, awaited) and
  // the auto-save (a batch, fired alongside a meeting commit). A failure is
  // told, not swallowed — the entry would otherwise vanish from the next
  // form with nobody the wiser.
  const saveDirectoryEntries = useCallback(
    async (entries: (CockpitDirectoryEntry & { clear_position?: boolean })[]): Promise<boolean> => {
      try {
        await upsertDirectory.mutateAsync({ entries: entries.map(({ party, name, position, clear_position }) => ({ party, name, position, clear_position })) });
        return true;
      } catch {
        toast.error(t(($) => $.meetings.directory_save_failed));
        return false;
      }
    },
    [upsertDirectory, t],
  );
  const saveDirectoryEntry = useCallback(
    (entry: CockpitDirectoryEntry & { clear_position?: boolean }) => saveDirectoryEntries([entry]),
    [saveDirectoryEntries],
  );
  const autoSaveDirectory = useCallback(
    (entries: CockpitDirectoryEntry[]) => {
      upsertDirectory.mutate({ entries: entries.map(({ party, name, position }) => ({ party, name, position })), only_unknown_names: true }, { onError: () => toast.error(t(($) => $.meetings.directory_save_failed)) });
    },
    [upsertDirectory, t],
  );

  // Contact writes invalidate the shared directory pages. Preset rows remain
  // protected by both the editor and the server.
  const removeDirectoryEntry = useCallback(
    async (entry: { party: string; name: string }): Promise<boolean> => {
      try {
        await deleteDirectoryEntry.mutateAsync(entry);
        return true;
      } catch {
        toast.error(t(($) => $.meetings.directory_delete_failed));
        return false;
      }
    },
    [deleteDirectoryEntry, t],
  );

  const focusTask = useCallback(
    (nodeId: string) => {
      setCollapsed((prev) => {
        const ancestors = new Set<string>();
        let cursor: string | null = nodeId;
        while (cursor) {
          const parent = summaryParent.get(cursor);
          if (!parent) break;
          ancestors.add(parent);
          cursor = parent;
        }
        if (ancestors.size === 0) return prev;
        const next = new Set(prev);
        ancestors.forEach((id) => next.delete(id));
        return next;
      });
      setFocusTarget((prev) => ({ nodeId, nonce: (prev?.nonce ?? 0) + 1 }));
      setTab("gantt");
    },
    [summaryParent, setCollapsed],
  );

  const openTask = useCallback((nodeId: string) => {
    navigation.push(cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, planView }, scope));
  }, [navigation, planView, scope]);
  const openMeeting = (meetingId?: string | null) => {
    navigation.push(cockpitMeetingContextPath(navigation.pathname, meetingId ?? null, scope, navigation.searchParams));
  };

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, [setCollapsed]);

  /**
   * Open the tree down to one level and no further. A six-module board with
   * 226 rows is unreadable fully expanded and useless fully collapsed; the
   * level someone wants is almost always "modules" or "modules and tasks".
   * Runs over the summary shape, so a merged group is one level, like the
   * rows the reader is looking at.
   */
  const expandToDepth = useCallback(
    (maxDepth: number) => {
      setCollapsed(
        new Set(
          summaryFlat
            .filter((e) => e.children.length > 0 && e.depth >= maxDepth)
            .map((e) => e.node.id),
        ),
      );
    },
    [summaryFlat, setCollapsed],
  );

  /**
   * First paint opens the board to its directions and stops there — the
   * shipped board's default: modules and directions visible, one click from
   * the tasks. This runs once: a live edit or a websocket refresh must not
   * fold a branch the reader just opened.
   */
  useEffect(() => {
    if (planState.seeded || summaryFlat.length === 0) return;
    setCollapsed(new Set(cockpitSummaryCollapseIds(summaryTree)));
  }, [planState.seeded, summaryFlat.length, summaryTree, setCollapsed]);

  useEffect(() => { if (selectedId && nodes.some((node) => node.id === selectedId)) focusTask(selectedId); }, [selectedId, nodes, focusTask]);

  const overall = useMemo(
    () => cockpitOverallProgress(nodes, today, board?.cockpit.goal_date ?? null),
    [nodes, today, board?.cockpit.goal_date],
  );

  const toggleRoot = useCallback((nodeId: string) => {
    setRootIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, [setRootIds]);

  /** Reports what provisioning actually managed, part by part. */
  const reportProvision = useCallback(
    (result: { task: { issue_identifier: string } | null; task_error: string; dir_created: boolean; dir_error: string; directory_operation_id?: string }) => {
      if (result.task) {
        toast.success(t(($) => $.meetings.task_opened, { identifier: result.task!.issue_identifier }));
      }
      if (result.task_error) {
        toast.error(t(($) => $.meetings.task_failed, { reason: result.task_error }));
      }
      if (result.directory_operation_id) toast.info(t(($) => $.meeting_directory.plan_registered));
      else if (result.dir_created) toast.success(t(($) => $.meetings.dir_created));
      if (result.dir_error && !result.directory_operation_id) {
        toast.error(t(($) => $.meetings.dir_failed, { reason: result.dir_error }));
      }
    },
    [t],
  );

  /** Each retry resumes the same confirmed command. The form owns navigation after the full operation settles. */
  const submitMeeting = useCallback(
    async (draft: CockpitMeetingDraft, provision: CockpitMeetingProvision, workflow: CockpitMeetingWorkflowSetup | null): Promise<CockpitMeetingCreationResult> => {
      const isCurrent = captureMeetingContext();
      const existing = useCockpitMeetingCreateDraftStore.getState().draft.byScope[meetingCreateKey];
      const progress = existing?.meeting.creation_key === draft.creation_key ? existing : null;
      if (!progress) throw new Error(t(($) => $.workflow.unconfirmed));
      try {
        let meetingId = progress?.meetingId ?? null;
        let directoryOperationId = progress.directoryOperationId ?? undefined;
        if (!meetingId) {
          const meeting = await createMeeting.mutateAsync({
            creation_key: draft.creation_key, node_id: draft.node_id || undefined,
            meet_date: draft.meet_date || null, start_time: draft.start_time || null, end_time: draft.end_time || null,
            kind: draft.kind, status: draft.status, track: draft.track, parties: draft.parties,
            organizer: draft.organizer, attendees: draft.attendees, location: draft.location, title: draft.title,
          });
          if (!meeting.id || meeting.creation_key !== draft.creation_key || typeof meeting.replayed !== "boolean") throw new Error(t(($) => $.workflow.unconfirmed));
          meetingId = meeting.id;
          checkpointCockpitMeetingCreation(meetingCreateKey, progress, { meetingId });
        }
        if (workflow && !progress?.workflowCreated) {
          await enableMeetingWorkflow.mutateAsync({ meetingId, body: workflow });
          checkpointCockpitMeetingCreation(meetingCreateKey, progress, { workflowCreated: true });
        }
        if (provision.create_dir && !progress?.directoryReady && !directoryOperationId) {
          const result = await provisionMeeting.mutateAsync({ id: meetingId, body: { ...provision, create_task: false } });
          if (isCurrent()) reportProvision(result);
          if (result.meeting.id !== meetingId) throw new Error(t(($) => $.workflow.unconfirmed));
          if (result.directory_operation_id) {
            directoryOperationId = result.directory_operation_id;
            checkpointCockpitMeetingCreation(meetingCreateKey, progress, { directoryOperationId });
          } else {
            if (result.dir_error) throw new Error(result.dir_error);
            if (!result.meeting.nas_dir) throw new Error(t(($) => $.workflow.unconfirmed));
            checkpointCockpitMeetingCreation(meetingCreateKey, progress, { directoryReady: true });
          }
        }
        return { meetingId, directoryOperationId };
      } catch (error) {
        if (isCurrent()) fail(error);
        throw error;
      }
    },
    [createMeeting, enableMeetingWorkflow, provisionMeeting, reportProvision, fail, t, captureMeetingContext, meetingCreateKey],
  );

  /** The import dialog keeps per-folder receipts and recoverable edits in the captured scope. */
  const submitMeetingImport = useCallback(
    async (items: CockpitMeetingImportItem[], createTask: boolean, expectedBaseDir: string): Promise<CockpitMeetingImportResult> => {
      const isCurrent = captureImportContext();
      try {
        return await importMeetings.mutateAsync({ items, project_id: meetingProjectId ?? undefined,
          module_id: meetingModuleId ?? undefined, node_id: meetingNodeId ?? undefined, create_task: createTask, expected_base_dir: expectedBaseDir });
      } catch (error) {
        if (isCurrent()) fail(error);
        throw error;
      }
    },
    [importMeetings, meetingProjectId, meetingModuleId, meetingNodeId, fail, captureImportContext],
  );

  const requestDeletion = (kind: "milestone", id: string) => {
    deletionOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeletion({ kind, id, label: board?.milestones.find((item) => item.id === id)?.name || t(($) => $.milestone.new) });
  };

  const confirmDeletion = async () => {
    if (!deletion || deletionLock.current) return;
    deletionLock.current = true;
    setDeleting(true);
    try {
      await deleteMilestone.mutateAsync(deletion.id);
      setDeletion(null);
    } catch (error) {
      fail(error);
    } finally {
      deletionLock.current = false;
      setDeleting(false);
    }
  };

  const [exporting, setExporting] = useState(false);
  const chartContainer = useRef<HTMLDivElement>(null);
  const exportChart = async (format: "png" | "pdf") => {
    const chart = chartContainer.current?.querySelector<HTMLElement>("[data-cockpit-gantt]");
    if (!board || !chart || exporting) return;
    if (Number(chart.dataset.cockpitRowCount) > 300) { fail(new Error(t(($) => $.plan_views.export_too_large))); return; }
    const popup = format === "pdf" ? window.open("", "_blank", "popup,width=1100,height=800") : null;
    if (format === "pdf" && !popup) { fail(new Error(t(($) => $.errors.save_failed))); return; }
    if (popup) popup.opener = null;
    setExporting(true);
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const canvas = await captureCockpitGantt(chart, format === "pdf");
      const filename = `${board.cockpit.title || "cockpit"}-${today}`;
      if (popup) await printCockpitGantt(canvas, popup, filename);
      else await downloadCockpitPng(canvas, `${filename}.png`);
    } catch (error) { popup?.close(); fail(error); }
    finally { setExporting(false); }
  };

  const showTaskWorkspace = Boolean(selectedId);

  const roots = tree.map((entry) => entry.node);
  const isBoardView = tab === "gantt" || tab === "finance";

  return (
    <div className="cockpit-skin flex h-full min-h-0 flex-col">
      <header className={cn("flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2", (tab === "meetings" ? Boolean(selectedMeetingId) : showTaskWorkspace) && "max-xl:hidden")}>
        <span className="flex-1" />

        {isBoardView && (
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t(($) => $.toolbar.search_placeholder)}
                aria-label={t(($) => $.toolbar.search)}
                className="h-7 w-56 pl-7 text-caption"
              />
            </div>

            {roots.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant={rootIds.size > 0 ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 gap-1 px-2"
                      aria-label={t(($) => $.toolbar.scope)}
                    >
                      <Layers className="size-3.5" />
                      {rootIds.size > 0
                        ? t(($) => $.toolbar.scope_count, {
                            n: rootIds.size,
                            total: roots.length,
                          })
                        : t(($) => $.toolbar.scope_all)}
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {roots.map((root) => (
                    <DropdownMenuCheckboxItem
                      key={root.id}
                      checked={rootIds.has(root.id)}
                      closeOnClick={false}
                      onCheckedChange={() => toggleRoot(root.id)}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: root.color || "var(--color-brand)" }}
                        aria-hidden
                      />
                      {displayCodes.get(root.id) ?? root.code} {root.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setRootIds(new Set())}>
                    {t(($) => $.toolbar.scope_all)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}

        {tab === "gantt" && planView === "gantt" && (
          <Button variant="ghost" size="icon-sm" aria-expanded={toolsOpen}
            aria-controls="cockpit-secondary-toolbar"
            aria-label={toolsOpen ? t(($) => $.toolbar.collapse_controls) : t(($) => $.toolbar.expand_controls)}
            onClick={() => setToolsOpen((open) => !open)}>
            {toolsOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </Button>
        )}

        {/* The two headline figures stay out of the collapsible toolbar: they
            are the board's state, not a control, and the shipped board keeps
            them visible however the controls are folded. */}
        {tab === "gantt" && planView === "gantt" && (
          <div className="flex items-center gap-2">
            <ProgressChip
              label={t(($) => $.toolbar.overall_progress)}
              value={overall.overall}
              hint={t(($) => $.toolbar.overall_basis)}
            />
            {board?.cockpit.goal_date && (
              <ProgressChip
                label={t(($) => $.toolbar.year_progress)}
                value={overall.thisYear}
                behind={overall.behind}
                hint={t(($) => $.toolbar.year_basis, {
                  date: board.cockpit.goal_date,
                  scheduled: overall.scheduled ?? "—",
                })}
              />
            )}
          </div>
        )}

        {tab === "gantt" && planView === "gantt" && toolsOpen && (
          <div id="cockpit-secondary-toolbar" className="order-last flex w-full flex-wrap items-center gap-2">
            <Select
              items={[
                { value: "month", label: t(($) => $.toolbar.zoom_month) },
                { value: "week", label: t(($) => $.toolbar.zoom_week) },
              ]}
              value={zoom}
              onValueChange={(value) => value && setZoom(value as CockpitZoom)}
            >
              <SelectTrigger className="h-7 w-24 text-caption" aria-label={t(($) => $.toolbar.zoom)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">{t(($) => $.toolbar.zoom_month)}</SelectItem>
                <SelectItem value="week">{t(($) => $.toolbar.zoom_week)}</SelectItem>
              </SelectContent>
            </Select>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
                    {collapsed.size > 0 ? (
                      <ChevronsUpDown className="size-3.5" />
                    ) : (
                      <ChevronsDownUp className="size-3.5" />
                    )}
                    {t(($) => $.toolbar.expand)}
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCollapsed(new Set())}>
                  {t(($) => $.toolbar.expand_all)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => expandToDepth(1)}>
                  {t(($) => $.toolbar.expand_l2)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => expandToDepth(2)}>
                  {t(($) => $.toolbar.expand_l3)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => expandToDepth(0)}>
                  {t(($) => $.toolbar.collapse_all)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant={showFinance ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1 px-2"
              aria-pressed={showFinance}
              onClick={() => setShowFinance((on) => !on)}
            >
              <CircleDollarSign className="size-3.5" />
              {t(($) => $.toolbar.show_finance)}
            </Button>

            {context.data?.capabilities?.meeting_disposition === true && <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={planState.includeArchivedMeetings} onChange={(event) => useCockpitScopeViewStore.getState().updatePlan(planKey, { includeArchivedMeetings: event.target.checked })} />{t(($) => $.meeting_disposition.include_archived_markers)}</label>}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2"
              onClick={() => setScrollToTodayNonce((n) => n + 1)}
            >
              <Crosshair className="size-3.5" />
              {t(($) => $.toolbar.back_to_today)}
            </Button>
          </div>
        )}

        {board && tab !== "meetings" && tab !== "changes" && <CockpitCsvExport wsId={wsId} scope={scope} initialMode={planView === "finance" ? "finance" : "tasks"} />}
        {cockpit && <CockpitVersions wsId={wsId} canRestore={canRestore}
          hasMeetingWorkflows={context.data?.has_meeting_workflows === true}
          hasMeetingLifecycle={context.data?.has_meeting_lifecycle === true}
          hasMeetingPreparation={context.data?.has_meeting_preparation === true}
          hasDirectoryHistory={context.data?.has_directory_history === true}
          hasInputReferences={context.data?.has_input_references === true} inputReferenceMeetings={context.data?.input_reference_meetings ?? []} inputReferenceMeetingsTotal={context.data?.input_reference_meetings_total ?? 0} onRefreshInputReferences={() => void context.refetch()}
          meetingsHref={cockpitScopedPath(navigation.pathname, new URLSearchParams(context.data?.has_directory_history === true ? "tab=meetings&meeting_archive=all" : "tab=meetings"), { projectId: null, moduleId: null })}
          hasStableBindings={context.data?.has_stable_bindings !== false} />}

        {tab === "gantt" && planView === "gantt" && board && <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
                <Download className="size-3.5" />
                {t(($) => $.toolbar.export)}
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={tab !== "gantt" || exporting} onClick={() => void exportChart("png")}>
              {t(($) => $.toolbar.export_png)}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={tab !== "gantt" || exporting} onClick={() => void exportChart("pdf")}>
              {t(($) => $.toolbar.export_pdf)}
            </DropdownMenuItem>

          </DropdownMenuContent>
        </DropdownMenu>}

        {/* The register's primary action is a meeting, not a work item —
            offering "add node" while showing meetings would file the wrong
            thing in one click. */}
        {tab === "meetings" ? (
          <Button size="sm" className="h-7 gap-1 px-2" disabled={context.data?.actor.is_human !== true} onClick={() => setCreatingMeeting(true)}>
            <Plus className="size-3.5" />
            {t(($) => $.meeting.new)}
          </Button>
        ) : tab !== "changes" ? (
          <CockpitPlanStructureCreate wsId={wsId} scope={scope} defaultKind={scope.moduleId && nodes.some((node) => node.module_id === scope.moduleId) ? "task" : scope.projectId && nodes.some((node) => node.project_id === scope.projectId && !node.module_id) ? "module" : "project"} disabled={context.data?.actor.is_human !== true || planQuery.isError} onCreated={openTask} />
        ) : null}
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* Keyed on the tab so each switch replays the short entrance on the
            fresh body — the chrome stays put, the content arrives. */}
        <div key={tab} className={cn("cockpit-tab-enter flex min-w-0 flex-1 flex-col overflow-hidden", tab === "meetings" && selectedMeetingId && "max-xl:hidden",
          tab !== "meetings" && showTaskWorkspace && "max-xl:hidden")}>
          {tab !== "meetings" && tab !== "changes" && planQuery.isError && <CockpitReadFailure error={planQuery.error} wsId={wsId} scope={scope} resource="plan" busy={planQuery.isFetching} onRetry={() => void planQuery.refetch()} />}
          {tab !== "meetings" && tab !== "changes" && planQuery.isSuccess && !planQuery.isError && (!board || board.nodes.length === 0) && <p className="p-8 text-body text-muted-foreground">{t(($) => $.plan_structure.empty)}</p>}
          {tab !== "meetings" && tab !== "changes" && planQuery.isPending && <div className="space-y-3 p-4"><Skeleton className="h-20" /><Skeleton className="h-64" /></div>}
          {tab === "overview" && board && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CockpitOverview
                board={board}
                contextNodeIds={contextNodeIds}
                displayCodes={displayCodes}
                today={today}
                onPatchBoard={patchBoard}
                onPatchNode={patchNode}
                onPatchMilestone={patchMilestone}
                onCreateMilestone={() => setCreatingMilestone(true)}
                onDeleteMilestone={(id) => requestDeletion("milestone", id)}
                readOnly={context.data?.actor.is_human !== true || planQuery.isError}
                meetingsSlot={<CockpitBusinessMeetings readOnly={context.data?.actor.is_human !== true} wsId={wsId} scope={scope} today={today} onOpenMeeting={openMeeting} onCreate={() => setCreatingMeeting(true)} />}
                onOpenBranch={(nodeId) => {
                  setRootIds(new Set([nodeId]));
                  navigation.push(cockpitSurfacePath(navigation.pathname, "plan", scope, "gantt"));
                }}
                onOpenModule={(rootCode) => {
                  const root = tree.find((entry) => entry.node.code === rootCode);
                  if (root) {
                    setRootIds(new Set([root.node.id]));
                    navigation.push(cockpitSurfacePath(navigation.pathname, "plan", scope, "gantt"));
                  }
                }}
                onOpenTask={openTask}
                ownerSuggestions={ownerSuggestions}
              />
            </div>
          )}

          {tab === "gantt" && planView === "gantt" && board && (
            <div ref={chartContainer} className="flex min-h-0 flex-1 flex-col" aria-busy={exporting}>
            <CockpitGantt
              board={board}
              displayCodes={displayCodes}
              contextNodeIds={contextNodeIds}
              taskCounts={taskCounts}
              today={today}
              zoom={zoom}
              query={query}
              rootIds={rootIds}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onSelect={openTask}
              selectedId={selectedId}
              onPatchNode={patchNode}
              readOnly={planQuery.isError || context.data?.actor.is_human !== true}
              statusSuggestions={statusSuggestions}
              ownerSuggestions={ownerSuggestions}
              showFinance={showFinance}
              includeArchivedMeetings={planState.includeArchivedMeetings}
              toolbarOpen={toolsOpen}
              scrollToTodayNonce={scrollToTodayNonce}
              focusTarget={focusTarget}
              renderAllRows={exporting}
              onOpenMeeting={openMeeting}
            />
            </div>
          )}

          {tab === "meetings" && (
            <CockpitMeetings
              wsId={wsId}
              scope={cockpitScope(navigation.searchParams)}
              today={today}
              selectedId={selectedMeetingId}
              onSelect={openMeeting}
              onCreate={() => setCreatingMeeting(true)}
              onScan={() => setScanningMeetings(true)}
              dispositionAvailable={context.data?.capabilities?.meeting_disposition === true}
              readOnly={context.data?.actor.is_human !== true}
            />
          )}

          {tab === "changes" && (
            <CockpitChanges key={planKey} wsId={wsId} scope={scope} readOnly={context.data?.actor.is_human !== true} onOpenTask={openTask} />
          )}

          {tab === "gantt" && planView === "responsibility" && <CockpitResponsibilities wsId={wsId} query={query} rootIds={rootIds} nodes={nodes} displayCodes={displayCodes} scope={scope} />}
          {tab === "gantt" && planView === "milestones" && board && <CockpitMilestones wsId={wsId} query={query} rootIds={rootIds} readOnly={context.data?.actor.is_human !== true || planQuery.isError} nodes={nodes} milestones={board.milestones} displayCodes={displayCodes} scope={scope}
            today={today} goalDate={board.cockpit.goal_date} onCreate={() => setCreatingMilestone(true)}
            onPatch={patchMilestone} onDelete={(id) => requestDeletion("milestone", id)} />}
          {(tab === "finance" || (tab === "gantt" && (planView === "table" || planView === "finance"))) && board && (
            <CockpitTable
              board={board}
              displayCodes={displayCodes}
              contextNodeIds={contextNodeIds}
              taskCounts={taskCounts}
              mode={planView === "table" ? "tasks" : "finance"}
              query={query}
              rootIds={rootIds}
              onSelect={openTask}
              selectedId={selectedId}
              onPatchNode={patchNode}
              readOnly={planQuery.isError || context.data?.actor.is_human !== true}
              statusSuggestions={statusSuggestions}
              execStatusSuggestions={execStatusSuggestions}
              budgetCategorySuggestions={budgetCategorySuggestions}
              ownerSuggestions={ownerSuggestions}
              vendorSuggestions={vendorSuggestions}
            />
          )}
        </div>

        {tab === "meetings" && selectedMeetingId && <CockpitSelectedMeeting key={selectedMeetingId} wsId={wsId} meetingId={selectedMeetingId} scope={scope}
          onClose={() => navigation.push(cockpitMeetingContextPath(navigation.pathname, null, scope, navigation.searchParams))} onOpenNode={openTask} />}

        {tab !== "meetings" && selectedId && <CockpitSelectedNode key={selectedId} wsId={wsId} nodeId={selectedId} scope={scope} planView={planView}
          section={destination.nodeView ?? "tasks"} onClose={() => navigation.push(cockpitSurfacePath(navigation.pathname, "plan", scope, planView))}
          onOpenNode={openTask} onOpenMeeting={openMeeting} />}

      </div>
      <CockpitMilestoneCreate wsId={wsId} scope={scope} open={creatingMilestone} onOpenChange={setCreatingMilestone} initialNodeId={selectedId && nodes.some((node) => node.id === selectedId) && !contextNodeIds.has(selectedId) ? selectedId : null} disabled={context.data?.actor.is_human !== true} />
      <CockpitMeetingCreate key={meetingCreateKey}
        open={creatingMeeting}
        onOpenChange={onMeetingCreateOpenChange}
        wsId={wsId}
        scope={scope}
        today={today}
        members={members}
        onSaveDirectoryEntry={saveDirectoryEntry}
        onDeleteDirectoryEntry={removeDirectoryEntry}
        onAutoSaveDirectory={autoSaveDirectory}
        currentUserName={currentUserName}
        currentUserId={currentUserId}
        savedMeetingId={savedMeetingId}
        workflowCreated={meetingWorkflowCreated}
        defaultProjectId={meetingProjectId}
        defaultModuleId={meetingModuleId}
        defaultNodeId={meetingNodeId}
        defaultAssigneeType={cockpit?.meeting_assignee_type || null}
        defaultAssigneeId={cockpit?.meeting_assignee_id ?? null}
        onSubmit={submitMeeting}
        onCreated={({ meetingId, directoryOperationId }) => directoryOperationId ? navigation.push(cockpitMeetingDirectoryPath(navigation.pathname, meetingId, directoryOperationId, navigation.searchParams)) : navigation.push(cockpitMeetingContextPath(navigation.pathname, meetingId, scope, navigation.searchParams, "preparation"))}
      />
      <CockpitMeetingImport
        open={scanningMeetings}
        onOpenChange={setScanningMeetings}
        wsId={wsId}
        projectId={meetingProjectId}
        moduleId={meetingModuleId}
        nodeId={meetingNodeId}
        onSubmit={submitMeetingImport}
      />
      <AlertDialog open={deletion !== null} onOpenChange={(open) => {
        if (!open && !deletionLock.current) setDeletion(null);
      }}>
        <AlertDialogContent finalFocus={deletionOpener}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.confirmation.delete_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.confirmation.delete_description, { label: deletion?.label ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={deleting} onClick={() => setDeletion(null)}>
              {commonT(($) => $.cancel)}
            </Button>
            <Button variant="destructive" disabled={deleting} aria-busy={deleting} onClick={confirmDeletion}>
              {commonT(($) => $.delete)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
