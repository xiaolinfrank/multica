"use client";

import { cockpitMeetingSpan, cockpitMeetingContextPath, type CockpitScope } from "@multica/core/cockpit";
import type { CockpitMeetingCard } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { ArrowUpRight, CalendarDays, FolderOpen, Link2 } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useMeetingOccurrenceLabel } from "./use-meeting-occurrence-label";
import { useT } from "../../i18n";

export function useMeetingStageLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    not_enabled: t(($) => $.work_overview.not_enabled), waiting_meeting: t(($) => $.work_overview.waiting_meeting), published: t(($) => $.workflow.published),
    review_pending: t(($) => $.work_overview.review_pending), reviewer_missing: t(($) => $.work_overview.reviewer_missing), publish_ready: t(($) => $.work_overview.publish_ready),
    release_ready: t(($) => $.work_overview.release_ready), restore_backlog: t(($) => $.work_overview.restore_backlog), materials_needed: t(($) => $.work_overview.materials_needed),
    readiness_needed: t(($) => $.work_overview.readiness_needed), minutes_needed: t(($) => $.work_overview.minutes_needed), minutes_rework: t(($) => $.work_overview.minutes_rework),
  };
  return (stage: string) => labels[stage] ?? t(($) => $.work_overview.other_work);
}

/** A bounded metadata page: bodies and full relation collections are read only in the selected meeting. */
export function CockpitMeetingCards({ items, scope, selectedId }: {
  items: CockpitMeetingCard[]; scope: CockpitScope; selectedId: string | null;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const stageLabel = useMeetingStageLabel(); const occurrenceLabel = useMeetingOccurrenceLabel();
  return <ul className="divide-y divide-border/65">{items.map((meeting) => <li key={meeting.id}>
    <div className={cn("group grid min-w-0 gap-3 rounded-xl px-4 py-4 transition-colors hover:bg-accent/55 sm:grid-cols-[minmax(0,1fr)_auto]", selectedId === meeting.id && "bg-accent")}>
    <AppLink href={cockpitMeetingContextPath(paths.cockpit(), meeting.id, scope, navigation.searchParams)} newTabTitle={meeting.title}
      aria-current={selectedId === meeting.id ? "true" : undefined} aria-label={t(($) => $.meetings.select, { title: meeting.title })}
      className="grid min-w-0 gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[120px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground sm:block sm:space-y-1">
        <p className="inline-flex items-center gap-1.5 font-medium text-foreground"><CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />{meeting.meet_date ?? t(($) => $.meetings.undated_section)}</p>
        <p className="min-w-0 break-words tabular-nums">{cockpitMeetingSpan(meeting) || t(($) => $.meeting.all_day)}</p>
        <p className="min-w-0 break-words font-mono text-micro" title={meeting.code}>{meeting.code}</p>
      </div>
      <div className="min-w-0 space-y-2"><h3 className="line-clamp-2 break-words text-body font-medium group-hover:underline" title={meeting.title}>{meeting.title || t(($) => $.issue_meetings.untitled)}</h3>
        <p className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {meeting.kind && <span>{meeting.kind}</span>}
          {meeting.parties && <span className="line-clamp-1 max-w-full" title={meeting.parties}>{meeting.parties}</span>}
          {meeting.location && <span className="line-clamp-1 max-w-full" title={meeting.location}>{meeting.location}</span>}
        </p>
        <div className="flex flex-wrap gap-2 text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Link2 className="size-3" aria-hidden />{t(($) => $.meeting_center.link_counts, { issues: meeting.issue_count, nodes: meeting.node_count })}</span>
          {meeting.nas_dir && <span className="inline-flex items-center gap-1"><FolderOpen className="size-3" aria-hidden />{t(($) => $.meeting_center.has_directory)}</span>}
        </div>
      </div>
    </AppLink>
      <div className="flex max-w-full flex-wrap items-start justify-between gap-2 sm:max-w-52 sm:flex-col sm:items-end">
        {typeof meeting.occurrence_state === "string" && <AppLink href={cockpitMeetingContextPath(paths.cockpit(), meeting.id, scope, navigation.searchParams, undefined)} className="max-w-full break-words rounded-md bg-muted px-2 py-1 text-caption hover:underline" aria-label={`${t(($) => $.meeting_lifecycle.record_occurrence)} · ${occurrenceLabel(meeting.occurrence_state)}`}>{occurrenceLabel(meeting.occurrence_state)}</AppLink>}
        {meeting.archived_at && <span className="rounded-md bg-muted px-2 py-1 text-caption">{t(($) => $.meeting_disposition.archived)}</span>}
        {meeting.workflow_enabled && <span className="rounded-md bg-brand/8 px-2 py-1 text-caption text-brand">{stageLabel(meeting.workflow_stage)}</span>}
        {meeting.status && <span className="line-clamp-2 max-w-full break-words text-caption text-muted-foreground" title={meeting.status}>{typeof meeting.occurrence_state === "string" ? t(($) => $.meeting_lifecycle.custom_status_value, { status: meeting.status }) : meeting.status}</span>}
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
    </div>
  </li>)}</ul>;
}
