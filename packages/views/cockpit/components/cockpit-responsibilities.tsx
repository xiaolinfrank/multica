"use client";

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildCockpitTree, flattenCockpitTree, cockpitScopeViewKey, cockpitObjectPath, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitNode } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { ArrowUpRight, Users } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";

export function CockpitResponsibilities({ wsId, nodes, displayCodes, scope, query, rootIds }: {
  wsId: string; nodes: CockpitNode[]; displayCodes: ReadonlyMap<string, string>; scope: CockpitScope; query: string; rootIds: ReadonlySet<string>;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const tree = buildCockpitTree(nodes).filter((entry) => rootIds.size === 0 || rootIds.has(entry.node.id));
    const needle = query.trim().toLowerCase();
    return flattenCockpitTree(tree).filter(({ node }) => !needle || [displayCodes.get(node.id), node.code, node.name, node.owner, node.collaborators].join(" ").toLowerCase().includes(needle));
  }, [nodes, rootIds, query, displayCodes]);
  useCockpitScrollMemory(scroll, JSON.stringify([cockpitScopeViewKey(wsId, scope), "cockpit-responsibilities.tsx"]), rows.length > 0, JSON.stringify([query, [...rootIds].sort()]));
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 76, overscan: 5,
    getItemKey: (index) => rows[index]!.node.id, initialRect: { width: 900, height: 480 } });
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t(($) => $.plan_views.responsibility)}>
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card/70 px-5 py-4"><Users className="size-4 text-muted-foreground" aria-hidden />
      <h2 className="text-title-sm font-medium">{t(($) => $.plan_views.responsibility)}</h2>
      <p className="text-caption text-muted-foreground">{t(($) => $.plan_views.responsibility_basis)}</p></div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-auto">
      <div role="table" aria-rowcount={rows.length + 1} className="min-w-[720px]">
        <div role="row" className="sticky top-0 z-10 grid grid-cols-[minmax(260px,2fr)_minmax(160px,1fr)_minmax(200px,1.4fr)] gap-4 border-b border-border bg-card px-5 py-3 text-caption font-medium text-muted-foreground">
          <span role="columnheader">{t(($) => $.plan_views.item)}</span><span role="columnheader">{t(($) => $.node.owner)}</span><span role="columnheader">{t(($) => $.node.collaborators)}</span>
        </div>
        <div role="rowgroup" className="relative" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((row) => { const entry = rows[row.index]!; const node = entry.node;
            return <div key={row.key} ref={virtual.measureElement} data-index={row.index} role="row" aria-rowindex={row.index + 2}
              className="absolute left-0 top-0 grid min-h-[76px] w-full grid-cols-[minmax(260px,2fr)_minmax(160px,1fr)_minmax(200px,1.4fr)] items-start gap-4 border-b border-border/60 px-5 py-4 text-body hover:bg-card/70"
              style={{ transform: `translateY(${row.start}px)` }}>
              <div role="cell" className="min-w-0" style={{ paddingLeft: Math.min(entry.depth, 4) * 12 }}>
                <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: node.id, view: "details", planView: "responsibility" }, scope)} className="group inline-flex max-w-full items-start gap-2">
                  <span className="line-clamp-2 min-w-0 break-words group-hover:underline" title={node.name}><span className="mr-2 font-mono text-caption text-muted-foreground">{displayCodes.get(node.id) ?? node.code}</span>{node.name}</span>
                  <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </AppLink>
              </div>
              <span role="cell" className="line-clamp-2 min-w-0 break-words" title={node.owner}>{node.owner || t(($) => $.workflow.unassigned)}</span>
              <span role="cell" className="line-clamp-2 min-w-0 break-words text-muted-foreground" title={node.collaborators}>{node.collaborators || "—"}</span>
            </div>;
          })}
        </div>
      </div>
      {rows.length === 0 && <p className="px-5 py-8 text-caption text-muted-foreground">{t(($) => $.plan_views.empty)}</p>}
    </div>
  </section>;
}
