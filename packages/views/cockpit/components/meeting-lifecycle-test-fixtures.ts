import type { CockpitAgendaDetail, CockpitAgendaMetadata, CockpitLifecycleCommandResult, CockpitMeetingLifecycleHeader } from "@multica/core/types";
export function lifecycleFixture(patch: Partial<CockpitMeetingLifecycleHeader> = {}): CockpitMeetingLifecycleHeader {
  return { workspace_id: "ws-1", meeting_id: "meeting-1", lifecycle_revision: 1, agenda_revision: 1, generated_at: "2026-10-11T01:00:00Z", occurrence: { state: "unconfirmed", started_confirmed_at: null, started_confirmed_by: null, ended_at: null, ended_by: null, ended_source: null, actual_started_at: null, actual_ended_at: null }, materials: null, workflow_enabled: false, agenda_total: 0, can_schedule: true, can_end: true, can_correct_times: true, can_edit_agenda: true, can_confirm_materials: false, can_reopen: false, can_unschedule: false, blocked_reasons: [{ action: "materials", code: "workflow_required" }], ...patch };
}
export function agendaFixture(patch: Partial<CockpitAgendaDetail> = {}): CockpitAgendaDetail {
  return { id: "agenda-1", workspace_id: "ws-1", meeting_id: "meeting-1", revision: 1, title: "Review delivery boundary", purposes: ["boundary_confirmation"], desired_outcome: "Define the handover boundary", notes: "Server discussion notes", sort_order: 1, facilitator_user_id: null, facilitator_name: "", node_id: null, node_code: "", node_title: "", reference_count: 0, created_at: "2026-10-11T01:00:00Z", updated_at: "2026-10-11T01:00:00Z", removed_at: null, can_edit: true, can_remove: true, ...patch };
}
export function agendaMetadataFixture(detail: CockpitAgendaDetail): CockpitAgendaMetadata {
  const { desired_outcome: _desired, notes: _notes, ...metadata } = detail; return metadata;
}
export function lifecycleResultFixture(current: CockpitMeetingLifecycleHeader, commandKey: string, action: CockpitLifecycleCommandResult["action"], patch: Partial<CockpitLifecycleCommandResult["receipt"]> = {}): CockpitLifecycleCommandResult {
  return { workspace_id: current.workspace_id, meeting_id: current.meeting_id, command_key: commandKey, action, replayed: false, current,
    receipt: { revision: current.lifecycle_revision, agenda_revision: current.agenda_revision, agenda_id: null, reference_id: null, issue_id: null, request_hash: "observed-command", reason: "", previous_occurrence: null, occurrence: null, materials: null, agenda: null, reference: null, ...patch } };
}
