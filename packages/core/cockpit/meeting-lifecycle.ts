import type {
  CockpitAgendaInput, CockpitAgendaReferenceInput, CockpitAgendaRemoveInput, CockpitLifecycleAction,
  CockpitLifecycleCommandInput, CockpitLifecycleReceipt, CockpitMaterialsInput,
  CockpitOccurrenceInput, CockpitPreparationIssueInput,
} from "../types/cockpit-meeting-lifecycle";

export type CockpitMeetingCommandBody = CockpitLifecycleCommandInput | CockpitOccurrenceInput | CockpitMaterialsInput
  | CockpitAgendaInput | CockpitAgendaRemoveInput | CockpitAgendaReferenceInput | CockpitPreparationIssueInput;

function sameTime(left: string | null, right: string | null) {
  return left === null || right === null ? left === right : Date.parse(left) === Date.parse(right);
}

/** A retained receipt confirms the submitted intent; current metadata can already be newer. */
export function cockpitLifecycleAcknowledged(result: { command_key: string; action: string; receipt: CockpitLifecycleReceipt }, action: CockpitLifecycleAction,
  body: CockpitMeetingCommandBody, agendaId?: string, referenceId?: string): boolean {
  if (result.command_key !== body.command_key || result.action !== action) return false;
  const receipt = result.receipt;
  if (agendaId && receipt.agenda_id !== agendaId || referenceId && receipt.reference_id !== referenceId) return false;
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
    const target = { schedule: "scheduled", start: "in_progress", end: "ended", correct_times: null, reopen: "scheduled" }[body.transition];
    if (target && occurrence.state !== target) return false;
    if (body.actual_started_at !== undefined && !sameTime(occurrence.actual_started_at, body.actual_started_at)) return false;
    if (body.actual_ended_at !== undefined && !sameTime(occurrence.actual_ended_at, body.actual_ended_at)) return false;
    if (body.transition === "correct_times" && receipt.reason !== body.reason?.trim()) return false;
    if (body.transition === "reopen" && receipt.reason !== body.reason?.trim()) return false;
    return true;
  }
  if ("materials_ready" in body) return receipt.materials?.ready === body.materials_ready;
  if (action === "agenda_create" || action === "agenda_update") {
    const input = body as CockpitAgendaInput, agenda = receipt.agenda;
    if (!agenda) return false;
    for (const field of ["desired_outcome", "notes", "facilitator_user_id", "node_id", "sort_order"] as const) {
      if (input[field] !== undefined && agenda[field] !== input[field]) return false;
    }
    if (input.title !== undefined && agenda.title !== input.title.trim()) return false;
    if (input.purposes && JSON.stringify([...new Set(input.purposes)].sort()) !== JSON.stringify([...new Set(agenda.purposes)].sort())) return false;
    return true;
  }
  if (action === "agenda_remove") return Boolean(receipt.agenda?.removed_at)
    && "reason" in body && receipt.reason === body.reason?.trim();
  if (action === "reference_attach") return "target_id" in body && receipt.reference?.target_id === body.target_id
    && receipt.reference.kind === body.kind && receipt.reference.purpose === body.purpose;
  if (action === "reference_remove") return Boolean(receipt.reference?.removed_at);
  if (action === "preparation_issue_create") {
    if (!("new_issue" in body)) return false;
    const issue = receipt.reference?.issue;
    return Boolean(issue && issue.id === receipt.issue_id && issue.title === body.new_issue.title.trim()
      && issue.status === "backlog" && issue.priority === body.new_issue.priority
      && issue.assignee_type === body.new_issue.assignee_type && issue.assignee_id === body.new_issue.assignee_id
      && issue.due_date === body.new_issue.due_date && issue.primary_node_id === body.primary_node_id
      && (body.primary_node_id !== null || issue.project_id === body.new_issue.project_id && issue.module_id === body.new_issue.module_id));
  }
  return false;
}
