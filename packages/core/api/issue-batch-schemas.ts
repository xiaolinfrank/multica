import { z } from "zod";
import type { IssueBatchReceipt } from "../types/issue-batch";
import { parseWithFallback } from "./schema";

const id = z.string().min(1);
// Accepts both the fork's canonical receipt outcomes and upstream's per-item
// batch outcomes ("updated" / "unchanged" / "deleted" / "skipped"), normalizing
// them into the canonical receipt shape so clients and CLI stay aligned.
const wireOutcome = z.enum([
  "applied",
  "rejected",
  "not_attempted",
  "not_applied",
  "updated",
  "unchanged",
  "deleted",
  "skipped",
]);
const result = z
  .object({
    issue_id: id,
    outcome: wireOutcome,
    revision: z.number().int().positive().optional(),
    changed: z.boolean().optional(),
    code: id.optional(),
  })
  .transform((row) => {
    if (row.outcome === "updated") {
      return { ...row, outcome: "applied" as const, changed: row.changed ?? true };
    }
    if (row.outcome === "unchanged") {
      return { ...row, outcome: "applied" as const, changed: row.changed ?? false };
    }
    if (row.outcome === "deleted") {
      return { ...row, outcome: "applied" as const };
    }
    if (row.outcome === "skipped") {
      return { ...row, outcome: "rejected" as const, code: row.code ?? "skipped" };
    }
    return row;
  })
  .refine((row) => row.outcome === "applied" || Boolean(row.code));
export const IssueBatchReceiptSchema = z.object({
  workspace_id: id, requested_ids: z.array(id).min(1),
  transaction_mode: z.enum(["per_item", "atomic"]),
  transaction_outcome: z.enum(["committed", "partial", "rolled_back", "not_started", "unknown"]),
  results: z.array(result), unconfirmed_ids: z.array(id),
  updated: z.number().int().nonnegative().optional(), deleted: z.number().int().nonnegative().optional(),
  error: z.string().optional(), code: z.string().optional(),
}).refine((value) => {
  const requested = new Set(value.requested_ids);
  const reported = [...value.results.map((row) => row.issue_id), ...value.unconfirmed_ids];
  if (requested.size !== value.requested_ids.length || reported.length !== requested.size
    || new Set(reported).size !== reported.length || reported.some((id) => !requested.has(id))) return false;
  const applied = value.results.filter((row) => row.outcome === "applied").length;
  if (value.unconfirmed_ids.length) return value.transaction_outcome === "unknown";
  if (value.transaction_outcome === "unknown") return false;
  if (value.transaction_outcome === "committed") return applied === requested.size;
  if (value.transaction_outcome === "partial") return applied > 0 && applied < requested.size;
  return applied === 0;
});

export function parseIssueBatchReceipt(raw: unknown, wsId: string, ids: readonly string[], operation: "update" | "delete"): IssueBatchReceipt | null {
  const receipt = parseWithFallback<IssueBatchReceipt | null>(raw, IssueBatchReceiptSchema, null, { endpoint: "POST /api/issues/batch-" + operation });
  const sent = [...new Set(ids)];
  if (!receipt || receipt.workspace_id !== wsId || receipt.requested_ids.length !== sent.length
    || receipt.requested_ids.some((id, index) => id !== sent[index])
    || receipt.transaction_mode !== (operation === "update" ? "per_item" : "atomic")) return null;
  const applied = receipt.results.filter((row) => row.outcome === "applied");
  if ((operation === "update" ? receipt.updated : receipt.deleted) !== applied.length) return null;
  if (operation === "update" && applied.some((row) => row.revision === undefined || row.changed === undefined)) return null;
  return receipt;
}

export class IssueBatchUnconfirmedError extends Error {
  constructor() { super("issue_batch_not_confirmed"); this.name = "IssueBatchUnconfirmedError"; }
}

const BatchParentFilingConflictItemSchema = z.object({
  issue_id: id,
  parent_issue_id: id,
  code: z.string().optional(),
});

const BatchParentFilingConflictResponseSchema = z.object({
  code: z.enum(["child_module_mismatch", "child_work_item_mismatch"]),
  conflicts: z.array(BatchParentFilingConflictItemSchema).optional(),
});

export interface ParsedBatchParentFilingConflict {
  code: "child_module_mismatch" | "child_work_item_mismatch";
  conflicts: Array<{ issue_id: string; parent_issue_id: string; code?: string }>;
}

export function parseBatchParentFilingConflict(
  raw: unknown,
): ParsedBatchParentFilingConflict | null {
  const parsed = parseWithFallback<z.infer<typeof BatchParentFilingConflictResponseSchema> | null>(
    raw,
    BatchParentFilingConflictResponseSchema,
    null,
    { endpoint: "POST /api/issues/batch-update" },
  );
  if (!parsed) return null;
  return {
    code: parsed.code,
    conflicts: parsed.conflicts ?? [],
  };
}
