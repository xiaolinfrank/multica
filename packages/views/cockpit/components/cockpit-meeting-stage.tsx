"use client";

// Stage selection navigates the workbench; checkmarks reflect confirmed facts.
// Visiting an earlier stage does not change the meeting's occurrence state.

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
    {MEETING_STAGE_ORDER.map((stage, index) => {
      const Icon = STAGE_ICON[stage];
      const finished = done.has(stage);
      return <TabsTrigger key={stage} value={stage} aria-label={t(($) => $.meeting_stage[stage])}
          data-finished={finished || undefined} className="cockpit-stage-step relative flex h-auto min-h-10 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-2 py-2 text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-active:border-border data-active:bg-card data-active:font-semibold data-active:text-brand data-active:hover:bg-card data-active:hover:text-brand dark:data-active:bg-card dark:data-active:text-brand @min-[32rem]/meeting-panel:flex-row @min-[32rem]/meeting-panel:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0">
          <span aria-hidden className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-micro leading-none tabular-nums">
            {finished ? <Check className="size-3" /> : index + 1}
          </span>
          <span className="min-w-0 whitespace-normal break-words [overflow-wrap:anywhere]">{t(($) => $.meeting_stage[stage])}</span>
          <Icon className="hidden size-3.5 @min-[32rem]/meeting-panel:block" aria-hidden />
        </TabsTrigger>;
    })}
  </>;
}
