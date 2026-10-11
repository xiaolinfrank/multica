import { z } from "zod";
import { CockpitTaskSchema } from "./schemas";
import { IssueOperationFieldSchema, IssueOperationTargetSchema } from "./issue-operation-basis-schemas";
import { CockpitOccurrenceSchema } from "./cockpit-meeting-common-schemas";
const id = z.string().min(1);
const commandKey = z.string().uuid();
const revision = z.number().int().positive();
const count = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.boolean().catch(false).default(false);
const effectKinds = new Set(["agenda", "preparation_issue", "issue_reference", "material_reference", "cancel_issue", "change_due_date", "link_meeting", "stop_run"]);
const effectStates = new Set(["pending", "applied", "needs_attention", "skipped"]);
const operationKinds = new Set(["apply_template", "cancel_preparation"]);
const operationStates = new Set(["active", "paused", "needs_attention", "completed"]);
function distinct(rows: Array<{ id: string }>) { return new Set(rows.map((row) => row.id)).size === rows.length; }

export const CockpitTemplateAgendaDefaultsSchema = z.object({
  title: z.string(),
  purposes: z.array(z.string()).max(100),
  desired_outcome: z.string(),
  notes: z.string(),
});

export const CockpitTemplateIssueDefaultsSchema = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.string(),
});

export const CockpitMeetingTemplateSlotSchema = z.object({
  slot_id: id,
  kind: z.string(),
  label: z.string(),
  agenda_slot_id: id.nullable(),
  agenda: CockpitTemplateAgendaDefaultsSchema.nullable(),
  new_issue: CockpitTemplateIssueDefaultsSchema.nullable(),
  purpose: z.string(),
});

export const CockpitMeetingTemplateConfigSchema = z.object({
  schema_version: revision,
  slots: z.array(CockpitMeetingTemplateSlotSchema).max(50),
})
  .refine((v) => v.slots.length > 0 && new Set(v.slots.map((s) => s.slot_id)).size === v.slots.length);

export const CockpitMeetingTemplateVersionMetadataSchema = z.object({
  id: id,
  template_id: id,
  number: revision,
  title: z.string(),
  active: z.boolean(),
  slot_count: count,
  config_hash: digest,
  command_key: commandKey,
  created_by: z.string(),
  created_by_name: z.string(),
  created_at: timestamp,
});

export const CockpitMeetingTemplateHeaderSchema = z.object({
  workspace_id: id,
  id: id,
  revision: revision,
  title: z.string(),
  description: z.string(),
  active: z.boolean(),
  created_by: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  current_version: CockpitMeetingTemplateVersionMetadataSchema,
  can_edit: capability,
})
  .refine((v) => v.current_version.template_id === v.id && v.current_version.title === v.title && v.current_version.active === v.active);

export const CockpitMeetingTemplateVersionDetailSchema = z.object({
  ...CockpitMeetingTemplateVersionMetadataSchema.shape,
  workspace_id: id,
  description: z.string(),
  config: CockpitMeetingTemplateConfigSchema,
})
  .refine((v) => v.slot_count === v.config.slots.length);

export const CockpitMeetingTemplatePageSchema = z.object({
  workspace_id: id,
  q: z.string(),
  include_inactive: z.boolean(),
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitMeetingTemplateHeaderSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
  can_create: capability,
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && distinct(v.items) && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0))
  .refine((v) => v.items.every((i) => i.workspace_id === v.workspace_id));

export const CockpitMeetingTemplateVersionPageSchema = z.object({
  workspace_id: id,
  template_id: id,
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitMeetingTemplateVersionMetadataSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && distinct(v.items) && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0))
  .refine((v) => v.items.every((i) => i.template_id === v.template_id));

