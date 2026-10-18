"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitMeeting } from "@multica/core/types";
import { cockpitMeetingFolderName, cockpitMeetingRegisterOptions, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";

export function cockpitMeetingLabel(meeting: Pick<CockpitMeeting, "code" | "title">): string {
  return cockpitMeetingFolderName({ code: meeting.code, title: meeting.title });
}

/** Adding one reference never treats a loaded page as the complete relation set. */
export function CockpitMeetingPicker({ wsId, onSelect, label, disabled }: {
  wsId: string; onSelect: (meetingId: string) => Promise<unknown>; label: string; disabled?: boolean;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [text, setText] = useState("");
  const q = useCockpitSearch(text); const changing = text.trim() !== q;
  const [cursors, setCursors] = useState<string[]>([""]); const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const query = useQuery({ ...cockpitMeetingRegisterOptions(wsId, EMPTY_COCKPIT_SCOPE, { q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open && !changing });
  return <Popover open={open && !disabled} onOpenChange={(next) => { if (!lock.current) { setOpen(next); setError(""); } }}>
    <PopoverTrigger disabled={disabled} render={<Button type="button" variant="ghost" size="sm" />}>{label}</PopoverTrigger>
    <PopoverContent align="start" className="w-[min(26rem,calc(100vw-2rem))] space-y-2">
      <Input value={text} disabled={saving} aria-label={t(($) => $.issue_meetings.search_placeholder)} placeholder={t(($) => $.issue_meetings.search_placeholder)}
        onChange={(event) => { setText(event.target.value); setCursors([""]); }} />
      {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || changing ? <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p> : <>
        <div className="max-h-72 overflow-y-auto overscroll-contain">{query.data.items.map((meeting) => <Button key={meeting.id} type="button" variant="ghost" size="sm" disabled={saving}
          className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => { if (lock.current) return; lock.current = true; setSaving(true); setError("");
            void Promise.resolve().then(() => onSelect(meeting.id)).then(() => setOpen(false)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed))).finally(() => { lock.current = false; setSaving(false); }); }}>
          {cockpitMeetingLabel(meeting)}</Button>)}{query.data.items.length === 0 && <p className="p-2 text-caption text-muted-foreground">{t(($) => $.issue_meetings.no_results)}</p>}</div>
        <CockpitFlowPaging page={cursors.length} shown={query.data.items.length} total={query.data.total} busy={query.isFetching || saving} hasNext={Boolean(query.data.next_cursor)}
          onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (query.data.next_cursor) setCursors((old) => [...old, query.data.next_cursor!]); }} />
      </>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </PopoverContent>
  </Popover>;
}
