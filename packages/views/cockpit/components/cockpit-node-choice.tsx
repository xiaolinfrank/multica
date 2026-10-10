"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitScopeNodesOptions, cockpitNodeIndexOptions, buildCockpitDisplayCodesFromIndex, isCockpitSummaryGroup, EMPTY_COCKPIT_SCOPE, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitNodeChoice } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { useT } from "../../i18n";
import { CockpitReadFailure } from "./cockpit-read-failure";
import { useCockpitSearch } from "./cockpit-task-flow";

/** Search pages are choices, never an authoritative set of existing links. */
export function CockpitNodeChoicePicker({ wsId, scope, label, onSelect, eligible = true, disabled, value, allowClear, onClear, displayCodes, triggerRender, align = "start", open: controlledOpen, onOpenChange }: {
  wsId: string; scope?: CockpitScope; label: string; value?: string; eligible?: boolean; disabled?: boolean;
  onSelect: (node: CockpitNodeChoice, displayCode: string) => void | Promise<unknown>;
  displayCodes?: ReadonlyMap<string, string>; allowClear?: boolean; onClear?: () => void;
  triggerRender?: React.ReactElement; align?: "start" | "center" | "end"; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useT("cockpit");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState(""); const lock = useRef(false);
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const [cursors, setCursors] = useState<string[]>([""]);
  const index = useQuery({ ...cockpitNodeIndexOptions(wsId), enabled: open && !displayCodes });
  const codes = useMemo(() => displayCodes ?? buildCockpitDisplayCodesFromIndex(index.data?.items ?? []), [displayCodes, index.data]);
  const exact = q ? [...codes].filter(([id, code]) => !isCockpitSummaryGroup(id) && code.toLowerCase() === q.toLowerCase()) : [];
  const requestQuery = exact.length === 1 ? exact[0]![0] : q;
  const query = useQuery({ ...cockpitScopeNodesOptions(wsId, { project_id: scope?.projectId ?? undefined,
    module_id: scope?.moduleId ?? undefined, q: requestQuery, eligible, cursor: cursors.at(-1) || undefined, page_size: 20 }), enabled: open && !changing && Boolean(displayCodes || (index.isSuccess && index.data)) });
  return <Popover open={open && !disabled} onOpenChange={(next) => { if (!lock.current) { setSaveError(""); setOpen(next); } }}>
    <PopoverTrigger disabled={disabled} render={triggerRender ?? <Button type="button" variant="outline" size="sm" aria-label={label} className="max-w-full justify-start" />}><span className="truncate">{value || label}</span></PopoverTrigger>
    <PopoverContent align={align} className="w-[min(24rem,calc(100vw-2rem))] space-y-2">
      <Input disabled={saving} value={text} name="cockpit-node-search" autoComplete="off" spellCheck={false} aria-label={t(($) => $.node_picker.search_placeholder)} placeholder={t(($) => $.node_picker.search_placeholder)} onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
      {allowClear && <Button type="button" size="sm" variant="ghost" onClick={() => { onClear?.(); setOpen(false); }}>{t(($) => $.node_picker.none)}</Button>}
      {!displayCodes && index.isError ? <CockpitReadFailure error={index.error} wsId={wsId} scope={scope ?? EMPTY_COCKPIT_SCOPE} resource="node-index" onRetry={() => void index.refetch()} />
        : (query.isError || (query.isSuccess && !query.data)) ? <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.action_flow.nodes_failed)}</p><Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t(($) => $.binding.retry)}</Button></div>
        : query.isPending || changing || (!displayCodes && index.isPending) ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>
        : <div className="max-h-72 overflow-y-auto overscroll-contain">{query.data?.items.map((node) => <Button key={node.id} type="button" variant="ghost" size="sm" className="h-auto w-full justify-start py-2 text-left" disabled={saving} onClick={() => { if (lock.current) return; lock.current = true; setSaving(true); setSaveError("");
          void Promise.resolve().then(() => onSelect(node, codes.get(node.id) ?? node.code)).then(() => setOpen(false)).catch((cause: unknown) => setSaveError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed))).finally(() => { lock.current = false; setSaving(false); }); }}>
          <span className="line-clamp-2 break-words" title={`${codes.get(node.id) ?? node.code} ${node.title}`}>{codes.get(node.id) ?? node.code} {node.title}</span>
        </Button>)}{query.data?.items.length === 0 && <p className="p-2 text-caption text-muted-foreground">{t(($) => $.node_picker.empty)}</p>}</div>}
      {saveError && <p role="alert" className="text-caption text-destructive">{saveError}</p>}
      <div className="flex justify-between gap-2"><Button type="button" variant="ghost" size="sm" disabled={cursors.length === 1 || query.isFetching || saving || changing} onClick={() => setCursors((old) => old.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!query.data?.next_cursor || query.isFetching || query.isError || saving || changing} onClick={() => { const next = query.data?.next_cursor; if (next) setCursors((old) => [...old, next]); }}>{t(($) => $.task_flow.next)}</Button></div>
    </PopoverContent>
  </Popover>;
}
