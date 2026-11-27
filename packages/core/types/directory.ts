/** One queued/dispatched/running agent task that would have a folder renamed
 *  under it. The server refuses the structural write and lists these so the
 *  reader can choose "sync now" or "later". */
export interface RunningAgentTask {
  task_id: string;
  issue_id: string;
  issue_identifier: string;
  status: string;
}

/** Another project pointing at the same collaboration root. Writing into a
 *  folder a second workspace also owns is worth saying out loud first. */
export interface SharedCollabProject {
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  project_id: string;
  project_title: string;
}

/** What a structural write does with the folder it affects.
 *  `sync` (default) renames it and refuses while an agent works in it;
 *  `defer` writes the row and leaves the folder for the panel; `force` renames
 *  even while an agent works. */
export type DirectorySyncMode = "sync" | "defer" | "force";

/** How one folder operation ended. `status` is created / renamed / ok /
 *  skipped / failed; `reason` carries a machine code (target_exists,
 *  no_collab_space, running_agent_tasks…) and `error` the human one. */
export interface NodeDirectorySyncResult {
  status: string;
  directory_name?: string;
  from_directory?: string;
  to_directory?: string;
  reason?: string;
  error?: string;
}

/** The plan row's folder as the panel reads it on demand. */
export interface PlanDirectoryStatus {
  node_id: string;
  kind: "project" | "module" | "work_item";
  project_id: string;
  project_collab_path: string | null;
  directory_name: string | null;
  expected_directory_name: string | null;
  full_path: string | null;
  /** ok | missing | name_mismatch | no_collab_path | root_unavailable | invalid */
  status: string;
  running_tasks: RunningAgentTask[];
  shared_collab_projects: SharedCollabProject[];
  error?: string;
}

/** One row of a fill pass. `action` is create / sync / none. */
export interface DirectoryFillItem {
  node_id: string;
  code: string;
  name: string;
  kind: "module" | "work_item";
  action: string;
  directory_name?: string;
  full_path?: string;
  status: string;
  reason?: string;
  error?: string;
}

export interface DirectoryFillResult {
  applied: boolean;
  items: DirectoryFillItem[];
  counts: Record<string, number>;
  shared_collab_projects: SharedCollabProject[];
  /** Who is working in the folders a preview would touch. */
  running_tasks: RunningAgentTask[];
}

/** The issue's delivery folder as the detail row reads it. */
export interface IssueDirectoryStatus {
  issue_id: string;
  project_id: string | null;
  project_collab_path: string | null;
  full_path: string | null;
  /** "meeting": the folder of the meeting the issue works for, prepared from
   *  that meeting and never created from the issue. "filing": the folder it is
   *  filed under. */
  source: "meeting" | "filing";
  /** The meeting a meeting folder is bound to. */
  meeting_id: string | null;
  /** ok | missing | no_collab_path | root_unavailable | invalid */
  status: string;
  shared_collab_projects: SharedCollabProject[];
  error?: string;
}

/** The answer to "open this issue's folder, now". */
export interface IssueDirectoryEnsureResult {
  full_path: string | null;
  source: "meeting" | "filing";
  meeting_id: string | null;
  status: string;
  exists: boolean;
  shared_collab_projects: SharedCollabProject[];
  error?: string;
}