export const CockpitMeetingTemplateSaveResultSchema = z.object({
  workspace_id: id,
  template_id: id,
  command_key: commandKey,
  request_hash: digest,
  replayed: z.boolean(),
  receipt: CockpitMeetingTemplateVersionDetailSchema,
  current: CockpitMeetingTemplateHeaderSchema,
})
  .refine((v) => v.receipt.workspace_id === v.workspace_id && v.receipt.template_id === v.template_id && v.receipt.command_key === v.command_key && v.current.workspace_id === v.workspace_id && v.current.id === v.template_id);

export const CockpitDispositionIssueSchema = z.object({
  issue: CockpitTaskSchema,
  issue_revision: revision,
  can_cancel: capability,
  can_change_due_date: capability,
  can_link_meeting: capability,
  cancel_status: z.string().nullable(),
  blocked_reasons: z.array(z.string()).max(100),
  ordinary_wakeup_count: count,
  system_rule_count: count,
  unstarted_wakeup_run_count: count,
  other_queued_run_count: count,
  active_run_count: count,
  agenda_total: count,
  targets: z.array(IssueOperationTargetSchema).max(3),
  targets_total: count,
  parent_issue_id: id.nullable(),
  evaluates_parent_rules: z.boolean(),
})
  .refine((v) => v.targets_total >= v.targets.length && (!v.evaluates_parent_rules || v.parent_issue_id !== null));

export const CockpitPreparationResolvedScopeSchema = z.object({
  node_id: id.nullable(),
  node_title: z.string(),
  project_id: id.nullable(),
  project_title: z.string(),
  module_id: id.nullable(),
  module_title: z.string(),
});

export const CockpitPreparationPreviewEffectSchema = z.object({
  slot_id: id,
  kind: z.string(),
  label: z.string(),
  agenda_slot_id: id.nullable(),
  selected: z.boolean(),
  allowed: capability,
  reason_codes: z.array(z.string()).max(100),
  targets: z.array(IssueOperationTargetSchema).max(3),
  issue_impact: CockpitDispositionIssueSchema.nullable(),
  scope: CockpitPreparationResolvedScopeSchema.nullable(),
});

export const CockpitTemplateApplicationPreviewSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  template_id: id,
  template_version_id: id,
  lifecycle_revision: revision,
  agenda_revision: revision,
  context_token: z.string(),
  config_hash: digest,
  effects: z.array(CockpitPreparationPreviewEffectSchema).max(50),
  selected_total: count,
  can_confirm: capability,
  blocked_reasons: z.array(z.string()).max(100),
})
  .refine((v) => (!v.can_confirm || v.context_token.trim().length > 0) && v.selected_total === v.effects.filter((e) => e.selected).length && new Set(v.effects.map((e) => e.slot_id)).size === v.effects.length)
  .transform((v) => ({ ...v, can_confirm: v.can_confirm && v.selected_total > 0 && v.effects.every((e) => !e.selected || e.allowed && effectKinds.has(e.kind)) }));

export const CockpitPreparationCountsSchema = z.object({
  total: count,
  pending: count,
  applied: count,
  needs_attention: count,
  skipped: count,
})
  .refine((v) => v.total <= 50 && v.total === v.pending + v.applied + v.needs_attention + v.skipped);

export const CockpitPreparationOperationHeaderSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  id: id,
  kind: z.string(),
  revision: revision,
  state: z.string(),
  command_key: commandKey,
  template_id: id.nullable(),
  template_version_id: id.nullable(),
  created_by: z.string(),
  created_by_name: z.string(),
  responsible_user_id: id,
  created_at: timestamp,
  updated_at: timestamp,
  counts: CockpitPreparationCountsSchema,
  can_continue: capability,
  can_resume: capability,
  can_pause: capability,
  can_claim: capability,
  blocked_reasons: z.array(z.string()).max(100),
  template_title: z.string().catch("").default(""),
  template_version_number: z.number().int().positive().nullable().catch(null).default(null),
  responsible_user_name: z.string().catch("").default(""),
})
  .refine((v) => v.state !== "completed" || v.counts.pending === 0 && v.counts.needs_attention === 0)
  .transform((v) => operationKinds.has(v.kind) && operationStates.has(v.state) ? v : { ...v, can_continue: false, can_resume: false, can_pause: false, can_claim: false });

