import type { CockpitDirectoryCommandReceipt } from "./cockpit-meeting-directory";
import type { CockpitTask } from "./cockpit";
import type { CockpitMeetingArchiveView, CockpitPreparationCommandReceipt } from "./cockpit-meeting-preparation";

export type CockpitOccurrenceTransition = "schedule" | "end" | "correct_times" | "reopen" | "unschedule";
export type CockpitAgendaPurpose = "planning" | "goal_review" | "boundary_confirmation" | "question_clarification" | "solution_discussion" | "direction_decision";
export type CockpitLifecycleAction = CockpitOccurrenceTransition | "materials" | "agenda_create" | "agenda_update" | "agenda_remove" | "reference_attach" | "reference_remove" | "preparation_issue_create" | "reinstate" | "archive" | "unarchive";
export interface CockpitLifecycleCommandInput { command_key: string; expected_revision: number }
export interface CockpitOccurrenceInput extends CockpitLifecycleCommandInput {
  transition: CockpitOccurrenceTransition;
  actual_started_at?: string | null;
  actual_ended_at?: string | null;
  reason?: string;
}
export interface CockpitMaterialsInput extends CockpitLifecycleCommandInput { materials_ready: boolean }
export interface CockpitAgendaInput extends CockpitLifecycleCommandInput {
  title?: string;
  purposes?: CockpitAgendaPurpose[];
  desired_outcome?: string;
  notes?: string;
  facilitator_user_id?: string | null;
  node_id?: string | null;
  sort_order?: number;
}
export interface CockpitAgendaRemoveInput extends CockpitLifecycleCommandInput { reason: string }
export interface CockpitAgendaReferenceInput extends CockpitLifecycleCommandInput {
  kind: "issue" | "artifact_reference";
  target_id: string;
  purpose: "preparation" | "material";
}
export interface CockpitPreparationIssueInput extends CockpitLifecycleCommandInput {
  primary_node_id: string | null;
  new_issue: {
    title: string;
    description: string;
    assignee_type: "member" | "agent" | "squad" | null;
    assignee_id: string | null;
    priority: "none" | "urgent" | "high" | "medium" | "low";
    due_date: string | null;
    project_id: string | null;
    module_id: string | null;
  };
}

export interface CockpitOccurrenceView {
  state: string;
  started_confirmed_at: string | null;
  started_confirmed_by: string | null;
  ended_at: string | null;
  ended_by: string | null;
  ended_source: string | null;
  actual_started_at: string | null;
  actual_ended_at: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancelled_reason?: string;
}
export interface CockpitMaterialsView {
  workflow_revision: number;
  ready: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  released: boolean;
}
export interface CockpitMeetingLifecycleHeader {
  workspace_id: string;
  meeting_id: string;
  lifecycle_revision: number;
  agenda_revision: number;
  generated_at: string;
  occurrence: CockpitOccurrenceView;
  materials: CockpitMaterialsView | null;
  workflow_enabled: boolean;
  agenda_total: number;
  can_schedule: boolean;
  can_end: boolean;
  can_correct_times: boolean;
  can_reopen: boolean;
  can_unschedule: boolean;
  can_edit_agenda: boolean;
  can_confirm_materials: boolean;
  blocked_reasons: Array<{ action: string; code: string }>;
  archive?: CockpitMeetingArchiveView;
}
export interface CockpitAgendaMetadata {
  id: string;
  workspace_id: string;
  meeting_id: string;
  revision: number;
  title: string;
  purposes: string[];
  sort_order: number;
  facilitator_user_id: string | null;
  facilitator_name: string;
  node_id: string | null;
  node_code: string;
  node_title: string;
  reference_count: number;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
  can_edit: boolean;
  can_remove: boolean;
}
export interface CockpitAgendaDetail extends CockpitAgendaMetadata { desired_outcome: string; notes: string }
export interface CockpitLifecyclePageQuery { cursor?: string; page_size?: number }
export interface CockpitAgendaQuery extends CockpitLifecyclePageQuery { q?: string; include_removed?: boolean }
export interface CockpitAgendaReferenceQuery extends CockpitLifecyclePageQuery { include_removed?: boolean }
export interface CockpitAgendaPage {
  workspace_id: string; meeting_id: string; agenda_revision: number;
  q: string; include_removed: boolean; page_size: number;
  items: CockpitAgendaMetadata[]; total: number; next_cursor: string | null;
}
export interface CockpitAgendaReferenceView {
  id: string; workspace_id: string; meeting_id: string; agenda_id: string;
  kind: string; target_id: string; purpose: string; available: boolean; label: string;
  issue: CockpitTask | null;
  artifact_id: string | null; version_id: string | null; version_number: number | null; content_hash: string | null;
  version_decision?: string | null;
  created_at: string; removed_at: string | null; can_remove: boolean;
}
export interface CockpitAgendaReferencePage {
  workspace_id: string; meeting_id: string; agenda_id: string; agenda_revision: number;
  include_removed: boolean; page_size: number;
  items: CockpitAgendaReferenceView[]; total: number; next_cursor: string | null;
}
export interface CockpitLifecycleReceipt {
  revision: number; agenda_revision: number;
  agenda_id: string | null; reference_id: string | null; issue_id: string | null;
  request_hash: string;
  reason: string;
  previous_occurrence: CockpitOccurrenceView | null;
  occurrence: CockpitOccurrenceView | null;
  materials: CockpitMaterialsView | null;
  agenda: CockpitAgendaDetail | null;
  reference: CockpitAgendaReferenceView | null;
  archive?: CockpitMeetingArchiveView | null;
  previous_archive?: CockpitMeetingArchiveView | null;
  preparation?: CockpitPreparationCommandReceipt | null;
  directory?: CockpitDirectoryCommandReceipt | null;
}
export interface CockpitLifecycleCommandResult {
  workspace_id: string; meeting_id: string; command_key: string;
  action: CockpitLifecycleAction; replayed: boolean;
  receipt: CockpitLifecycleReceipt; current: CockpitMeetingLifecycleHeader;
}
export interface CockpitLifecycleCommandMetadata {
  command_key: string; action: string; actor_id: string; actor_name: string; created_at: string;
  revision: number; agenda_id: string | null; reference_id: string | null; issue_id: string | null;
  operation_id?: string | null; effect_id?: string | null;
  actor_type?: string; directory_operation_id?: string | null; directory_step_id?: string | null;
}
export interface CockpitLifecycleCommandPage {
  workspace_id: string; meeting_id: string; page_size: number;
  items: CockpitLifecycleCommandMetadata[]; total: number; next_cursor: string | null;
}
export interface CockpitLifecycleCommandDetail extends CockpitLifecycleCommandMetadata {
  workspace_id: string; meeting_id: string; receipt: CockpitLifecycleReceipt;
}
