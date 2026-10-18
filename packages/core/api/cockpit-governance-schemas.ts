import { z } from "zod";
import { CockpitPendingChangeSchema, CockpitSnapshotSchema, CockpitNodeSchema } from "./schemas";
import { CockpitReadScopeSchema } from "./cockpit-read-schemas";
const count = z.number().int().nonnegative();
export const CockpitChangePageSchema = z.object({
  workspace_id: z.string().min(1), scope: CockpitReadScopeSchema, q: z.string(),
  status: z.enum(["all", "pending", "decided", "applied", "rejected", "withdrawn"]),
  items: z.array(CockpitPendingChangeSchema).max(100), total: count, next_cursor: z.string().nullable(),
  counts: z.object({ pending: count, decided: count }),
}).refine((value) => value.total >= value.items.length && value.counts.pending + value.counts.decided >= value.total
  && new Set(value.items.map((item) => item.id)).size === value.items.length
  && (value.next_cursor === null || value.items.length > 0));
export const CockpitSnapshotPageSchema = z.object({
  workspace_id: z.string().min(1), scope: z.literal("workspace"), q: z.string(),
  items: z.array(CockpitSnapshotSchema).max(100), total: count, next_cursor: z.string().nullable(),
}).refine((value) => value.total >= value.items.length && new Set(value.items.map((item) => item.id)).size === value.items.length
  && (value.next_cursor === null || value.items.length > 0));

export const CockpitChangePreviewSchema = z.object({
  workspace_id: z.string().min(1), context: CockpitReadScopeSchema, change: CockpitPendingChangeSchema.extend({ id: z.string().min(1), node_id: z.string().min(1), field: z.string().min(1), old_value: z.string(), new_value: z.string(), status: z.literal("pending"), updated_at: z.string().min(1) }),
  current_value: z.string(), conflict: z.boolean(), review_token: z.string().regex(/^"[0-9a-f]{64}"$/),
}).refine((value) => value.conflict === (value.current_value !== value.change.old_value)
  && (value.context.module_id === null || value.context.project_id !== null));

export const CockpitReviewedChangeResponseSchema = z.object({
  change: CockpitPendingChangeSchema.extend({ id: z.string().min(1), node_id: z.string().min(1), field: z.string().min(1), old_value: z.string(), new_value: z.string(), status: z.literal("applied") }),
  node: CockpitNodeSchema.extend({ id: z.string().min(1) }),
});
