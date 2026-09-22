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
  /**
   * Where a new meeting files its task and its folder: a project, one of its
   * modules, and the directory their material goes in. Chosen in the product
   * and remembered here — which project a programme keeps its meetings in is
   * a property of the programme, not of the code.
   */
  meeting_project_id: string | null;
  meeting_module_id: string | null;
  /** The sub-item under the module that meeting material is archived in — a
   *  node on this board's tree ("06.06.03 会议纪要与素材"). Its code opens the
   *  meeting task's title and its folder holds the material. */
  meeting_node_id: string | null;
  meeting_dir: string;
  /** Who a new meeting's task is assigned to. The pair travels together:
   *  "member" | "agent" | "squad" says which table the id points into, and
   *  an empty type means the member filing the meeting. */
  meeting_assignee_type: string;
  meeting_assignee_id: string | null;
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
  /** Free text ("10:00–11:00"): what the log recorded before the span was
   *  structured. Rows written since carry start_time/end_time instead, and
   *  `cockpitMeetingSpan` is what renders either of them. */
  time_range: string;
  /** "HH:MM", null for a meeting nobody has timed. The calendar views place a
   *  meeting by these; an untimed one sits in the all-day lane. */
  start_time: string | null;
  end_time: string | null;
  title: string;
  /** The platform's own number, "20260921-01" — the date and that day's
   *  sequence. `meet_no` is the conferencing system's dial-in number, which
   *  belongs to the provider and is a different thing entirely. */
  code: string;
  /** Free text, like every other vocabulary field on this board: the
   *  programme's own words for what kind of meeting it was and where it
   *  stands. */
  kind: string;
  status: string;
  /** The organisations at the table, separated by "、". `attendees` lists
   *  people, the same way. */
  parties: string;
  /** People. A name that matches a workspace member is shown as that member;
   *  anyone else is an ordinary name, because half the room at a joint
   *  meeting has no account here. */
  organizer: string;
  location: string;
  attendees: string;
  meet_no: string;
  link: string;
  /** The agenda and running remarks, one line per point. */
  note: string;
  minutes: string;
  decisions: string;
  actions: string;
  /** Absolute path of the meeting's folder on the shared NAS, as the daemon
   *  hosts mount it. Written by provisioning; rendered through the shared
   *  local-path affordance, never as a bare link. */
  nas_dir: string;
  /** True when the row was read off the share rather than typed: its date,
   *  number, parties and subject are guesses from a folder name and want
   *  checking. Cleared by whoever checks them. */
  detected: boolean;
}

/**
 * One issue a meeting is carried out through. The pair (meeting_id, issue_id)
 * is the row's identity — there is no surrogate key — so a list keys on both.
 */
export interface CockpitMeetingIssueLink {
  meeting_id: string;
  issue_id: string;
  /** "task" for the issue the platform opened with the meeting, "" for one
   *  someone attached by hand. */
  role: string;
  issue_number: number;
  /** Workspace-prefixed identifier, e.g. "BIO-314". Assembled server-side. */
  issue_identifier: string;
  issue_title: string;
  issue_status: string;
  position: number;
}

/** One work-breakdown item a meeting was about. */
export interface CockpitMeetingNodeLink {
  meeting_id: string;
  node_id: string;
  position: number;
}

export interface CockpitBoard {
  cockpit: Cockpit;
  nodes: CockpitNode[];
  payments: CockpitPayment[];
  issue_links: CockpitIssueLink[];
  milestones: CockpitMilestone[];
  meetings: CockpitMeeting[];
  meeting_issues: CockpitMeetingIssueLink[];
  meeting_nodes: CockpitMeetingNodeLink[];
}

/**
 * Which collection a `cockpit:changed` event moved. `board` means the whole
 * thing was replaced (an import or restore) and the client should re-read
 * rather than patch; `snapshots` means only the version history moved.
 */
export type CockpitEventScope =
  | "cockpit"
  | "node"
  | "payment"
  | "issue_links"
  | "milestone"
  | "meeting"
  | "meeting_issues"
  | "meeting_nodes"
  | "board"
  | "changes"
  | "snapshots";

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
    | "meeting_project_id"
    | "meeting_module_id"
    | "meeting_node_id"
    | "meeting_dir"
    | "meeting_assignee_type"
    | "meeting_assignee_id"
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
  Pick<
    CockpitMeeting,
    | "meet_date"
    | "time_range"
    | "start_time"
    | "end_time"
    | "title"
    | "code"
    | "kind"
    | "status"
    | "parties"
    | "organizer"
    | "location"
    | "attendees"
    | "meet_no"
    | "link"
    | "note"
    | "minutes"
    | "decisions"
    | "actions"
    | "nas_dir"
    | "detected"
  >
>;

/**
 * What filing a meeting asks the server to set up alongside the row: the task
 * it is carried out through, and the folder its material goes in. Both are
 * optional and both report their own outcome — an unmounted share must not
 * cost someone the record of a meeting that happened.
 */
