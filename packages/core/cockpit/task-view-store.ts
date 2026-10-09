import { create } from "zustand";

export interface CockpitTaskView {
  text: string;
  status: string;
  category: string;
  relation: "primary" | "reference";
  versionId: string;
  cursorKey: string;
  cursors: string[];
}
export const EMPTY_COCKPIT_TASK_VIEW: CockpitTaskView = {
  text: "", status: "", category: "active", relation: "primary", versionId: "", cursorKey: "", cursors: [""],
};

/** Session-only navigation context. Cursors and dialogs are never written to persistent storage. */
export const useCockpitTaskViewStore = create<{
  views: Record<string, CockpitTaskView>;
  update: (key: string, patch: Partial<CockpitTaskView>) => void;
  reset: () => void;
}>((set) => ({ views: {},
  update: (key, patch) => set((state) => {
    const current = state.views[key] ?? EMPTY_COCKPIT_TASK_VIEW;
    const filters = ["text", "status", "category", "relation", "versionId"] as const;
    const changedFilter = filters.some((field) => field in patch && patch[field] !== current[field]);
    const next = { ...current, ...patch };
    return { views: { ...state.views, [key]: changedFilter ? { ...next, cursorKey: "", cursors: [""] } : next } };
  }),
  reset: () => set({ views: {} }),
}));

export function cockpitTaskViewKey(wsId: string, kind: "node" | "meeting" | "issue", id: string) { return JSON.stringify([wsId, kind, id]); }
