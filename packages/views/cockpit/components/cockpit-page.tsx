"use client";

// The project cockpit page: "/:slug/cockpit" on web, the same view on desktop.
//
// One board per workspace, edited by everyone at once. Server state lives in the
// board query; the view state below (which tab, which branch, what is collapsed,
// what is selected) is local to this screen and deliberately not persisted —
// re-opening the cockpit should show the board, not the last person's scroll
// position.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import type {
  CockpitIssueLink,
  CockpitMeeting,
  CockpitMeetingIssueLink,
  CockpitMeetingNodeLink,
  CockpitMeetingPatch,
  CockpitMeetingImportItem,
  CockpitMeetingProvision,
  MemberWithUser,
  CockpitMilestonePatch,
  CockpitNode,
  CockpitNodePatch,
  CockpitPatch,
  CockpitPayment,
  CockpitPaymentPatch,
  Issue,
  Module,
} from "@multica/core/types";
import {
  buildCockpitDisplayCodes,
  buildCockpitSummaryTree,
  buildCockpitTree,
  cockpitBoardOptions,
  cockpitChangesOptions,
  cockpitNodeIssueFiling,
  cockpitOverallProgress,
  cockpitSummaryCollapseIds,
  cockpitTasksCsv,
  flattenCockpitTree,
  groupMeetingIssues,
  groupMeetingNodes,
  groupMeetingsByNode,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  useCreateCockpitMeeting,
  useCreateCockpitMilestone,
  useCreateCockpitNode,
  useCreateCockpitPayment,
  useDeleteCockpitMeeting,
  useDeleteCockpitMilestone,
  useDeleteCockpitNode,
  useDeleteCockpitMeetingIssue,
  useDeleteCockpitMeetingNode,
  useDeleteCockpitNodeIssue,
  useDeleteCockpitPayment,
  useImportCockpitMeetingFolders,
  useProvisionCockpitMeeting,
  useSetCockpitMeetingIssues,
  useSetCockpitMeetingNodes,
  useSetCockpitNodeIssues,
  useUpdateCockpit,
  useUpdateCockpitMeeting,
  useUpdateCockpitMilestone,
  useUpdateCockpitNode,
  useUpdateCockpitPayment,
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
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useModalStore } from "@multica/core/modals";
import { useT } from "../../i18n";
import { EditableText } from "./cockpit-fields";
import { CockpitChanges } from "./cockpit-changes";
import { captureCockpitGantt, downloadCockpitPng, printCockpitGantt } from "./cockpit-export";
import { CockpitGantt, type CockpitZoom } from "./cockpit-gantt";
import { CockpitMeetingCreate, type CockpitMeetingDraft } from "./cockpit-meeting-create";
import { CockpitMeetingImport } from "./cockpit-meeting-import";
import { CockpitMeetingPanel } from "./cockpit-meeting-panel";
import { CockpitMeetings } from "./cockpit-meetings";
import type { CockpitNodeIssueOption } from "./cockpit-node-issue-picker";
import { CockpitNodePanel } from "./cockpit-node-panel";
import { CockpitOverview } from "./cockpit-overview";
import { CockpitTable } from "./cockpit-table";
import { CockpitVersions } from "./cockpit-versions";

type CockpitTab = "overview" | "gantt" | "meetings" | "changes" | "finance";

const TABS: CockpitTab[] = ["overview", "gantt", "meetings", "changes", "finance"];

// Stable empty arrays: an inline `?? []` allocates a fresh array on every
// render while the board query is loading, which invalidates every memo
// downstream of it.
const EMPTY_NODES: CockpitNode[] = [];
const EMPTY_MEMBERS: MemberWithUser[] = [];
const EMPTY_MODULES: Module[] = [];
const EMPTY_PAYMENTS: CockpitPayment[] = [];
const EMPTY_LINKS: CockpitIssueLink[] = [];
const EMPTY_MEETINGS: CockpitMeeting[] = [];
const EMPTY_MEETING_ISSUES: CockpitMeetingIssueLink[] = [];
const EMPTY_MEETING_NODES: CockpitMeetingNodeLink[] = [];

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

