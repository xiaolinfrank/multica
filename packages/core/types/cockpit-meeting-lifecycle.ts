import type { CockpitDirectoryCommandReceipt } from "./cockpit-meeting-directory";
import type { CockpitMeetingArchiveView, CockpitPreparationCommandReceipt } from "./cockpit-meeting-preparation";

export type CockpitOccurrenceTransition = "schedule" | "end" | "correct_times" | "reopen" | "unschedule";
export type CockpitLifecycleAction = CockpitOccurrenceTransition | "materials" | "agenda_create" | "agenda_update" | "agenda_remove" | "reference_attach" | "reference_remove" | "preparation_issue_create" | "reinstate" | "archive" | "unarchive";
export interface CockpitLifecycleCommandInput { command_key: string; expected_revision: number }
export interface CockpitOccurrenceInput extends CockpitLifecycleCommandInput {
  transition: CockpitOccurrenceTransition;
  actual_started_at?: string | null;
  actual_ended_at?: string | null;
  reason?: string;
}
export interface CockpitMaterialsInput extends CockpitLifecycleCommandInput { materials_ready: boolean }
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
  generated_at: string;
  occurrence: CockpitOccurrenceView;
  materials: CockpitMaterialsView | null;
  workflow_enabled: boolean;
  can_schedule: boolean;
  can_end: boolean;
  can_correct_times: boolean;
  can_reopen: boolean;
  can_unschedule: boolean;
  can_confirm_materials: boolean;
  blocked_reasons: Array<{ action: string; code: string }>;
  archive?: CockpitMeetingArchiveView;
}
export interface CockpitLifecyclePageQuery { cursor?: string; page_size?: number }
export interface CockpitLifecycleReceipt {
  revision: number;
  issue_id: string | null;
  request_hash: string;
  reason: string;
  previous_occurrence: CockpitOccurrenceView | null;
  occurrence: CockpitOccurrenceView | null;
  materials: CockpitMaterialsView | null;
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
  revision: number; issue_id: string | null;
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
