// Shared wire contract for bounded meeting directory preparation.

export interface CockpitDirectoryPrincipal {
  source: string;
  actor_type: string;
  actor_id: string;
  actor_name: string;
  credential_owner_user_id: string;
  authorizing_user_id: string;
  authorizing_user_name: string;
  confirmed_by_user_id: string | null;
  run_id: string | null;
  issue_id: string | null;
  agent_id: string | null;
  runtime_id: string | null;
  relation_kind: string;
  agenda_reference_id: string | null;
}

export interface CockpitDirectoryGrant {
  kind: string;
  command_key: string;
  revision: number;
  responsible_user_id: string;
  principal: CockpitDirectoryPrincipal;
  target_hash: string;
  root_config_hash: string;
  accepted_at: string;
  observed_binding: CockpitDirectoryBinding;
}

export interface CockpitDirectoryTarget {
  root_id: string;
  root_path: string;
  prepare_subpath: string;
  relative_directory: string;
  directory: string;
  target_hash: string;
  root_config_hash: string;
}

export interface CockpitDirectoryBinding {
  nas_dir: string;
  revision: number;
}

export interface CockpitDirectoryRootMetadata {
  root_id: string;
  root_path: string;
  prepare_subpath_count: number;
}

export interface CockpitDirectoryRootDetail extends CockpitDirectoryRootMetadata {
  workspace_id: string;
  prepare_subpaths: Array<string>;
}

