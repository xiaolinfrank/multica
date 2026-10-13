import type { CockpitMeetingView } from "@multica/core/cockpit";

/** The workflow summary carries all the stage needs: whether a version is live. */
export type MeetingStageWorkflow = { published_version_id?: string | null } | null | undefined;

export type CockpitMeetingStage = "preparation" | "recording" | "minutes_review" | "followup";

export const MEETING_STAGE_ORDER: readonly CockpitMeetingStage[] = ["preparation", "recording", "minutes_review", "followup"];

/** The panel views that host each stage's working surface. */
export const STAGE_VIEW: Record<CockpitMeetingStage, Exclude<CockpitMeetingView, "agenda" | "workflow" | "resources" | "details">> = {
  preparation: "preparation", recording: "recording", minutes_review: "minutes_review", followup: "followup",
};

/**
 * R4 (design-principles-2026-10-12, principle 3): the meeting stage is a live
 * projection of the occurrence confirmation plus the minutes associations —
 * never a stored state machine field. Cancelled meetings have no stage line.
 */
export function cockpitMeetingStage(occurrenceState: string | undefined, workflow: MeetingStageWorkflow): CockpitMeetingStage | null {
  if (occurrenceState === "cancelled") return null;
  if (occurrenceState === "in_progress") return "recording";
  if (occurrenceState === "ended") return workflow?.published_version_id ? "followup" : "minutes_review";
  return "preparation";
}

/** View a stage should land on when a meeting opens without an explicit view. */
export function meetingStageDefaultView(occurrenceState: string | undefined, workflow: MeetingStageWorkflow): "preparation" | "recording" | "minutes_review" | "followup" {
  return STAGE_VIEW[cockpitMeetingStage(occurrenceState, workflow) ?? "preparation"];
}

/** Stages completed as of the current stage, for the checkmarks on the segment bar. */
export function meetingStagesBefore(stage: CockpitMeetingStage): CockpitMeetingStage[] {
  return MEETING_STAGE_ORDER.slice(0, MEETING_STAGE_ORDER.indexOf(stage));
}
