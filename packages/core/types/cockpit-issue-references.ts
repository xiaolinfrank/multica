export interface CockpitIssueNodeReference {
  node_id: string; code: string; title: string; available: boolean; relation: "reference" | "unknown"; can_unlink: boolean;
}
export interface CockpitIssueMeetingReference {
  meeting_id: string; code: string; title: string; meet_date: string; available: boolean;
  role: string; roles: string[]; required_roles: string[]; can_unlink: boolean;
  has_direct_reference?: boolean; has_agenda_reference?: boolean; agenda_id?: string | null; agenda_total?: number;
}
export interface CockpitIssueReferencePage<T> {
  workspace_id: string; issue_id: string; items: T[]; total: number; next_cursor: string | null;
}
export interface CockpitIssueReferenceQuery { cursor?: string; page_size?: number }
export interface CockpitIssueReferenceRemoval {
  workspace_id: string; issue_id: string; kind: "node" | "meeting"; target_id: string; removed: true;
}
