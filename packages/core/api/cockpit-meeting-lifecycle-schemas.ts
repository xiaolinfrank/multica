import { CockpitDirectoryCommandReceiptSchema } from "./cockpit-meeting-directory-schemas";
import { z } from "zod";
import { CockpitTaskSchema } from "./schemas";
import { CockpitOccurrenceSchema, CockpitMeetingArchiveSchema, cockpitOccurrenceStates as occurrenceStates } from "./cockpit-meeting-common-schemas";
import { CockpitPreparationCommandReceiptSchema } from "./cockpit-meeting-preparation-schemas";

const id = z.string().min(1);
const revision = z.number().int().positive();
const count = z.number().int().nonnegative();
const time = z.string().datetime({ offset: true });
const nullableTime = time.nullable();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.boolean().catch(false).default(false);
export const CockpitMaterialsSchema = z.object({
  workflow_revision: revision, ready: z.boolean(), confirmed_at: nullableTime,
  confirmed_by: id.nullable(), released: z.boolean(),
});

export const CockpitMeetingLifecycleHeaderSchema = z.object({
  workspace_id: id, meeting_id: id, lifecycle_revision: revision, agenda_revision: revision,
  generated_at: time, occurrence: CockpitOccurrenceSchema, materials: CockpitMaterialsSchema.nullable(),
  workflow_enabled: z.boolean(), agenda_total: count,
  can_schedule: capability, can_start: capability, can_end: capability,
  can_correct_times: capability, can_edit_agenda: capability, can_confirm_materials: capability,
  blocked_reasons: z.array(z.object({ action: z.string(), code: z.string() })).default([]),
  archive: CockpitMeetingArchiveSchema.optional(),
}).refine((value) => value.workflow_enabled === (value.materials !== null), "Materials confirmation requires the same meeting work package")
  .transform((value) => occurrenceStates.has(value.occurrence.state) ? value : {
    ...value, can_schedule: false, can_start: false, can_end: false, can_correct_times: false,
  });

export const CockpitAgendaMetadataSchema = z.object({
  id, workspace_id: id, meeting_id: id, revision, title: z.string(), purposes: z.array(z.string()),
  sort_order: z.number().int(), facilitator_user_id: id.nullable(), facilitator_name: z.string().default(""),
  node_id: id.nullable(), node_code: z.string().default(""), node_title: z.string().default(""),
  reference_count: count, created_at: time, updated_at: time, removed_at: nullableTime,
  can_edit: capability, can_remove: capability,
});
export const CockpitAgendaDetailSchema = CockpitAgendaMetadataSchema.extend({ desired_outcome: z.string(), notes: z.string() });
export const CockpitAgendaPageSchema = z.object({
  workspace_id: id, meeting_id: id, agenda_revision: revision, q: z.string(), include_removed: z.boolean(),
  page_size: z.number().int().min(1).max(100), items: z.array(CockpitAgendaMetadataSchema).max(100), total: count, next_cursor: id.nullable(),
}).refine((page) => page.items.length <= page.page_size && page.items.length <= page.total
  && new Set(page.items.map((item) => item.id)).size === page.items.length
  && page.items.every((item) => item.workspace_id === page.workspace_id && item.meeting_id === page.meeting_id
    && (page.include_removed || item.removed_at === null)), "Agenda page scope, counts or removal filter do not match");

