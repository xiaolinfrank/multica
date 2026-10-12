/** The workflow summary carries all the stage needs: whether a version is live. */
export type MeetingStageWorkflow = { published_version_id?: string | null } | null | undefined;

export type CockpitMeetingStage = "preparation" | "recording" | "minutes_review" | "followup";

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

/** Which panel section a stage should open on, for stage-aware landing. */
export function meetingStageDefaultSection(occurrenceState: string | undefined, workflow: MeetingStageWorkflow): "agenda" | "workflow" {
  const stage = cockpitMeetingStage(occurrenceState, workflow);
  return stage === "minutes_review" || stage === "followup" ? "workflow" : "agenda";
}
