import { CockpitAttentionItemSchema, CockpitOverviewDataSchema } from "@multica/core/api/schemas";
import type { CockpitAttentionItem, CockpitOverviewData } from "@multica/core/types";

export const overviewScope = { workspace_id: "ws-1", project_id: null, project_title: "", as_of: "2026-10-10", generated_at: "2026-10-10T10:00:00Z" };
export function overviewAttention(index: number, overrides: Partial<CockpitAttentionItem> = {}): CockpitAttentionItem {
  return { ...CockpitAttentionItemSchema.parse({ id: `issue-${index}`, kind: "issue", reason: "active_issue", title: `Open item ${index}`,
    created_at: "2024-01-01T10:00:00Z", due_date: "2024-02-01", responsibility: "assigned_member", assignee_name: "Ada",
    issue_identifier: `PMO-${index}`, issue_status: "todo", issue_status_category: "unstarted", flags: ["overdue"], can_act: true,
    next_action: "open_issue", target: { kind: "issue", id: `issue-${index}`, issue_id: `issue-${index}` } }), ...overrides };
}
export function workOverview(overrides: Partial<CockpitOverviewData> = {}): CockpitOverviewData {
  const counts = { total: 125, active: 100, unstarted: 89, started: 10, done: 20, closed: 5, unknown: 1, overdue: 4, blocked: 2, unassigned: 0 };
  return { ...CockpitOverviewDataSchema.parse({ ...overviewScope, board: { id: "board-1", title: "Plan", goal_title: "Launch the next release" },
    actor: { user_id: "member-1", role: "member", is_human: true },
    summary: { primary_issues: counts, my_primary_issues: { ...counts, total: 10, active: 8, unstarted: 6, started: 1, done: 1, closed: 1, unknown: 1 },
      execution_nodes: { total: 2, with_active_issues: 2 }, attention: { team_total: 100, mine_total: 40, team_by_kind: { workflow: 2, issue: 96, action: 1, nas: 1 }, mine_by_kind: { workflow: 1, issue: 39 } } },
    attention: { ...overviewScope, view: "mine", kind: "", items: Array.from({ length: 8 }, (_, index) => overviewAttention(index + 1)), total: 40, next_cursor: "preview-next" },
    execution_nodes: { ...overviewScope, items: [{ id: "node-1", code: "01.01.01", name: "Release verification", project_id: "project-1", project_title: "Alpha", module_id: "module-1", module_title: "Service", issue_counts: counts }], total: 2, next_cursor: "node-next" },
    recent_meetings: { ...overviewScope, range_start: "2026-09-11", range_end: "2026-10-17", items: [{ id: "meeting-1", title: "Release review", meet_date: "2026-10-10", ended_at: "2026-10-10T09:00:00Z", workflow_enabled: true, workflow_stage: "review_pending" }], total: 1, next_cursor: null },
  }), ...overrides };
}
