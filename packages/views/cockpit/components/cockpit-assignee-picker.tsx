"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitAssigneesOptions, useCockpitAssigneeAvailability, canChooseCockpitAssignee } from "@multica/core/cockpit";
import type { IssueAssigneeType } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Bot, Users, UserRound } from "lucide-react";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitAssigneePicker({ wsId, assigneeType, assigneeId, onUpdate, triggerRender, open: controlledOpen, onOpenChange, disabled = false, label }: {
  wsId: string; assigneeType: string | null; assigneeId: string | null; disabled?: boolean; label?: string; triggerRender?: React.ReactElement;
  open?: boolean; onOpenChange?: (open: boolean) => void; onUpdate: (value: { assignee_type: IssueAssigneeType; assignee_id: string }) => void;
}) {
  const { t } = useT("cockpit"); const [internalOpen, setInternalOpen] = useState(false), [text, setText] = useState(""); const [kind, setKind] = useState<"all" | IssueAssigneeType>("all"); const [cursors, setCursors] = useState<string[]>([""]);
  const open = controlledOpen ?? internalOpen; const setOpen = onOpenChange ?? setInternalOpen;
  const q = useCockpitSearch(text), changing = q !== text.trim();
  const selected = useCockpitAssigneeAvailability(wsId, assigneeType, assigneeId);
  const query = useQuery({ ...cockpitAssigneesOptions(wsId, { q, kind, cursor: cursors.at(-1) || undefined, page_size: 20 }), enabled: open && !changing });
  const page = query.data;
  const labels = { all: t(($) => $.assignee_picker.all), member: t(($) => $.assignee_picker.members), agent: t(($) => $.assignee_picker.agents), squad: t(($) => $.assignee_picker.squads) };
  const reason = (value: string) => {
    switch (value) {
      case "archived": return t(($) => $.assignee_picker.archived);
      case "runtime_unbound": return t(($) => $.assignee_picker.runtime_unbound);
      case "invocation_denied": return t(($) => $.assignee_picker.invocation_denied);
      case "leader_missing": return t(($) => $.assignee_picker.leader_missing);
      case "leader_archived": return t(($) => $.assignee_picker.leader_archived);
      case "unsupported_status": return t(($) => $.assignee_picker.unsupported);
      default: return t(($) => $.assignee_picker.unavailable);
    }
  };
  return <div className="min-w-0 space-y-1"><Popover open={open && !disabled} onOpenChange={setOpen}>
    <PopoverTrigger disabled={disabled} render={triggerRender ?? <Button type="button" variant="outline" size="sm" aria-label={label ?? t(($) => $.task_flow.assignee)} />}><span className="max-w-64 truncate">{selected.selected?.title || assigneeId || t(($) => $.assignee_picker.choose)}</span></PopoverTrigger>
    <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] space-y-3"><Input name="cockpit-assignee-search" autoComplete="off" spellCheck={false} aria-label={t(($) => $.assignee_picker.search)} placeholder={t(($) => $.assignee_picker.search)} value={text} onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
      <div role="group" aria-label={t(($) => $.assignee_picker.types)} className="flex flex-wrap gap-1">{(["all", "member", "agent", "squad"] as const).map((value) => <Button key={value} type="button" variant={kind === value ? "secondary" : "ghost"} size="sm" aria-pressed={kind === value} onClick={() => { setKind(value); setCursors([""]); }}>{labels[value]}</Button>)}</div>
      {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>
        : page && <ul className="max-h-72 space-y-2 overflow-y-auto">{page.items.map((item) => {
          const available = canChooseCockpitAssignee(item); const Icon = item.type === "member" ? UserRound : item.type === "squad" ? Users : Bot;
          return <li key={`${item.type}:${item.id}`}><Button type="button" variant={item.type === assigneeType && item.id === assigneeId ? "secondary" : "ghost"} disabled={!available} className="h-auto w-full items-start justify-start py-2 text-left" aria-label={item.title} onClick={() => {
            if (!available || (item.type !== "member" && item.type !== "agent" && item.type !== "squad")) return;
            onUpdate({ assignee_type: item.type, assignee_id: item.id }); setOpen(false);
          }}><Icon className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 space-y-1"><span className="line-clamp-2 block break-words">{item.title}</span><span className="block break-all text-micro text-muted-foreground">{item.email || item.id}</span>{!available && <span className="block text-caption text-muted-foreground">{reason(item.reason)}</span>}</span></Button></li>;
        })}</ul>}
      {page?.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
      {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || changing}
        onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} /> : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
      <p className="text-micro text-muted-foreground">{t(($) => $.assignee_picker.planning_only)}</p>
    </PopoverContent>
  </Popover>{assigneeId && selected.isError && <CockpitFlowError onRetry={() => void selected.refetch()} />}
    {assigneeId && selected.isSuccess && !selected.available && !selected.isFetching && <p role="status" className="text-caption text-muted-foreground">{reason(selected.selected?.reason ?? "")}</p>}
  </div>;
}
