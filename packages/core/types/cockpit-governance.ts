import type { CockpitPendingChange, CockpitSnapshot } from "./cockpit";
import type { CockpitReadPage, CockpitReadScope } from "./cockpit-read";
export type CockpitChangeStatusFilter = "all" | "pending" | "decided" | "applied" | "rejected" | "withdrawn";
export interface CockpitGovernancePageQuery { q?: string; cursor?: string; page_size?: number }
export interface CockpitChangePageQuery extends CockpitGovernancePageQuery { status?: CockpitChangeStatusFilter }
export interface CockpitChangePage extends CockpitReadPage<CockpitPendingChange> {
  workspace_id: string; scope: CockpitReadScope; q: string; status: CockpitChangeStatusFilter;
  counts: { pending: number; decided: number };
}
export interface CockpitSnapshotPage extends CockpitReadPage<CockpitSnapshot> { workspace_id: string; scope: "workspace"; q: string }

export interface CockpitChangePreview {
  workspace_id: string; context: CockpitReadScope; change: CockpitPendingChange; current_value: string; conflict: boolean; review_token: string;
}
