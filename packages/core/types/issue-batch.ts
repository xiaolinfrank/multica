export type IssueBatchOutcome = "applied" | "rejected" | "not_attempted" | "not_applied";
export interface IssueBatchResult {
  issue_id: string;
  outcome: IssueBatchOutcome;
  revision?: number;
  changed?: boolean;
  code?: string;
}
export interface IssueBatchReceipt {
  workspace_id: string;
  requested_ids: string[];
  transaction_mode: "per_item" | "atomic";
  transaction_outcome: "committed" | "partial" | "rolled_back" | "not_started" | "unknown";
  results: IssueBatchResult[];
  unconfirmed_ids: string[];
  updated?: number;
  deleted?: number;
  error?: string;
  code?: string;
}
export interface IssueBatchWriteOptions {
  expected_revisions?: Record<string, number>;
}