export const CockpitPreparationEffectReceiptSchema = z.object({
  effect_id: id,
  command_key: commandKey,
  request_hash: digest,
  kind: z.string(),
  agenda_id: id.nullable(),
  reference_id: id.nullable(),
  issue_id: id.nullable(),
  run_id: id.nullable(),
  issue: CockpitTaskSchema.nullable(),
  run_status: z.string().nullable(),
  stopped_wakeup_ids: z.array(z.string()).max(100),
  cancelled_queue_ids: z.array(z.string()).max(100),
  applied_at: timestamp,
  authorization_key: commandKey,
  authorization_revision: revision,
  changed: z.boolean(),
  stopped_wakeup_total: count,
  cancelled_queue_total: count,
  facts_hash: digest,
  target_meeting_id: id.nullable(),
})
  .refine((v) => (v.kind !== "link_meeting" || Boolean(v.target_meeting_id && v.agenda_id && v.reference_id && v.issue_id)) && v.stopped_wakeup_total >= v.stopped_wakeup_ids.length && v.cancelled_queue_total >= v.cancelled_queue_ids.length && new Set(v.stopped_wakeup_ids).size === v.stopped_wakeup_ids.length && new Set(v.cancelled_queue_ids).size === v.cancelled_queue_ids.length && (v.kind !== "stop_run" || Boolean(v.run_id) && ["completed", "failed", "cancelled"].includes(v.run_status ?? "") && (!v.changed || v.run_status === "cancelled")) && (!v.issue || v.issue.id === v.issue_id) && (v.kind !== "preparation_issue" || Boolean(v.issue_id && v.reference_id && v.agenda_id && v.issue?.status === "backlog")));

export const CockpitPreparationEffectSchema = z.object({
  id: id,
  operation_id: id,
  slot_id: id,
  position: count,
  kind: z.string(),
  label: z.string(),
  revision: revision,
  state: z.string(),
  command_key: commandKey,
  dependency_id: id.nullable(),
  error_code: z.string(),
  reason: z.string(),
  targets: z.array(IssueOperationTargetSchema).max(3),
  receipt: CockpitPreparationEffectReceiptSchema.nullable(),
  can_apply: capability,
  can_skip: capability,
  can_reauthorize: capability,
  authorization_key: commandKey,
  authorization_revision: revision,
})
  .refine((v) => (!v.receipt || v.receipt.effect_id === v.id && v.receipt.command_key === v.command_key && v.receipt.kind === v.kind && v.receipt.authorization_key === v.authorization_key && v.receipt.authorization_revision === v.authorization_revision) && (v.state !== "applied" || v.receipt !== null))
  .transform((v) => effectKinds.has(v.kind) && effectStates.has(v.state) ? v : { ...v, can_apply: false, can_skip: false, can_reauthorize: false });

export const CockpitPreparationEffectPageSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  operation_id: id,
  revision: revision,
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitPreparationEffectSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && distinct(v.items) && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0))
  .refine((v) => v.items.every((i) => i.operation_id === v.operation_id));

export const CockpitPreparationOperationPageSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitPreparationOperationHeaderSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && distinct(v.items) && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0))
  .refine((v) => v.items.every((i) => i.workspace_id === v.workspace_id && i.meeting_id === v.meeting_id));

export const CockpitDispositionRunSchema = z.object({
  id: id,
  issue_id: id,
  agent_id: id,
  agent_name: z.string(),
  status: z.string(),
  started_at: timestamp.nullable(),
  is_wakeup: z.boolean(),
  can_stop: capability,
  blocked_reasons: z.array(z.string()).max(100),
})
  .transform((v) => ["queued", "deferred", "dispatched", "running", "waiting_local_directory", "completed", "failed", "cancelled"].includes(v.status) ? v : { ...v, can_stop: false });

