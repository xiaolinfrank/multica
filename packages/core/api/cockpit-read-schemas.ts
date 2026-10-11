import { z } from "zod";
import { CockpitSchema, CockpitNodeSchema, CockpitPaymentSchema, CockpitMilestoneSchema, CockpitMeetingSchema, CockpitMeetingIssueLinkSchema, CockpitMeetingNodeLinkSchema } from "./schemas";

const count = z.number().int().nonnegative();
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: count, next_cursor: z.string().nullable() })
  .refine((value) => value.total >= value.items.length, "Page count is smaller than its contents");
export const CockpitReadScopeSchema = z.object({ project_id: z.string().nullable(), module_id: z.string().nullable(), project_title: z.string(), module_title: z.string() });
export const CockpitContextDataSchema = z.object({
  workspace_id: z.string().min(1), scope: CockpitReadScopeSchema, cockpit: CockpitSchema.nullable(),
  actor: z.object({ user_id: z.string().min(1), role: z.string(), is_human: z.boolean() }), has_meeting_workflows: z.boolean(), has_stable_bindings: z.boolean(),
  has_meeting_lifecycle: z.boolean().optional(),
  has_meeting_preparation: z.boolean().optional(),
  has_directory_history: z.boolean().optional(),
  has_input_references: z.boolean().default(false),
  input_reference_meetings: z.array(z.object({meeting_id: z.string().uuid(), title: z.string()})).max(3).default([]),
  input_reference_meetings_total: z.number().int().nonnegative().default(0),
  capabilities: z.object({ artifacts: z.boolean().catch(false).default(false), acceptance: z.boolean().catch(false).default(false), meeting_lifecycle: z.boolean().catch(false).default(false), meeting_templates: z.boolean().catch(false).default(false), meeting_disposition: z.boolean().catch(false).default(false), meeting_directory_preparation: z.boolean().catch(false).default(false), inputs: z.boolean().catch(false).default(false), run_input_manifests: z.boolean().catch(false).default(false) }).optional().catch(undefined),
}).refine((value) => !value.capabilities?.meeting_lifecycle || typeof value.has_meeting_lifecycle === "boolean", "Lifecycle-enabled contexts must report their retained meeting facts")
  .refine((value) => !value.capabilities?.meeting_templates && !value.capabilities?.meeting_disposition || typeof value.has_meeting_preparation === "boolean", "Preparation-enabled contexts must report retained preparation facts")
  .refine((value) => !value.capabilities?.meeting_directory_preparation || typeof value.has_directory_history === "boolean", "Directory-enabled contexts must report retained directory history")
  .refine((value) => value.has_input_references === (value.input_reference_meetings_total > 0)
    && value.input_reference_meetings.length === Math.min(3, value.input_reference_meetings_total)
    && new Set(value.input_reference_meetings.map((meeting) => meeting.meeting_id)).size === value.input_reference_meetings.length,
  "Retained input references require exact bounded meeting targets");
const nodeIndex = z.array(z.object({ id: z.string(), parent_id: z.string().nullable(), code: z.string(), position: z.number().finite() }));
export const CockpitNodeIndexPageSchema = z.object({ workspace_id: z.string().min(1), items: nodeIndex.max(20_000), total: count })
  .refine((value) => value.items.length === value.total && new Set(value.items.map((item) => item.id)).size === value.total);
export const CockpitPlanDataSchema = CockpitContextDataSchema.safeExtend({
  complete: z.literal(true), nodes: z.array(CockpitNodeSchema), payments: z.array(CockpitPaymentSchema), milestones: z.array(CockpitMilestoneSchema), node_index: nodeIndex, context_node_ids: z.array(z.string()),
  task_counts: z.array(z.object({ node_id: z.string(), primary_total: count, reference_total: count, active: count, done: count, closed: count })),
  counts: z.object({ nodes: count, payments: count, milestones: count, index_nodes: count }),
}).refine((value) => value.counts.nodes === value.nodes.length && value.counts.payments === value.payments.length
  && value.counts.milestones === value.milestones.length && value.counts.index_nodes === value.node_index.length, "Plan scope must be complete");
