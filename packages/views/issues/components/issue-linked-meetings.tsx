"use client";

// Linked-meetings section of the issue sidebar: the reverse read of the
// cockpit's meeting→issue links. The board is one workspace-cached query, so
// this section is a filter over shared state, not a new request per issue —
// and the cockpit:changed events that update meetings invalidate it for free.
// Hides itself when the issue is linked to no meeting.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { cockpitBoardOptions } from "@multica/core/cockpit";
import type { CockpitMeeting } from "@multica/core/types";
import { CalendarDays, ChevronRight } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function IssueLinkedMeetings({ issueId }: { issueId: string }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true);
  const { data: board } = useQuery(cockpitBoardOptions(wsId ?? ""));

  const meetings = useMemo(() => {
    if (!board) return [];
    const linkedIds = new Set(
      (board.meeting_issues ?? [])
        .filter((l) => l.issue_id === issueId)
        .map((l) => l.meeting_id),
    );
    if (linkedIds.size === 0) return [];
    const byId = new Map<string, CockpitMeeting>((board.meetings ?? []).map((m) => [m.id, m]));
    return [...linkedIds]
      .map((id) => byId.get(id))
      .filter((m): m is CockpitMeeting => m !== undefined)
      .sort((a, b) => (a.meet_date ?? "").localeCompare(b.meet_date ?? ""));
  }, [board, issueId]);

  if (meetings.length === 0) return null;

  return (
    <div data-testid="issue-linked-meetings">
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.detail.section_linked_meetings)}
        <span className="text-micro text-muted-foreground tabular-nums">{meetings.length}</span>
        <ChevronRight className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <ul className="space-y-0.5 pl-2">
          {meetings.map((m) => (
            <li key={m.id}>
              <AppLink
                href={`${paths.cockpit()}?meeting=${encodeURIComponent(m.id)}`}
                className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
              >
                <CalendarDays className="!size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="shrink-0 font-mono text-micro tabular-nums">{m.code}</span>
                <span className="truncate">{m.title}</span>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
