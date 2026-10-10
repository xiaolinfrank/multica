"use client";

import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cockpitScopeViewKey, cockpitObjectPath, isCockpitMilestoneDone, sortCockpitMilestones, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitMilestone, CockpitMilestonePatch, CockpitNode } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Flag, Plus } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { CockpitMilestoneCard } from "./cockpit-overview";

export function CockpitMilestones({ wsId, milestones, nodes, displayCodes, scope, query, rootIds, today, goalDate, onCreate, onPatch, onDelete, readOnly }: {
  wsId: string; milestones: CockpitMilestone[]; nodes: CockpitNode[]; displayCodes: ReadonlyMap<string, string>; scope: CockpitScope; query: string; rootIds: ReadonlySet<string>;
  today: string; goalDate: string | null; onCreate: () => void;
  onPatch: (id: string, patch: CockpitMilestonePatch) => void; onDelete: (id: string) => void; readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const scroll = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const rows = useMemo(() => sortCockpitMilestones(milestones).filter((milestone) => {
    const node = milestone.node_id ? nodeById.get(milestone.node_id) : undefined;
    if (rootIds.size > 0) { let root = node; const seen = new Set<string>();
      while (root?.parent_id && !seen.has(root.id)) { seen.add(root.id); root = nodeById.get(root.parent_id); }
      if (!root || !rootIds.has(root.id)) return false;
    }
    const needle = query.trim().toLowerCase();
    return !needle || [milestone.name, milestone.condition, milestone.status, node?.name, node?.code, node ? displayCodes.get(node.id) : ""].join(" ").toLowerCase().includes(needle);
  }), [milestones, nodeById, rootIds, query, displayCodes]);
  const selected = milestones.find((milestone) => milestone.id === selectedId);
  const selectedNode = selected?.node_id ? nodeById.get(selected.node_id) : undefined;
  useCockpitScrollMemory(scroll, JSON.stringify([cockpitScopeViewKey(wsId, scope), "cockpit-milestones.tsx"]), rows.length > 0, JSON.stringify([query, [...rootIds].sort()]));
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 80, overscan: 5,
    getItemKey: (index) => rows[index]!.id, initialRect: { width: 900, height: 480 } });
  return <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedId(null); }}><section className="flex min-h-0 flex-1 flex-col" aria-label={t(($) => $.plan_views.milestones)}>
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/70 px-5 py-4"><Flag className="size-4 text-muted-foreground" aria-hidden />
      <h2 className="text-title-sm font-medium">{t(($) => $.plan_views.milestones)}</h2>
      <p className="text-caption text-muted-foreground">{t(($) => $.plan_views.milestone_basis)}</p>
      {!readOnly && <Button type="button" variant="outline" size="sm" onClick={onCreate} className="ml-auto"><Plus className="size-3.5" />{t(($) => $.overview.add_milestone)}</Button>}
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto">
      <div role="table" aria-rowcount={rows.length + 1} className="min-w-[700px]">
        <div role="row" className="sticky top-0 z-10 grid grid-cols-[minmax(240px,2fr)_130px_130px_minmax(160px,1fr)] gap-4 border-b border-border bg-card px-5 py-3 text-caption font-medium text-muted-foreground">
          <span role="columnheader">{t(($) => $.milestone.name)}</span><span role="columnheader">{t(($) => $.overview.milestone_plan_date)}</span>
          <span role="columnheader">{t(($) => $.overview.milestone_done_date)}</span><span role="columnheader">{t(($) => $.plan_views.item)}</span>
        </div>
        <div role="rowgroup" className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => { const milestone = rows[row.index]!; const node = milestone.node_id ? nodeById.get(milestone.node_id) : undefined;
            return <div key={row.key} ref={virtual.measureElement} data-index={row.index} role="row" aria-rowindex={row.index + 2}
              className="absolute left-0 top-0 grid min-h-20 w-full grid-cols-[minmax(240px,2fr)_130px_130px_minmax(160px,1fr)] items-start gap-4 border-b border-border/60 px-5 py-4 text-body hover:bg-card/70"
              style={{ transform: `translateY(${row.start}px)` }}>
              <div role="cell" className="min-w-0"><DialogTrigger render={<Button type="button" variant="ghost" size="sm" className="-ml-2 h-auto min-h-8 max-w-full justify-start whitespace-normal text-left" />} onClick={() => setSelectedId(milestone.id)}>
                <span className="line-clamp-2 break-words" title={milestone.name}>{milestone.name || t(($) => $.milestone.new)}</span></DialogTrigger>
                <p className="text-micro text-muted-foreground">{isCockpitMilestoneDone(milestone) ? t(($) => $.plan_views.milestone_recorded) : milestone.status || t(($) => $.common.unset)}</p></div>
              <span role="cell" className="pt-1 text-caption tabular-nums">{milestone.plan_date || "—"}</span>
              <span role="cell" className="pt-1 text-caption tabular-nums">{milestone.actual_date || "—"}</span>
              <div role="cell" className="min-w-0 pt-1 text-caption">{node ? <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: node.id, planView: "milestones" }, scope)} className="line-clamp-2 break-words hover:underline" title={node.name}>
                <span className="mr-1 font-mono text-muted-foreground">{displayCodes.get(node.id) ?? node.code}</span>{node.name}</AppLink> : "—"}</div>
            </div>;
          })}
        </div>
      </div>
      {rows.length === 0 && <p className="px-5 py-8 text-caption text-muted-foreground">{t(($) => $.empty.no_milestones)}</p>}
    </div>
    <DialogContent><DialogHeader><DialogTitle>{t(($) => $.plan_views.milestones)}</DialogTitle></DialogHeader>
        {selected && <ol><CockpitMilestoneCard milestone={selected} node={selectedNode} nodeCode={selectedNode ? displayCodes.get(selectedNode.id) ?? selectedNode.code : ""}
          countdownFrom={null} today={today} fallbackDate={goalDate} onPatch={(patch) => onPatch(selected.id, patch)} onDelete={() => onDelete(selected.id)} readOnly={readOnly} /></ol>}
    </DialogContent>
  </section></Dialog>;
}
