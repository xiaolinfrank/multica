/**
 * Returns a copy of `agents` with the agent named `pinnedName` moved to the
 * front, preserving the relative order of everything else (BayClaw fork:
 * keeps the deployment's default assignee — 通用智能体（主） — at the top of
 * every agent picker). Returns the input order unchanged when pinnedName is
 * empty, absent from the list, or already first. Never mutates the input, so
 * it is safe to compose with memoized React Query selectors.
 */
export function pinAgentByName<T extends { name?: string | null }>(
  agents: readonly T[],
  pinnedName: string | undefined | null,
): T[] {
  if (!pinnedName) return [...agents];
  const idx = agents.findIndex((a) => a.name === pinnedName);
  if (idx <= 0) return [...agents];
  const next = [...agents];
  const pinned = next.splice(idx, 1)[0];
  if (pinned === undefined) return [...agents]; // unreachable after findIndex, keeps noUncheckedIndexedAccess happy
  next.unshift(pinned);
  return next;
}

/**
 * Chat seat order (BayClaw fork): the built-in Chief of Staff (system_key
 * "mika") opens the new-session agent list, the host-node generic agent
 * (通用智能体（主）) follows, and everything else keeps its original order.
 * Stable sort, never mutates the input. Composes with pinAgentByName: run
 * the pin first, then this — a pinned agent lands in second seat, behind
 * Mika, in deployments that set DEFAULT_ISSUE_ASSIGNNEE_NODE.
 */
export function orderChatAgentsBySeat<
  T extends { name?: string | null; system_key?: string | null },
>(agents: readonly T[]): T[] {
  const seat = (a: T): number => {
    if (a.system_key === "mika") return 0;
    if (a.name != null && a.name.endsWith("（主）")) return 1;
    return 2;
  };
  return agents
    .map((agent, index) => ({ agent, index, seat: seat(agent) }))
    .sort((x, y) => x.seat - y.seat || x.index - y.index)
    .map((entry) => entry.agent);
}
