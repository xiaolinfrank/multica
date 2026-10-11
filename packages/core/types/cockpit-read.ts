import type { Cockpit, CockpitNode, CockpitPayment, CockpitMilestone, CockpitMeeting, CockpitMeetingIssueLink, CockpitMeetingNodeLink } from "./cockpit";

export interface CockpitReadScope { project_id: string | null; module_id: string | null; project_title: string; module_title: string }
export interface CockpitContextData {
  workspace_id: string; scope: CockpitReadScope; cockpit: Cockpit | null;
  actor: { user_id: string; role: string; is_human: boolean }; has_meeting_workflows: boolean; has_stable_bindings: boolean;
  has_meeting_lifecycle?: boolean;
  has_meeting_preparation?: boolean;
  has_directory_history?: boolean;
  capabilities?: { artifacts: boolean; acceptance: boolean; meeting_lifecycle?: boolean; meeting_templates?: boolean; meeting_disposition?: boolean; meeting_directory_preparation?: boolean };
}
export interface CockpitNodeIndexEntry { id: string; parent_id: string | null; code: string; position: number }
export interface CockpitNodeIndexPage { workspace_id: string; items: CockpitNodeIndexEntry[]; total: number }
export interface CockpitPlanTaskCount { node_id: string; primary_total: number; reference_total: number; active: number; done: number; closed: number }
/** Oversized scopes fail explicitly instead of returning truncated rollups. */
export interface CockpitPlanData extends CockpitContextData {
  complete: true; nodes: CockpitNode[]; payments: CockpitPayment[]; milestones: CockpitMilestone[]; context_node_ids: string[];
  node_index: CockpitNodeIndexEntry[]; task_counts: CockpitPlanTaskCount[];
  counts: { nodes: number; payments: number; milestones: number; index_nodes: number };
}
export interface CockpitPlanExportData extends CockpitPlanData {
  issue_links: { node_id: string; issue_identifier: string }[]; issue_link_total: number; generated_at: string;
}
export interface CockpitReadPage<T> { items: T[]; total: number; next_cursor: string | null }
export interface CockpitObjectRelationPage<T> extends CockpitReadPage<T> { workspace_id: string; object_id: string; kind: string; payment_total: number }
export interface CockpitScopeItem { id: string; title: string; project_id: string | null }
export interface CockpitScopeItemPage extends CockpitReadPage<CockpitScopeItem> { workspace_id: string; project_id: string | null }
export type CockpitMeetingCard = Omit<CockpitMeeting, "note" | "minutes" | "decisions" | "actions"> & {
  issue_count: number; node_count: number; workflow_enabled: boolean; workflow_stage: string; display_excerpt: string;
};
export interface CockpitMeetingRegisterQuery {
  archive?: CockpitMeetingArchiveFilter;
  q?: string; node_id?: string; node_ids?: string[]; tracks?: string[]; kinds?: string[]; statuses?: string[]; parties?: string[];
  only?: ("consensus" | "folder" | "links" | "detected")[]; workflow_stage?: string;
  date_from?: string; date_to?: string; cursor?: string; page_size?: number;
}
export interface CockpitMeetingRegisterPage extends CockpitReadPage<CockpitMeetingCard> {
  archive?: CockpitMeetingArchiveFilter;
  workspace_id: string; scope: CockpitReadScope; node_id: string | null; node_ids: string[];
  /** Present only for finite windows up to 93 days; counts cover every matching row. */
  day_counts: { date: string; total: number }[]; date_from: string | null; date_to: string | null;
}
export type CockpitMeetingArchiveFilter = "active" | "archived" | "all";
export interface CockpitNodeBindingContext {
  project_id: string | null; module_id: string | null; project_title: string; module_title: string;
  source_node_id: string | null; eligible: boolean; reason: string;
}
export interface CockpitNodeDetailData extends CockpitContextData {
  node: CockpitNode; ancestors: CockpitNode[]; children_count: number; scope_match: boolean;
  binding: CockpitNodeBindingContext; node_index: CockpitNodeIndexEntry[];
  payments: CockpitReadPage<CockpitPayment>; payment_total: number; meetings: CockpitReadPage<CockpitMeetingCard>;
}
export interface CockpitMeetingDetailData extends CockpitContextData {
  meeting: CockpitMeeting; scope_match: boolean; node_index: CockpitNodeIndexEntry[];
  linked_issues: CockpitReadPage<CockpitMeetingIssueLink>;
  linked_nodes: CockpitReadPage<CockpitMeetingNodeLink & { code: string; name: string }>;
}
export interface CockpitPlanMeetingMarkerRow { row_key: string; node_ids: string[] }
export interface CockpitPlanMeetingMarkerQuery { rows: CockpitPlanMeetingMarkerRow[]; date_from: string; date_to: string; archive?: CockpitMeetingArchiveFilter; cursor?: string }
export interface CockpitPlanMeetingMarkerGroup { row_key: string; date: string; total: number; items: { id: string; title: string; code: string; start_time: string | null }[] }
export interface CockpitPlanMeetingMarkerPage {
  archive?: CockpitMeetingArchiveFilter;
  workspace_id: string; scope: CockpitReadScope; rows: CockpitPlanMeetingMarkerRow[]; date_from: string; date_to: string;
  groups: CockpitPlanMeetingMarkerGroup[]; total_groups: number; next_cursor: string | null;
}
