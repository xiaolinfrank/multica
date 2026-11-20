"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import type { PlanRow } from "./plan-rows";

export interface PlanRowNameProps {
  row: PlanRow;
  /** Children are shown. */
  open: boolean;
  /** Structure writes are closed: read-only scope, or a plan never reconciled. */
  locked: boolean;
  renaming: boolean;
  compact?: boolean;
  /** Pixels per level. Surfaces with their own row height pass their own. */
  indent?: number;
  /** A row that cannot unfold (the gantt's leaves) keeps the chevron's space
   *  but shows no control. */
  expandable?: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onStartRename: () => void;
  onSubmitRename: (name: string) => void | Promise<void>;
  onCancelRename: () => void;
  /** Rendered after the name: progress, issue counts, row actions. */
  trailing?: ReactNode;
}

/** The plan's name column: expand, address, name, rename. One implementation
 *  for the tree, the table and the gantt — the row model is PlanRow in all
 *  three, so the column cannot disagree with itself about levels or codes. */
export function PlanRowName({
  row, open, locked, renaming, compact = false, indent = 14, expandable = true,
  onToggle, onSelect, onStartRename, onSubmitRename, onCancelRename, trailing,
}: PlanRowNameProps) {
  const { t } = useT("cockpit");
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      style={{ paddingLeft: row.depth * (compact ? 8 : indent) }}
    >
      <span className="flex shrink-0 items-center">
        {/* Every level expands: a work item's children are its issues, which
            load on demand rather than with the tree. */}
        {expandable ? (
          <button type="button" aria-label={open ? t(($) => $.plan_tree.collapse) : t(($) => $.plan_tree.expand)}
            aria-expanded={open} onClick={onToggle}
            className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground">
            {open ? <ChevronDown className="size-3" aria-hidden /> : <ChevronRight className="size-3" aria-hidden />}
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
      </span>
      <button type="button" onClick={onSelect} title={row.node.code} aria-label={t(($) => $.plan_tree.open_row, { code: row.code })}
        className="shrink-0 rounded-sm px-1 font-mono text-micro text-muted-foreground hover:text-foreground"
        style={row.kind === "project" && row.node.color ? { color: row.node.color } : undefined}>
        {row.code}
      </button>
      {renaming ? (
        <InlineName defaultValue={row.name} disabled={locked} onSubmit={onSubmitRename} onCancel={onCancelRename} />
      ) : (
        <button type="button" disabled={locked}
          onDoubleClick={onStartRename}
          onKeyDown={(e) => { if (e.key === "F2") onStartRename(); }}
          className={cn("min-w-0 flex-1 truncate text-left", row.kind !== "work_item" && "font-medium")}
          title={row.name}>
          {row.name}
        </button>
      )}
      {trailing}
    </div>
  );
}

/** A name field that commits on Enter and cancels on Escape. */
function InlineName({ defaultValue, disabled, onSubmit, onCancel }: {
  defaultValue: string; disabled: boolean;
  onSubmit: (name: string) => void | Promise<void>; onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <input autoFocus value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)}
      onBlur={() => { const next = value.trim(); if (next && next !== defaultValue) void onSubmit(next); else onCancel(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); const next = value.trim(); if (next) void onSubmit(next); else onCancel(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      className="min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-caption" />
  );
}
