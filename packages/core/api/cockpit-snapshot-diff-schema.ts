import { z } from "zod";

const count = z.number().int().nonnegative();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const planCounts = z.object({ nodes: count, payments: count, milestones: count });
const value = z.object({
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  truncated: z.boolean(), sha256: hash,
}).refine((entry) => !entry.truncated || typeof entry.value === "string");
const item = z.object({
  entity_kind: z.enum(["board", "node", "payment", "milestone", "unknown"]).catch("unknown"),
  id: z.string().min(1), change: z.enum(["added", "removed", "modified", "unknown"]).catch("unknown"),
  code: z.string(), name: z.string(),
  field_changes: z.array(z.object({ field: z.string().min(1), before: value, after: value })),
});
export const CockpitSnapshotDiffSchema = z.object({
  workspace_id: z.string().min(1), snapshot_id: z.string().min(1), snapshot_created_at: z.string(),
  snapshot_cockpit_id: z.string(), current_cockpit_id: z.string().nullable(), scope: z.literal("workspace"),
  generated_at: z.string().min(1), comparable: z.boolean(), reason: z.string(),
  snapshot_complete: z.boolean(), current_complete: z.boolean(), snapshot_counts: planCounts, current_counts: planCounts,
  counts: z.object({ added: count, removed: count, modified: count, unchanged: count }),
  items: z.array(item), total: count, page_size: z.number().int().min(1).max(100), next_cursor: z.string().min(1).nullable(),
  comparison_token: z.string(),
}).refine((page) => page.items.length <= page.page_size && page.total >= page.items.length
  && page.total === page.counts.added + page.counts.removed + page.counts.modified
  && new Set(page.items.map((entry) => `${entry.entity_kind}:${entry.id}`)).size === page.items.length
  && (!page.next_cursor || page.items.length === page.page_size)
  && (page.comparable ? page.reason === "" && page.snapshot_complete && page.current_complete
    && Boolean(page.current_cockpit_id) && page.current_cockpit_id === page.snapshot_cockpit_id && hash.safeParse(page.comparison_token).success
    : Boolean(page.reason) && page.total === 0 && page.items.length === 0 && page.next_cursor === null));