export interface CockpitDirectoryRootPage {
  workspace_id: string;
  page_size: number;
  items: Array<CockpitDirectoryRootMetadata>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitDirectoryCapabilities {
  available: boolean;
  can_preview: boolean;
  can_create: boolean;
}

export interface CockpitDirectorySummary {
  workspace_id: string;
  meeting_id: string;
  generated_at: string;
  binding: CockpitDirectoryBinding;
  binding_candidate: CockpitDirectoryTarget | null;
  binding_candidate_reason: string;
  capabilities: CockpitDirectoryCapabilities;
  blocked_reasons: Array<string>;
  current: CockpitDirectoryOperationHeader | null;
  history_total: number;
  unfinished_total: number;
  needs_attention_total: number;
}

export interface CockpitDirectoryCounts {
  total: number;
  pending: number;
  running: number;
  retry_wait: number;
  satisfied: number;
  needs_attention: number;
  abandoned: number;
}

export interface CockpitDirectoryOperationHeader {
  workspace_id: string;
  meeting_id: string;
  id: string;
  revision: number;
  state: string;
  command_key: string;
  request_hash: string;
  plan_hash: string;
  target: CockpitDirectoryTarget;
  created_by_type: string;
  created_by: string;
  created_by_name: string;
  source_principal: CockpitDirectoryPrincipal;
  responsible_user_id: string;
  responsible_user_name: string;
  last_grant: CockpitDirectoryGrant;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  observed_binding: CockpitDirectoryBinding;
  accepted_binding_revision: number | null;
  bind_after_base: boolean;
  binding_result: string;
  counts: CockpitDirectoryCounts;
  can_retry: boolean;
  can_pause: boolean;
  can_resume: boolean;
  can_claim: boolean;
  can_abandon: boolean;
  blocked_reasons: Array<string>;
}

export interface CockpitDirectoryOperationPage {
  workspace_id: string;
  meeting_id: string;
  page_size: number;
  items: Array<CockpitDirectoryOperationHeader>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitDirectoryStepMetadata {
  id: string;
  operation_id: string;
  position: number;
  kind: string;
  label: string;
  relative_path: string;
  state: string;
  revision: number;
  grant_command_key: string;
  grant_revision: number;
  attempt_count: number;
  last_attempt_id: string | null;
  last_observed_at: string | null;
  outcome: string | null;
  last_error_code: string;
  can_retry: boolean;
  blocked_reasons: Array<string>;
}

export interface CockpitDirectoryStepPage {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  items: Array<CockpitDirectoryStepMetadata>;
  total: number;
  counts: CockpitDirectoryCounts;
}

export interface CockpitDirectoryAttemptMetadata {
  id: string;
  step_id: string;
  attempt_number: number;
  state: string;
  started_at: string;
  finished_at: string | null;
  error_code: string;
  outcome: string | null;
  observed_at: string | null;
}

export interface CockpitDirectoryObservation {
  directory: string;
  directory_identity: string;
  root_identity: string;
  outcome: string;
  observed_at: string;
}

export interface CockpitDirectoryAttemptDetail extends CockpitDirectoryAttemptMetadata {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  grant_command_key: string;
  grant_revision: number;
  error_message: string;
  receipt: CockpitDirectoryObservation | null;
  late_receipt: CockpitDirectoryObservation | null;
  late_observed_at: string | null;
}

export interface CockpitDirectoryAttemptPage {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  step_id: string;
  page_size: number;
  items: Array<CockpitDirectoryAttemptMetadata>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitDirectoryPreviewInput {
  mode: "prepare" | "repair";
  root_id: string;
  relative_directory: string;
  partitions: Array<string>;
  observed_nas_dir: string;
  observed_binding_revision: number;
  bind_after_base: boolean;
}

export interface CockpitDirectoryPreviewStep {
  step_id: string | null;
  position: number;
  parent_position: number | null;
  kind: string;
  label: string;
  relative_path: string;
  path_hash: string;
  planned_state: string;
  error_code: string;
}

export interface CockpitDirectoryPreviewCounts {
  total: number;
  exists: number;
  missing: number;
  conflict: number;
  unknown: number;
}

export interface CockpitDirectoryPreview {
  workspace_id: string;
  meeting_id: string;
  target: CockpitDirectoryTarget;
  plan_hash: string;
  observed_binding: CockpitDirectoryBinding;
  bind_after_base: boolean;
  steps: Array<CockpitDirectoryPreviewStep>;
  counts: CockpitDirectoryPreviewCounts;
  context_token: string;
  can_confirm: boolean;
  blocked_reasons: Array<string>;
  checked_at: string;
  principal: CockpitDirectoryPrincipal | null;
}

export interface CockpitDirectoryCreateInput extends CockpitDirectoryPreviewInput {
  command_key: string;
  expected_revision: number;
  context_token: string;
}

export interface CockpitDirectoryRetryPreviewInput {
  step_ids: Array<string>;
}

export interface CockpitDirectoryRetryPreview extends CockpitDirectoryPreview {
  operation_id: string;
  operation_revision: number;
  step_ids: Array<string>;
}

export interface CockpitDirectoryRetryInput {
  command_key: string;
  expected_revision: number;
  step_ids: Array<string>;
  context_token: string;
  reason: string;
}

export interface CockpitDirectoryControlInput {
  command_key: string;
  expected_revision: number;
  transition: string;
  reason: string;
}

export interface CockpitDirectoryCommandReceipt {
  directory_operation_id: string;
  directory_step_ids: Array<string>;
  request_hash: string;
  context_token: string | null;
  plan_hash: string;
  target: CockpitDirectoryTarget;
  observed_binding: CockpitDirectoryBinding;
  bind_after_base: boolean;
  operation_revision: number;
  state: string;
  responsible_user_id: string;
  authorized_at: string;
  reason: string;
  principal: CockpitDirectoryPrincipal;
  grant: CockpitDirectoryGrant;
}

export interface CockpitDirectoryCommandResult {
  workspace_id: string;
  meeting_id: string;
  command_key: string;
  action: string;
  replayed: boolean;
  receipt: CockpitDirectoryCommandReceipt;
  current: CockpitDirectoryOperationHeader;
}

export interface CockpitMeetingDirectoryPageQuery { page_size?: number; cursor?: string }

export interface CockpitDirectoryCancellationImpact {
  unfinished_total: number;
  will_pause_total: number;
  sample_operation_ids: string[];
  facts_hash: string;
}
export interface CockpitDirectoryCancellationEffect {
  paused_total: number;
  sample_operation_ids: string[];
  facts_hash: string;
}
