"use client";

import { useState } from "react";
import { Copy, Ellipsis, FolderOpen, Plus } from "@multica/ui/icons";
import type { CockpitNode } from "@multica/core/types";
import { useT } from "../i18n";
import type { PlanRow } from "./plan-rows";

export interface PlanRowActionsProps {
  row: PlanRow;
  /** The modules a work item can move to; only used by that menu item. */
  modules: CockpitNode[];
  /** Which child the level's "+" adds. Absent hides the button — a surface
   *  that cannot run the flow here does not offer it. */
  addChildLabel?: string;
  onAddChild?: () => void;
  addIssueLabel?: string;
  onAddIssue?: () => void;
  onMove: (parentId: string) => void;
  onRenumber: () => void;
  onDelete: () => void;
  /** The row's delivery folder, derived from the plan read — never from the
   *  disk. Absent when the surface cannot compose one. */
  directoryPath?: string | null;
  /** Why there is no folder to open (no collaboration root, no module folder). */
  directoryDisabledReason?: string;
  onOpenDirectory?: () => void;
  onCopyDirectory?: () => void;
}

/** The row's hover actions — "+" to add a child, "…" for move, renumber and
 *  delete — shared by the plan tree and the gantt's name column so the two
 *  cannot drift about what a level can do. */
export function PlanRowActions({
  row, modules, addChildLabel, onAddChild, addIssueLabel, onAddIssue, onMove, onRenumber, onDelete,
  directoryPath, directoryDisabledReason, onOpenDirectory, onCopyDirectory,
}: PlanRowActionsProps) {
  const { t } = useT("cockpit");
  const [menuOpen, setMenuOpen] = useState(false);
  const hasFolder = Boolean(directoryPath);
  // Structure rows (the project) own no folder; a module or work item without
  // one says why, because "open folder" that does nothing looks broken.
  const showDirectory = Boolean(onOpenDirectory || onCopyDirectory);
  return (
    <>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        {showDirectory && (
          <>
            <button type="button" aria-label={t(($) => $.directories.open)} title={hasFolder ? directoryPath ?? undefined : directoryDisabledReason}
              disabled={!hasFolder || !onOpenDirectory}
              onClick={() => onOpenDirectory?.()}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
              <FolderOpen className="size-3" aria-hidden />
            </button>
            <button type="button" aria-label={t(($) => $.directories.copy)} title={hasFolder ? directoryPath ?? undefined : directoryDisabledReason}
              disabled={!hasFolder || !onCopyDirectory}
              onClick={() => onCopyDirectory?.()}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
              <Copy className="size-3" aria-hidden />
            </button>
          </>
        )}
        {onAddChild && (
          <button type="button" aria-label={addChildLabel ?? t(($) => $.plan_tree.add_child)}
            onClick={onAddChild}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
            <Plus className="size-3" aria-hidden />
          </button>
        )}
        {onAddIssue && (
          <button type="button" aria-label={addIssueLabel ?? t(($) => $.plan_tree.add_issue)} onClick={onAddIssue}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
            <Plus className="size-3" aria-hidden />
          </button>
        )}
        <button type="button" aria-label={t(($) => $.plan_tree.more)} aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
          <Ellipsis className="size-3" aria-hidden />
        </button>
      </span>
      {menuOpen && (
        <PlanRowMenu
          row={row}
          modules={modules}
          onMove={(parentId) => { setMenuOpen(false); onMove(parentId); }}
          onRenumber={() => { setMenuOpen(false); onRenumber(); }}
          onDelete={() => { setMenuOpen(false); onDelete(); }}
        />
      )}
    </>
  );
}

/** The row's "…" menu. Only the actions the level supports appear. */
function PlanRowMenu({ row, modules, onMove, onRenumber, onDelete }: {
  row: PlanRow;
  modules: CockpitNode[];
  onMove: (parentId: string) => void;
  onRenumber: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("cockpit");
  const [moving, setMoving] = useState(false);
  return (
    <div role="menu" className="flex flex-col gap-1 border-b border-border/60 bg-popover px-3 py-1.5 text-caption">
      {row.kind === "work_item" && !moving && (
        <button type="button" role="menuitem" className="text-left" onClick={() => setMoving(true)}>{t(($) => $.plan_tree.move)}</button>
      )}
      {moving && (
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">{t(($) => $.plan_tree.move_to)}</span>
          <select className="rounded-sm border border-input bg-background px-1" defaultValue=""
            onChange={(event) => { if (event.target.value) onMove(event.target.value); }}>
            <option value="" disabled>{t(($) => $.plan_tree.choose_module)}</option>
            {modules.filter((module) => module.id !== row.node.parent_id).map((module) => (
              <option key={module.id} value={module.id}>{module.code} {module.name}</option>
            ))}
          </select>
        </label>
      )}
      {row.kind !== "work_item" && (
        <button type="button" role="menuitem" className="text-left" onClick={onRenumber}>{t(($) => $.plan_tree.renumber)}</button>
      )}
      {row.kind !== "project" && (
        <button type="button" role="menuitem" className="text-left text-destructive" onClick={onDelete}>{t(($) => $.plan_tree.delete)}</button>
      )}
    </div>
  );
}

/** Inline create field for a module or a work item. The tree renders it as a
 *  row of its own; the gantt keeps its fixed row height and renders it inside
 *  the row it belongs to. */
export function CreateRow({ label, onSubmit, onCancel, inline = false }: {
  label: string;
  onSubmit: (name: string) => void | Promise<void>;
  onCancel: () => void;
  inline?: boolean;
}) {
  const { t } = useT("cockpit");
  const [value, setValue] = useState("");
  return (
    <div role={inline ? undefined : "row"}
      className={inline
        ? "flex min-w-0 flex-1 items-center gap-1"
        : "flex items-center gap-1 border-b border-border/60 bg-muted/40 px-2 py-1 text-caption"}>
      <input autoFocus value={value} placeholder={label} onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); const next = value.trim(); if (next) void onSubmit(next); }
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }}
        className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-caption" />
      <button type="button" className="text-primary" disabled={!value.trim()}
        onClick={() => { const next = value.trim(); if (next) void onSubmit(next); }}>↵</button>
      <button type="button" className="text-muted-foreground" onClick={onCancel}>{t(($) => $.plan_tree.cancel)}</button>
    </div>
  );
}
