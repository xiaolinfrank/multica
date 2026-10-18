"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitScopeMembersOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

/** Meeting participant names remain editable text; membership search only helps enter a name. */
export function CockpitMemberNamePicker({ wsId, label, disabled, onSelect }: { wsId: string; label: string; disabled?: boolean; onSelect: (name: string) => void }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false), [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(text), changing = q !== text.trim();
  const query = useQuery({ ...cockpitScopeMembersOptions(wsId, { q, cursor: cursors.at(-1) || undefined, page_size: 20 }), enabled: open && !changing });
  const page = query.data;
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button variant="ghost" size="sm" type="button" disabled={disabled} aria-label={`${label}: ${t(($) => $.meeting_center.find_member)}`} />}>{t(($) => $.meeting_center.find_member)}</PopoverTrigger>
    <PopoverContent align="start" className="w-[min(25rem,calc(100vw-2rem))] space-y-3"><Input aria-label={t(($) => $.shell.search_members)} placeholder={t(($) => $.shell.search_members)} value={text} autoComplete="off" name="meeting-participant-search" spellCheck={false} onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
      {query.isError || (query.isSuccess && !page) ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>
        : <ul className="max-h-64 overflow-y-auto">{page?.items.map((member) => <li key={member.id}><Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-start text-left" onClick={() => { onSelect(member.title); setOpen(false); }}><span className="line-clamp-2 break-words">{member.title}</span></Button></li>)}</ul>}
      {page && page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
      {page && <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.filtered_total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || changing}
        onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />}
      {!page && cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
    </PopoverContent>
  </Popover>;
}