/** Hands the browser a file. The CSV itself is built in `@multica/core`. */
function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: Safari reads the blob
  // after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function CockpitPage() {
  const { t } = useT("cockpit");
  const { t: commonT } = useT("common");
  const wsId = useWorkspaceId();
  const [tab, setTab] = useState<CockpitTab>("overview");
  const [zoom, setZoom] = useState<CockpitZoom>("month");
  const [query, setQuery] = useState("");
  // Empty means "every module"; the menu is multi-select, so comparing two
  // modules side by side does not mean opening the board twice.
  const [rootIds, setRootIds] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [creatingMeeting, setCreatingMeeting] = useState(false);
  const [scanningMeetings, setScanningMeetings] = useState(false);
  const [showFinance, setShowFinance] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(true);
  const [deletion, setDeletion] = useState<{ kind: "meeting" | "milestone" | "payment"; id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletionLock = useRef(false);
  const deletionOpener = useRef<HTMLElement | null>(null);
  const [scrollToTodayNonce, setScrollToTodayNonce] = useState(0);
  // The gantt locates-and-flashes one row; the nonce makes repeat clicks on
  // the same digest task re-trigger the effect.
  const [focusTarget, setFocusTarget] = useState<{ nodeId: string; nonce: number } | null>(
    null,
  );
  const [today] = useState(todayString);

  const { data: board, isLoading } = useQuery(cockpitBoardOptions(wsId));
  const { data: pendingChanges } = useQuery(cockpitChangesOptions(wsId));
  const pendingCount = useMemo(
    () => (pendingChanges ?? []).filter((c) => c.status === "pending").length,
    [pendingChanges],
  );

  // Restore replaces the whole board, which the server gates to owner/admin.
  // The role check here only decides whether the affordance is offered.
  const currentUserId = useAuthStore((s) => s.user?.id ?? "");
  const { data: members } = useQuery(memberListOptions(wsId));
  // The workspace's modules, read for one reason: a work item files its
  // issues into the module its row code names.
  const { data: modules } = useQuery(moduleListOptions(wsId));
  const openModal = useModalStore((state) => state.open);
  const canRestore = useMemo(() => {
    const mine = (members ?? []).find((m) => m.user_id === currentUserId);
    return mine?.role === "owner" || mine?.role === "admin";
  }, [members, currentUserId]);
  const currentUserName = useMemo(
    () => (members ?? []).find((m) => m.user_id === currentUserId)?.name ?? "",
    [members, currentUserId],
  );

  const updateBoard = useUpdateCockpit(wsId);
  const createNode = useCreateCockpitNode(wsId);
  const updateNode = useUpdateCockpitNode(wsId);
  const deleteNode = useDeleteCockpitNode(wsId);
  const setNodeIssues = useSetCockpitNodeIssues(wsId);
  const unlinkIssue = useDeleteCockpitNodeIssue(wsId);
  const createPayment = useCreateCockpitPayment(wsId);
  const updatePayment = useUpdateCockpitPayment(wsId);
  const deletePayment = useDeleteCockpitPayment(wsId);
  const createMilestone = useCreateCockpitMilestone(wsId);
  const updateMilestone = useUpdateCockpitMilestone(wsId);
  const deleteMilestone = useDeleteCockpitMilestone(wsId);
  const createMeeting = useCreateCockpitMeeting(wsId);
  const updateMeeting = useUpdateCockpitMeeting(wsId);
  const deleteMeeting = useDeleteCockpitMeeting(wsId);
  const provisionMeeting = useProvisionCockpitMeeting(wsId);
  const importMeetings = useImportCockpitMeetingFolders(wsId);
  const setMeetingIssues = useSetCockpitMeetingIssues(wsId);
  const unlinkMeetingIssue = useDeleteCockpitMeetingIssue(wsId);
  const setMeetingNodes = useSetCockpitMeetingNodes(wsId);
  const unlinkMeetingNode = useDeleteCockpitMeetingNode(wsId);

  // `board?.nodes ?? []` inline would mint a new array on every render where
  // the query is still loading, invalidating every memo below it.
  const nodes = useMemo(() => board?.nodes ?? EMPTY_NODES, [board?.nodes]);
  const tree = useMemo(() => buildCockpitTree(nodes), [nodes]);
  // The shipped shape of the board: merged directions, tasks flattened under
  // the group rows. The gantt and the detail tables quote row codes from this
  // tree, so a code means the same row everywhere.
  const summaryTree = useMemo(() => buildCockpitSummaryTree(tree), [tree]);
  const summaryFlat = useMemo(() => flattenCockpitTree(summaryTree), [summaryTree]);
  const displayCodes = useMemo(() => buildCockpitDisplayCodes(summaryTree), [summaryTree]);
  // "06.06.02 会议台账与会议号" — how a linked work item reads wherever it is
  // named outside the gantt itself.
  const nodeLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const node of nodes) {
      labels.set(node.id, `${displayCodes.get(node.id) ?? node.code} ${node.name}`.trim());
    }
    return labels;
  }, [nodes, displayCodes]);
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
  }, [summaryTree, summaryFlat]);
  const flat = useMemo(() => flattenCockpitTree(tree), [tree]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const paymentsByNode = useMemo(
    () => groupPaymentsByNode(board?.payments ?? EMPTY_PAYMENTS),
    [board?.payments],
  );
  const linksByNode = useMemo(
    () => groupIssueLinksByNode(board?.issue_links ?? EMPTY_LINKS),
    [board?.issue_links],
  );

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

  const meetings = board?.meetings ?? EMPTY_MEETINGS;
  const meetingIssues = board?.meeting_issues ?? EMPTY_MEETING_ISSUES;
  const meetingNodes = board?.meeting_nodes ?? EMPTY_MEETING_NODES;
  const meetingIssuesByMeeting = useMemo(() => groupMeetingIssues(meetingIssues), [meetingIssues]);
  const meetingNodesByMeeting = useMemo(() => groupMeetingNodes(meetingNodes), [meetingNodes]);
  const meetingsByNode = useMemo(
    () => groupMeetingsByNode(meetings, meetingNodes),
    [meetings, meetingNodes],
  );
  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );

  // A node deleted by someone else must not leave the panel showing a ghost.
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [selectedId, nodeById]);

  useEffect(() => {
    if (selectedMeetingId && !meetings.some((m) => m.id === selectedMeetingId)) {
      setSelectedMeetingId(null);
    }
  }, [selectedMeetingId, meetings]);

  const fail = useCallback(
    (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
    },
    [t],
  );

  const patchBoard = useCallback(
    (patch: CockpitPatch) => updateBoard.mutate(patch, { onError: fail }),
    [updateBoard, fail],
  );
  const patchNode = useCallback(
    (id: string, patch: CockpitNodePatch) => updateNode.mutate({ id, patch }, { onError: fail }),
    [updateNode, fail],
  );
  const patchPayment = useCallback(
    (id: string, patch: CockpitPaymentPatch) => updatePayment.mutate({ id, patch }, { onError: fail }),
    [updatePayment, fail],
  );
  const patchMilestone = useCallback(
    (id: string, patch: CockpitMilestonePatch) =>
      updateMilestone.mutate({ id, patch }, { onError: fail }),
    [updateMilestone, fail],
  );
  const patchMeeting = useCallback(
    (id: string, patch: CockpitMeetingPatch) => updateMeeting.mutate({ id, patch }, { onError: fail }),
    [updateMeeting, fail],
  );

  // Read at call time, not captured: a linker can outlive the render that
  // produced it — the create dialog keeps its callback across a whole run of
  // "Create another" — and a replace built from a captured set would drop
  // every link made in between.
  const linksByNodeRef = useRef(linksByNode);
  useEffect(() => {
    linksByNodeRef.current = linksByNode;
  }, [linksByNode]);

  const linkIssue = useCallback(
    (nodeId: string, issueId: string) => {
      // Sent as a replace of the full set rather than as an append, so the
      // server writes the order this client is showing. Both clients derive
      // that set from the same realtime-synced board, so the last write wins
      // on a set that already agrees.
      const existing = (linksByNodeRef.current.get(nodeId) ?? []).map((l) => l.issue_id);
      if (existing.includes(issueId)) return;
      setNodeIssues.mutate(
        { nodeId, issueIds: [...existing, issueId], replace: true },
        { onError: fail },
      );
    },
    [setNodeIssues, fail],
  );

  /**
   * Open a new issue on a work item. The board and the tracker are numbered by
   * the same outline, so the row code says where the issue belongs: its leading
   * segments name the module, the module carries its project, and the code
   * itself opens the title the way the module's own "+" does.
   *
   * The issue is linked to the row as soon as it exists. Creating work from a
   * work item and then having to search for it to attach it would leave the
   * board no better off than before the link table.
   */
  const createIssueForNode = useCallback(
    (option: CockpitNodeIssueOption) => {
      openModal("create-issue", {
        title: option.code,
        project_id: option.project_id,
        module_id: option.module_id,
        // The row travels whole so the dialog can name it, and show it as a
        // field the user can move off: the row it proposes is a guess from
        // where the click came from, not a decision.
        cockpit_node: option,
        on_created: (issue: Issue, state: { cockpit_node_id: string | null }) => {
          if (state.cockpit_node_id) linkIssue(state.cockpit_node_id, issue.id);
        },
      });
    },
    [openModal, linkIssue],
  );

  /**
   * Jump from a digest-card task row into the gantt: expand its ancestors so
   * the row is rendered, select it (opens the node panel) and flash it.
   */
  const openTask = useCallback(
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
      setSelectedId(nodeId);
      setFocusTarget((prev) => ({ nodeId, nonce: (prev?.nonce ?? 0) + 1 }));
      setTab("gantt");
    },
    [summaryParent],
  );

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

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
    [summaryFlat],
  );

  /**
   * First paint opens the board to its directions and stops there — the
   * shipped board's default: modules and directions visible, one click from
   * the tasks. This runs once: a live edit or a websocket refresh must not
   * fold a branch the reader just opened.
   */
  const didSeedCollapse = useRef(false);
  useEffect(() => {
    if (didSeedCollapse.current || summaryFlat.length === 0) return;
    didSeedCollapse.current = true;
    setCollapsed(new Set(cockpitSummaryCollapseIds(summaryTree)));
  }, [summaryFlat, summaryTree]);

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
  }, []);

  const addNode = useCallback(() => {
    // A new node lands under whatever is selected, at the end of that branch.
    const parent = selectedId ? nodeById.get(selectedId) : undefined;
    const siblings = nodes.filter((n) => n.parent_id === (parent?.id ?? null));
    const position = siblings.reduce((max, n) => Math.max(max, n.position), 0) + 1;
    // Codes must be unique per board; suffixing the count is a starting point
    // the author renames, not a scheme the board depends on.
    const base = parent ? `${parent.code}-` : "L1-";
    let index = siblings.length + 1;
    let code = `${base}${String(index).padStart(2, "0")}`;
    const taken = new Set(nodes.map((n) => n.code));
    while (taken.has(code)) {
      index += 1;
      code = `${base}${String(index).padStart(2, "0")}`;
    }
    createNode.mutate(
      { code, name: "", parent_id: parent?.id ?? null, position, status: "" },
      {
        onSuccess: (node) => {
          setSelectedId(node.id);
          setTab("gantt");
        },
        onError: fail,
      },
    );
  }, [selectedId, nodeById, nodes, createNode, fail]);

  // Linking is additive at this level, same as a work item's issues: the
  // picker sends the full set it wants rather than a diff.
  const linkMeetingIssue = useCallback(
    (meetingId: string, issueId: string) => {
      const current = (meetingIssuesByMeeting.get(meetingId) ?? []).map((l) => l.issue_id);
      if (current.includes(issueId)) return;
      setMeetingIssues.mutate(
        { meetingId, issueIds: [...current, issueId], replace: true },
        { onError: fail },
      );
    },
    [meetingIssuesByMeeting, setMeetingIssues, fail],
  );

  const toggleMeetingNode = useCallback(
    (meetingId: string, nodeId: string) => {
      const current = (meetingNodesByMeeting.get(meetingId) ?? []).map((l) => l.node_id);
      if (current.includes(nodeId)) {
        unlinkMeetingNode.mutate({ meetingId, nodeId }, { onError: fail });
        return;
      }
      setMeetingNodes.mutate(
        { meetingId, nodeIds: [...current, nodeId], replace: true },
        { onError: fail },
      );
    },
    [meetingNodesByMeeting, setMeetingNodes, unlinkMeetingNode, fail],
  );

  /** Reports what provisioning actually managed, part by part. */
  const reportProvision = useCallback(
    (result: { task: { issue_identifier: string } | null; task_error: string; dir_created: boolean; dir_error: string }) => {
      if (result.task) {
        toast.success(t(($) => $.meetings.task_opened, { identifier: result.task!.issue_identifier }));
      }
      if (result.task_error) {
        toast.error(t(($) => $.meetings.task_failed, { reason: result.task_error }));
      }
      if (result.dir_created) toast.success(t(($) => $.meetings.dir_created));
      if (result.dir_error) {
        toast.error(t(($) => $.meetings.dir_failed, { reason: result.dir_error }));
      }
    },
    [t],
  );

  const provisionSelectedMeeting = useCallback(
    (meetingId: string, parts: { task?: boolean; dir?: boolean }) => {
      provisionMeeting.mutate(
        {
          id: meetingId,
          body: { create_task: parts.task === true, create_dir: parts.dir === true, remember: true },
        },
        { onSuccess: reportProvision, onError: fail },
      );
    },
    [provisionMeeting, reportProvision, fail],
  );

  /** Files a meeting: the row first, then whatever the form asked for on top
   *  of it. The row is what must not be lost, so it is written on its own. */
  const submitMeeting = useCallback(
    async (draft: CockpitMeetingDraft, provision: CockpitMeetingProvision) => {
      try {
        const meeting = await createMeeting.mutateAsync({
          meet_date: draft.meet_date || null,
          start_time: draft.start_time || null,
          end_time: draft.end_time || null,
          kind: draft.kind,
          status: draft.status,
          parties: draft.parties,
          organizer: draft.organizer,
          attendees: draft.attendees,
          location: draft.location,
          title: draft.title,
          code: draft.code,
        });
        setSelectedMeetingId(meeting.id);
        setTab("meetings");
        if (provision.create_task || provision.create_dir) {
          const result = await provisionMeeting.mutateAsync({ id: meeting.id, body: provision });
          reportProvision(result);
        }
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    [createMeeting, provisionMeeting, reportProvision, fail],
  );

  /** Turns the archive folders someone picked into meeting rows. */
  const submitMeetingImport = useCallback(
    async (items: CockpitMeetingImportItem[], createTask: boolean) => {
      try {
        const result = await importMeetings.mutateAsync({
          items,
          project_id: board?.cockpit.meeting_project_id ?? undefined,
          module_id: board?.cockpit.meeting_module_id ?? undefined,
          node_id: board?.cockpit.meeting_node_id ?? undefined,
          create_task: createTask,
        });
        if (result.meetings.length > 0) {
          toast.success(t(($) => $.meetings.scan_imported, { n: result.meetings.length }));
          setTab("meetings");
          setSelectedMeetingId(result.meetings[0]!.id);
        }
        // Every folder that was asked for and not taken says why, one by one:
        // a batch that half worked must not read as a batch that worked.
        for (const skip of result.skipped) {
          toast.error(t(($) => $.meetings.scan_skipped, { folder: skip.name, reason: skip.reason }));
        }
      } catch (error) {
        fail(error);
        throw error;
      }
    },
    [importMeetings, board, t, fail],
  );

  const requestDeletion = (kind: "meeting" | "milestone" | "payment", id: string) => {
    // Deleting the selected meeting closes its panel once the server agrees;
    // the panel itself only asks.
    deletionOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // What the confirmation names is the record, not the button that asked:
    // "meeting.delete" is the delete control's accessible name and reading it
    // back in makes the prompt say it will delete "delete meeting X".
    const named = (value: string | undefined, fallback: string) =>
      value?.trim() ? value.trim() : fallback;
    const label = kind === "meeting"
      ? named(board?.meetings.find((item) => item.id === id)?.title, t(($) => $.meeting.title_placeholder))
      : kind === "milestone"
        ? named(board?.milestones.find((item) => item.id === id)?.name, t(($) => $.milestone.new))
        : named(board?.payments.find((item) => item.id === id)?.label, t(($) => $.payment.label));
    setDeletion({ kind, id, label });
  };

  const confirmDeletion = async () => {
    if (!deletion || deletionLock.current) return;
    deletionLock.current = true;
    setDeleting(true);
    try {
      const mutation = deletion.kind === "meeting" ? deleteMeeting
        : deletion.kind === "milestone" ? deleteMilestone : deletePayment;
      await mutation.mutateAsync(deletion.id);
      setDeletion(null);
    } catch (error) {
      fail(error);
    } finally {
      deletionLock.current = false;
      setDeleting(false);
    }
  };

  const exportTasks = useCallback(() => {
    if (!board) return;
    downloadCsv(cockpitTasksCsv(board), `${board.cockpit.title || "cockpit"}-${today}-tasks.csv`);
  }, [board, today]);

  const [exporting, setExporting] = useState(false);
  const chartContainer = useRef<HTMLDivElement>(null);
  const exportChart = async (format: "png" | "pdf") => {
    const chart = chartContainer.current?.querySelector<HTMLElement>("[data-cockpit-gantt]");
    if (!board || !chart || exporting) return;
    const popup = format === "pdf" ? window.open("", "_blank", "popup,width=1100,height=800") : null;
    if (format === "pdf" && !popup) { fail(new Error(t(($) => $.errors.save_failed))); return; }
    if (popup) popup.opener = null;
    setExporting(true);
    try {
      const canvas = await captureCockpitGantt(chart, format === "pdf");
      const filename = `${board.cockpit.title || "cockpit"}-${today}`;
      if (popup) await printCockpitGantt(canvas, popup, filename);
      else await downloadCockpitPng(canvas, `${filename}.png`);
    } catch (error) { popup?.close(); fail(error); }
    finally { setExporting(false); }
  };

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedEntry = selectedId ? flat.find((e) => e.node.id === selectedId) : undefined;
  // Resolved from the DISPLAY code, which is the number the gantt shows and the
  // number the modules are titled with — the stored code carries the
  // programme's history and names nothing outside the board.
  const selectedFiling = useMemo((): CockpitNodeIssueOption | null => {
    if (!selected) return null;
    const code = displayCodes.get(selected.id) ?? selected.code;
    const filing = cockpitNodeIssueFiling(code, modules ?? EMPTY_MODULES);
    if (!filing) return null;
    return {
      node_id: selected.id,
      code,
      label: nodeLabels.get(selected.id) ?? code,
      project_id: filing.project_id,
      module_id: filing.module_id,
    };
  }, [selected, displayCodes, nodeLabels, modules]);

  if (isLoading || !board) {
    return (
      // cockpit-skin also on the loading frame so the board never flashes the
      // app theme while the query resolves.
      <div className="cockpit-skin flex flex-col gap-3 p-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const roots = tree.map((entry) => entry.node);
  const isBoardView = tab === "gantt" || tab === "finance";
  // A lookup rather than a ternary chain: five tabs is where the chain stops
  // being readable and starts hiding a missing label.
  const tabLabels: Record<CockpitTab, string> = {
    overview: t(($) => $.tabs.overview),
    gantt: t(($) => $.tabs.gantt),
    meetings: t(($) => $.tabs.meetings),
    changes: t(($) => $.tabs.changes),
    finance: t(($) => $.tabs.finance),
  };

  return (
    <div className="cockpit-skin flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <EditableText
          value={board.cockpit.title}
          onCommit={(title) => patchBoard({ title })}
          label={t(($) => $.header.title)}
          placeholder={t(($) => $.header.title_placeholder)}
          displayClassName="text-title-sm font-semibold"
        />

        <nav className="ml-2 flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              // The active tab keeps its identity under the cursor: hover only
              // touches the background of the inactive ones.
              className={cn(
                "rounded-sm px-2.5 py-1 text-caption transition-colors",
                tab === key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              {tabLabels[key]}
              {key === "changes" && pendingCount > 0 && (
                <span
                  className="ml-1 rounded-full bg-brand px-1.5 py-px text-micro leading-4 font-medium text-brand-foreground"
                  aria-label={t(($) => $.changes.queue_title, { n: pendingCount })}
                >
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </button>
          ))}
        </nav>

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

        {tab === "gantt" && (
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
        {tab === "gantt" && (
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

        {tab === "gantt" && toolsOpen && (
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

        <CockpitVersions wsId={wsId} canRestore={canRestore} />

        <DropdownMenu>
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
            <DropdownMenuItem onClick={exportTasks}>
              {t(($) => $.toolbar.export_tasks)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* The register's primary action is a meeting, not a work item —
            offering "add node" while showing meetings would file the wrong
            thing in one click. */}
        {tab === "meetings" ? (
          <Button size="sm" className="h-7 gap-1 px-2" onClick={() => setCreatingMeeting(true)}>
            <Plus className="size-3.5" />
            {t(($) => $.meeting.new)}
          </Button>
        ) : (
          <Button size="sm" className="h-7 gap-1 px-2" onClick={addNode}>
            <Plus className="size-3.5" />
            {t(($) => $.toolbar.add_node)}
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {tab === "overview" && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <CockpitOverview
                board={board}
                today={today}
                onPatchBoard={patchBoard}
                onPatchNode={patchNode}
                onPatchMilestone={patchMilestone}
                onCreateMilestone={() =>
                  createMilestone.mutate({ name: t(($) => $.milestone.new), status: "" }, { onError: fail })
                }
                onDeleteMilestone={(id) => requestDeletion("milestone", id)}
                onPatchMeeting={patchMeeting}
                // The same dialog the register's own "new meeting" opens.
                // A meeting is not a row someone fills in afterwards: it
                // decides a number, a folder and a task at the moment it is
                // filed, and a quick-add that skipped all three left rows the
                // rest of the register could not be read against.
                onCreateMeeting={() => setCreatingMeeting(true)}
                onDeleteMeeting={(id) => requestDeletion("meeting", id)}
                onOpenMeetings={(meetingId) => {
                  setSelectedMeetingId(meetingId ?? null);
                  setTab("meetings");
                }}
                onOpenBranch={(nodeId) => {
                  setRootIds(new Set([nodeId]));
                  setTab("gantt");
                }}
                onOpenModule={(rootCode) => {
                  const root = tree.find((entry) => entry.node.code === rootCode);
                  if (root) {
                    setRootIds(new Set([root.node.id]));
                    setTab("gantt");
                  }
                }}
                onOpenTask={openTask}
                ownerSuggestions={ownerSuggestions}
              />
            </div>
          )}

          {tab === "gantt" && (
            <div ref={chartContainer} className="flex min-h-0 flex-1 flex-col" aria-busy={exporting}>
            <CockpitGantt
              board={board}
              today={today}
              zoom={zoom}
              query={query}
              rootIds={rootIds}
              collapsed={collapsed}
              onToggleCollapse={toggleCollapse}
              onSelect={setSelectedId}
              selectedId={selectedId}
              onPatchNode={patchNode}
              statusSuggestions={statusSuggestions}
              ownerSuggestions={ownerSuggestions}
              showFinance={showFinance}
              toolbarOpen={toolsOpen}
              scrollToTodayNonce={scrollToTodayNonce}
              focusTarget={focusTarget}
              onOpenMeeting={(meetingId) => {
                setSelectedMeetingId(meetingId);
                setTab("meetings");
              }}
            />
            </div>
          )}

          {tab === "meetings" && (
            <CockpitMeetings
              board={board}
              today={today}
              selectedId={selectedMeetingId}
              onSelect={setSelectedMeetingId}
              onCreate={() => setCreatingMeeting(true)}
              onScan={() => setScanningMeetings(true)}
            />
          )}

          {tab === "changes" && (
            <CockpitChanges wsId={wsId} nodes={nodes} onOpenTask={openTask} />
          )}

          {tab === "finance" && (
            <CockpitTable
              board={board}
              mode="finance"
              query={query}
              rootIds={rootIds}
              onSelect={setSelectedId}
              selectedId={selectedId}
              onPatchNode={patchNode}
              statusSuggestions={statusSuggestions}
              execStatusSuggestions={execStatusSuggestions}
              budgetCategorySuggestions={budgetCategorySuggestions}
              ownerSuggestions={ownerSuggestions}
              vendorSuggestions={vendorSuggestions}
            />
          )}
        </div>

        {tab === "meetings" && selectedMeeting && (
          <CockpitMeetingPanel
            key={selectedMeeting.id}
            meeting={selectedMeeting}
            nodes={nodes}
            meetings={meetings}
            members={members ?? EMPTY_MEMBERS}
            issueLinks={meetingIssuesByMeeting.get(selectedMeeting.id) ?? []}
            nodeLinks={meetingNodesByMeeting.get(selectedMeeting.id) ?? []}
            nodeLabels={nodeLabels}
            onPatch={(patch) => patchMeeting(selectedMeeting.id, patch)}
            onClose={() => setSelectedMeetingId(null)}
            onDelete={() => requestDeletion("meeting", selectedMeeting.id)}
            onLinkIssue={(issueId) => linkMeetingIssue(selectedMeeting.id, issueId)}
            onUnlinkIssue={(issueId) =>
              unlinkMeetingIssue.mutate({ meetingId: selectedMeeting.id, issueId }, { onError: fail })
            }
            onToggleNode={(nodeId) => toggleMeetingNode(selectedMeeting.id, nodeId)}
            onOpenNode={openTask}
            onProvision={(parts) => provisionSelectedMeeting(selectedMeeting.id, parts)}
            provisioning={provisionMeeting.isPending}
          />
        )}

        {tab !== "meetings" && selected && (
          <CockpitNodePanel
            key={selected.id}
            node={selected}
            parent={selected.parent_id ? nodeById.get(selected.parent_id) : undefined}
            payments={paymentsByNode.get(selected.id) ?? []}
            links={linksByNode.get(selected.id) ?? []}
            meetings={meetingsByNode.get(selected.id) ?? []}
            isBranch={(selectedEntry?.children.length ?? 0) > 0}
            depth={selectedEntry?.depth ?? 0}
            deleteConfirmationDescription={(selectedEntry?.children.length ?? 0) > 0
              ? t(($) => $.confirmation.delete_branch_description, { label: selected.name || selected.code })
              : t(($) => $.confirmation.delete_description, { label: selected.name || selected.code })}
            statusSuggestions={statusSuggestions}
            execStatusSuggestions={execStatusSuggestions}
            budgetCategorySuggestions={budgetCategorySuggestions}
            ownerSuggestions={ownerSuggestions}
            vendorSuggestions={vendorSuggestions}
            onPatch={(patch) => patchNode(selected.id, patch)}
            onDelete={() =>
              deleteNode.mutateAsync(selected.id, {
                onSuccess: () => setSelectedId(null),
                onError: fail,
              })
            }
            onClose={() => setSelectedId(null)}
            onLinkIssue={(issueId) => linkIssue(selected.id, issueId)}
            onUnlinkIssue={(issueId) =>
              unlinkIssue.mutate({ nodeId: selected.id, issueId }, { onError: fail })
            }
            onCreateIssue={
              selectedFiling ? () => createIssueForNode(selectedFiling) : undefined
            }
            onOpenMeeting={(meetingId) => {
              setSelectedMeetingId(meetingId);
              setTab("meetings");
            }}
            onCreatePayment={() =>
              createPayment.mutate(
                {
                  nodeId: selected.id,
                  body: {
                    label: t(($) => $.payment.new_label, {
                      index: (paymentsByNode.get(selected.id)?.length ?? 0) + 1,
                    }),
                    amount: 0,
                    position: paymentsByNode.get(selected.id)?.length ?? 0,
                  },
                },
                { onError: fail },
              )
            }
            onPatchPayment={patchPayment}
            onDeletePayment={(paymentId) => requestDeletion("payment", paymentId)}
          />
        )}
      </div>
      <CockpitMeetingCreate
        open={creatingMeeting}
        onOpenChange={setCreatingMeeting}
        wsId={wsId}
        today={today}
        meetings={meetings}
        nodes={nodes}
        members={members ?? EMPTY_MEMBERS}
        currentUserName={currentUserName}
        defaultProjectId={board.cockpit.meeting_project_id}
        defaultModuleId={board.cockpit.meeting_module_id}
        defaultNodeId={board.cockpit.meeting_node_id}
        defaultAssigneeType={board.cockpit.meeting_assignee_type || null}
        defaultAssigneeId={board.cockpit.meeting_assignee_id}
        onSubmit={submitMeeting}
      />
      <CockpitMeetingImport
        open={scanningMeetings}
        onOpenChange={setScanningMeetings}
        wsId={wsId}
        projectId={board.cockpit.meeting_project_id}
        moduleId={board.cockpit.meeting_module_id}
        nodeId={board.cockpit.meeting_node_id}
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
