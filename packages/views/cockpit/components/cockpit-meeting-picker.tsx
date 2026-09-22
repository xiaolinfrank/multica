"use client";

// Choosing a meeting off the register. Unlike the issue picker next door this
// needs no search endpoint: the board read already carries every meeting, so
// the filtering is local and the list is complete the moment it opens.
//
// Newest first, because what gets linked by hand is almost always a meeting
// that just happened.

import { useMemo, useState } from "react";
import type { CockpitMeeting } from "@multica/core/types";
import { cockpitMeetingFolderName } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@multica/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Check, Plus } from "lucide-react";
import { useT } from "../../i18n";

/** How a meeting reads in one line: its number, then what it was about. The
 *  same rule the register and the folder name use, so one meeting is quoted
 *  the same way wherever it appears. */
export function cockpitMeetingLabel(meeting: CockpitMeeting): string {
  return cockpitMeetingFolderName({ code: meeting.code, title: meeting.title });
}

export function CockpitMeetingPicker({
  meetings,
  selectedIds,
  onToggle,
  label,
  disabled,
}: {
  meetings: CockpitMeeting[];
  /** Already-linked meeting ids, ticked so a second click reads as a toggle. */
  selectedIds: Set<string>;
  onToggle: (meetingId: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const sorted = [...meetings].sort((a, b) => {
      const byDate = (b.meet_date ?? "").localeCompare(a.meet_date ?? "");
      return byDate !== 0 ? byDate : b.code.localeCompare(a.code);
    });
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    // Parties are in the haystack because half the programme's meetings are
    // remembered by who was in the room, not by what they were titled.
    return sorted.filter((m) =>
      `${m.code} ${m.title} ${m.parties} ${m.meet_date ?? ""}`.toLowerCase().includes(needle),
    );
  }, [meetings, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-caption">
            <Plus className="size-3" />
            {label}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[26rem] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t(($) => $.issue_meetings.search_placeholder)}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{t(($) => $.issue_meetings.no_results)}</CommandEmpty>
            {rows.length > 0 && (
              <CommandGroup>
                {rows.map((meeting) => {
                  const linked = selectedIds.has(meeting.id);
                  return (
                    <CommandItem
                      key={meeting.id}
                      value={meeting.id}
                      onSelect={() => onToggle(meeting.id)}
                      className="gap-2"
                    >
                      <span className="shrink-0 font-mono text-caption text-muted-foreground">
                        {meeting.code || meeting.meet_date || "—"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body">{meeting.title}</span>
                      {linked && <Check className="size-3.5 shrink-0 text-brand" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
