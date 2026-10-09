export interface CockpitOverviewScope {
  workspace_id: string;
  project_id: string | null;
  project_title: string;
  as_of: string;
  generated_at: string;
}

export interface CockpitOverviewIssueCounts {
  total: number;
  active: number;
  unstarted: number;
  started: number;
  done: number;
  closed: number;
  unknown: number;
  overdue: number;
  blocked: number;
  unassigned: number;
}

export interface CockpitAttentionTarget {
  kind: string;
  id: string;
  meeting_id: string | null;
  version_id: string | null;
  node_id: string | null;
  issue_id: string | null;
  action_id: string | null;
  export_id: string | null;
}

export interface CockpitAttentionItem {
  id: string;
  kind: string;
  reason: string;
  title: string;
  flags: string[];
  created_at: string;
  due_date: string | null;
  responsibility: string;
  assignee_type: string | null;
  assignee_id: string | null;
  assignee_name: string;
  can_act: boolean;
  next_action: string;
  target: CockpitAttentionTarget;
  meeting_code: string;
  meeting_title: string;
  version_number: number | null;
  node_code: string;
  node_name: string;
  issue_identifier: string;
  issue_status: string;
  issue_status_category: string;
}

export interface CockpitAttentionPage extends CockpitOverviewScope {
  view: string;
  kind: string;
  items: CockpitAttentionItem[];
  total: number;
  next_cursor: string | null;
}

export interface CockpitExecutionOverviewItem {
  id: string;
  code: string;
  name: string;
  project_id: string;
  project_title: string;
  module_id: string;
  module_title: string;
  plan_owner: string;
  plan_status: string;
  plan_start_date: string | null;
  plan_end_date: string | null;
  issue_counts: CockpitOverviewIssueCounts;
}

export interface CockpitExecutionOverviewPage extends CockpitOverviewScope {
  items: CockpitExecutionOverviewItem[];
  total: number;
  next_cursor: string | null;
}

export interface CockpitRecentMeeting {
  id: string;
  code: string;
  title: string;
  meet_date: string;
  time_range: string;
  meeting_status: string;
  ended_at: string | null;
  workflow_enabled: boolean;
  workflow_stage: string;
  minutes_issue_id: string | null;
  current_version_id: string | null;
  current_version_number: number | null;
  published_version_id: string | null;
}

export interface CockpitRecentMeetingPage extends CockpitOverviewScope {
  range_start: string;
  range_end: string;
  items: CockpitRecentMeeting[];
  total: number;
  next_cursor: string | null;
}

export interface CockpitOverviewData extends CockpitOverviewScope {
  board: { id: string; title: string; goal_title: string; goal_date: string | null } | null;
  actor: { user_id: string; role: string; is_human: boolean };
  summary: {
    primary_issues: CockpitOverviewIssueCounts;
    my_primary_issues: CockpitOverviewIssueCounts;
    execution_nodes: { total: number; with_active_issues: number };
    attention: { team_total: number; mine_total: number; team_by_kind: Record<string, number>; mine_by_kind: Record<string, number> };
  };
  attention: CockpitAttentionPage;
  execution_nodes: CockpitExecutionOverviewPage;
  recent_meetings: CockpitRecentMeetingPage;
}

export interface CockpitOverviewQuery {
  as_of: string;
  project_id?: string;
  attention_view?: "mine" | "team";
}

export interface CockpitOverviewPageQuery {
  as_of: string;
  project_id?: string;
  cursor?: string;
  page_size?: number;
}

export interface CockpitAttentionQuery extends CockpitOverviewPageQuery {
  view: "mine" | "team";
  kind?: string;
}