export const CockpitAgendaReferenceSchema = z.object({
  id, workspace_id: id, meeting_id: id, agenda_id: id, kind: z.string(), target_id: id, purpose: z.string(),
  available: z.boolean(), label: z.string(), issue: CockpitTaskSchema.nullable(),
  artifact_id: id.nullable(), version_id: id.nullable(), version_number: revision.nullable(), content_hash: hash.nullable(),
  version_decision: z.string().nullable().default(null),
  created_at: time, removed_at: nullableTime, can_remove: capability,
}).refine((value) => !value.available || (value.kind !== "issue" || value.issue?.id === value.target_id)
  && (value.kind !== "artifact_reference" || Boolean(value.artifact_id && value.version_id && value.version_number && value.content_hash)),
"Available references require an exact target");
export const CockpitAgendaReferencePageSchema = z.object({
  workspace_id: id, meeting_id: id, agenda_id: id, agenda_revision: revision, include_removed: z.boolean(),
  page_size: z.number().int().min(1).max(100), items: z.array(CockpitAgendaReferenceSchema).max(100), total: count, next_cursor: id.nullable(),
}).refine((page) => page.items.length <= page.page_size && page.items.length <= page.total
  && new Set(page.items.map((item) => item.id)).size === page.items.length
  && page.items.every((item) => item.workspace_id === page.workspace_id && item.meeting_id === page.meeting_id && item.agenda_id === page.agenda_id
    && (page.include_removed || item.removed_at === null)), "Agenda reference page does not match its scope or filter");

export const CockpitLifecycleActionSchema = z.enum(["schedule", "start", "end", "correct_times", "materials",
  "agenda_create", "agenda_update", "agenda_remove", "reference_attach", "reference_remove", "preparation_issue_create", "reinstate", "archive", "unarchive"]);
export const CockpitLifecycleReceiptSchema = z.object({
  revision, agenda_revision: revision, agenda_id: id.nullable(), reference_id: id.nullable(), issue_id: id.nullable(),
  request_hash: hash, reason: z.string(), previous_occurrence: CockpitOccurrenceSchema.nullable(),
  occurrence: CockpitOccurrenceSchema.nullable(), materials: CockpitMaterialsSchema.nullable(),
  agenda: CockpitAgendaDetailSchema.nullable(), reference: CockpitAgendaReferenceSchema.nullable(),
  archive: CockpitMeetingArchiveSchema.nullable().optional(), previous_archive: CockpitMeetingArchiveSchema.nullable().optional(),
  preparation: CockpitPreparationCommandReceiptSchema.nullable().optional(),
  directory: CockpitDirectoryCommandReceiptSchema.nullable().optional(),
});
export const CockpitLifecycleCommandResultSchema = z.object({
  workspace_id: id, meeting_id: id, command_key: z.string().uuid(), action: CockpitLifecycleActionSchema,
  replayed: z.boolean(), receipt: CockpitLifecycleReceiptSchema, current: CockpitMeetingLifecycleHeaderSchema,
}).refine((result) => {
  const { receipt, current, action } = result;
  if (current.workspace_id !== result.workspace_id || current.meeting_id !== result.meeting_id) return false;
  if (receipt.agenda && (receipt.agenda.id !== receipt.agenda_id || receipt.agenda.workspace_id !== result.workspace_id || receipt.agenda.meeting_id !== result.meeting_id)) return false;
  if (receipt.reference && (receipt.reference.id !== receipt.reference_id || receipt.reference.agenda_id !== receipt.agenda_id
    || receipt.reference.workspace_id !== result.workspace_id || receipt.reference.meeting_id !== result.meeting_id)) return false;
  if (["schedule", "start", "end", "correct_times"].includes(action)) return receipt.occurrence !== null
    && (action !== "correct_times" || Boolean(receipt.reason.trim() && receipt.previous_occurrence));
  if (action === "archive" || action === "unarchive") return Boolean(receipt.archive && receipt.previous_archive && receipt.reason.trim())
    && (action === "archive" ? receipt.archive?.archived_at !== null : receipt.archive?.archived_at === null);
  if (action === "reinstate") return receipt.occurrence?.state === "scheduled" && receipt.previous_occurrence?.state === "cancelled" && Boolean(receipt.reason.trim());
  if (action === "materials") return receipt.materials !== null;
  if (action.startsWith("agenda_")) return receipt.agenda !== null
    && (action !== "agenda_remove" || Boolean(receipt.agenda.removed_at && receipt.reason.trim()));
  if (!receipt.reference) return false;
  if (action === "reference_remove") return receipt.reference.removed_at !== null;
  if (action === "preparation_issue_create") return receipt.issue_id !== null && receipt.reference.kind === "issue"
    && receipt.reference.purpose === "preparation" && receipt.reference.target_id === receipt.issue_id
    && receipt.reference.issue?.id === receipt.issue_id && receipt.reference.issue.status === "backlog";
  return true;
}, "The command receipt must identify its exact result independently of current metadata");

