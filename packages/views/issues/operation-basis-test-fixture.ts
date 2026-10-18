import type { Issue, IssueOperationBasis, IssueOperationBasisPage } from "@multica/core/types";

export function operationIssueFixture(id: string, overrides: Partial<Issue> = {}): Issue {
  return { id, workspace_id: "ws-1", identifier: `DEL-${id}`, number: 1, title: `Delivery ${id}`, description: null, status: "todo", priority: "none", assignee_type: null, assignee_id: null, creator_type: "member", creator_id: "human", project_id: null, module_id: null, parent_issue_id: null, position: 1, stage: null, start_date: null, due_date: null, metadata: {}, properties: {}, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z", ...overrides };
}

export function issueOperationFixture(issueId: string, overrides: Partial<IssueOperationBasis> = {}): IssueOperationBasis {
  const allowed = { state: "allowed" as const, reason_codes: [] };
  return { issue_id: issueId, issue_revision: 1, availability: "available", status: { ...allowed, allowed_categories: ["unstarted", "started", "done", "closed"] }, assignee: allowed, scope: allowed, parent: allowed, primary: allowed, delete: allowed, execution: allowed, targets: [], targets_total: 0, ...overrides };
}

export function issueOperationPageFixture(wsId: string, ids: readonly string[]): IssueOperationBasisPage {
  return { workspace_id: wsId, schema_version: 1, generated_at: "2026-10-11T00:00:00Z", items: ids.map((id) => issueOperationFixture(id)) };
}
