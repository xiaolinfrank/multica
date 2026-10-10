import type { CockpitOverviewData } from "../types/cockpit-overview";

/** An explicit presentation whitelist. Financial fields, descriptions, capabilities and actor identity never enter this model. */
export function cockpitReportData(data: CockpitOverviewData) {
  return {
    workspaceId: data.workspace_id, scope: { projectId: data.project_id, moduleId: data.module_id ?? null, projectTitle: data.project_title, moduleTitle: data.module_title ?? "" },
    asOf: data.as_of, retrievedAt: data.generated_at,
    title: data.board?.title ?? "", goal: data.board?.goal_title ?? "", goalDate: data.board?.goal_date ?? null, hasBoard: Boolean(data.board),
    summary: {
      workItems: data.summary.execution_nodes.total, workItemsWithActiveIssues: data.summary.execution_nodes.with_active_issues,
      issues: { total: data.summary.primary_issues.total, active: data.summary.primary_issues.active, done: data.summary.primary_issues.done,
        closed: data.summary.primary_issues.closed, unknown: data.summary.primary_issues.unknown, overdue: data.summary.primary_issues.overdue,
        blocked: data.summary.primary_issues.blocked, unassigned: data.summary.primary_issues.unassigned },
      attention: data.summary.attention.team_total,
    },
    execution: { total: data.execution_nodes.total, items: data.execution_nodes.items.map((item) => ({
      id: item.id, code: item.code, title: item.name, owner: item.plan_owner, status: item.plan_status, start: item.plan_start_date, end: item.plan_end_date,
      activeIssues: item.issue_counts.active, overdueIssues: item.issue_counts.overdue, blockedIssues: item.issue_counts.blocked,
    })) },
    attention: { total: data.attention.total, items: data.attention.items.map((item) => ({
      id: item.id, title: item.title, kind: item.kind, reason: item.reason, dueDate: item.due_date,
      target: { kind: item.target.kind, id: item.target.id, meeting_id: item.target.meeting_id, version_id: item.target.version_id,
        node_id: item.target.node_id, issue_id: item.target.issue_id, action_id: item.target.action_id, export_id: item.target.export_id },
    })) },
    meetings: { total: data.recent_meetings.total, rangeStart: data.recent_meetings.range_start, rangeEnd: data.recent_meetings.range_end,
      items: data.recent_meetings.items.map((item) => ({ id: item.id, title: item.title, date: item.meet_date, time: item.time_range, status: item.meeting_status, stage: item.workflow_stage })) },
  };
}
export type CockpitReportData = ReturnType<typeof cockpitReportData>;
