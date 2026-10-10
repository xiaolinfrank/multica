"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitDirectoryPageOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { useT } from "../../i18n";
import { CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitContactNamePicker({ wsId, label, disabled, onSelect }: { wsId: string; label: string; disabled?: boolean; onSelect: (name: string) => void }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false), [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(text), changing = q !== text.trim();
  const query = useQuery({ ...cockpitDirectoryPageOptions(wsId, { q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open && !changing });
  const page = query.data;
  return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`${label}: ${t(($) => $.meeting_center.find_contact)}`} />}>{t(($) => $.meeting_center.find_contact)}</PopoverTrigger>
    <PopoverContent align="start" className="w-[min(25rem,calc(100vw-2rem))] space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.directory.workspace_scope)}</p>
      <Input name="meeting-contact-search" autoComplete="off" spellCheck={false} value={text} aria-label={t(($) => $.meeting_center.find_contact)} placeholder={t(($) => $.meeting_center.find_contact)} onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
      {query.isError ? <div role="alert" className="space-y-2 text-caption text-destructive"><p>{t(($) => $.directory.load_failed)}</p><Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>{t(($) => $.binding.retry)}</Button></div>
        : query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : page && <ul className="max-h-64 overflow-y-auto">{page.items.map((contact) => <li key={JSON.stringify([contact.party, contact.name])}><Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-start text-left" onClick={() => { onSelect(contact.name); setOpen(false); }}><span className="min-w-0"><span className="block break-words">{contact.name}</span><span className="block break-words text-micro text-muted-foreground">{[contact.party, contact.position].filter(Boolean).join(" / ")}</span></span></Button></li>)}</ul>}
      {page?.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.no_matches)}</p>}
      {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || changing} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
        : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
    </PopoverContent>
  </Popover>;
}
