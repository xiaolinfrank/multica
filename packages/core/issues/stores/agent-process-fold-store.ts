import { create } from "zustand";

/**
 * Whether the reader has manually opened or closed a run's process fold on the
 * issue detail page, keyed by task ID. Absent means "no manual choice yet" —
 * the fold then follows its default, which is open while the run streams and
 * closed once it settles.
 *
 * This has to be a store rather than component state. A settled run's fold
 * hangs off its result comment, and the comment timeline is virtualized
 * (react-virtuoso in issue-detail.tsx), so scrolling a fold out of the viewport
 * unmounts it. With useState the reader's "keep this open" would be forgotten
 * by the time they scrolled back. Desktop tab backgrounding has the same shape
 * (MUL-4741).
 *
 * Deliberately NOT persisted, same contract as sub-issues-collapse-store: a
 * reload returns every fold to its default.
 */
interface AgentProcessFoldStore {
  /** taskId → the reader's explicit choice. Absent = follow the default. */
  overrides: ReadonlyMap<string, boolean>;
  setOpen: (taskId: string, open: boolean) => void;
  /**
   * Drop a task's override. Called on the streaming → settled edge so a run the
   * reader opened while it was live still collapses when it finishes — the
   * result is the point once there is one, and the fold is one click away.
   */
  clearOverride: (taskId: string) => void;
}

export const useAgentProcessFoldStore = create<AgentProcessFoldStore>()((set) => ({
  overrides: new Map<string, boolean>(),
  setOpen: (taskId, open) =>
    set((s) => {
      if (s.overrides.get(taskId) === open) return s;
      const next = new Map(s.overrides);
      next.set(taskId, open);
      return { overrides: next };
    }),
  clearOverride: (taskId) =>
    set((s) => {
      if (!s.overrides.has(taskId)) return s;
      const next = new Map(s.overrides);
      next.delete(taskId);
      return { overrides: next };
    }),
}));
