export interface CockpitSnapshotDiffValue {
  value: string | number | boolean | null;
  truncated: boolean;
  sha256: string;
}
export interface CockpitSnapshotDiffItem {
  entity_kind: "board" | "node" | "payment" | "milestone" | "unknown";
  id: string;
  change: "added" | "removed" | "modified" | "unknown";
  code: string;
  name: string;
  field_changes: { field: string; before: CockpitSnapshotDiffValue; after: CockpitSnapshotDiffValue }[];
}
export interface CockpitSnapshotDiff {
  workspace_id: string;
  snapshot_id: string;
  snapshot_created_at: string;
  snapshot_cockpit_id: string;
  current_cockpit_id: string | null;
  scope: "workspace";
  generated_at: string;
  comparable: boolean;
  reason: string;
  snapshot_complete: boolean;
  current_complete: boolean;
  snapshot_counts: { nodes: number; payments: number; milestones: number };
  current_counts: { nodes: number; payments: number; milestones: number };
  counts: { added: number; removed: number; modified: number; unchanged: number };
  items: CockpitSnapshotDiffItem[];
  total: number;
  page_size: number;
  next_cursor: string | null;
  comparison_token: string;
}
