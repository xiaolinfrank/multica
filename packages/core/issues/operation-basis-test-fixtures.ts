import type { IssueOperationBasis, IssueOperationBasisPage } from "../types";

export function operationBasisFixture(issueId = "issue-1", patch: Partial<IssueOperationBasis> = {}): IssueOperationBasis {
  const allowed = () => ({ state: "allowed" as const, reason_codes: [] });
  return {
    issue_id: issueId, availability: "available", issue_revision: 3,
    status: { ...allowed(), allowed_categories: ["unstarted", "started", "done", "closed"] },
    assignee: allowed(), scope: allowed(), parent: allowed(), primary: allowed(), delete: allowed(), execution: allowed(),
    targets: [], targets_total: 0, ...patch,
  };
}
export function operationBasisPageFixture(ids: readonly string[], workspaceId = "ws-1"): IssueOperationBasisPage {
  return { workspace_id: workspaceId, schema_version: 1, generated_at: "2026-10-11T00:00:00Z", items: ids.map((id) => operationBasisFixture(id)) };
}
