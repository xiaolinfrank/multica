import { CockpitMeetingActionSchema, CockpitNodeSchema, CockpitTaskSchema } from "@multica/core/api/schemas";
import type { CockpitMeetingAction, CockpitTask, CockpitTaskPage, SearchIssueResult } from "@multica/core/types";

export const actionNode = CockpitNodeSchema.parse({ id: "node-1", cockpit_id: "cockpit-1", name: "Large L3", code: "01.01.01" });
export function compactTask(index: number, overrides: Partial<CockpitTask> = {}): CockpitTask {
  return { ...CockpitTaskSchema.parse({ id: `issue-${index}`, identifier: `PMO-${index}`, title: `Work item ${index}`, status: "backlog", status_category: "unstarted",
    project_id: "project-1", module_id: "module-1", primary_node_id: "node-1", primary_revision: 1, assignee_type: "member", assignee_id: "reviewer-1", assignee_name: "Human Reviewer" }), ...overrides };
}
export function compactPage(overrides: Partial<CockpitTaskPage> = {}): CockpitTaskPage {
  return { node_id: "node-1", items: Array.from({ length: 25 }, (_, index) => compactTask(index + 1)), total: 125, filtered_total: 100, next_cursor: "page-2",
    summary: { total: 125, by_status: [{ status: "backlog", category: "unstarted", count: 99 }, { status: "done", category: "done", count: 20 }, { status: "cancelled", category: "closed", count: 5 }, { status: "legacy-unknown", category: "unknown", count: 1 }],
      by_category: { unstarted: 99, started: 0, done: 20, closed: 5, unknown: 1 }, done: 20, closed: 5, unknown: 1 },
    eligibility: { eligible: true, project_id: "project-1", module_id: "module-1", reason: "" }, ...overrides };
}
export function meetingAction(overrides: Partial<CockpitMeetingAction> = {}): CockpitMeetingAction {
  return { ...CockpitMeetingActionSchema.parse({ id: "action-1", meeting_id: "10000000-0000-4000-8000-000000000001", version_id: "version-1", version_number: 1,
    source_content_hash: "hash-of-fixed-text", source_quote: "Fixed minutes text", title: "Verify interface", description: "Check required fields", status: "draft", revision: 1,
    proposal_key: "40000000-0000-4000-8000-000000000001", created_by: "reviewer-1", created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z", can_edit: true, can_resolve: true }), ...overrides };
}
export function choiceIssue(index: number): SearchIssueResult {
  return { id: `issue-${index}`, workspace_id: "ws-1", number: index, identifier: `PMO-${index}`, title: `Candidate ${index}`, description: null,
    status: "todo", priority: "none", assignee_type: "member", assignee_id: "reviewer-1", creator_type: "member", creator_id: "reviewer-1", parent_issue_id: null,
    project_id: "project-1", module_id: "module-1", position: 0, stage: null, start_date: null, due_date: "2026-11-01", metadata: {}, properties: {}, created_at: "", updated_at: "", match_source: "title" };
}
