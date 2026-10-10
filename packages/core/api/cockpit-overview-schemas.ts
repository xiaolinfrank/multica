import { z } from "zod";

const count = z.number().int().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const optionalDate = date.nullable().catch(null).default(null);
export const CockpitOverviewScopeSchema = z.object({
  workspace_id: z.string().min(1), project_id: z.string().nullable(), project_title: z.string().default(""),
  module_id: z.string().nullable().default(null), module_title: z.string().default(""),
  as_of: date, generated_at: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))),
}).loose();
export const CockpitOverviewIssueCountsSchema = z.object({
  total: count, active: count, unstarted: count, started: count, done: count, closed: count, unknown: count,
  overdue: count, blocked: count, unassigned: count,
}).loose();
export const CockpitAttentionItemSchema = z.object({
  id: z.string().min(1), kind: z.string(), reason: z.string().default(""), title: z.string().default(""),
  flags: z.array(z.string()).catch([]).default([]), created_at: z.string().default(""), due_date: optionalDate,
  responsibility: z.string().default(""), assignee_type: z.string().nullable().default(null), assignee_id: z.string().nullable().default(null), assignee_name: z.string().default(""),
  can_act: z.boolean().catch(false).default(false), next_action: z.string().default(""),
  target: z.object({ kind: z.string().default(""), id: z.string().default(""), meeting_id: z.string().nullable().default(null), version_id: z.string().nullable().default(null),
    node_id: z.string().nullable().default(null), issue_id: z.string().nullable().default(null), action_id: z.string().nullable().default(null), export_id: z.string().nullable().default(null),
  }).default({ kind: "", id: "", meeting_id: null, version_id: null, node_id: null, issue_id: null, action_id: null, export_id: null }),
  meeting_code: z.string().default(""), meeting_title: z.string().default(""), version_number: z.number().int().positive().nullable().default(null),
  node_code: z.string().default(""), node_name: z.string().default(""), issue_identifier: z.string().default(""), issue_status: z.string().default(""), issue_status_category: z.string().default("unknown"),
}).loose();
export const CockpitAttentionPageSchema = CockpitOverviewScopeSchema.extend({
  view: z.string(), kind: z.string().default(""), items: z.array(CockpitAttentionItemSchema), total: count, next_cursor: z.string().nullable(),
}).refine((page) => page.total >= page.items.length, "Page count is smaller than its contents");
export const CockpitExecutionOverviewItemSchema = z.object({
  id: z.string().min(1), code: z.string().default(""), name: z.string().default(""), project_id: z.string(), project_title: z.string().default(""),
  module_id: z.string(), module_title: z.string().default(""), plan_owner: z.string().default(""), plan_status: z.string().default(""),
  plan_start_date: optionalDate, plan_end_date: optionalDate, issue_counts: CockpitOverviewIssueCountsSchema,
}).loose();
export const CockpitExecutionOverviewPageSchema = CockpitOverviewScopeSchema.extend({
  items: z.array(CockpitExecutionOverviewItemSchema), total: count, next_cursor: z.string().nullable(),
}).refine((page) => page.total >= page.items.length, "Page count is smaller than its contents");
export const CockpitRecentMeetingSchema = z.object({
  id: z.string().min(1), code: z.string().default(""), title: z.string().default(""), meet_date: date, time_range: z.string().default(""), meeting_status: z.string().default(""),
  ended_at: z.string().nullable().default(null), workflow_enabled: z.boolean().default(false), workflow_stage: z.string().default("not_enabled"),
  minutes_issue_id: z.string().nullable().default(null), current_version_id: z.string().nullable().default(null), current_version_number: z.number().int().positive().nullable().default(null), published_version_id: z.string().nullable().default(null),
}).loose();
export const CockpitRecentMeetingPageSchema = CockpitOverviewScopeSchema.extend({
  range_start: date, range_end: date, items: z.array(CockpitRecentMeetingSchema), total: count, next_cursor: z.string().nullable(),
}).refine((page) => page.total >= page.items.length, "Page count is smaller than its contents");
export const CockpitOverviewDataSchema = CockpitOverviewScopeSchema.extend({
  board: z.object({ id: z.string().min(1), title: z.string().default(""), goal_title: z.string().default(""), goal_date: optionalDate }).nullable().default(null),
  actor: z.object({ user_id: z.string(), role: z.string().default(""), is_human: z.boolean().catch(false).default(false) }),
  summary: z.object({ primary_issues: CockpitOverviewIssueCountsSchema, my_primary_issues: CockpitOverviewIssueCountsSchema,
    execution_nodes: z.object({ total: count, with_active_issues: count }),
    attention: z.object({ team_total: count, mine_total: count, team_by_kind: z.record(z.string(), count), mine_by_kind: z.record(z.string(), count) }),
  }),
  attention: CockpitAttentionPageSchema, execution_nodes: CockpitExecutionOverviewPageSchema, recent_meetings: CockpitRecentMeetingPageSchema,
});
