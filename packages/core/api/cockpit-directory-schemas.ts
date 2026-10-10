import { z } from "zod";
const key = z.object({ party: z.string(), name: z.string().min(1) });
const entry = key.extend({ position: z.string(), source: z.string().catch("unknown") });
export const CockpitDirectoryPageSchema = z.object({
  workspace_id: z.string().min(1), scope: z.literal("workspace"), q: z.string(),
  party: z.string().nullable(), parties: z.array(z.string()).max(20).nullable(),
  items: z.array(entry).max(100), total: z.number().int().nonnegative(), next_cursor: z.string().min(1).nullable(),
});
export const CockpitDirectoryReceiptSchema = z.object({
  workspace_id: z.string().min(1), scope: z.literal("workspace"), action: z.enum(["upserted", "deleted"]),
  entries: z.array(entry).max(200), skipped: z.array(key).max(200), deleted: z.array(key).max(1),
});
