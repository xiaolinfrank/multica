"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitScopeMembersOptions, cockpitSelectedMemberOptions } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { copyText } from "@multica/ui/lib/clipboard";
import { Check, ChevronsUpDown, Copy } from "lucide-react";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { settingsHref } from "../../settings/components/settings-navigation";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function CockpitReviewerSelect({ wsId, value, onChange, disabled, label, excludeId, emptyLabel, missingLabel }: {
  wsId: string; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string; excludeId?: string; emptyLabel?: string; missingLabel?: string;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const id = useId();
  const [copyResult, setCopyResult] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false); const [text, setText] = useState(""); const [cursors, setCursors] = useState<string[]>([""]);
  const q = useCockpitSearch(text); const changing = q !== text.trim();
  const selected = useQuery(cockpitSelectedMemberOptions(wsId, value));
  const query = useQuery({ ...cockpitScopeMembersOptions(wsId, { q, cursor: cursors.at(-1) || undefined, page_size: 20 }), enabled: Boolean(wsId && open && !changing) });
  const data = query.data; const person = selected.data?.items.find((entry) => entry.id === value);
  const title = label ?? t(($) => $.workflow.reviewer);
  return <div className="min-w-0 space-y-1"><label htmlFor={id} className="text-caption">{title}</label>
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setCopyResult(null); }}><PopoverTrigger render={<Button id={id} type="button" variant="outline" disabled={disabled} aria-label={title} className="w-full justify-between" />}>
      <span className="min-w-0 truncate">{person?.title || (value ? selected.isPending ? t(($) => $.workflow.loading) : value : emptyLabel ?? t(($) => $.workflow.choose_reviewer))}</span><ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </PopoverTrigger><PopoverContent align="start" className="w-[min(25rem,calc(100vw-2rem))] space-y-3 p-3">
      <Input autoFocus name="cockpit-reviewer-search" autoComplete="off" spellCheck={false} value={text} aria-label={t(($) => $.shell.search_members)} placeholder={t(($) => $.shell.search_members)}
        onChange={(event) => { if (event.target.value !== text) setCursors([""]); setText(event.target.value); }} />
      {(query.isError || (query.isSuccess && !query.data)) ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || changing ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
        : data && <><ul className="max-h-64 space-y-1 overflow-y-auto">{data.items.map((member) => <li key={member.id} className="flex items-start gap-1"><Button type="button" variant={value === member.id ? "secondary" : "ghost"} disabled={disabled || member.id === excludeId}
          className="h-auto min-h-9 min-w-0 flex-1 justify-start whitespace-normal text-left" aria-label={member.title} aria-describedby={`${id}-${member.id}-identity`} aria-pressed={value === member.id} onClick={() => { onChange(member.id); setOpen(false); }}>
          <span className="min-w-0 flex-1 space-y-1"><span className="line-clamp-2 block break-words">{member.title}</span><span id={`${id}-${member.id}-identity`} className="block break-all text-micro text-muted-foreground">{member.email || member.id}</span></span>
          {value === member.id && <Check className="size-3.5 shrink-0" aria-hidden />}</Button>
          {!member.email && <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.shell.copy_member_id, { name: member.title })} onClick={() => { void copyText(member.id).then(setCopyResult).catch(() => setCopyResult(false)); }}><Copy className="size-3.5" /></Button>}
        </li>)}</ul>
          {copyResult !== null && <p role="status" className="text-caption text-muted-foreground">{copyResult ? t(($) => $.shell.member_id_copied) : t(($) => $.shell.member_id_copy_failed)}</p>}
          {data.items.length === 0 && <div className="space-y-2 text-caption text-muted-foreground"><p>{q ? t(($) => $.task_flow.no_matches) : t(($) => $.workflow.no_reviewers)}</p>
            {!q && <AppLink href={settingsHref(paths.settings(), new URLSearchParams(), "members")} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.workflow.open_members)}</AppLink>}</div>}</>}
      {data ? <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.filtered_total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching || changing}
        onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (data.next_cursor) setCursors([...cursors, data.next_cursor]); }} />
        : cursors.length > 1 && <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
    </PopoverContent></Popover>
    {value && (selected.isError || (selected.isSuccess && !selected.data)) && <CockpitFlowError onRetry={() => void selected.refetch()} />}
    {value && selected.isSuccess && selected.data && !person && <p role="alert" className="text-caption text-destructive">{missingLabel ?? t(($) => $.artifacts.reviewer_missing)}</p>}
  </div>;
}
