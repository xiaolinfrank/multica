"use client";

// R4 (proposal §9.3): the meeting reads as one line of work. The stage
// segments ARE the navigation — clicking a stage switches the working surface
// below, one level instead of two. The checkmarks show where the meeting's
// confirmed facts stand; the selection shows which surface you are reading
// (visiting an earlier stage is a look back, never a state change).

import { Button } from "@multica/ui/components/ui/button";
import { TabsTrigger } from "@multica/ui/components/ui/tabs";
import { Check, ClipboardList, FileText, ListChecks, PenLine } from "lucide-react";
import { useT } from "../../i18n";
import { cockpitMeetingStage, meetingStagesBefore, MEETING_STAGE_ORDER, type CockpitMeetingStage, type MeetingStageWorkflow, type MeetingStageTiming } from "./meeting-stage";

const STAGE_ICON = { preparation: ClipboardList, recording: PenLine, minutes_review: FileText, followup: ListChecks } as const;

export function CockpitMeetingStageTabs({ occurrenceState, workflow, timing, now }: { occurrenceState: string | undefined; workflow: MeetingStageWorkflow; timing?: MeetingStageTiming; now?: Date }) {
  const { t } = useT("cockpit");
  const current = cockpitMeetingStage(occurrenceState, workflow, timing, now);
  const done = current ? new Set(meetingStagesBefore(current)) : new Set<CockpitMeetingStage>();
  return <>
    {MEETING_STAGE_ORDER.map((stage, index) => {
      const Icon = STAGE_ICON[stage];
      const finished = done.has(stage);
      return <TabsTrigger key={stage} value={stage} className="h-9 flex-1 gap-1.5 px-2.5 text-body data-active:bg-primary/10 data-active:font-semibold data-active:text-primary data-active:shadow-sm">
        <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] leading-none tabular-nums">
          {finished ? <Check className="size-3" /> : index + 1}
        </span>
        <span className="truncate">{t(($) => $.meeting_stage[stage])}</span>
        <Icon className="hidden size-3.5 sm:block" aria-hidden />
      </TabsTrigger>;
    })}
  </>;
}

/**
 * The single primary action for the meeting's current stage, for the header.
 * S06: while preparing, a meeting whose materials are confirmed offers the
 * full-width workbench; one still missing them offers the gap view instead.
 */
export function CockpitMeetingStageAction({ occurrenceState, workflow, timing, now, materialsReady, onOpenView }: {
  occurrenceState: string | undefined;
  workflow: MeetingStageWorkflow;
  timing?: MeetingStageTiming;
  now?: Date;
  materialsReady?: boolean;
  onOpenView: (view: "preparation" | "recording" | "minutes_review" | "followup" | "resources", options?: { focused?: boolean }) => void;
}) {
  const { t } = useT("cockpit");
  const stage = cockpitMeetingStage(occurrenceState, workflow, timing, now);
  if (!stage) return null;
  const action = stage === "preparation"
    ? materialsReady
      ? { label: t(($) => $.meeting_stage.action_enter_workbench), view: "recording" as const, focused: true, solid: true }
      : { label: t(($) => $.meeting_stage.action_view_gaps), view: "resources" as const, focused: false, solid: false }
    : stage === "recording" ? { label: t(($) => $.meeting_stage.action_end_meeting), view: "recording" as const, focused: false, solid: true }
    : stage === "minutes_review" ? { label: t(($) => $.meeting_stage.action_minutes), view: "minutes_review" as const, focused: false, solid: false }
    : { label: t(($) => $.meeting_stage.action_followup), view: "followup" as const, focused: false, solid: false };
  const Icon = STAGE_ICON[stage];
  return <Button size="sm" variant={action.solid ? "default" : "outline"} className="h-7 shrink-0 gap-1.5 px-2.5 text-caption" onClick={() => onOpenView(action.view, { focused: action.focused })}>
    <Icon className="size-3.5" aria-hidden />
    {action.label}
  </Button>;
}
