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

type ChatSeatAgent = { name?: string | null; system_key?: string | null };

function chatAgentSeat(agent: ChatSeatAgent): number {
  if (agent.system_key === "mika") return 0;
  if (agent.name === "通用智能体（主）" || agent.name === "通用智能体") return 1;
  return 2;
}

/** Mika leads chat pickers, followed by the generic agent; other agents keep their order. */
export function orderChatAgentsBySeat<T extends ChatSeatAgent>(agents: readonly T[]): T[] {
  return agents
    .map((agent, index) => ({ agent, index, seat: chatAgentSeat(agent) }))
    .sort((x, y) => x.seat - y.seat || x.index - y.index)
    .map((entry) => entry.agent);
}

/** The first two seats precede ownership groups, even when the viewer owns other agents. */
export function groupChatAgentsBySeat<T extends ChatSeatAgent & { owner_id?: string | null }>(
  agents: readonly T[],
  userId: string | undefined,
): { preferred: T[]; mine: T[]; others: T[] } {
  const preferred: T[] = [];
  const mine: T[] = [];
  const others: T[] = [];
  for (const agent of orderChatAgentsBySeat(agents)) {
    if (chatAgentSeat(agent) < 2) preferred.push(agent);
    else if (agent.owner_id === userId) mine.push(agent);
    else others.push(agent);
  }
  return { preferred, mine, others };
}