export const CockpitPreparationAuthorizationSchema = z.object({
  key: commandKey,
  revision: revision,
  context_token: z.string(),
  facts_hash: digest,
  confirmed_by: z.string(),
  confirmed_at: timestamp,
  impact: CockpitDispositionIssueSchema.nullable(),
  selected_run: CockpitDispositionRunSchema.nullable(),
  scope: CockpitPreparationResolvedScopeSchema.nullable(),
})
  .refine((v) => !v.selected_run || !v.impact || v.selected_run.issue_id === v.impact.issue.id);

export const CockpitPreparationCommandReceiptSchema = z.object({
  operation_id: id,
  kind: z.string(),
  revision: revision,
  state: z.string(),
  effect_ids: z.array(z.string()).max(50),
  effect_id: id.nullable(),
  reason: z.string(),
  request_hash: digest,
  occurrence: CockpitOccurrenceSchema.nullable(),
  context_token: z.string(),
  template_version_id: id.nullable(),
  authorization: CockpitPreparationAuthorizationSchema.nullable(),
  previous_authorization: CockpitPreparationAuthorizationSchema.nullable(),
})
  .refine((v) => new Set(v.effect_ids).size === v.effect_ids.length && (!v.effect_id || v.effect_ids.includes(v.effect_id)) && ((!v.authorization && !v.previous_authorization) || Boolean(v.authorization && v.previous_authorization && v.effect_id && v.authorization.revision === v.previous_authorization.revision + 1)));

export const CockpitPreparationCommandResultSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  command_key: commandKey,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitPreparationCommandReceiptSchema,
  current: CockpitPreparationOperationHeaderSchema,
})
  .refine((v) => v.receipt.operation_id === v.current.id && v.current.workspace_id === v.workspace_id && v.current.meeting_id === v.meeting_id);

export const CockpitPreparationEffectResultSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  operation_id: id,
  effect_id: id,
  command_key: commandKey,
  replayed: z.boolean(),
  receipt: CockpitPreparationEffectReceiptSchema,
  current: CockpitPreparationOperationHeaderSchema,
})
  .refine((v) => v.receipt.effect_id === v.effect_id && v.receipt.command_key === v.command_key && v.current.id === v.operation_id && v.current.meeting_id === v.meeting_id && v.current.workspace_id === v.workspace_id);

export const CockpitPreparationEffectDetailSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  operation_id: id,
  effect: CockpitPreparationEffectSchema,
  current: CockpitPreparationOperationHeaderSchema,
})
  .refine((v) => v.effect.operation_id === v.operation_id && v.current.id === v.operation_id && v.current.meeting_id === v.meeting_id && v.current.workspace_id === v.workspace_id);

export const CockpitPreparationReauthorizationPreviewSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  operation_id: id,
  effect_id: id,
  effect_revision: revision,
  command_key: commandKey,
  fixed_intent_hash: digest,
  context_token: z.string(),
  previous_authorization: CockpitPreparationAuthorizationSchema,
  current_impact: CockpitDispositionIssueSchema.nullable(),
  targets: z.array(IssueOperationTargetSchema).max(3),
  can_confirm: capability,
  blocked_reasons: z.array(z.string()).max(100),
  current_run: CockpitDispositionRunSchema.nullable(),
  current_scope: CockpitPreparationResolvedScopeSchema.nullable(),
})
  .refine((v) => (!v.can_confirm || v.context_token.trim().length > 0) && (!v.previous_authorization.selected_run || !v.current_run || v.previous_authorization.selected_run.id === v.current_run.id) && (!v.previous_authorization.impact || !v.current_impact || v.previous_authorization.impact.issue.id === v.current_impact.issue.id));

export const CockpitCancellationImpactPageSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  lifecycle_revision: revision,
  q: z.string(),
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitDispositionIssueSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && new Set(v.items.map((i) => i.issue.id)).size === v.items.length && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0));

