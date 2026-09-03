"use client";

// The project cockpit page: "/:slug/cockpit" on web, the same view on desktop.
//
// One board per workspace, edited by everyone at once. Server state lives in the
// board query; the view state below (which tab, which branch, what is collapsed,
// what is selected) is local to this screen and deliberately not persisted —
// re-opening the cockpit should show the board, not the last person's scroll
// position.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import type {
  CockpitIssueLink,
  CockpitMeetingPatch,
  CockpitMilestonePatch,
  CockpitNode,
  CockpitNodePatch,
  CockpitPatch,
  CockpitPayment,
  CockpitPaymentPatch,
} from "@multica/core/types";
import {
  buildCockpitTree,
  cockpitBoardOptions,
  flattenCockpitTree,
  groupIssueLinksByNode,
  groupPaymentsByNode,
  useCreateCockpitMeeting,
  useCreateCockpitMilestone,
  useCreateCockpitNode,
  useCreateCockpitPayment,
  useDeleteCockpitMeeting,
  useDeleteCockpitMilestone,
  useDeleteCockpitNode,
  useDeleteCockpitNodeIssue,
  useDeleteCockpitPayment,
  useSetCockpitNodeIssues,
  useUpdateCockpit,
  useUpdateCockpitMeeting,
  useUpdateCockpitMilestone,
  useUpdateCockpitNode,
  useUpdateCockpitPayment,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { toast } from "sonner";
import { ChevronsDownUp, ChevronsUpDown, Plus, Search } from "lucide-react";
import { useT } from "../../i18n";
import { EditableText } from "./cockpit-fields";
import { CockpitGantt, type CockpitZoom } from "./cockpit-gantt";
import { CockpitNodePanel } from "./cockpit-node-panel";
import { CockpitOverview } from "./cockpit-overview";

type CockpitTab = "overview" | "gantt";

// Stable empty arrays: an inline `?? []` allocates a fresh array on every
// render while the board query is loading, which invalidates every memo
// downstream of it.
const EMPTY_NODES: CockpitNode[] = [];
const EMPTY_PAYMENTS: CockpitPayment[] = [];
const EMPTY_LINKS: CockpitIssueLink[] = [];

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

export function CockpitPage() {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const [tab, setTab] = useState<CockpitTab>("overview");
  const [zoom, setZoom] = useState<CockpitZoom>("month");
  const [query, setQuery] = useState("");
  const [rootId, setRootId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [today] = useState(todayString);

  const { data: board, isLoading } = useQuery(cockpitBoardOptions(wsId));

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

  // `board?.nodes ?? []` inline would mint a new array on every render where
  // the query is still loading, invalidating every memo below it.
  const nodes = useMemo(() => board?.nodes ?? EMPTY_NODES, [board?.nodes]);
  const tree = useMemo(() => buildCockpitTree(nodes), [nodes]);
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

  // A node deleted by someone else must not leave the panel showing a ghost.
  useEffect(() => {
    if (selectedId && !nodeById.has(selectedId)) setSelectedId(null);
  }, [selectedId, nodeById]);

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

  const linkIssue = useCallback(
    (nodeId: string, issueId: string) => {
      const existing = (linksByNode.get(nodeId) ?? []).map((l) => l.issue_id);
      setNodeIssues.mutate(
        { nodeId, issueIds: [...existing, issueId], replace: true },
        { onError: fail },
      );
    },
    [linksByNode, setNodeIssues, fail],
  );

  const toggleCollapse = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(flat.filter((e) => e.children.length > 0).map((e) => e.node.id)));
  }, [flat]);

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

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedEntry = selectedId ? flat.find((e) => e.node.id === selectedId) : undefined;

  if (isLoading || !board) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const roots = tree.map((entry) => entry.node);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <EditableText
          value={board.cockpit.title}
          onCommit={(title) => patchBoard({ title })}
          label={t(($) => $.header.title)}
          placeholder={t(($) => $.header.title_placeholder)}
          displayClassName="text-title-sm font-semibold"
        />

        <nav className="ml-2 flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {(["overview", "gantt"] as const).map((key) => (
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
              {key === "overview" ? t(($) => $.tabs.overview) : t(($) => $.tabs.gantt)}
            </button>
          ))}
        </nav>

        <span className="flex-1" />

        {tab === "gantt" && (
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
              <Select
                items={[
                  { value: "all", label: t(($) => $.toolbar.scope_all) },
                  ...roots.map((root) => ({ value: root.id, label: `${root.code} ${root.name}` })),
                ]}
                value={rootId ?? "all"}
                onValueChange={(value) => setRootId(!value || value === "all" ? null : value)}
              >
                <SelectTrigger className="h-7 w-44 text-caption" aria-label={t(($) => $.toolbar.scope)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t(($) => $.toolbar.scope_all)}</SelectItem>
                  {roots.map((root) => (
                    <SelectItem key={root.id} value={root.id}>
                      {root.code} {root.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

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

            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2"
              onClick={() => (collapsed.size > 0 ? setCollapsed(new Set()) : collapseAll())}
            >
              {collapsed.size > 0 ? (
                <ChevronsUpDown className="size-3.5" />
              ) : (
                <ChevronsDownUp className="size-3.5" />
              )}
              {collapsed.size > 0 ? t(($) => $.toolbar.expand_all) : t(($) => $.toolbar.collapse_all)}
            </Button>
          </>
        )}

        <Button size="sm" className="h-7 gap-1 px-2" onClick={addNode}>
          <Plus className="size-3.5" />
          {t(($) => $.toolbar.add_node)}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {tab === "overview" ? (
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
                onDeleteMilestone={(id) => deleteMilestone.mutate(id, { onError: fail })}
                onPatchMeeting={patchMeeting}
                onCreateMeeting={() =>
                  createMeeting.mutate({ title: t(($) => $.meeting.new), meet_date: today }, { onError: fail })
                }
                onDeleteMeeting={(id) => deleteMeeting.mutate(id, { onError: fail })}
                onOpenBranch={(nodeId) => {
                  setRootId(nodeId);
                  setTab("gantt");
                }}
              />
            </div>
          ) : (
            <CockpitGantt
                board={board}
                today={today}
                zoom={zoom}
                query={query}
                rootId={rootId}
                collapsed={collapsed}
                onToggleCollapse={toggleCollapse}
                onSelect={setSelectedId}
                selectedId={selectedId}
                onPatchNode={patchNode}
                statusSuggestions={statusSuggestions}
            />
          )}
        </div>

        {selected && (
          <CockpitNodePanel
            node={selected}
            parent={selected.parent_id ? nodeById.get(selected.parent_id) : undefined}
            payments={paymentsByNode.get(selected.id) ?? []}
            links={linksByNode.get(selected.id) ?? []}
            isBranch={(selectedEntry?.children.length ?? 0) > 0}
            statusSuggestions={statusSuggestions}
            execStatusSuggestions={execStatusSuggestions}
            budgetCategorySuggestions={budgetCategorySuggestions}
            ownerSuggestions={ownerSuggestions}
            onPatch={(patch) => patchNode(selected.id, patch)}
            onDelete={() =>
              deleteNode.mutate(selected.id, {
                onSuccess: () => setSelectedId(null),
                onError: fail,
              })
            }
            onClose={() => setSelectedId(null)}
            onLinkIssue={(issueId) => linkIssue(selected.id, issueId)}
            onUnlinkIssue={(issueId) =>
              unlinkIssue.mutate({ nodeId: selected.id, issueId }, { onError: fail })
            }
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
            onDeletePayment={(paymentId) => deletePayment.mutate(paymentId, { onError: fail })}
          />
        )}
      </div>
    </div>
  );
}
