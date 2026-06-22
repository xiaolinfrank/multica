import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { Agent, Squad, Workspace } from "../types";

export const workspaceKeys = {
  all: (wsId: string) => ["workspaces", wsId] as const,
  list: () => ["workspaces", "list"] as const,
  members: (wsId: string) => ["workspaces", wsId, "members"] as const,
  invitations: (wsId: string) => ["workspaces", wsId, "invitations"] as const,
  myInvitations: () => ["invitations", "mine"] as const,
  agents: (wsId: string) => ["workspaces", wsId, "agents"] as const,
  squads: (wsId: string) => ["workspaces", wsId, "squads"] as const,
  // Per-squad member status. Lives under the workspace key tree so
  // workspace switches naturally drop the cache, and so a broad
  // `["workspaces", wsId, "squads"]` invalidation covers it.
  squadMemberStatus: (wsId: string, squadId: string) =>
    ["workspaces", wsId, "squads", squadId, "members-status"] as const,
  skills: (wsId: string) => ["workspaces", wsId, "skills"] as const,
  assigneeFrequency: (wsId: string) => ["workspaces", wsId, "assignee-frequency"] as const,
  agentWorkspaces: (wsId: string) => ["workspaces", wsId, "agent-workspaces"] as const,
  // On-demand file ops keyed by the workspace's on-disk task dir. Not WS-driven
  // (file ops are user-initiated RPCs), so these rely on staleTime + manual
  // invalidation after a reclaim.
  workspaceTree: (wsId: string, taskShort: string) =>
    ["workspaces", wsId, "workspace-tree", taskShort] as const,
  workspaceFile: (wsId: string, taskShort: string, path: string) =>
    ["workspaces", wsId, "workspace-file", taskShort, path] as const,
};

export function workspaceListOptions() {
  return queryOptions({
    queryKey: workspaceKeys.list(),
    queryFn: () => api.listWorkspaces(),
  });
}

/** Persistent agent workspaces (per agent×issue) for the management page. */
export function agentWorkspacesOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.agentWorkspaces(wsId),
    queryFn: () => api.listAgentWorkspaces(wsId),
    // Footprint shifts slowly and is daemon-reported on a ~3m cadence; a short
    // stale window keeps the page fresh without hammering on every focus.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * One workspace's file tree, fetched on demand via the daemon RPC. Disabled
 * until the caller opts in (e.g. the issue-detail section is expanded) so we
 * don't pay the round trip for collapsed sections. retry:false — a failed RPC
 * is shown as-is rather than hammered.
 */
export function workspaceTreeOptions(
  wsId: string,
  taskShort: string,
  enabled: boolean,
) {
  return queryOptions({
    queryKey: workspaceKeys.workspaceTree(wsId, taskShort),
    queryFn: ({ signal }) => api.fetchWorkspaceTree(wsId, taskShort, { signal }),
    enabled: enabled && !!wsId && !!taskShort,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** One file's contents, fetched on demand when a file is selected. */
export function workspaceFileOptions(
  wsId: string,
  taskShort: string,
  path: string,
) {
  return queryOptions({
    queryKey: workspaceKeys.workspaceFile(wsId, taskShort, path),
    queryFn: ({ signal }) => api.readWorkspaceFile(wsId, taskShort, path, { signal }),
    enabled: !!wsId && !!taskShort && !!path,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Resolves the workspace whose slug matches, from the cached workspace list. */
export function workspaceBySlugOptions(slug: string) {
  return queryOptions({
    ...workspaceListOptions(),
    select: (list: Workspace[]) => list.find((w) => w.slug === slug) ?? null,
  });
}

export function memberListOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.members(wsId),
    queryFn: () => api.listMembers(wsId),
  });
}

export function agentListOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.agents(wsId),
    queryFn: () =>
      api.listAgents({ workspace_id: wsId, include_archived: true }),
  });
}

export function squadListOptions(wsId: string) {
  return queryOptions<Squad[]>({
    queryKey: workspaceKeys.squads(wsId),
    queryFn: () => api.listSquads(),
    enabled: !!wsId,
  });
}

// Per-squad members status snapshot. The freshness signal is the WS task /
// agent / runtime invalidation wired in use-realtime-sync (which broadly
// invalidates `["workspaces", wsId, "squads"]`); the staleTime is a
// tab-focus safety net.
export function squadMemberStatusOptions(wsId: string, squadId: string) {
  return queryOptions({
    queryKey: workspaceKeys.squadMemberStatus(wsId, squadId),
    queryFn: () => api.getSquadMemberStatus(squadId),
    enabled: !!wsId && !!squadId,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
  });
}

export function skillListOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.skills(wsId),
    queryFn: () => api.listSkills(),
  });
}

export function skillDetailOptions(wsId: string, skillId: string) {
  return queryOptions({
    queryKey: [...workspaceKeys.skills(wsId), skillId] as const,
    queryFn: () => api.getSkill(skillId),
    enabled: !!skillId,
  });
}

/**
 * Builds a `Map<skillId, Agent[]>` from the cached agent list. The server
 * already returns each agent with its full skill list inline, so no extra
 * request is needed — "which agents use skill X" is pure client-side fold.
 *
 * Exposed as a plain helper rather than a `queryOptions` with `select` so
 * the Map's identity is stable across unrelated agent-cache rerenders —
 * callers wrap this in `useMemo(..., [agents])` and only re-fold when the
 * agent array identity actually changes. Previously this was `{ select }`,
 * which returned a new Map every subscription tick and triggered cascading
 * re-renders on every `agent:updated` WS event.
 */
export function selectSkillAssignments(
  agents: Agent[] | undefined,
): Map<string, Agent[]> {
  const map = new Map<string, Agent[]>();
  if (!agents) return map;
  for (const a of agents) {
    if (a.archived_at) continue;
    for (const s of a.skills ?? []) {
      const existing = map.get(s.id);
      if (existing) existing.push(a);
      else map.set(s.id, [a]);
    }
  }
  return map;
}

export function invitationListOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.invitations(wsId),
    queryFn: () => api.listWorkspaceInvitations(wsId),
  });
}

export function myInvitationListOptions() {
  return queryOptions({
    queryKey: workspaceKeys.myInvitations(),
    queryFn: () => api.listMyInvitations(),
  });
}

export function assigneeFrequencyOptions(wsId: string) {
  return queryOptions({
    queryKey: workspaceKeys.assigneeFrequency(wsId),
    queryFn: () => api.getAssigneeFrequency(),
  });
}
