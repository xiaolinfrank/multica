"use client";
import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cockpitPlanOptions, buildCockpitDisplayCodesFromIndex, buildCockpitTree, flattenCockpitTree, cockpitMissingFields, type CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitReadFailure } from "./cockpit-read-failure";

export function CockpitPlanQuality({ wsId, scope, onOpenTask }: { wsId: string; scope: CockpitScope; onOpenTask: (id: string) => void }) {
  const { t } = useT("cockpit"); const query = useQuery(cockpitPlanOptions(wsId, scope)); const data = query.data; const scroll = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => data ? buildCockpitTree(data.nodes).map((root) => ({ root: root.node,
    rows: flattenCockpitTree([root]).filter((entry) => entry.children.length === 0 && !data.context_node_ids.includes(entry.node.id)).map((entry) => ({ node: entry.node, missing: cockpitMissingFields(entry.node) })) })).filter((group) => group.rows.length > 0) : [], [data]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const display = useMemo(() => groups.flatMap((group) => [
    { kind: "group" as const, id: `group:${group.root.id}`, group },
    ...group.rows.map((row) => ({ kind: "item" as const, id: row.node.id, row })),
  ]), [groups]);
  const codes = useMemo(() => buildCockpitDisplayCodesFromIndex(query.data?.node_index ?? []), [query.data?.node_index]);
  const suggestedFields = ["collaborators", "vendor", "budget_category", "exec_status", "dependencies", "deliverable", "note", "current_progress"] as const;
  const virtual = useVirtualizer({ count: display.length, getScrollElement: () => scroll.current, estimateSize: () => 70, overscan: 5, initialRect: { width: 800, height: 300 } });
  if (query.isPending) return <Spinner />;
  if (query.isError) return <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource="plan-quality" onRetry={() => void query.refetch()} />;
  return <section className="space-y-3 rounded-xl border bg-card p-4"><h3 className="text-caption">{t(($) => $.table.check)} · {t(($) => $.table.core_missing, { count: rows.reduce((sum, row) => sum + row.missing.length, 0) })} · {t(($) => $.table.check_ok)} {rows.filter((row) => row.missing.length === 0).length}/{rows.length}</h3>
    <div ref={scroll} className="max-h-80 min-h-20 overflow-y-auto"><ul className="relative" style={{ height: virtual.getTotalSize() }}>{virtual.getVirtualItems().map((item) => { const entry = display[item.index]!;
      if (entry.kind === "group") return <li key={entry.id} ref={virtual.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full bg-muted/60 px-2 py-3 text-caption font-medium" style={{ transform: `translateY(${item.start}px)` }}>{codes.get(entry.group.root.id) ?? entry.group.root.code} {entry.group.root.name} · {t(($) => $.table.core_missing, { count: entry.group.rows.reduce((sum, row) => sum + row.missing.length, 0) })} · {t(($) => $.table.check_ok)} {entry.group.rows.filter((row) => row.missing.length === 0).length}/{entry.group.rows.length}</li>;
      const row = entry.row; const suggested = suggestedFields.filter((field) => !row.node[field].trim()).map((field) => t(($) => $.node[field])); if (row.node.budget_amount == null) suggested.push(t(($) => $.node.budget)); return <li key={row.node.id} ref={virtual.measureElement} data-index={item.index} className="absolute left-0 top-0 w-full space-y-1 border-b py-3" style={{ transform: `translateY(${item.start}px)` }}>
      <Button type="button" variant="link" className="h-auto max-w-full p-0 text-left" onClick={() => onOpenTask(row.node.id)}><span className="line-clamp-2 break-words">{codes.get(row.node.id) ?? row.node.code} {row.node.name}</span></Button>
      <p className="text-caption">{t(($) => $.node.owner)}: {row.node.owner || t(($) => $.common.unset)}</p>
      <p className="text-caption text-muted-foreground">{row.missing.length ? `${t(($) => $.table.core_missing, { count: row.missing.length })}: ${row.missing.map((field) => t(($) => $.node[field])).join(" / ")}` : t(($) => $.table.check_ok)}</p>
      {suggested.length > 0 && <p className="text-caption text-muted-foreground">{t(($) => $.table.suggested_fields, { count: suggested.length })}: {suggested.join(" / ")}</p>}
    </li>; })}</ul></div></section>;
}
