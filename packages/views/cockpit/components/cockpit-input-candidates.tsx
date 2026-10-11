"use client";

import { useId } from "react";
import { FileText, Folder } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

/** Metadata from one bounded server page; selected IDs are owned by the draft. */
export type CockpitInputCandidate = {
  id: string;
  name: string;
  metadata: string;
  selected: boolean;
  blockedReason?: string;
} & ({ kind: "file"; canSelect: boolean } | { kind: "directory"; canOpen: boolean });

export function CockpitInputCandidates({ items, busy, onSelect, onOpenDirectory }: {
  items: CockpitInputCandidate[];
  busy?: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onOpenDirectory: (id: string) => void;
}) {
  const { t } = useT("cockpit");
  const id = useId();
  if (items.length === 0) return busy ? <p role="status" className="flex items-center gap-2 py-4 text-caption"><Spinner aria-hidden="true" />{t(($) => $.workflow.loading)}</p>
    : <p className="py-4 text-caption text-muted-foreground">{t(($) => $.input_materials.no_candidates)}</p>;
  return <ul className="max-h-[42dvh] min-w-0 space-y-1 overflow-y-auto overscroll-contain" aria-label={t(($) => $.input_materials.candidates)} aria-busy={busy}>
    {items.map((item, index) => <li key={item.id} className={cn("min-w-0 rounded-md p-2", item.selected ? "bg-accent ring-1 ring-inset ring-border" : "hover:bg-muted/50")}>
      {item.kind === "directory" ? <Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal px-0 text-left"
        disabled={busy || !item.canOpen} aria-describedby={item.blockedReason ? `${id}-${index}-reason` : undefined} onClick={() => onOpenDirectory(item.id)}>
        <Folder aria-hidden="true" className="size-4 shrink-0" /><span className="line-clamp-2 min-w-0 break-words [overflow-wrap:anywhere]" title={item.name}>{item.name}</span>
      </Button> : <label className="flex min-w-0 items-start gap-2">
        <input type="checkbox" name="input_candidate" className="mt-1 shrink-0 accent-primary" checked={item.selected} aria-describedby={item.blockedReason ? `${id}-${index}-reason` : undefined}
          disabled={busy || (!item.canSelect && !item.selected)} onChange={(event) => onSelect(item.id, event.target.checked)} />
        <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="line-clamp-2 min-w-0 break-words text-caption font-medium [overflow-wrap:anywhere]" title={item.name}>{item.name}</span>
      </label>}
      <p className="mt-1 break-words text-caption text-muted-foreground [overflow-wrap:anywhere]">{item.metadata}</p>
      {item.blockedReason && <p id={`${id}-${index}-reason`} className="mt-1 break-words text-caption text-muted-foreground [overflow-wrap:anywhere]">{item.blockedReason}</p>}
    </li>)}
  </ul>;
}

export function CockpitInputSelectionSummary({ selectedCount, selectionLimit, onReview, disabled }: {
  selectedCount: number;
  selectionLimit: number;
  onReview: () => void;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 p-3">
    <p className="text-caption tabular-nums">{t(($) => $.input_materials.selection_count, { count: selectedCount, limit: selectionLimit })}</p>
    <Button type="button" variant="outline" size="sm" disabled={disabled || selectedCount === 0} onClick={onReview}>{t(($) => $.input_materials.review_selection)}</Button>
  </div>;
}
