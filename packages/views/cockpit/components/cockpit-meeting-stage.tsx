"use client";

// The meeting reads as one line of work: 准备 → 会议记录 → 纪要确认, drawn
// as a timeline inside the highlighted stage card. The segments ARE the
// navigation — clicking one switches the stage surface below it. Checkmarks
// show where the meeting's confirmed facts stand; the selection shows which
// surface is open (visiting an earlier stage is a look back, never a state
// change).

import { Fragment } from "react";
import { TabsTrigger } from "@multica/ui/components/ui/tabs";
import { Check, ClipboardList, FileText, PenLine } from "lucide-react";
import { useT } from "../../i18n";
import { cockpitMeetingStage, meetingStagesBefore, MEETING_STAGE_ORDER, type CockpitMeetingStage, type MeetingStageWorkflow, type MeetingStageTiming } from "./meeting-stage";

const STAGE_ICON = { preparation: ClipboardList, recording: PenLine, minutes_review: FileText } as const;

export function CockpitMeetingStageTabs({ occurrenceState, workflow, timing, now }: { occurrenceState: string | undefined; workflow: MeetingStageWorkflow; timing?: MeetingStageTiming; now?: Date }) {
  const { t } = useT("cockpit");
  const current = cockpitMeetingStage(occurrenceState, workflow, timing, now);
  const done = current ? new Set(meetingStagesBefore(current)) : new Set<CockpitMeetingStage>();
  return <>
    <span aria-hidden className="pointer-events-none absolute inset-x-8 top-1/2 h-px -translate-y-1/2 bg-border" />
    {MEETING_STAGE_ORDER.map((stage, index) => {
      const Icon = STAGE_ICON[stage];
      const finished = done.has(stage);
      return <Fragment key={stage}>
        <TabsTrigger value={stage} aria-label={t(($) => $.meeting_stage[stage])}
          className="relative z-10 flex h-9 flex-none items-center justify-center gap-1.5 rounded-full border border-transparent bg-background px-3 text-body whitespace-nowrap text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-active:border-primary/50 data-active:bg-primary/10 data-active:font-semibold data-active:text-primary sm:flex-1 [&_svg]:pointer-events-none [&_svg]:shrink-0">
          <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] leading-none tabular-nums">
            {finished ? <Check className="size-3" /> : index + 1}
          </span>
          <span className="truncate">{t(($) => $.meeting_stage[stage])}</span>
          <Icon className="hidden size-3.5 sm:block" aria-hidden />
        </TabsTrigger>
      </Fragment>;
    })}
  </>;
}
