"use client";

// R4 (proposal §9.3): one meeting reads as one line of work — preparation,
// the meeting itself, its minutes, then the actions it opened. The strip is a
// projection, never a second state machine: the stage is recomputed from the
// occurrence confirmation and the minutes associations every render.

import { Button } from "@multica/ui/components/ui/button";
import { Check, ClipboardList, FileText, ListChecks } from "lucide-react";
import { useT } from "../../i18n";
import { cockpitMeetingStage, type CockpitMeetingStage, type MeetingStageWorkflow } from "./meeting-stage";

const STAGE_ICON = { preparation: ClipboardList, recording: Check, minutes_review: FileText, followup: ListChecks } as const;

export function CockpitMeetingStageStrip({
  occurrenceState, workflow, onOpenSection,
}: {
  occurrenceState: string | undefined;
  workflow: MeetingStageWorkflow;
  onOpenSection: (section: "agenda" | "workflow" | "resources" | "details") => void;
}) {
  const { t } = useT("cockpit");
  const stage = cockpitMeetingStage(occurrenceState, workflow);
  if (!stage) return null;
  const order: CockpitMeetingStage[] = ["preparation", "recording", "minutes_review", "followup"];
  const action = stage === "preparation" ? { label: t(($) => $.meeting_stage.action_check_materials), section: "resources" as const }
    : stage === "recording" ? { label: t(($) => $.meeting_stage.action_end_meeting), section: "agenda" as const }
    : stage === "minutes_review" ? { label: t(($) => $.meeting_stage.action_minutes), section: "workflow" as const }
    : { label: t(($) => $.meeting_stage.action_followup), section: "workflow" as const };
  const Icon = STAGE_ICON[stage];
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5" aria-label={t(($) => $.meeting_stage.strip)}>
    <ol className="flex min-w-0 flex-1 items-center gap-1 text-caption">
      {order.map((item, index) => {
        const current = item === stage;
        const done = order.indexOf(stage) > index;
        return <li key={item} className="flex min-w-0 items-center gap-1">
          {index > 0 && <span aria-hidden className="text-muted-foreground/50">→</span>}
          <button
            type="button"
            aria-current={current ? "step" : undefined}
            className={current ? "font-medium text-primary" : done ? "text-muted-foreground" : "text-muted-foreground/70 hover:text-foreground"}
            onClick={() => onOpenSection(item === "preparation" ? "resources" : item === "recording" ? "agenda" : "workflow")}
          >
            {t(($) => $.meeting_stage[item])}
          </button>
        </li>;
      })}
    </ol>
    <Button size="sm" variant={stage === "recording" ? "default" : "outline"} className="h-7 shrink-0 gap-1 px-2 text-caption" onClick={() => onOpenSection(action.section)}>
      <Icon className="size-3.5" aria-hidden />
      {action.label}
    </Button>
  </div>;
}
