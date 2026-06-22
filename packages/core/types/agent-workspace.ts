/**
 * A persistent agent workspace: the on-disk working directory the daemon keeps
 * for one (agent, issue) pair. The workspace lives as long as its issue exists
 * (see the daemon GC policy) and is surfaced here for the management UI.
 */
export interface AgentWorkspace {
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  issue_status: string;
  agent_id: string;
  agent_name: string;
  /** Fleet node (daemon) that physically holds this workspace. */
  device_name: string;
  /** First 8 chars of the owning task UUID — the on-disk directory name. */
  task_short: string;
  size_bytes: number;
  /** Working-tree bytes of git checkouts inside the workdir — reclaimable. */
  repo_checkout_bytes: number;
  file_count: number;
  age_seconds: number;
}

export interface AgentWorkspacesResponse {
  workspaces: AgentWorkspace[];
  total_size_bytes: number;
  total_repo_checkout_bytes: number;
}