export const CockpitScopeItemPageSchema = page(z.object({ id: z.string().min(1), title: z.string(), project_id: z.string().nullable() })).safeExtend({
  workspace_id: z.string().min(1), project_id: z.string().nullable(),
});
export const CockpitPlanExportDataSchema = CockpitPlanDataSchema.safeExtend({
  issue_links: z.array(z.object({ node_id: z.string().min(1), issue_identifier: z.string().min(1) })).max(250_000), issue_link_total: count, generated_at: z.string().min(1),
}).refine((value) => {
  const nodes = new Set(value.nodes.map((node) => node.id));
  const context = new Set(value.context_node_ids);
  return value.issue_links.length === value.issue_link_total && value.issue_links.every((link) => nodes.has(link.node_id) && !context.has(link.node_id));
});
export const CockpitMeetingCardSchema = CockpitMeetingSchema.omit({ note: true, minutes: true, decisions: true, actions: true }).extend({
  issue_count: count, node_count: count, workflow_enabled: z.boolean(), workflow_stage: z.string(), display_excerpt: z.string().refine((value) => [...value].length <= 200),
}).strip();
export const CockpitMeetingRegisterPageSchema = page(CockpitMeetingCardSchema).safeExtend({
  archive: z.enum(["active", "archived", "all"]).optional(),
  workspace_id: z.string().min(1), scope: CockpitReadScopeSchema, node_id: z.string().nullable(), node_ids: z.array(z.string()).max(200),
  day_counts: z.array(z.object({ date: z.string(), total: count })).max(93), date_from: z.string().nullable(), date_to: z.string().nullable(),
});
export const CockpitNodeDetailDataSchema = CockpitContextDataSchema.safeExtend({
  node: CockpitNodeSchema, ancestors: z.array(CockpitNodeSchema), children_count: count, scope_match: z.boolean(), node_index: nodeIndex,
  binding: z.object({ project_id: z.string().nullable(), module_id: z.string().nullable(), project_title: z.string(), module_title: z.string(), source_node_id: z.string().nullable(), eligible: z.boolean(), reason: z.string() }),
  payments: page(CockpitPaymentSchema), payment_total: z.number().finite(), meetings: page(CockpitMeetingCardSchema),
});
export const CockpitMeetingDetailDataSchema = CockpitContextDataSchema.safeExtend({
  meeting: CockpitMeetingSchema, scope_match: z.boolean(), node_index: nodeIndex,
  linked_issues: page(CockpitMeetingIssueLinkSchema), linked_nodes: page(CockpitMeetingNodeLinkSchema.extend({ code: z.string(), name: z.string() })),
});
const objectPageFields = { workspace_id: z.string().min(1), object_id: z.string().min(1), payment_total: z.number().finite() };
export const CockpitNodePaymentPageSchema = page(CockpitPaymentSchema).safeExtend({ ...objectPageFields, kind: z.literal("payments") });
export const CockpitMeetingIssuePageSchema = page(CockpitMeetingIssueLinkSchema).safeExtend({ ...objectPageFields, kind: z.literal("meeting_issues") });
export const CockpitMeetingNodePageSchema = page(CockpitMeetingNodeLinkSchema.extend({ code: z.string(), name: z.string() })).safeExtend({ ...objectPageFields, kind: z.literal("meeting_nodes") });
export const CockpitMeetingNextCodeSchema = z.object({ workspace_id: z.string().min(1), date: z.string(), code: z.string().min(1) });
export const CockpitNodeCodePreviewSchema = z.object({ workspace_id: z.string().min(1), parent_id: z.string().nullable(), code: z.string().min(1).max(64) });
export const CockpitPlanMeetingMarkerPageSchema = z.object({
  archive: z.enum(["active", "archived", "all"]).optional(),
  workspace_id: z.string().min(1), scope: CockpitReadScopeSchema, rows: z.array(z.object({ row_key: z.string().min(1).max(100), node_ids: z.array(z.string().min(1)).min(1).max(20) })).max(100), date_from: z.string(), date_to: z.string(),
  groups: z.array(z.object({ row_key: z.string().min(1), date: z.string(), total: count,
    items: z.array(z.object({ id: z.string().min(1), title: z.string(), code: z.string(), start_time: z.string().nullable() })).max(5),
  }).refine((value) => value.total >= value.items.length)).max(500), total_groups: count, next_cursor: z.string().nullable(),
}).refine((value) => value.total_groups >= value.groups.length && new Set(value.rows.flatMap((row) => row.node_ids)).size <= 200 && value.groups.every((group) => value.rows.some((row) => row.row_key === group.row_key)
  && group.date >= value.date_from && group.date <= value.date_to));
