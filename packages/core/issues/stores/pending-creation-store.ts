import { create } from "zustand";

/**
 * Task ids the user has waved away in the pending-creation strip.
 *
 * Client state, deliberately NOT persisted: a dismissal is ephemeral UI intent,
 * and the durable record of a failed creation is the inbox item the server
 * writes. It lives in a store rather than component state because the strip's
 * host is keyed by surface — route and view changes remount it, and a dismissal
 * that resurrects on every remount is worse than no dismiss affordance at all.
 */
interface PendingCreationDismissState {
  dismissed: ReadonlySet<string>;
  dismiss: (taskId: string) => void;
  reset: () => void;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export const usePendingCreationStore = create<PendingCreationDismissState>((set) => ({
  dismissed: EMPTY,
  dismiss: (taskId) =>
    set((s) => {
      if (s.dismissed.has(taskId)) return s;
      const next = new Set(s.dismissed);
      next.add(taskId);
      return { dismissed: next };
    }),
  reset: () => set({ dismissed: EMPTY }),
}));
