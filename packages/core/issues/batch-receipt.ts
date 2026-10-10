import { ApiError } from "../api";
import { parseIssueBatchReceipt } from "../api/issue-batch-schemas";
import type { IssueBatchReceipt } from "../types/issue-batch";

export function issueBatchErrorReceipt(error: unknown, wsId: string, ids: readonly string[], operation: "update" | "delete"): IssueBatchReceipt | null {
  return error instanceof ApiError ? parseIssueBatchReceipt(error.body, wsId, ids, operation) : null;
}
export function issueBatchAppliedIds(receipt: IssueBatchReceipt | null | undefined): string[] {
  return receipt?.results.filter((row) => row.outcome === "applied").map((row) => row.issue_id) ?? [];
}
export function issueBatchComplete(receipt: IssueBatchReceipt | null | undefined): boolean {
  return Boolean(receipt && receipt.transaction_outcome === "committed" && receipt.unconfirmed_ids.length === 0
    && receipt.results.length === receipt.requested_ids.length && receipt.results.every((row) => row.outcome === "applied"));
}
