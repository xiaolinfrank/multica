import type {
  CockpitLifecycleAction,
  CockpitLifecycleCommandInput, CockpitLifecycleReceipt, CockpitMaterialsInput,
  CockpitOccurrenceInput,
} from "../types/cockpit-meeting-lifecycle";

export type CockpitMeetingCommandBody = CockpitLifecycleCommandInput | CockpitOccurrenceInput | CockpitMaterialsInput;

function sameTime(left: string | null, right: string | null) {
  return left === null || right === null ? left === right : Date.parse(left) === Date.parse(right);
}

/** A retained receipt confirms the submitted intent; current metadata can already be newer. */
export function cockpitLifecycleAcknowledged(result: { command_key: string; action: string; receipt: CockpitLifecycleReceipt }, action: CockpitLifecycleAction,
  body: CockpitMeetingCommandBody): boolean {
  if (result.command_key !== body.command_key || result.action !== action) return false;
  const receipt = result.receipt;
  if (action === "archive" || action === "unarchive" || action === "reinstate") {
    if (!("reason" in body) || !body.reason?.trim() || receipt.reason !== body.reason.trim()) return false;
    if (action === "reinstate") return receipt.occurrence?.state === "scheduled" && receipt.previous_occurrence?.state === "cancelled"
      && receipt.occurrence.cancelled_at === null && receipt.occurrence.cancelled_by === null && receipt.occurrence.cancelled_reason === "";
    return Boolean(receipt.previous_archive && receipt.archive)
      && (action === "archive" ? Boolean(receipt.archive?.archived_at) && receipt.archive?.reason === body.reason.trim() : receipt.archive?.archived_at === null && receipt.archive.archived_by === null && receipt.archive.reason === "");
  }
  if ("transition" in body) {
    const occurrence = receipt.occurrence;
    if (!occurrence || action !== body.transition) return false;
    const target = { schedule: "scheduled", end: "ended", correct_times: null, reopen: "scheduled", unschedule: "unconfirmed" }[body.transition];
    if (target && occurrence.state !== target) return false;
    if (body.actual_started_at !== undefined && !sameTime(occurrence.actual_started_at, body.actual_started_at)) return false;
    if (body.actual_ended_at !== undefined && !sameTime(occurrence.actual_ended_at, body.actual_ended_at)) return false;
    if (body.transition === "correct_times" && receipt.reason !== body.reason?.trim()) return false;
    if (body.transition === "reopen" && receipt.reason !== body.reason?.trim()) return false;
    if (body.transition === "unschedule" && receipt.reason !== body.reason?.trim()) return false;
    return true;
  }
  if ("materials_ready" in body) return receipt.materials?.ready === body.materials_ready;
  return false;
}
