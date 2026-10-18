import { z } from "zod";

const id = z.string().min(1);
const key = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive();
const count = z.number().int().nonnegative();
const time = z.string().datetime({ offset: true });
const capability = z.boolean().catch(false).default(false);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const operationStates = new Set(["active", "paused", "needs_attention", "completed", "abandoned"]);
const stepStates = new Set(["pending", "running", "retry_wait", "satisfied", "needs_attention", "abandoned"]);
const knownPrincipal = (value: { source: string; actor_type: string }) => value.source === "human" && value.actor_type === "member"
  || value.source === "task_token" && value.actor_type === "agent";

export const CockpitDirectoryPrincipalSchema = z.object({
  source: z.string(), actor_type: z.string(), actor_id: id, actor_name: z.string().default(""),
  credential_owner_user_id: id, authorizing_user_id: id, authorizing_user_name: z.string().default(""),
  confirmed_by_user_id: id.nullable(), run_id: id.nullable(), issue_id: id.nullable(), agent_id: id.nullable(),
  runtime_id: id.nullable(), relation_kind: z.string(), agenda_reference_id: id.nullable(),
}).refine((p) => {
  if (p.source === "human") return p.actor_type === "member" && p.actor_id === p.credential_owner_user_id
    && p.actor_id === p.authorizing_user_id && p.actor_id === p.confirmed_by_user_id && p.relation_kind === "none"
    && [p.run_id, p.issue_id, p.agent_id, p.runtime_id, p.agenda_reference_id].every((value) => value === null);
  if (p.source === "task_token") return p.actor_type === "agent" && p.actor_id === p.agent_id
    && p.confirmed_by_user_id === null && Boolean(p.run_id && p.issue_id && p.agent_id && p.runtime_id)
    && ["work_package", "agenda_preparation", "direct_preparation", "legacy_task"].includes(p.relation_kind)
    && (p.relation_kind === "agenda_preparation" ? p.agenda_reference_id !== null : p.agenda_reference_id === null);
  return true;
}, "Directory authorization must distinguish the actor, credential owner and delegating member");

export const CockpitDirectoryBindingSchema = z.object({ nas_dir: z.string(), revision });

export const CockpitDirectoryGrantSchema = z.object({
  kind: z.string(), command_key: key, revision, responsible_user_id: id, principal: CockpitDirectoryPrincipalSchema,
  target_hash: hash, root_config_hash: hash, accepted_at: time, observed_binding: CockpitDirectoryBindingSchema,
}).refine((grant) => grant.kind !== "human" || grant.principal.source === "human")
  .refine((grant) => grant.kind !== "delegated_task" || grant.principal.source === "task_token");

export const CockpitDirectoryTargetSchema = z.object({
  root_id: id, root_path: z.string().min(1), prepare_subpath: z.string().min(1), relative_directory: z.string().min(1),
  directory: z.string().min(1), target_hash: hash, root_config_hash: hash,
});

export const CockpitDirectoryRootMetadataSchema = z.object({ root_id: id, root_path: z.string().min(1), prepare_subpath_count: count.max(32) });
export const CockpitDirectoryRootDetailSchema = CockpitDirectoryRootMetadataSchema.extend({
  workspace_id: id, prepare_subpaths: z.array(z.string().min(1)).max(32),
}).refine((root) => root.prepare_subpaths.length === root.prepare_subpath_count && unique(root.prepare_subpaths));
const pageFields = { page_size: z.number().int().min(1).max(100), total: count, next_cursor: id.nullable() };
function validPage(page: { page_size: number; total: number; items: readonly unknown[]; next_cursor: string | null }) {
  return page.items.length <= page.page_size && page.items.length <= page.total && (!page.next_cursor || page.items.length > 0);
}
export const CockpitDirectoryRootPageSchema = z.object({
  workspace_id: id, ...pageFields, items: z.array(CockpitDirectoryRootMetadataSchema).max(100),
}).refine((page) => validPage(page) && unique(page.items.map((item) => item.root_id)));

export const CockpitDirectoryCountsSchema = z.object({
  total: count.max(32), pending: count, running: count, retry_wait: count, satisfied: count, needs_attention: count, abandoned: count,
}).refine((c) => c.pending + c.running + c.retry_wait + c.satisfied + c.needs_attention + c.abandoned === c.total);

