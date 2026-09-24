"use client";

// Picking a work item off the execution gantt, level by level.
//
// The board is three levels deep in practice (板块 › 模块 › 任务) and a flat
// list of a few hundred codes is unusable in a menu. A submenu per level keeps
// the choice the shape the reader already has in their head, and every level
// is selectable: a meeting about a whole module should not have to name one of
// its tasks to be recorded against it.

import { useMemo } from "react";
import type { CockpitNode } from "@multica/core/types";
import { buildCockpitDisplayCodes, buildCockpitTree, type CockpitTreeNode } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@multica/ui/components/ui/dropdown-menu";
import { Check, Plus } from "lucide-react";
import { useT } from "../../i18n";

export interface CockpitNodePickerProps {
  nodes: CockpitNode[];
  /** Already-linked node ids, shown with a tick so a second click reads as a
   *  toggle rather than a no-op. */
  selectedIds: Set<string>;
  onToggle: (nodeId: string) => void;
  label: string;
  disabled?: boolean;
  /** Display codes for the menu labels. Every shipped surface numbers by the
   *  summary tree, so callers pass those codes and the menu quotes the same
   *  number the caller's rows do. The raw-tree fallback only covers ad-hoc
   *  reuse outside any numbered surface. */
  codes?: Map<string, string>;
}

function NodeBranch({
  entry,
  codes,
  selectedIds,
  onToggle,
}: {
  entry: CockpitTreeNode;
  codes: Map<string, string>;
  selectedIds: Set<string>;
  onToggle: (nodeId: string) => void;
}) {
  const code = codes.get(entry.node.id) ?? entry.node.code;
  const label = `${code} ${entry.node.name}`.trim();
  const picked = selectedIds.has(entry.node.id);

  if (entry.children.length === 0) {
    return (
      <DropdownMenuItem closeOnClick={false} onClick={() => onToggle(entry.node.id)}>
        <Check className={picked ? "size-3.5" : "size-3.5 opacity-0"} aria-hidden />
        <span className="truncate">{label}</span>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Check className={picked ? "size-3.5" : "size-3.5 opacity-0"} aria-hidden />
        <span className="truncate">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-72 overflow-y-auto">
        {/* The branch itself is a valid answer, so it leads its own submenu. */}
        <DropdownMenuItem closeOnClick={false} onClick={() => onToggle(entry.node.id)}>
          <Check className={picked ? "size-3.5" : "size-3.5 opacity-0"} aria-hidden />
          <span className="truncate">{label}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {entry.children.map((child) => (
          <NodeBranch
            key={child.node.id}
            entry={child}
            codes={codes}
            selectedIds={selectedIds}
            onToggle={onToggle}
          />
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function CockpitNodePicker({
  nodes,
  selectedIds,
  onToggle,
  label,
  disabled,
  codes: codesOverride,
}: CockpitNodePickerProps) {
  const { t } = useT("cockpit");
  const tree = useMemo(() => buildCockpitTree(nodes), [nodes]);
  const codes = useMemo(
    () => codesOverride ?? buildCockpitDisplayCodes(tree),
    [codesOverride, tree],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || tree.length === 0}
        render={
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-caption">
            <Plus className="size-3" />
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        {tree.length === 0 ? (
          <DropdownMenuItem disabled>{t(($) => $.empty.no_nodes)}</DropdownMenuItem>
        ) : (
          tree.map((root) => (
            <NodeBranch
              key={root.node.id}
              entry={root}
              codes={codes}
              selectedIds={selectedIds}
              onToggle={onToggle}
            />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
