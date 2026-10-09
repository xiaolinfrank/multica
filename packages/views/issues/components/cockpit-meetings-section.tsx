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
import type { CockpitMeeting, CockpitMeetingIssueLink } from "@multica/core/types";
import { ChevronRight, X } from "lucide-react";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import {
  CockpitMeetingPicker,
  cockpitMeetingLabel,
} from "../../cockpit/components/cockpit-meeting-picker";
import { CockpitMeetingRoleLabels } from "../../cockpit/components/cockpit-meeting-issue-links";

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
    const links = new Map(
      (board?.meeting_issues ?? [])
        .filter((link) => link.issue_id === issueId)
        .map((link) => [link.meeting_id, link]),
    );
    // Walk the register's own order so the rows read the way the board lists
    // them, rather than in link-creation order.
    const entries: { id: string; meeting?: CockpitMeeting; link: CockpitMeetingIssueLink }[] = [];
    const availableIds = new Set<string>();
    for (const meeting of board?.meetings ?? []) {
      availableIds.add(meeting.id);
      const link = links.get(meeting.id);
      if (link) entries.push({ id: meeting.id, meeting, link });
    }
    // Keep unresolved relations visible without guessing a destination or
    // exposing a title that the current board response did not provide.
    for (const [id, link] of links) {
      if (!availableIds.has(id)) entries.push({ id, link });
    }
    return { rows: entries, linkedIds: new Set(links.keys()) };
  }, [board, issueId]);

  // Hide empty registers, but retain any unresolved relationship so it can
  // be understood and removed without navigating to an unrelated page.
  if (!board || (board.meetings.length === 0 && rows.length === 0)) return null;

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
        aria-expanded={open}
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
              {rows.map(({ id, meeting, link }) => {
                const title = meeting?.title.trim() || t(($) => $.issue_meetings.untitled);
                const label = meeting
                  ? cockpitMeetingLabel({ ...meeting, title })
                  : t(($) => $.issue_meetings.unavailable);
                return (
                  <li
                    key={id}
                    className="group/meeting -mx-1 flex items-center gap-1 rounded-sm px-1 transition-colors hover:bg-accent/50"
                  >
                    <div className="min-w-0 flex-1 py-1">
                      {meeting ? (
                        <AppLink
                          href={`${paths.cockpit()}?meeting=${encodeURIComponent(id)}`}
                          newTabTitle={label}
                          className="block truncate text-caption hover:text-foreground hover:underline"
                        >
                          <span className="font-mono text-muted-foreground">
                            {meeting.code || meeting.meet_date}
                          </span>{" "}
                          {title}
                        </AppLink>
                      ) : (
                        <span className="block text-caption text-muted-foreground">{label}</span>
                      )}
                      <CockpitMeetingRoleLabels link={link} />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        unlinkMeeting.mutate({ meetingId: id, issueId }, { onError: fail })
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
          {board.meetings.length > 0 && (
            <CockpitMeetingPicker
              meetings={board.meetings}
              selectedIds={linkedIds}
              onToggle={toggleMeeting}
              label={t(($) => $.issue_meetings.link)}
              disabled={busy}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
