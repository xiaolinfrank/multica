import { z } from "zod";

const time = z.string().datetime({ offset: true }).nullable();
const id = z.string().min(1).nullable();
export const cockpitOccurrenceStates = new Set(["unconfirmed", "scheduled", "in_progress", "ended", "cancelled"]);

export const CockpitOccurrenceSchema = z.object({
  state: z.string(), started_confirmed_at: time, started_confirmed_by: id,
  ended_at: time, ended_by: id, ended_source: z.string().nullable(),
  actual_started_at: time, actual_ended_at: time,
  cancelled_at: time.optional(), cancelled_by: id.optional(), cancelled_reason: z.string().optional(),
}).refine((value) => !cockpitOccurrenceStates.has(value.state) || (
  (value.state === "ended") === (value.ended_at !== null)
  && (!value.actual_ended_at || value.state === "ended")
  && (!value.actual_started_at || !value.actual_ended_at || Date.parse(value.actual_started_at) <= Date.parse(value.actual_ended_at))
  && (value.state !== "cancelled" || Boolean(value.cancelled_at && value.cancelled_reason?.trim()))
), "Occurrence confirmation and explicitly recorded times are inconsistent");

export const CockpitMeetingArchiveSchema = z.object({ archived_at: time, archived_by: id, reason: z.string() })
  .refine((value) => value.archived_at === null || Boolean(value.archived_by && value.reason.trim()));
