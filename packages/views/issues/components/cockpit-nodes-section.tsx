"use client";

// The board's work items this issue is carried out through — the reverse of
// the issue picker on a gantt node. Reads the same cached board the cockpit
// page reads and reuses its link/unlink mutations, so both ends of the
// relation move together through the shared cache and the realtime board
// events, and a member can wire a task into the programme without leaving
// the task.
//
// Mounting the board read here also means opening any issue creates the
// workspace's board row on first read (the server lazily creates it); an
// empty board leaves this section hidden, so the row sits inert until
// somebody actually builds a breakdown in the cockpit.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  buildCockpitDisplayCodes,
  buildCockpitSummaryTree,
  buildCockpitTree,
  cockpitBoardOptions,
  useDeleteCockpitNodeIssue,
  useSetCockpitNodeIssues,
} from "@multica/core/cockpit";
import type { CockpitNode } from "@multica/core/types";
import { ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitNodePicker } from "../../cockpit/components/cockpit-node-picker";

export function CockpitNodesSection({ issueId }: { issueId: string }) {
  // Cockpit vocabulary lives in the cockpit namespace — the fork-only one —
  // so this copy travels with the board's, not with upstream's issue copy.
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true);

  const { data: board } = useQuery(cockpitBoardOptions(wsId));
  const linkNode = useSetCockpitNodeIssues(wsId);
  const unlinkNode = useDeleteCockpitNodeIssue(wsId);

  const fail = useCallback(
    (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
    },
    [t],
  );

  // Display codes are how a work item is addressed everywhere else on the
  // board ("06.06.02"), so derive them the way the gantt does — from the
  // summary tree, not the raw one — and the labels here match the rows a
  // reader correlating this task with the board is looking at.
  const tree = useMemo(() => buildCockpitTree(board?.nodes ?? []), [board?.nodes]);
  const codes = useMemo(() => buildCockpitDisplayCodes(buildCockpitSummaryTree(tree)), [tree]);

  const { rows, linkedIds } = useMemo(() => {
    const ids = new Set(
      (board?.issue_links ?? []).filter((l) => l.issue_id === issueId).map((l) => l.node_id),
    );
    // Walk the board's own node order so the rows read top-down like the tree.
    const entries: { node: CockpitNode; code: string }[] = [];
    for (const node of board?.nodes ?? []) {
      if (ids.has(node.id)) entries.push({ node, code: codes.get(node.id) ?? node.code });
    }
    return { rows: entries, linkedIds: ids };
  }, [board, codes, issueId]);

  // An empty board has nothing to offer the picker; the breakdown is built
  // in the cockpit, and this section would be all chrome.
  if (!board || board.nodes.length === 0) return null;

  const busy = linkNode.isPending || unlinkNode.isPending;
  const toggleNode = (nodeId: string) => {
    if (linkedIds.has(nodeId)) {
      unlinkNode.mutate({ nodeId, issueId }, { onError: fail });
      return;
    }
    // Same shape as the cockpit's own pickers: send the node's whole link
    // set with this issue appended, so the chip order on the node stays what
    // this end sees instead of the new link jumping to the front.
    const current = (board?.issue_links ?? [])
      .filter((l) => l.node_id === nodeId)
      .map((l) => l.issue_id);
    linkNode.mutate({ nodeId, issueIds: [...current, issueId], replace: true }, { onError: fail });
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${
          open ? "" : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setOpen(!open)}
      >
        {/* The label is the one item that may shrink; without nowrap +
            truncate a long translation reflows the heading (MUL-5804). */}
        <span className="truncate">{t(($) => $.issue_detail.title)}</span>
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </button>
      {open ? (
        <div className="pl-2">
          {rows.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.issue_detail.none)}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map(({ node, code }) => {
                const label = `${code} ${node.name}`.trim();
                return (
                  <li
                    key={node.id}
                    className="group/node -mx-1 flex items-center gap-1 rounded-sm px-1 transition-colors hover:bg-accent/50"
                  >
                    {/* The row opens the board the work item lives on. There
                        is no per-node deep link yet, so the gantt's own
                        leftmost column is where the code is looked up. */}
                    <AppLink
                      href={paths.cockpit()}
                      newTabTitle={label}
                      className="min-w-0 flex-1 truncate py-1 text-caption hover:text-foreground"
                    >
                      <span className="font-mono text-muted-foreground">{code}</span> {node.name}
                    </AppLink>
                    <button
                      type="button"
                      onClick={() => unlinkNode.mutate({ nodeId: node.id, issueId }, { onError: fail })}
                      disabled={busy}
                      aria-label={t(($) => $.issue_detail.unlink, { label })}
                      title={t(($) => $.issue_detail.unlink, { label })}
                      className="shrink-0 rounded-xs p-1 text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/node:pointer-events-auto group-hover/node:opacity-100 disabled:opacity-40"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <CockpitNodePicker
            nodes={board.nodes}
            selectedIds={linkedIds}
            onToggle={toggleNode}
            label={t(($) => $.issue_detail.link)}
            disabled={busy}
            codes={codes}
          />
        </div>
      ) : null}
    </div>
  );
}
