import { z } from "zod";

export const CockpitNasAttemptSchema = z.object({
  id: z.string().uuid(), attempt_number: z.number().int().positive(), status: z.string(),
  target_path: z.string().min(1), receipt_path: z.string().min(1), content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  verified_path: z.string().nullable(), verified_receipt_path: z.string().nullable(), verified_attempt_id: z.string().uuid().nullable(),
  receipt_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(), size_bytes: z.number().int().nonnegative().nullable(),
  last_error_code: z.string(), last_error: z.string(), created_at: z.string().min(1), updated_at: z.string().min(1), verified_at: z.string().nullable(),
}).strip().refine((row) => !["verified", "recovered"].includes(row.status) || Boolean(row.verified_path && row.verified_receipt_path
  && row.verified_attempt_id && row.receipt_hash && row.size_bytes && row.verified_at), "Verified attempts require completion evidence");

export const CockpitNasAttemptPageSchema = z.object({
  workspace_id: z.string().min(1), meeting_id: z.string().min(1), export_id: z.string().min(1),
  items: z.array(CockpitNasAttemptSchema), total: z.number().int().nonnegative(), next_cursor: z.string().nullable(),
}).strip().refine((page) => page.total >= page.items.length && new Set(page.items.map((item) => item.id)).size === page.items.length,
  "Attempt count or identity is inconsistent");