export interface CockpitMeetingProvision {
  create_task?: boolean;
  create_dir?: boolean;
  project_id?: string;
  module_id?: string;
  /** The archive sub-item. An empty string files at the module level
   *  instead, which is why absent and empty differ. */
  node_id?: string;
  /** The folder to create the meeting's folder in, and what to call it.
   *  Absent means "derive both", which is what the form sends back after
   *  showing the derivation to a human. */
  base_dir?: string;
  folder_name?: string;
  assignee_type?: string;
  assignee_id?: string;
  /** Store this destination on the board so later meetings pre-fill it. */
  remember?: boolean;
}

export interface CockpitMeetingProvisionResult {
  meeting: CockpitMeeting;
  issues: CockpitMeetingIssueLink[];
  task: CockpitMeetingIssueLink | null;
  /** Why the task or the folder is missing. Empty on success; a filled one is
   *  not a failed request — the meeting is saved and the part that failed can
   *  be retried. */
  task_error: string;
  dir: string;
  dir_created: boolean;
  dir_error: string;
}

/** Where a new meeting would be filed, for the form to show before it is. */
export interface CockpitMeetingDestination {
  project_id: string;
  project_title: string;
  module_id: string;
  module_title: string;
  /** The archive sub-item under the module, and the code its task titles
   *  open with. */
  node_id: string;
  node_code: string;
  node_title: string;
  collab_path: string;
  base_dir: string;
  /** True when base_dir was worked out from the project, module and sub-item
   *  rather than confirmed by someone — the form shows it as a proposal. */
  derived: boolean;
  /** True when base_dir exists on the server right now. False is not an
   *  error: the share may not be mounted there, or the archive folder may
   *  simply not have been created yet. */
  base_dir_exists: boolean;
  /** True when the server could create what is missing. This, not
   *  base_dir_exists, is what decides whether a folder can be asked for. */
  creatable: boolean;
  error: string;
}

/**
 * One folder in the archive folder, and what its name gives up about the
 * meeting that filled it. Every guessed field is editable before import and
 * the row it creates stays flagged afterwards.
 */
export interface CockpitMeetingScanEntry {
  name: string;
  path: string;
  modified_at: string;
  files: number;
  /** The meeting already recording this folder, or "" when nothing does. */
  meeting_id: string;
  code: string;
  meet_date: string;
  parties: string;
  title: string;
}

export interface CockpitMeetingScan {
  base_dir: string;
  base_dir_exists: boolean;
  entries: CockpitMeetingScanEntry[];
  /** How many of the folders are already in the register. Reported rather
   *  than filtered out so "nothing new" reads as "I looked". */
  matched: number;
  truncated: boolean;
  error: string;
}

export interface CockpitMeetingImportItem {
  name: string;
  code?: string;
  meet_date?: string;
  title?: string;
  parties?: string;
  kind?: string;
}

export interface CockpitMeetingImportResult {
  meetings: CockpitMeeting[];
  issues: CockpitMeetingIssueLink[];
  /** Folders that were asked for and not imported, each with why. One folder
   *  that disappeared between the scan and the import must not cost the
   *  other nine. */
  skipped: { name: string; reason: string }[];
}

/**
 * One proposed field edit waiting for a human. Nothing on the board moved to
 * produce this row; apply is what moves it.
 */
export interface CockpitPendingChange {
  id: string;
  cockpit_id: string;
  node_id: string;
  /** The node's code/name resolved server-side; empty when the node is gone. */
  node_code: string;
  node_name: string;
  /** One of the node's plain data fields (name, status, end_date, progress, …). */
  field: string;
  /** What the field said when the change was queued / what apply overwrote. */
  old_value: string;
  new_value: string;
  /** "manual" | "agent". */
  source: string;
  reason: string;
  /** "pending" | "applied" | "rejected" | "withdrawn". */
  status: string;
  created_by_type: string;
  created_by_label: string;
  decided_by_type: string;
  decided_by_label: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One judgement from a batch ingest, per proposal. Machine-readable so an
 * agent can react without parsing prose. */
export interface CockpitIngestOutcome {
  node: string;
  field: string;
  /** "queued" | "updated" | "skipped" | "rejected". */
  status: string;
  /** "" | "no_change" | "duplicate" | "invalid_field" | "invalid_value" | "unknown_node". */
  reason: string;
  id: string | null;
}

/**
 * One frozen board version. Payload stays server-side: a version list that
 * dragged the whole board per row would be the heaviest read on the page.
 */
export interface CockpitSnapshot {
  id: string;
  /** "import" | "restore" | "manual" — why the version was frozen. */
  trigger_kind: string;
  /** Free-text name, manual versions only. */
  label: string;
  node_count: number;
  /** "member" or "agent". */
  created_by_type: string;
  /** Display name resolved at write time. */
  created_by_label: string;
  created_at: string;
}

/** What a restore brought back — same shape an import reports. */
export interface CockpitImportResult {
  nodes: number;
  payments: number;
  issue_links: number;
  milestones: number;
  meetings: number;
  /** Issue references the frozen board names that no issue answers to now. */
  unresolved_issues: string[];
}
