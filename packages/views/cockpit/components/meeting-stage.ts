import type { CockpitMeetingView } from "@multica/core/cockpit";

/** The workflow summary carries all the stage needs: whether a version is live. */
export type MeetingStageWorkflow = { published_version_id?: string | null } | null | undefined;

/** The scheduled window of the meeting row, for the live "recording" projection. */
export type MeetingStageTiming = { meet_date: string | null; start_time: string | null; end_time: string | null } | null | undefined;

export type CockpitMeetingStage = "preparation" | "recording" | "minutes_review" | "followup";

export const MEETING_STAGE_ORDER: readonly CockpitMeetingStage[] = ["preparation", "recording", "minutes_review", "followup"];

/** The panel views that host each stage's working surface. */
export const STAGE_VIEW: Record<CockpitMeetingStage, Exclude<CockpitMeetingView, "agenda" | "workflow" | "resources" | "details">> = {
  preparation: "preparation", recording: "recording", minutes_review: "minutes_review", followup: "followup",
};

/**
 * R4 collapse: the start confirmation is gone. A scheduled meeting inside its
 * own time window IS the meeting in progress — a projection of the row's
 * meet_date/start_time/end_time, never a stored state (principle 3).
 */
export function meetingInsideWindow(timing: MeetingStageTiming, now: Date = new Date()): boolean {
  if (!timing?.meet_date) return false;
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (timing.meet_date !== day) return false;
  if (!timing.start_time) return true;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const clock = now.getHours() * 60 + now.getMinutes();
  return clock >= minutes(timing.start_time) && (!timing.end_time || clock <= minutes(timing.end_time));
}

/**
 * R4 (design-principles-2026-10-12, principle 3): the meeting stage is a live
 * projection of the occurrence confirmation plus the minutes associations —
 * never a stored state machine field. Cancelled meetings have no stage line.
 */
export function cockpitMeetingStage(occurrenceState: string | undefined, workflow: MeetingStageWorkflow, timing: MeetingStageTiming = null, now: Date = new Date()): CockpitMeetingStage | null {
  if (occurrenceState === "cancelled") return null;
  if (occurrenceState === "ended") return workflow?.published_version_id ? "followup" : "minutes_review";
  if (occurrenceState === "scheduled" && meetingInsideWindow(timing, now)) return "recording";
  return "preparation";
}

/** View a stage should land on when a meeting opens without an explicit view. */
export function meetingStageDefaultView(occurrenceState: string | undefined, workflow: MeetingStageWorkflow, timing: MeetingStageTiming = null): "preparation" | "recording" | "minutes_review" | "followup" {
  return STAGE_VIEW[cockpitMeetingStage(occurrenceState, workflow, timing) ?? "preparation"];
}

/** Stages completed as of the current stage, for the checkmarks on the segment bar. */
export function meetingStagesBefore(stage: CockpitMeetingStage): CockpitMeetingStage[] {
  return MEETING_STAGE_ORDER.slice(0, MEETING_STAGE_ORDER.indexOf(stage));
}
