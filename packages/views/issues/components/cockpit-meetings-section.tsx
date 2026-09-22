"use client";

// The meetings this issue is recorded against — the reverse of the issue
// picker on a meeting. Same shape and same cache as the work-items section
// above it: both ends of the relation move together through the shared board
// cache and its realtime events.
//
// A meeting's own task is one of these links (role "task"), so a task filed by
// provisioning already shows the meeting it came out of without anyone wiring
// it up.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  cockpitBoardOptions,
  useDeleteCockpitMeetingIssue,
  useSetCockpitMeetingIssues,
} from "@multica/core/cockpit";
import { ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import {
  CockpitMeetingPicker,
  cockpitMeetingLabel,
} from "../../cockpit/components/cockpit-meeting-picker";

export function CockpitMeetingsSection({ issueId }: { issueId: string }) {
  // Cockpit vocabulary lives in the fork-only cockpit namespace, so this copy
  // travels with the board's rather than with upstream's issue copy.
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [open, setOpen] = useState(true);

  const { data: board } = useQuery(cockpitBoardOptions(wsId));
  const linkMeeting = useSetCockpitMeetingIssues(wsId);
  const unlinkMeeting = useDeleteCockpitMeetingIssue(wsId);

  const fail = useCallback(
    (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
    },
    [t],
  );

  const { rows, linkedIds } = useMemo(() => {
    const ids = new Set(
      (board?.meeting_issues ?? []).filter((l) => l.issue_id === issueId).map((l) => l.meeting_id),
    );
    // Walk the register's own order so the rows read the way the board lists
    // them, rather than in link-creation order.
    const entries = (board?.meetings ?? []).filter((m) => ids.has(m.id));
    return { rows: entries, linkedIds: ids };
  }, [board, issueId]);

  // Nothing to offer until the programme keeps a register; the section would
  // be all chrome.
  if (!board || board.meetings.length === 0) return null;

  const busy = linkMeeting.isPending || unlinkMeeting.isPending;
  const toggleMeeting = (meetingId: string) => {
    if (linkedIds.has(meetingId)) {
      unlinkMeeting.mutate({ meetingId, issueId }, { onError: fail });
      return;
    }
    // Append, never replace: replacing rewrites the meeting's whole link set
    // from this end, which knows nothing about the links this issue is not
    // part of.
    linkMeeting.mutate({ meetingId, issueIds: [issueId] }, { onError: fail });
  };

  return (
    <div>
      <button
        type="button"
        className={`flex w-full min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-caption font-medium transition-colors mb-2 hover:bg-accent/70 ${
          open ? "" : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">{t(($) => $.issue_meetings.title)}</span>
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </button>
      {open ? (
        <div className="pl-2">
          {rows.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.issue_meetings.none)}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map((meeting) => {
                const label = cockpitMeetingLabel(meeting);
                return (
                  <li
                    key={meeting.id}
                    className="group/meeting -mx-1 flex items-center gap-1 rounded-sm px-1 transition-colors hover:bg-accent/50"
                  >
                    {/* The row opens the register the meeting is filed in.
                        There is no per-meeting deep link yet. */}
                    <AppLink
                      href={paths.cockpit()}
                      newTabTitle={label}
                      className="min-w-0 flex-1 truncate py-1 text-caption hover:text-foreground hover:underline"
                    >
                      <span className="font-mono text-muted-foreground">
                        {meeting.code || meeting.meet_date}
                      </span>{" "}
                      {meeting.title}
                    </AppLink>
                    <button
                      type="button"
                      onClick={() =>
                        unlinkMeeting.mutate({ meetingId: meeting.id, issueId }, { onError: fail })
                      }
                      disabled={busy}
                      aria-label={t(($) => $.issue_meetings.unlink, { label })}
                      title={t(($) => $.issue_meetings.unlink, { label })}
                      className="shrink-0 rounded-xs p-1 text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/meeting:pointer-events-auto group-hover/meeting:opacity-100 disabled:opacity-40"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <CockpitMeetingPicker
            meetings={board.meetings}
            selectedIds={linkedIds}
            onToggle={toggleMeeting}
            label={t(($) => $.issue_meetings.link)}
            disabled={busy}
          />
        </div>
      ) : null}
    </div>
  );
}
