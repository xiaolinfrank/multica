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
