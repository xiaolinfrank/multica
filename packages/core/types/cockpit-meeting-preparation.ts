import type { CockpitDirectoryCancellationImpact, CockpitDirectoryCancellationEffect } from "./cockpit-meeting-directory";
import type { CockpitTask } from "./cockpit";
import type { IssueOperationField, IssueOperationTarget } from "./issue-operation-basis";
import type { CockpitLifecycleCommandInput, CockpitOccurrenceView, CockpitLifecyclePageQuery } from "./cockpit-meeting-lifecycle";

export interface CockpitPreparationPreviewEffect {
  slot_id: string;
  kind: string;
  label: string;
  selected: boolean;
  allowed: boolean;
  reason_codes: Array<string>;
  targets: Array<IssueOperationTarget>;
  issue_impact: CockpitDispositionIssue | null;
  scope: CockpitPreparationResolvedScope | null;
}

export interface CockpitPreparationCounts {
  total: number;
  pending: number;
  applied: number;
  needs_attention: number;
  skipped: number;
}

export interface CockpitPreparationOperationHeader {
  workspace_id: string;
  meeting_id: string;
  id: string;
  kind: string;
  revision: number;
  state: string;
  command_key: string;
  created_by: string;
  created_by_name: string;
  responsible_user_id: string;
  created_at: string;
  updated_at: string;
  counts: CockpitPreparationCounts;
  can_continue: boolean;
  can_resume: boolean;
  can_pause: boolean;
  can_claim: boolean;
  blocked_reasons: Array<string>;
  responsible_user_name: string;
}

export interface CockpitPreparationEffectReceipt {
  effect_id: string;
  command_key: string;
  request_hash: string;
  kind: string;
  issue_id: string | null;
  run_id: string | null;
  issue: CockpitTask | null;
  run_status: string | null;
  stopped_wakeup_ids: Array<string>;
  cancelled_queue_ids: Array<string>;
  applied_at: string;
  authorization_key: string;
  authorization_revision: number;
  changed: boolean;
  stopped_wakeup_total: number;
  cancelled_queue_total: number;
  facts_hash: string;
  target_meeting_id: string | null;
}

export interface CockpitPreparationEffect {
  id: string;
  operation_id: string;
  slot_id: string;
  position: number;
  kind: string;
  label: string;
  revision: number;
  state: string;
  command_key: string;
  dependency_id: string | null;
  error_code: string;
  reason: string;
  targets: Array<IssueOperationTarget>;
  receipt: CockpitPreparationEffectReceipt | null;
  can_apply: boolean;
  can_skip: boolean;
  can_reauthorize: boolean;
  authorization_key: string;
  authorization_revision: number;
}