export const CockpitDispositionRunPageSchema = z.object({
  workspace_id: id,
  meeting_id: id,
  issue_id: id,
  page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitDispositionRunSchema).max(100),
  total: count,
  next_cursor: z.string().nullable(),
})
  .refine((v) => v.items.length <= v.page_size && v.items.length <= v.total && distinct(v.items) && (v.next_cursor === null || v.next_cursor.length > 0 && v.items.length > 0))
  .refine((v) => v.items.every((i) => i.issue_id === v.issue_id));

export const CockpitCancellationPreviewSchema = z.object({
  intent: z.string(),
  workspace_id: id,
  meeting_id: id,
  lifecycle_revision: revision,
  context_token: z.string(),
  occurrence: CockpitOccurrenceSchema,
  affected_issue_total: count,
  unselected_issue_total: count,
  active_run_total: count,
  unselected_run_total: count,
  effects: z.array(CockpitPreparationPreviewEffectSchema).max(50),
  selected_total: count,
  can_confirm: capability,
  blocked_reasons: z.array(z.string()).max(100),
})
  .refine((v) => (!v.can_confirm || v.context_token.trim().length > 0) && v.selected_total === v.effects.filter((e) => e.selected).length && v.unselected_issue_total <= v.affected_issue_total && v.unselected_run_total <= v.active_run_total)
  .transform((v) => ({ ...v, can_confirm: v.can_confirm && ((v.intent === "cancel" && ["unconfirmed", "scheduled"].includes(v.occurrence.state)) || (v.intent === "append_disposition" && v.occurrence.state === "cancelled")) && v.effects.every((e) => !e.selected || e.allowed && effectKinds.has(e.kind)) }));

export const CockpitMeetingPendingCountsSchema = z.object({
  minutes_review: count,
  draft_actions: count,
  active_preparation_issues: count,
  active_runs: count,
  nas_operations: count,
  preparation_operations: count,
});

export const CockpitMeetingOperationBasisSchema = z.object({
  append_disposition: IssueOperationFieldSchema,
  workspace_id: id,
  meeting_id: id,
  schema_version: revision,
  generated_at: timestamp,
  availability: z.string(),
  lifecycle_revision: revision.nullable(),
  delete: IssueOperationFieldSchema,
  cancel: IssueOperationFieldSchema,
  reinstate: IssueOperationFieldSchema,
  archive: IssueOperationFieldSchema,
  unarchive: IssueOperationFieldSchema,
  add_preparation: IssueOperationFieldSchema,
  apply_template: IssueOperationFieldSchema,
  can_add_preparation: capability,
  pending: CockpitMeetingPendingCountsSchema,
  current_operation: CockpitPreparationOperationHeaderSchema.nullable(),
  targets: z.array(IssueOperationTargetSchema).max(3),
  targets_total: count,
})
  .refine((v) => v.schema_version === 1 && v.targets_total >= v.targets.length)
  .transform((v) => v.availability === "available" ? { ...v, can_add_preparation: v.can_add_preparation && v.add_preparation.state === "allowed" } : { ...v, can_add_preparation: false, delete: { state: "unknown" as const, reason_codes: v.delete.reason_codes }, cancel: { state: "unknown" as const, reason_codes: v.cancel.reason_codes }, reinstate: { state: "unknown" as const, reason_codes: v.reinstate.reason_codes }, archive: { state: "unknown" as const, reason_codes: v.archive.reason_codes }, unarchive: { state: "unknown" as const, reason_codes: v.unarchive.reason_codes }, add_preparation: { state: "unknown" as const, reason_codes: v.add_preparation.reason_codes }, apply_template: { state: "unknown" as const, reason_codes: v.apply_template.reason_codes }, append_disposition: { state: "unknown" as const, reason_codes: v.append_disposition.reason_codes } });