export const CockpitDirectoryOperationHeaderSchema = z.object({
  workspace_id: id, meeting_id: id, id, revision, state: z.string(), command_key: key, request_hash: hash, plan_hash: hash,
  target: CockpitDirectoryTargetSchema, created_by_type: z.string(), created_by: id, created_by_name: z.string().default(""),
  source_principal: CockpitDirectoryPrincipalSchema, responsible_user_id: id, responsible_user_name: z.string().default(""),
  last_grant: CockpitDirectoryGrantSchema, created_at: time, updated_at: time, finished_at: time.nullable(),
  observed_binding: CockpitDirectoryBindingSchema, accepted_binding_revision: revision.nullable(), bind_after_base: z.boolean(),
  binding_result: z.string(), counts: CockpitDirectoryCountsSchema, can_retry: capability, can_pause: capability,
  can_resume: capability, can_claim: capability, can_abandon: capability, blocked_reasons: z.array(z.string()).default([]),
}).refine((item) => item.created_by === item.source_principal.actor_id && item.created_by_type === item.source_principal.actor_type
  && item.last_grant.target_hash === item.target.target_hash, "Directory operation source and fixed target do not match")
  .transform((item) => operationStates.has(item.state) && knownPrincipal(item.last_grant.principal)
    && ["human", "delegated_task"].includes(item.last_grant.kind) && ["pending", "unchanged", "updated", "conflict"].includes(item.binding_result)
    ? item : { ...item, can_retry: false, can_pause: false, can_resume: false, can_claim: false, can_abandon: false });

export const CockpitDirectorySummarySchema = z.object({
  workspace_id: id, meeting_id: id, generated_at: time, binding: CockpitDirectoryBindingSchema,
  binding_candidate: CockpitDirectoryTargetSchema.nullable(), binding_candidate_reason: z.string(),
  capabilities: z.object({ available: capability, can_preview: capability, can_create: capability }),
  blocked_reasons: z.array(z.string()).default([]), current: CockpitDirectoryOperationHeaderSchema.nullable(),
  history_total: count, unfinished_total: count, needs_attention_total: count,
}).refine((value) => value.unfinished_total <= value.history_total && value.needs_attention_total <= value.unfinished_total
  && (!value.current || value.current.workspace_id === value.workspace_id && value.current.meeting_id === value.meeting_id)
  && (!value.current || value.history_total > 0));
export const CockpitDirectoryOperationPageSchema = z.object({
  workspace_id: id, meeting_id: id, ...pageFields, items: z.array(CockpitDirectoryOperationHeaderSchema).max(100),
}).refine((page) => validPage(page) && unique(page.items.map((item) => item.id))
  && page.items.every((item) => item.workspace_id === page.workspace_id && item.meeting_id === page.meeting_id));

export const CockpitDirectoryStepMetadataSchema = z.object({
  id, operation_id: id, position: count.max(32), kind: z.string(), label: z.string().default(""), relative_path: z.string().min(1),
  state: z.string(), revision, grant_command_key: key, grant_revision: revision, attempt_count: count,
  last_attempt_id: id.nullable(), last_observed_at: time.nullable(), outcome: z.string().nullable(), last_error_code: z.string(),
  can_retry: capability, blocked_reasons: z.array(z.string()).default([]),
}).transform((step) => stepStates.has(step.state) && ["ancestor", "base", "partition"].includes(step.kind)
  ? step : { ...step, can_retry: false });
export const CockpitDirectoryStepPageSchema = z.object({
  workspace_id: id, meeting_id: id, operation_id: id, items: z.array(CockpitDirectoryStepMetadataSchema).max(32),
  total: count.max(32), counts: CockpitDirectoryCountsSchema,
}).refine((page) => page.items.length === page.total && page.total === page.counts.total
  && unique(page.items.map((item) => item.id)) && page.items.every((item, index) => item.operation_id === page.operation_id
    && (index === 0 || page.items[index - 1]!.position < item.position)), "Directory steps must be complete and ordered for the exact operation");

export const CockpitDirectoryAttemptMetadataSchema = z.object({
  id, step_id: id, attempt_number: revision, state: z.string(), started_at: time, finished_at: time.nullable(),
  error_code: z.string(), outcome: z.string().nullable(), observed_at: time.nullable(),
});
export const CockpitDirectoryObservationSchema = z.object({
  directory: z.string().min(1), directory_identity: z.string().min(1), root_identity: z.string().min(1), outcome: z.string(), observed_at: time,
});
export const CockpitDirectoryAttemptDetailSchema = CockpitDirectoryAttemptMetadataSchema.extend({
  workspace_id: id, meeting_id: id, operation_id: id, grant_command_key: key, grant_revision: revision,
  error_message: z.string(), receipt: CockpitDirectoryObservationSchema.nullable(), late_receipt: CockpitDirectoryObservationSchema.nullable(),
  late_observed_at: time.nullable(),
}).refine((attempt) => (attempt.late_receipt === null) === (attempt.late_observed_at === null), "Late directory observations need their own timestamp");
export const CockpitDirectoryAttemptPageSchema = z.object({
  workspace_id: id, meeting_id: id, operation_id: id, step_id: id, ...pageFields,
  items: z.array(CockpitDirectoryAttemptMetadataSchema).max(100),
}).refine((page) => validPage(page) && unique(page.items.map((item) => item.id)) && page.items.every((item) => item.step_id === page.step_id));

export const CockpitDirectoryPreviewStepSchema = z.object({
  step_id: id.nullable(), position: count.max(32), parent_position: count.max(32).nullable(), kind: z.string(),
  label: z.string().default(""), relative_path: z.string().min(1), path_hash: hash, planned_state: z.string(), error_code: z.string(),
});
export const CockpitDirectoryPreviewCountsSchema = z.object({ total: count.max(32), exists: count, missing: count, conflict: count, unknown: count })
  .refine((c) => c.exists + c.missing + c.conflict + c.unknown === c.total);