export interface CockpitPreparationEffectPage {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  revision: number;
  page_size: number;
  items: Array<CockpitPreparationEffect>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitPreparationOperationPage {
  workspace_id: string;
  meeting_id: string;
  page_size: number;
  items: Array<CockpitPreparationOperationHeader>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitPreparationEffectApplyInput {
  command_key: string;
  authorization_key: string;
  authorization_revision: number;
}

export interface CockpitPreparationControlInput extends CockpitLifecycleCommandInput {
  transition: string;
  effect_id: string | null;
  reason: string;
}

export interface CockpitPreparationCommandReceipt {
  directory_effect?: CockpitDirectoryCancellationEffect | null;
  operation_id: string;
  kind: string;
  revision: number;
  state: string;
  effect_ids: Array<string>;
  effect_id: string | null;
  reason: string;
  request_hash: string;
  occurrence: CockpitOccurrenceView | null;
  context_token: string;
  authorization: CockpitPreparationAuthorization | null;
  previous_authorization: CockpitPreparationAuthorization | null;
}

export interface CockpitPreparationCommandResult {
  workspace_id: string;
  meeting_id: string;
  command_key: string;
  action: string;
  replayed: boolean;
  receipt: CockpitPreparationCommandReceipt;
  current: CockpitPreparationOperationHeader;
}

export interface CockpitPreparationEffectResult {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  effect_id: string;
  command_key: string;
  replayed: boolean;
  receipt: CockpitPreparationEffectReceipt;
  current: CockpitPreparationOperationHeader;
}

export interface CockpitPreparationEffectDetail {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  effect: CockpitPreparationEffect;
  current: CockpitPreparationOperationHeader;
}

export interface CockpitPreparationAuthorization {
  key: string;
  revision: number;
  context_token: string;
  facts_hash: string;
  confirmed_by: string;
  confirmed_at: string;
  impact: CockpitDispositionIssue | null;
  selected_run: CockpitDispositionRun | null;
  scope: CockpitPreparationResolvedScope | null;
}

export interface CockpitPreparationReauthorizationPreview {
  workspace_id: string;
  meeting_id: string;
  operation_id: string;
  effect_id: string;
  effect_revision: number;
  command_key: string;
  fixed_intent_hash: string;
  context_token: string;
  previous_authorization: CockpitPreparationAuthorization;
  current_impact: CockpitDispositionIssue | null;
  targets: Array<IssueOperationTarget>;
  can_confirm: boolean;
  blocked_reasons: Array<string>;
  current_run: CockpitDispositionRun | null;
  current_scope: CockpitPreparationResolvedScope | null;
}

export interface CockpitPreparationReauthorizationInput extends CockpitLifecycleCommandInput {
  context_token: string;
  reason: string;
}

export interface CockpitPreparationResolvedScope {
  node_id: string | null;
  node_title: string;
  project_id: string | null;
  project_title: string;
  module_id: string | null;
  module_title: string;
}

export interface CockpitDispositionIssue {
  issue: CockpitTask;
  issue_revision: number;
  can_cancel: boolean;
  can_change_due_date: boolean;
  can_link_meeting: boolean;
  cancel_status: string | null;
  blocked_reasons: Array<string>;
  ordinary_wakeup_count: number;
  system_rule_count: number;
  unstarted_wakeup_run_count: number;
  other_queued_run_count: number;
  active_run_count: number;
  targets: Array<IssueOperationTarget>;
  targets_total: number;
  parent_issue_id: string | null;
  evaluates_parent_rules: boolean;
}

export interface CockpitCancellationImpactPage {
  workspace_id: string;
  meeting_id: string;
  lifecycle_revision: number;
  q: string;
  page_size: number;
  items: Array<CockpitDispositionIssue>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitDispositionRun {
  id: string;
  issue_id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  started_at: string | null;
  is_wakeup: boolean;
  can_stop: boolean;
  blocked_reasons: Array<string>;
}

export interface CockpitDispositionRunPage {
  workspace_id: string;
  meeting_id: string;
  issue_id: string;
  page_size: number;
  items: Array<CockpitDispositionRun>;
  total: number;
  next_cursor: string | null;
}

export interface CockpitCancellationIssueChoice {
  issue_id: string;
  expected_revision: number;
  action: string;
  cancel_status: string | null;
  due_date: string | null;
  target_meeting_id: string | null;
}

export interface CockpitCancellationPreviewInput {
  reason: string;
  issues: Array<CockpitCancellationIssueChoice>;
  run_ids: Array<string>;
}

export interface CockpitCancellationPreview {
  directory_impact?: CockpitDirectoryCancellationImpact | null;
  intent: string;
  workspace_id: string;
  meeting_id: string;
  lifecycle_revision: number;
  context_token: string;
  occurrence: CockpitOccurrenceView;
  affected_issue_total: number;
  unselected_issue_total: number;
  active_run_total: number;
  unselected_run_total: number;
  effects: Array<CockpitPreparationPreviewEffect>;
  selected_total: number;
  can_confirm: boolean;
  blocked_reasons: Array<string>;
}

export interface CockpitCancellationInput extends CockpitLifecycleCommandInput, CockpitCancellationPreviewInput {
  context_token: string;
}

export interface CockpitMeetingDispositionInput extends CockpitLifecycleCommandInput {
  transition: string;
  reason: string;
}

export interface CockpitMeetingArchiveView {
  archived_at: string | null;
  archived_by: string | null;
  reason: string;
}

export interface CockpitMeetingPendingCounts {
  directory_operations?: number;
  minutes_review: number;
  draft_actions: number;
  active_preparation_issues: number;
  active_runs: number;
  nas_operations: number;
  preparation_operations: number;
}

export interface CockpitMeetingOperationBasis {
  append_disposition: IssueOperationField;
  workspace_id: string;
  meeting_id: string;
  schema_version: number;
  generated_at: string;
  availability: string;
  lifecycle_revision: number | null;
  delete: IssueOperationField;
  cancel: IssueOperationField;
  reinstate: IssueOperationField;
  archive: IssueOperationField;
  unarchive: IssueOperationField;
  pending: CockpitMeetingPendingCounts;
  current_operation: CockpitPreparationOperationHeader | null;
  targets: Array<IssueOperationTarget>;
  targets_total: number;
}

export interface CockpitCancellationImpactQuery extends CockpitLifecyclePageQuery { q?: string }
export type CockpitPreparationControlTransition = "pause" | "resume" | "skip" | "claim";
export type CockpitMeetingDispositionTransition = "reinstate" | "archive" | "unarchive";
export type CockpitPreparationCommandAction = "cancel" | "preparation_dispose" | "preparation_reauthorize" | "preparation_pause" | "preparation_resume" | "preparation_skip" | "preparation_claim";