export const CockpitLifecycleCommandPageSchema = z.object({
  workspace_id: id, meeting_id: id, page_size: z.number().int().min(1).max(100),
  items: z.array(z.object({ command_key: z.string().uuid(), action: z.string(), actor_id: id, actor_type: z.string().default("member"), actor_name: z.string(),
    created_at: time, revision, agenda_id: id.nullable(), reference_id: id.nullable(), issue_id: id.nullable(), operation_id: id.nullable().optional(), effect_id: id.nullable().optional(), directory_operation_id: id.nullable().optional(), directory_step_id: id.nullable().optional() })).max(100),
  total: count, next_cursor: id.nullable(),
}).refine((page) => page.items.length <= page.page_size && page.items.length <= page.total
  && new Set(page.items.map((item) => item.command_key)).size === page.items.length, "Command metadata page repeats or exceeds its items");

export const CockpitLifecycleCommandDetailSchema = z.object({
  workspace_id: id, meeting_id: id, command_key: z.string().uuid(), action: z.string(), actor_id: id, actor_type: z.string().default("member"), actor_name: z.string(),
  created_at: time, revision, agenda_id: id.nullable(), reference_id: id.nullable(), issue_id: id.nullable(), operation_id: id.nullable().optional(), effect_id: id.nullable().optional(), directory_operation_id: id.nullable().optional(), directory_step_id: id.nullable().optional(), receipt: CockpitLifecycleReceiptSchema,
}).refine((value) => value.receipt.revision === value.revision && value.receipt.agenda_id === value.agenda_id
  && value.receipt.reference_id === value.reference_id && value.receipt.issue_id === value.issue_id
  && (!value.receipt.directory || !value.receipt.preparation && value.operation_id == null && value.effect_id == null
    && value.receipt.directory.directory_operation_id === value.directory_operation_id
    && value.receipt.directory.request_hash === value.receipt.request_hash
    && value.receipt.directory.principal.actor_type === value.actor_type
    && value.receipt.directory.principal.actor_id === value.actor_id
    && (!value.directory_step_id || value.receipt.directory.directory_step_ids.includes(value.directory_step_id)))
  && (!value.receipt.preparation || value.directory_operation_id == null && value.directory_step_id == null)
  && (!value.receipt.preparation || value.receipt.preparation.operation_id === value.operation_id && value.receipt.preparation.effect_id === (value.effect_id ?? null))
  && (!value.receipt.preparation || value.receipt.preparation.request_hash === value.receipt.request_hash
    && (value.action !== "template_apply" || value.receipt.preparation.kind === "apply_template")
    && (!["cancel", "preparation_dispose"].includes(value.action) || value.receipt.preparation.kind === "cancel_preparation"))
  && (!value.receipt.agenda || value.receipt.agenda.id === value.receipt.agenda_id
    && value.receipt.agenda.workspace_id === value.workspace_id && value.receipt.agenda.meeting_id === value.meeting_id)
  && (!value.receipt.reference || value.receipt.reference.id === value.receipt.reference_id
    && value.receipt.reference.agenda_id === value.receipt.agenda_id
    && value.receipt.reference.workspace_id === value.workspace_id && value.receipt.reference.meeting_id === value.meeting_id
    && (!value.receipt.issue_id || value.receipt.reference.kind !== "issue" || value.receipt.reference.target_id === value.receipt.issue_id)),
"Historical command metadata and receipt must identify the same result");