const previewFields = {
  workspace_id: id, meeting_id: id, target: CockpitDirectoryTargetSchema, plan_hash: hash, observed_binding: CockpitDirectoryBindingSchema,
  bind_after_base: z.boolean(), steps: z.array(CockpitDirectoryPreviewStepSchema).max(32), counts: CockpitDirectoryPreviewCountsSchema,
  context_token: z.union([hash, z.literal("")]), can_confirm: capability, blocked_reasons: z.array(z.string()).default([]),
  checked_at: time, principal: CockpitDirectoryPrincipalSchema.nullable(),
};
function validPreview(value: z.infer<z.ZodObject<typeof previewFields>>) {
  return value.steps.length === value.counts.total && unique(value.steps.map((step) => step.relative_path))
    && value.steps.every((step, index) => (index === 0 || value.steps[index - 1]!.position < step.position)
      && (step.parent_position === null || step.parent_position < step.position))
    && (!value.can_confirm || Boolean(value.context_token && value.principal && knownPrincipal(value.principal)
      && value.steps.length > 0 && value.blocked_reasons.length === 0 && value.counts.conflict === 0 && value.counts.unknown === 0
      && value.steps.every((step) => ["exists", "missing"].includes(step.planned_state) && ["ancestor", "base", "partition"].includes(step.kind))));
}
export const CockpitDirectoryPreviewSchema = z.object(previewFields).refine((value) => validPreview(value)
  && value.steps.every((step) => step.step_id === null), "Directory preview must identify safe, ordered changes and a real principal");
export const CockpitDirectoryRetryPreviewSchema = z.object({
  ...previewFields, operation_id: id, operation_revision: revision, step_ids: z.array(id).min(1).max(32),
}).refine((value) => validPreview(value) && unique(value.step_ids) && value.steps.length === value.step_ids.length
  && value.steps.every((step) => step.step_id !== null && value.step_ids.includes(step.step_id))
  && unique(value.steps.map((step) => step.step_id!)), "Directory retry preview must match exactly the selected original steps");

export const CockpitDirectoryCommandReceiptSchema = z.object({
  directory_operation_id: id, directory_step_ids: z.array(id).max(32), request_hash: hash, context_token: hash.nullable(), plan_hash: hash,
  target: CockpitDirectoryTargetSchema, observed_binding: CockpitDirectoryBindingSchema, bind_after_base: z.boolean(), operation_revision: revision,
  state: z.string(), responsible_user_id: id, authorized_at: time, reason: z.string(),
  principal: CockpitDirectoryPrincipalSchema, grant: CockpitDirectoryGrantSchema,
}).refine((receipt) => unique(receipt.directory_step_ids) && receipt.target.target_hash === receipt.grant.target_hash,
  "Directory receipt must retain the same fixed target and unique selected steps");
export const CockpitDirectoryCommandResultSchema = z.object({
  workspace_id: id, meeting_id: id, command_key: key, action: z.enum(["directory_prepare", "directory_retry", "directory_pause", "directory_resume", "directory_claim", "directory_abandon"]),
  replayed: z.boolean(), receipt: CockpitDirectoryCommandReceiptSchema, current: CockpitDirectoryOperationHeaderSchema,
}).refine((value) => value.current.workspace_id === value.workspace_id && value.current.meeting_id === value.meeting_id
  && value.current.id === value.receipt.directory_operation_id && value.current.plan_hash === value.receipt.plan_hash
  && value.current.target.target_hash === value.receipt.target.target_hash
  && value.current.target.root_id === value.receipt.target.root_id
  && value.current.target.relative_directory === value.receipt.target.relative_directory
  && (!["directory_prepare", "directory_retry", "directory_claim"].includes(value.action)
    || value.receipt.grant.command_key === value.command_key
      && value.receipt.grant.principal.source === value.receipt.principal.source
      && value.receipt.grant.principal.actor_id === value.receipt.principal.actor_id
      && value.receipt.grant.principal.authorizing_user_id === value.receipt.principal.authorizing_user_id
      && value.receipt.grant.responsible_user_id === value.receipt.responsible_user_id), "Directory result must identify the same operation independently of its current progress");

export const CockpitDirectoryCancellationImpactSchema = z.object({
  unfinished_total: count, will_pause_total: count, sample_operation_ids: z.array(id).max(100), facts_hash: hash,
}).refine((value) => value.will_pause_total <= value.unfinished_total && value.sample_operation_ids.length <= value.will_pause_total && unique(value.sample_operation_ids));
export const CockpitDirectoryCancellationEffectSchema = z.object({
  paused_total: count, sample_operation_ids: z.array(id).max(100), facts_hash: hash,
}).refine((value) => value.sample_operation_ids.length <= value.paused_total && unique(value.sample_operation_ids));
