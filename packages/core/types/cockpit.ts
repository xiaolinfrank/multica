// Read model for the project cockpit — the workspace's programme board.
//
// One board per workspace: a work-breakdown tree with dates, owners, budget and
// instalments, plus milestones, meetings, and the issues each work item is
// carried out by. GET /api/cockpit returns all of it in one response; every
// write returns just the row it changed.

export interface Cockpit {
  id: string;
  workspace_id: string;
  title: string;
  /** The annual objective shown in the banner, and its target date. */
  goal_title: string;
  goal_date: string | null;
  /**
   * The three narrative cards at the foot of the overview. Empty means "derive
   * it from the tasks" — the board rolls its own summary up in that case, which
   * stays correct on its own.
   */
  summary_overall: string;
  summary_next: string;
  summary_support: string;
  /** Free-text provenance line for the whole board. */
  basis: string;
  created_at: string;
  updated_at: string;
}

export interface CockpitNode {
  id: string;
  cockpit_id: string;
  /** null for a root node. Depth is derived by walking this, not stored. */
  parent_id: string | null;
  /** The human address of the node — "L1-02", "L3-01-08". Unique per board. */
  code: string;
  name: string;
  position: number;
  /** Branch colour; empty means "inherit from the nearest ancestor that sets one". */
  color: string;
  owner: string;
  collaborators: string;
  start_date: string | null;
  end_date: string | null;
  /** Free text: the board uses whatever vocabulary the programme already uses. */
  status: string;
  progress: number;
  deliverable: string;
  dependencies: string;
  note: string;
  /** One-line current progress, shown on cards and in the weekly panel. */
  current_progress: string;
  vendor: string;
  budget_category: string;
  /** In the board's own unit. null means "no budget line", which is not 0. */
  budget_amount: number | null;
  exec_status: string;
  contract: string;
  source: string;
  updated_by_type: string;
  updated_by_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CockpitPayment {
  id: string;
  node_id: string;
  label: string;
  pay_date: string | null;
  amount: number;
  position: number;
}

export interface CockpitIssueLink {
  id: string;
  node_id: string;
  issue_id: string;
  issue_number: number;
  /** Workspace-prefixed identifier, e.g. "BIO-314". Assembled server-side. */
  issue_identifier: string;
  issue_title: string;
  issue_status: string;
  position: number;
}

export interface CockpitMilestone {
  id: string;
  name: string;
  plan_date: string | null;
  /** Set once it landed. A milestone with an actual date reads as done. */
  actual_date: string | null;
  status: string;
  /** The branch it belongs to, by node id. null for a programme-wide milestone. */
  node_id: string | null;
  condition: string;
  guard: string;
  position: number;
}

export interface CockpitMeeting {
  id: string;
  meet_date: string | null;
  /** Free text ("10:00–11:00"): recorded as people wrote it. */
  time_range: string;
  title: string;
  attendees: string;
  meet_no: string;
  link: string;
  note: string;
}

export interface CockpitBoard {
  cockpit: Cockpit;
  nodes: CockpitNode[];
  payments: CockpitPayment[];
  issue_links: CockpitIssueLink[];
  milestones: CockpitMilestone[];
  meetings: CockpitMeeting[];
}

/**
 * Which collection a `cockpit:changed` event moved. `board` means the whole
 * thing was replaced (an import) and the client should re-read rather than
 * patch.
 */
export type CockpitEventScope =
  | "cockpit"
  | "node"
  | "payment"
  | "issue_links"
  | "milestone"
  | "meeting"
  | "board";

export interface CockpitChangedPayload {
  scope: CockpitEventScope;
  action: string;
  entity: unknown;
}

/** Partial write shapes. Only the keys present are written. */
export type CockpitPatch = Partial<
  Pick<
    Cockpit,
    | "title"
    | "goal_title"
    | "goal_date"
    | "summary_overall"
    | "summary_next"
    | "summary_support"
    | "basis"
  >
>;

export type CockpitNodePatch = Partial<
  Pick<
    CockpitNode,
    | "code"
    | "parent_id"
    | "name"
    | "position"
    | "color"
    | "owner"
    | "collaborators"
    | "start_date"
    | "end_date"
    | "status"
    | "progress"
    | "deliverable"
    | "dependencies"
    | "note"
    | "current_progress"
    | "vendor"
    | "budget_category"
    | "budget_amount"
    | "exec_status"
    | "contract"
    | "source"
  >
>;

export type CockpitPaymentPatch = Partial<
  Pick<CockpitPayment, "label" | "pay_date" | "amount" | "position">
>;

export type CockpitMilestonePatch = Partial<
  Pick<
    CockpitMilestone,
    "name" | "plan_date" | "actual_date" | "status" | "node_id" | "condition" | "guard" | "position"
  >
>;

export type CockpitMeetingPatch = Partial<
  Pick<CockpitMeeting, "meet_date" | "time_range" | "title" | "attendees" | "meet_no" | "link" | "note">
>;
